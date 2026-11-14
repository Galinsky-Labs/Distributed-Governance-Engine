-- DCE-011/012/013/014: frozen electorate rosters, record-date snapshots,
-- proxies, weighted ballots, proposal bundles, challenges and finality.
-- Roster entries hold voting units and an opaque evidence reference. A
-- person-uniqueness key is stored only as a salted keyed digest; raw
-- eligibility evidence never reaches the database.
CREATE SCHEMA dge_electorates;
REVOKE ALL ON SCHEMA dge_electorates FROM PUBLIC;
GRANT USAGE ON SCHEMA dge_electorates TO dge_identity_runtime;

CREATE TABLE dge_electorates.rosters (
  tenant_id uuid NOT NULL REFERENCES dge_identity.tenants(id),
  id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('membership-derived','unit-register','verified-person-cohort')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  person_key_salt char(64) NOT NULL CHECK (person_key_salt ~ '^[a-f0-9]{64}$'),
  created_by uuid NOT NULL REFERENCES dge_identity.accounts(id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id)
);
-- Append-only versions keyed by principal and class. The latest version
-- recorded at or before a record date is the one a snapshot considers.
CREATE TABLE dge_electorates.roster_entries (
  tenant_id uuid NOT NULL,
  roster_id uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES dge_identity.accounts(id),
  class text NOT NULL CHECK (class ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  version integer NOT NULL CHECK (version BETWEEN 1 AND 1000),
  units numeric(78,0) NOT NULL CHECK (units >= 0),
  person_key_digest char(64) CHECK (person_key_digest ~ '^[a-f0-9]{64}$'),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  evidence_ref text CHECK (evidence_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$'),
  recorded_by uuid NOT NULL REFERENCES dge_identity.accounts(id),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,roster_id,principal_id,class,version),
  FOREIGN KEY (tenant_id,roster_id) REFERENCES dge_electorates.rosters(tenant_id,id),
  CHECK (valid_to IS NULL OR valid_to>valid_from)
);
CREATE TABLE dge_electorates.snapshots (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  roster_id uuid NOT NULL,
  record_date timestamptz NOT NULL,
  members jsonb NOT NULL,
  summary jsonb NOT NULL,
  snapshot_digest char(64) NOT NULL CHECK (snapshot_digest ~ '^[a-f0-9]{64}$'),
  created_by uuid NOT NULL REFERENCES dge_identity.accounts(id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,roster_id,record_date),
  FOREIGN KEY (tenant_id,roster_id) REFERENCES dge_electorates.rosters(tenant_id,id),
  CHECK (record_date<created_at)
);
CREATE TABLE dge_electorates.events (
  tenant_id uuid NOT NULL REFERENCES dge_identity.tenants(id),
  id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES dge_identity.accounts(id),
  kind text NOT NULL CHECK (kind IN ('roster-created','entry-recorded','membership-synced',
    'snapshot-created','proxy-granted','proxy-revoked')),
  command_id uuid NOT NULL,
  request_digest char(64) NOT NULL,
  result jsonb NOT NULL,
  event_digest char(64) NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,actor_id,command_id)
);
CREATE TABLE dge_electorates.proxy_grants (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  grantor_id uuid NOT NULL REFERENCES dge_identity.accounts(id),
  grantee_id uuid NOT NULL REFERENCES dge_identity.accounts(id),
  roster_id uuid,
  decision_id uuid,
  allocation jsonb,
  expires_at timestamptz,
  created_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES dge_identity.accounts(id),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,roster_id) REFERENCES dge_electorates.rosters(tenant_id,id),
  FOREIGN KEY (tenant_id,decision_id) REFERENCES dge_decisions.decisions(tenant_id,id),
  CHECK (grantor_id<>grantee_id),
  CHECK ((roster_id IS NULL)<>(decision_id IS NULL)),
  CHECK (expires_at IS NULL OR expires_at>created_at),
  CHECK ((revoked_at IS NULL)=(revoked_by IS NULL)),
  CHECK (allocation IS NULL OR jsonb_typeof(allocation)='object')
);
CREATE TABLE dge_electorates.proxy_ballots (
  tenant_id uuid NOT NULL,
  decision_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  proxy_id uuid NOT NULL REFERENCES dge_identity.accounts(id),
  principal_id uuid NOT NULL REFERENCES dge_identity.accounts(id),
  choice text NOT NULL CHECK (choice IN ('yes','no','abstain')),
  version integer NOT NULL CHECK (version BETWEEN 1 AND 100),
  allocation jsonb,
  cast_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,decision_id,grant_id),
  FOREIGN KEY (tenant_id,decision_id) REFERENCES dge_decisions.decisions(tenant_id,id),
  FOREIGN KEY (tenant_id,grant_id) REFERENCES dge_electorates.proxy_grants(tenant_id,id),
  CHECK (proxy_id<>principal_id)
);
CREATE TABLE dge_electorates.bundle_members (
  tenant_id uuid NOT NULL,
  decision_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 19),
  document_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  PRIMARY KEY (tenant_id,decision_id,position),
  UNIQUE (tenant_id,decision_id,proposal_id),
  FOREIGN KEY (tenant_id,decision_id) REFERENCES dge_decisions.decisions(tenant_id,id),
  FOREIGN KEY (tenant_id,document_id,proposal_id) REFERENCES dge_proposals.proposals(tenant_id,document_id,id)
);
CREATE TABLE dge_electorates.challenges (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  decision_id uuid NOT NULL,
  challenger_id uuid NOT NULL REFERENCES dge_identity.accounts(id),
  reason_category text NOT NULL CHECK (reason_category IN
    ('eligibility','ballot-irregularity','procedure','conflict-of-interest','other')),
  statement text NOT NULL CHECK (char_length(statement) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL,
  command_id uuid NOT NULL,
  request_digest char(64) NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','dismissed','upheld','moot')),
  resolved_by uuid REFERENCES dge_identity.accounts(id),
  resolved_at timestamptz,
  resolution_note text CHECK (resolution_note IS NULL OR char_length(resolution_note) BETWEEN 1 AND 1000),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,challenger_id,command_id),
  FOREIGN KEY (tenant_id,decision_id) REFERENCES dge_decisions.decisions(tenant_id,id),
  CHECK ((status='pending')=(resolved_at IS NULL) AND (resolved_at IS NULL)=(resolved_by IS NULL))
);
-- Every certificate a decision has carried (provisional, final or void).
CREATE TABLE dge_electorates.certificates (
  tenant_id uuid NOT NULL,
  decision_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 100),
  finality text NOT NULL CHECK (finality IN ('provisional','final','void')),
  certificate jsonb NOT NULL,
  certificate_digest char(64) NOT NULL CHECK (certificate_digest ~ '^[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,decision_id,sequence),
  FOREIGN KEY (tenant_id,decision_id) REFERENCES dge_decisions.decisions(tenant_id,id)
);

