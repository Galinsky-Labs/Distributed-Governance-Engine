-- DCE-020/021/022: instance-wide append-only transparency log, signed
-- checkpoints, witness cosignatures and a durable anchor queue.
-- The log stores digests and commitments only: never document text, ballots,
-- signature marks, identities or keys. Sequencing is done by a worker that
-- declares its purpose in the transaction (dge.worker); request handlers stay
-- tenant-scoped and can only append to their own outbox rows.
CREATE SCHEMA dge_ledger;
REVOKE ALL ON SCHEMA dge_ledger FROM PUBLIC;
GRANT USAGE ON SCHEMA dge_ledger TO dge_identity_runtime;

CREATE TABLE dge_ledger.head (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  size bigint NOT NULL CHECK (size >= 0)
);
INSERT INTO dge_ledger.head(id,size) VALUES (true,0);

CREATE TABLE dge_ledger.entries (
  seq bigint PRIMARY KEY CHECK (seq >= 0),
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9-]{1,40}$'),
  scope text NOT NULL CHECK (scope IN ('public','blinded')),
  tenant_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  event_digest char(64) NOT NULL CHECK (event_digest ~ '^[a-f0-9]{64}$'),
  leaf_hash char(64) NOT NULL CHECK (leaf_hash ~ '^[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL,
  UNIQUE (kind,event_digest)
);
CREATE INDEX ledger_entries_subject ON dge_ledger.entries(subject_id,seq);
CREATE INDEX ledger_entries_digest ON dge_ledger.entries(event_digest);

