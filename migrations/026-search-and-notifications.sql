-- DCE-032: public full-text search, subscriptions and notification delivery.
-- Only intentionally published content is indexed: dge_documents and
-- dge_proposals hold public material exclusively. Client-encrypted documents
-- (dge_private) are never indexed here; private search runs at authorized
-- clients. Notification rows carry identifiers, event kinds and cadences only;
-- titles are read from public documents at delivery time.

CREATE SCHEMA dge_search;
REVOKE ALL ON SCHEMA dge_search FROM PUBLIC;
GRANT USAGE ON SCHEMA dge_search TO dge_identity_runtime;

-- Accent- and case-insensitive folding shared by the index and the query.
CREATE FUNCTION dge_search.fold(value text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN lower(regexp_replace(normalize(value, NFKD), '[̀-ًͯ-ٰٟ]', '', 'g'));

-- Readable text of a legal document body in document order. Bounded so the
-- generated vector stays far below the 1 MB tsvector limit for any valid
-- document; text past the bound is not searchable.
CREATE FUNCTION dge_search.document_body(doc jsonb) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN left((SELECT coalesce(string_agg(concat_ws(' ', node->>'term', node->>'title', node->>'label', node->>'text'), ' '), '')
    FROM jsonb_path_query(doc, 'strict $.content.** ? (@.type() == "object")') AS node), 200000);

GRANT EXECUTE ON FUNCTION dge_search.fold(text), dge_search.document_body(jsonb) TO dge_identity_runtime;

-- Generated columns cannot drift from the content they index.
ALTER TABLE dge_documents.documents ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple'::regconfig, dge_search.fold(coalesce(current->'metadata'->>'title', ''))), 'A') ||
  setweight(to_tsvector('simple'::regconfig, dge_search.fold(dge_search.document_body(current))), 'B')
) STORED;
ALTER TABLE dge_proposals.proposals ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple'::regconfig, dge_search.fold(coalesce(proposal->>'rationale', ''))), 'B') ||
  setweight(to_tsvector('simple'::regconfig, dge_search.fold(left(coalesce(proposal->>'replacement', ''), 200000))), 'C')
) STORED;
CREATE INDEX document_search ON dge_documents.documents USING gin (search_vector);
CREATE INDEX proposal_search ON dge_proposals.proposals USING gin (search_vector);

-- Proposals are published content; this exposes them to cross-document
-- search the way public_document_directory exposes documents.
CREATE POLICY public_proposal_search ON dge_proposals.proposals FOR SELECT TO dge_identity_runtime
  USING (current_setting('dge.public_search', true) = 'enabled');

CREATE SCHEMA dge_notifications;
REVOKE ALL ON SCHEMA dge_notifications FROM PUBLIC;
GRANT USAGE ON SCHEMA dge_notifications TO dge_identity_runtime;