-- Existing closed decisions keep a NULL finality, which means final.
ALTER TABLE dge_decisions.decisions
  ADD COLUMN finality text CHECK (finality IN ('provisional','held','final','void')),
  ADD COLUMN challenge_closes_at timestamptz,
  ADD CONSTRAINT decision_finality_closed CHECK (state='closed' OR (finality IS NULL AND challenge_closes_at IS NULL));
-- A void decision frees its proposal for a new decision with a new snapshot.
ALTER TABLE dge_decisions.decisions DROP CONSTRAINT decisions_tenant_id_document_id_proposal_id_key;
CREATE UNIQUE INDEX decisions_active_proposal ON dge_decisions.decisions(tenant_id,document_id,proposal_id)
  WHERE finality IS DISTINCT FROM 'void';
GRANT UPDATE (finality,challenge_closes_at) ON dge_decisions.decisions TO dge_identity_runtime;

CREATE FUNCTION dge_electorates.guard_decision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF OLD.state='closed' AND NEW.state<>'closed' THEN
    RAISE EXCEPTION 'A closed decision cannot reopen';
  END IF;
  IF OLD.state='closed' AND COALESCE(OLD.finality,'final') IN ('final','void') AND
     NEW.finality IS DISTINCT FROM OLD.finality THEN
    RAISE EXCEPTION 'Final and void decisions are immutable';
  END IF;
  -- The request role can never rewrite a final or void certificate. Owner
  -- roles are outside this control; certificate digests detect tampering.
  IF current_user='dge_identity_runtime' AND OLD.state='closed' AND COALESCE(OLD.finality,'final') IN ('final','void') AND
     (NEW.certificate IS DISTINCT FROM OLD.certificate OR NEW.certificate_digest IS DISTINCT FROM OLD.certificate_digest) THEN
    RAISE EXCEPTION 'Final and void decisions are immutable';
  END IF;
  IF NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id OR NEW.snapshot IS DISTINCT FROM OLD.snapshot OR
     NEW.snapshot_digest<>OLD.snapshot_digest OR NEW.proposal_id<>OLD.proposal_id THEN
    RAISE EXCEPTION 'Decision snapshot bindings are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_decision BEFORE UPDATE ON dge_decisions.decisions
  FOR EACH ROW EXECUTE FUNCTION dge_electorates.guard_decision();