-- Hashes of complete (perfect) subtrees only; partial ranges are derived.
CREATE TABLE dge_ledger.nodes (
  level smallint NOT NULL CHECK (level BETWEEN 0 AND 62),
  idx bigint NOT NULL CHECK (idx >= 0),
  hash char(64) NOT NULL CHECK (hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (level,idx)
);

CREATE TABLE dge_ledger.checkpoints (
  size bigint PRIMARY KEY CHECK (size >= 0),
  root_hash char(64) NOT NULL CHECK (root_hash ~ '^[a-f0-9]{64}$'),
  issued_at timestamptz NOT NULL,
  key_id char(64) NOT NULL,
  body jsonb NOT NULL,
  signature text NOT NULL,
  checkpoint_digest char(64) NOT NULL UNIQUE
);

CREATE TABLE dge_ledger.witness_keys (
  key_id char(64) PRIMARY KEY CHECK (key_id ~ '^[a-f0-9]{64}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  public_key text NOT NULL CHECK (char_length(public_key) BETWEEN 40 AND 64),
  added_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE TABLE dge_ledger.witness_signatures (
  size bigint NOT NULL REFERENCES dge_ledger.checkpoints(size),
  key_id char(64) NOT NULL REFERENCES dge_ledger.witness_keys(key_id),
  signature text NOT NULL,
  received_at timestamptz NOT NULL,
  PRIMARY KEY (size,key_id)
);

CREATE TABLE dge_ledger.anchors (
  id uuid PRIMARY KEY,
  size bigint NOT NULL REFERENCES dge_ledger.checkpoints(size),
  checkpoint_digest char(64) NOT NULL,
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9-]{1,60}$'),
  network text NOT NULL CHECK (char_length(network) BETWEEN 1 AND 60),
  reason text NOT NULL CHECK (reason IN ('periodic','finalization','manual')),
  status text NOT NULL CHECK (status IN ('pending','submitted','confirmed','final','failed')),
  proof text,
  block_height bigint,
  block_hash char(64),
  confirmations integer,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL,
  last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 120),
  cost_units bigint NOT NULL DEFAULT 0 CHECK (cost_units >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (size,provider),
  CHECK (status IN ('pending','failed') OR proof IS NOT NULL),
  CHECK (status NOT IN ('confirmed','final') OR (block_height IS NOT NULL AND block_hash IS NOT NULL))
);
CREATE INDEX ledger_anchor_queue ON dge_ledger.anchors(status,next_attempt_at);

-- Generic transactional outbox for stores added after the first four.
CREATE TABLE dge_ledger.outbox (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES dge_identity.tenants(id),
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9-]{1,40}$'),
  scope text NOT NULL CHECK (scope IN ('public','blinded')),
  subject_id uuid NOT NULL,
  event_digest char(64) NOT NULL CHECK (event_digest ~ '^[a-f0-9]{64}$'),
  finalization boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  ledger_seq bigint,
  UNIQUE (kind,event_digest)
);
CREATE INDEX ledger_outbox_pending ON dge_ledger.outbox(created_at) WHERE ledger_seq IS NULL;

ALTER TABLE dge_documents.anchor_outbox ADD COLUMN ledger_seq bigint;
ALTER TABLE dge_proposals.anchor_outbox ADD COLUMN ledger_seq bigint;
ALTER TABLE dge_discussion.anchor_outbox ADD COLUMN ledger_seq bigint;
ALTER TABLE dge_decisions.anchor_outbox ADD COLUMN ledger_seq bigint;
CREATE INDEX document_outbox_pending ON dge_documents.anchor_outbox(created_at) WHERE ledger_seq IS NULL;
CREATE INDEX proposal_outbox_pending ON dge_proposals.anchor_outbox(created_at) WHERE ledger_seq IS NULL;
CREATE INDEX discussion_outbox_pending ON dge_discussion.anchor_outbox(created_at) WHERE ledger_seq IS NULL;
CREATE INDEX decision_outbox_pending ON dge_decisions.anchor_outbox(created_at) WHERE ledger_seq IS NULL;

DO $$ DECLARE target text; BEGIN
  FOREACH target IN ARRAY ARRAY['head','entries','nodes','checkpoints','witness_keys','witness_signatures','anchors'] LOOP
    EXECUTE format('ALTER TABLE dge_ledger.%I ENABLE ROW LEVEL SECURITY',target);
    EXECUTE format('ALTER TABLE dge_ledger.%I FORCE ROW LEVEL SECURITY',target);
    EXECUTE format('CREATE POLICY public_read ON dge_ledger.%I FOR SELECT TO dge_identity_runtime USING (true)',target);
    EXECUTE format('CREATE POLICY worker_insert ON dge_ledger.%I FOR INSERT TO dge_identity_runtime WITH CHECK (current_setting(''dge.worker'',true)=''ledger'')',target);
    EXECUTE format('CREATE POLICY worker_update ON dge_ledger.%I FOR UPDATE TO dge_identity_runtime USING (current_setting(''dge.worker'',true)=''ledger'') WITH CHECK (current_setting(''dge.worker'',true)=''ledger'')',target);
  END LOOP;
  FOREACH target IN ARRAY ARRAY['dge_documents','dge_proposals','dge_discussion','dge_decisions'] LOOP
    EXECUTE format('CREATE POLICY ledger_worker_read ON %I.anchor_outbox FOR SELECT TO dge_identity_runtime USING (current_setting(''dge.worker'',true)=''ledger'')',target);
    EXECUTE format('CREATE POLICY ledger_worker_mark ON %I.anchor_outbox FOR UPDATE TO dge_identity_runtime USING (current_setting(''dge.worker'',true)=''ledger'' AND ledger_seq IS NULL) WITH CHECK (current_setting(''dge.worker'',true)=''ledger'')',target);
    EXECUTE format('GRANT UPDATE (ledger_seq) ON %I.anchor_outbox TO dge_identity_runtime',target);
  END LOOP;
END $$;
ALTER TABLE dge_ledger.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE dge_ledger.outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON dge_ledger.outbox FOR SELECT TO dge_identity_runtime
  USING (tenant_id::text=current_setting('dge.tenant_id',true));
CREATE POLICY tenant_append ON dge_ledger.outbox FOR INSERT TO dge_identity_runtime
  WITH CHECK (tenant_id::text=current_setting('dge.tenant_id',true) AND ledger_seq IS NULL);
CREATE POLICY ledger_worker_read ON dge_ledger.outbox FOR SELECT TO dge_identity_runtime
  USING (current_setting('dge.worker',true)='ledger');
CREATE POLICY ledger_worker_mark ON dge_ledger.outbox FOR UPDATE TO dge_identity_runtime
  USING (current_setting('dge.worker',true)='ledger' AND ledger_seq IS NULL)
  WITH CHECK (current_setting('dge.worker',true)='ledger');

GRANT SELECT ON ALL TABLES IN SCHEMA dge_ledger TO dge_identity_runtime;
GRANT INSERT ON dge_ledger.entries,dge_ledger.nodes,dge_ledger.checkpoints,dge_ledger.witness_keys,
  dge_ledger.witness_signatures,dge_ledger.anchors,dge_ledger.outbox TO dge_identity_runtime;
GRANT UPDATE (size) ON dge_ledger.head TO dge_identity_runtime;
GRANT UPDATE (revoked_at) ON dge_ledger.witness_keys TO dge_identity_runtime;
GRANT UPDATE (status,proof,block_height,block_hash,confirmations,attempts,next_attempt_at,last_error,cost_units,updated_at)
  ON dge_ledger.anchors TO dge_identity_runtime;
GRANT UPDATE (ledger_seq) ON dge_ledger.outbox TO dge_identity_runtime;

-- Entries, nodes and checkpoints are append-only even for the worker.
CREATE FUNCTION dge_ledger.reject_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Transparency log records are append-only';
END $$;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON dge_ledger.entries
  FOR EACH ROW EXECUTE FUNCTION dge_ledger.reject_change();
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON dge_ledger.nodes
  FOR EACH ROW EXECUTE FUNCTION dge_ledger.reject_change();
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON dge_ledger.checkpoints
  FOR EACH ROW EXECUTE FUNCTION dge_ledger.reject_change();
CREATE FUNCTION dge_ledger.guard_head() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.size < OLD.size THEN RAISE EXCEPTION 'Transparency log cannot shrink'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_head BEFORE UPDATE ON dge_ledger.head
  FOR EACH ROW EXECUTE FUNCTION dge_ledger.guard_head();