CREATE TABLE dge_notifications.preferences (
  account_id uuid PRIMARY KEY REFERENCES dge_identity.accounts(id),
  in_app text NOT NULL CHECK (in_app IN ('immediate','daily','weekly','off')),
  email text NOT NULL CHECK (email IN ('immediate','daily','weekly','off')),
  locale text NOT NULL CHECK (locale ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  updated_at timestamptz NOT NULL
);

CREATE TABLE dge_notifications.email_addresses (
  account_id uuid PRIMARY KEY REFERENCES dge_identity.accounts(id),
  address text NOT NULL CHECK (char_length(address) BETWEEN 3 AND 254),
  verified_at timestamptz,
  verification_sent_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE dge_notifications.subscriptions (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES dge_identity.accounts(id),
  target_kind text NOT NULL CHECK (target_kind IN ('document','proposal','workspace')),
  target_id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES dge_identity.tenants(id),
  document_id uuid,
  created_at timestamptz NOT NULL,
  UNIQUE (account_id, target_kind, target_id),
  CHECK ((target_kind = 'workspace') = (document_id IS NULL)),
  CHECK (target_kind <> 'workspace' OR target_id = tenant_id),
  CHECK (target_kind <> 'document' OR target_id = document_id)
);
CREATE INDEX subscription_targets ON dge_notifications.subscriptions(target_kind, target_id);

-- Last ledger sequence fanned out. -1 means nothing has been read yet.
CREATE TABLE dge_notifications.worker_cursor (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  ledger_seq bigint NOT NULL CHECK (ledger_seq >= -1),
  updated_at timestamptz NOT NULL
);
INSERT INTO dge_notifications.worker_cursor(id, ledger_seq, updated_at) VALUES (true, -1, now());

-- One row per (subscriber, channel, ledger entry): the unique key makes
-- fan-out idempotent however often the worker re-reads an entry.
CREATE TABLE dge_notifications.deliveries (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES dge_identity.accounts(id),
  channel text NOT NULL CHECK (channel IN ('in-app','email')),
  cadence text NOT NULL CHECK (cadence IN ('immediate','daily','weekly')),
  ledger_seq bigint NOT NULL CHECK (ledger_seq >= 0),
  event_kind text NOT NULL CHECK (event_kind ~ '^[a-z][a-z0-9-]{1,40}$'),
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  proposal_id uuid,
  recorded_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','delivered','suppressed','dead')),
  due_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL,
  last_error text CHECK (last_error IS NULL OR last_error ~ '^[a-z0-9 .:_-]{1,120}$'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (account_id, channel, ledger_seq)
);
CREATE INDEX delivery_queue ON dge_notifications.deliveries(next_attempt_at) WHERE status = 'pending';
CREATE INDEX delivery_account ON dge_notifications.deliveries(account_id, channel, status);

CREATE TABLE dge_notifications.inbox (
  position bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  account_id uuid NOT NULL REFERENCES dge_identity.accounts(id),
  kind text NOT NULL CHECK (kind IN ('event','digest')),
  cadence text NOT NULL CHECK (cadence IN ('immediate','daily','weekly')),
  items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL,
  read_at timestamptz
);
CREATE INDEX inbox_account ON dge_notifications.inbox(account_id, position DESC);
CREATE INDEX inbox_unread ON dge_notifications.inbox(account_id) WHERE read_at IS NULL;

DO $$ DECLARE target text; BEGIN
  FOREACH target IN ARRAY ARRAY['preferences','email_addresses','subscriptions','worker_cursor','deliveries','inbox'] LOOP
    EXECUTE format('ALTER TABLE dge_notifications.%I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE dge_notifications.%I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('CREATE POLICY worker_all ON dge_notifications.%I TO dge_identity_runtime USING (current_setting(''dge.worker'',true)=''notifications'') WITH CHECK (current_setting(''dge.worker'',true)=''notifications'')', target);
  END LOOP;
  FOREACH target IN ARRAY ARRAY['preferences','email_addresses','subscriptions','inbox'] LOOP
    EXECUTE format('CREATE POLICY account_read ON dge_notifications.%I FOR SELECT TO dge_identity_runtime USING (account_id::text=current_setting(''dge.account_id'',true))', target);
  END LOOP;
  FOREACH target IN ARRAY ARRAY['preferences','email_addresses','subscriptions'] LOOP
    EXECUTE format('CREATE POLICY account_insert ON dge_notifications.%I FOR INSERT TO dge_identity_runtime WITH CHECK (account_id::text=current_setting(''dge.account_id'',true))', target);
    EXECUTE format('CREATE POLICY account_delete ON dge_notifications.%I FOR DELETE TO dge_identity_runtime USING (account_id::text=current_setting(''dge.account_id'',true))', target);
  END LOOP;
  FOREACH target IN ARRAY ARRAY['preferences','email_addresses','inbox'] LOOP
    EXECUTE format('CREATE POLICY account_update ON dge_notifications.%I FOR UPDATE TO dge_identity_runtime USING (account_id::text=current_setting(''dge.account_id'',true)) WITH CHECK (account_id::text=current_setting(''dge.account_id'',true))', target);
  END LOOP;
END $$;

GRANT SELECT, INSERT, DELETE ON dge_notifications.subscriptions TO dge_identity_runtime;
GRANT SELECT, INSERT, DELETE ON dge_notifications.preferences TO dge_identity_runtime;
GRANT UPDATE (in_app, email, locale, updated_at) ON dge_notifications.preferences TO dge_identity_runtime;
GRANT SELECT, INSERT, DELETE ON dge_notifications.email_addresses TO dge_identity_runtime;
GRANT UPDATE (address, verified_at, verification_sent_at, updated_at) ON dge_notifications.email_addresses TO dge_identity_runtime;
GRANT SELECT, INSERT ON dge_notifications.inbox TO dge_identity_runtime;
GRANT UPDATE (read_at) ON dge_notifications.inbox TO dge_identity_runtime;
GRANT SELECT, INSERT ON dge_notifications.deliveries TO dge_identity_runtime;
GRANT UPDATE (status, attempts, next_attempt_at, last_error, updated_at) ON dge_notifications.deliveries TO dge_identity_runtime;
GRANT SELECT ON dge_notifications.worker_cursor TO dge_identity_runtime;
GRANT UPDATE (ledger_seq, updated_at) ON dge_notifications.worker_cursor TO dge_identity_runtime;

-- The cursor only moves forward, so a stale worker cannot replay old fan-out.
CREATE FUNCTION dge_notifications.guard_cursor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.ledger_seq < OLD.ledger_seq THEN RAISE EXCEPTION 'Notification cursor cannot move backwards'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_cursor BEFORE UPDATE ON dge_notifications.worker_cursor
  FOR EACH ROW EXECUTE FUNCTION dge_notifications.guard_cursor();