CREATE FUNCTION dge_electorates.reject_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Electorate history is append-only';
END $$;
DO $$ DECLARE target text; BEGIN
  FOREACH target IN ARRAY ARRAY['rosters','roster_entries','snapshots','events','bundle_members','certificates'] LOOP
    EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON dge_electorates.%I FOR EACH ROW EXECUTE FUNCTION dge_electorates.reject_change()',target);
  END LOOP;
END $$;
CREATE FUNCTION dge_electorates.guard_grant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR
     (to_jsonb(NEW)-'revoked_at'-'revoked_by')<>(to_jsonb(OLD)-'revoked_at'-'revoked_by') THEN
    RAISE EXCEPTION 'Proxy grants can only be revoked once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_grant BEFORE UPDATE ON dge_electorates.proxy_grants
  FOR EACH ROW EXECUTE FUNCTION dge_electorates.guard_grant();
CREATE TRIGGER no_delete BEFORE DELETE ON dge_electorates.proxy_grants
  FOR EACH ROW EXECUTE FUNCTION dge_electorates.reject_change();
CREATE FUNCTION dge_electorates.guard_challenge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF OLD.status<>'pending' OR NEW.status='pending' OR
     (to_jsonb(NEW)-'status'-'resolved_by'-'resolved_at'-'resolution_note')<>
     (to_jsonb(OLD)-'status'-'resolved_by'-'resolved_at'-'resolution_note') THEN
    RAISE EXCEPTION 'A challenge is resolved exactly once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_challenge BEFORE UPDATE ON dge_electorates.challenges
  FOR EACH ROW EXECUTE FUNCTION dge_electorates.guard_challenge();
CREATE TRIGGER no_delete BEFORE DELETE ON dge_electorates.challenges
  FOR EACH ROW EXECUTE FUNCTION dge_electorates.reject_change();

DO $$ DECLARE target text; BEGIN
  FOREACH target IN ARRAY ARRAY['rosters','roster_entries','snapshots','events','proxy_grants',
    'proxy_ballots','bundle_members','challenges','certificates'] LOOP
    EXECUTE format('ALTER TABLE dge_electorates.%I ENABLE ROW LEVEL SECURITY',target);
    EXECUTE format('ALTER TABLE dge_electorates.%I FORCE ROW LEVEL SECURITY',target);
    EXECUTE format('CREATE POLICY tenant_scope ON dge_electorates.%I TO dge_identity_runtime USING (tenant_id::text=current_setting(''dge.tenant_id'',true)) WITH CHECK (tenant_id::text=current_setting(''dge.tenant_id'',true))',target);
  END LOOP;
END $$;
GRANT SELECT,INSERT ON dge_electorates.rosters,dge_electorates.roster_entries,dge_electorates.snapshots,
  dge_electorates.events,dge_electorates.bundle_members,dge_electorates.certificates TO dge_identity_runtime;
GRANT SELECT,INSERT ON dge_electorates.proxy_grants,dge_electorates.challenges,dge_electorates.proxy_ballots TO dge_identity_runtime;
GRANT UPDATE (revoked_at,revoked_by) ON dge_electorates.proxy_grants TO dge_identity_runtime;
GRANT UPDATE (choice,version,cast_at) ON dge_electorates.proxy_ballots TO dge_identity_runtime;
GRANT UPDATE (status,resolved_by,resolved_at,resolution_note) ON dge_electorates.challenges TO dge_identity_runtime;
CREATE INDEX roster_entries_record_date ON dge_electorates.roster_entries(tenant_id,roster_id,recorded_at);
CREATE INDEX proxy_grants_grantor ON dge_electorates.proxy_grants(tenant_id,grantor_id);
CREATE INDEX proxy_grants_grantee ON dge_electorates.proxy_grants(tenant_id,grantee_id);
CREATE INDEX bundle_members_proposal ON dge_electorates.bundle_members(tenant_id,proposal_id);
CREATE INDEX challenges_decision ON dge_electorates.challenges(tenant_id,decision_id);
