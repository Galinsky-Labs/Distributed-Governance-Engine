-- DCE-034: indexes for public reads that arrive without a tenant context.
-- Each existing index leads with tenant_id, so these lookups previously
-- scanned every tenant's rows.
CREATE INDEX public_version_lookup ON dge_documents.versions(document_id,version);
CREATE INDEX public_proposal_directory ON dge_proposals.proposals(document_id,id);
CREATE INDEX public_point_lookup ON dge_discussion.points(document_id,proposal_id,parent_id);
CREATE INDEX public_decision_receipt_lookup ON dge_decisions.decisions(document_id,proposal_id);
-- Exact prefix of the ballots primary key; it only cost write time and space.
DROP INDEX dge_decisions.dge_decision_ballots_lookup;

-- DCE-037: federation and delayed-network protocol.
-- Instance-level records (peers, queues, mirrored snapshots, evidence) are
-- reachable only in transactions that declare dge.worker='federation'.
-- Records hold signed protocol objects, digests and voter key ids, never
-- document plaintext of private workspaces or member identities in public
-- form. Decided envelopes, evidence and observed checkpoints are append-only.
CREATE SCHEMA dge_federation;
REVOKE ALL ON SCHEMA dge_federation FROM PUBLIC;
GRANT USAGE ON SCHEMA dge_federation TO dge_identity_runtime;

CREATE TABLE dge_federation.peers (
  instance_id text PRIMARY KEY CHECK (instance_id ~ '^[a-z0-9][a-z0-9.-]{2,80}$'),
  record jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  checkpoint_sent bigint NOT NULL DEFAULT 0 CHECK (checkpoint_sent >= 0),
  registered_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
-- One authority per document. local=true: this instance orders it.
CREATE TABLE dge_federation.authorities (
  document_id uuid PRIMARY KEY,
  tenant_id uuid,
  authority text NOT NULL,
  local boolean NOT NULL,
  claim jsonb NOT NULL,
  accepted_at timestamptz NOT NULL,
  CHECK (local = (tenant_id IS NOT NULL))
);
CREATE TABLE dge_federation.replicas (
  document_id uuid NOT NULL REFERENCES dge_federation.authorities(document_id),
  peer text NOT NULL REFERENCES dge_federation.peers(instance_id),
  snapshot_sequence bigint NOT NULL DEFAULT 0,
  snapshot_digest char(64),
  PRIMARY KEY (document_id,peer)
);
CREATE TABLE dge_federation.decisions (
  decision_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL REFERENCES dge_federation.authorities(document_id),
  proposal_id uuid NOT NULL,
  descriptor jsonb NOT NULL,
  descriptor_digest char(64) NOT NULL UNIQUE,
  cutoff_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id,document_id,proposal_id),
  FOREIGN KEY (tenant_id,decision_id) REFERENCES dge_decisions.decisions(tenant_id,id)
);
CREATE TABLE dge_federation.key_bindings (
  decision_id uuid NOT NULL REFERENCES dge_federation.decisions(decision_id),
  voter_key_id char(64) NOT NULL,
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES dge_identity.accounts(id),
  generation integer NOT NULL CHECK (generation BETWEEN 1 AND 100),
  binding jsonb NOT NULL,
  active boolean NOT NULL,
  bound_at timestamptz NOT NULL,
  PRIMARY KEY (decision_id,voter_key_id)
);
CREATE UNIQUE INDEX federation_active_binding ON dge_federation.key_bindings(decision_id,account_id) WHERE active;
-- Every envelope the authority decided, with its signed receipt.
CREATE TABLE dge_federation.envelopes (
  envelope_id char(64) PRIMARY KEY,
  decision_id uuid NOT NULL REFERENCES dge_federation.decisions(decision_id),
  voter_key_id char(64) NOT NULL,
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 100),
  status text NOT NULL CHECK (status IN ('accepted','rejected')),
  reason text,
  via text,
  envelope jsonb NOT NULL,
  receipt jsonb NOT NULL,
  received_at timestamptz NOT NULL
);
CREATE INDEX federation_voter_envelopes ON dge_federation.envelopes(decision_id,voter_key_id);
CREATE UNIQUE INDEX federation_accepted_sequence ON dge_federation.envelopes(decision_id,voter_key_id,sequence) WHERE status='accepted';
-- Mirror side: envelopes relayed to an authority and the receipts that came back.
CREATE TABLE dge_federation.relays (
  envelope_id char(64) PRIMARY KEY,
  authority text NOT NULL,
  decision_id uuid NOT NULL,
  relayed_at timestamptz NOT NULL,
  receipt jsonb,
  audited text CHECK (audited IN ('included','omitted'))
);
-- Durable store-and-forward queue. Sequence orders one (recipient, document) channel.
CREATE TABLE dge_federation.outbox (
  id char(64) PRIMARY KEY,
  recipient text NOT NULL REFERENCES dge_federation.peers(instance_id),
  document_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence >= 1),
  message jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  delivered_at timestamptz,
  last_error text,
  UNIQUE (recipient,document_id,sequence)
);
CREATE INDEX federation_outbox_due ON dge_federation.outbox(next_attempt_at) WHERE delivered_at IS NULL;
CREATE TABLE dge_federation.inbox (
  id char(64) PRIMARY KEY,
  sender text NOT NULL,
  document_id uuid NOT NULL,
  sequence bigint NOT NULL,
  message jsonb NOT NULL,
  received_at timestamptz NOT NULL,
  applied_at timestamptz,
  outcome text,
  UNIQUE (sender,document_id,sequence)
);
CREATE TABLE dge_federation.channels (
  sender text NOT NULL,
  document_id uuid NOT NULL,
  applied_through bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (sender,document_id)
);
CREATE INDEX federation_inbox_pending ON dge_federation.inbox(sender,document_id,sequence) WHERE applied_at IS NULL;
CREATE TABLE dge_federation.mirror_documents (
  document_id uuid PRIMARY KEY REFERENCES dge_federation.authorities(document_id),
  authority text NOT NULL,
  sequence bigint NOT NULL,
  bundle jsonb NOT NULL,
  verified_at timestamptz NOT NULL
);
CREATE TABLE dge_federation.checkpoints (
  instance_id text NOT NULL,
  size bigint NOT NULL CHECK (size >= 0),
  root_hash char(64) NOT NULL,
  checkpoint jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (instance_id,size)
);
CREATE TABLE dge_federation.evidence (
  id uuid PRIMARY KEY,
  peer text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('authority-conflict','split-view','sender-equivocation','omission','conflicting-receipts','invalid-message')),
  document_id uuid,
  details jsonb NOT NULL,
  observed_at timestamptz NOT NULL
);
CREATE TABLE dge_federation.nonces (
  instance_id text NOT NULL,
  nonce char(32) NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (instance_id,nonce)
);

DO $$ DECLARE target text; BEGIN
  FOREACH target IN ARRAY ARRAY['peers','authorities','replicas','decisions','key_bindings','envelopes','relays','outbox','inbox','channels','mirror_documents','checkpoints','evidence','nonces'] LOOP
    EXECUTE format('ALTER TABLE dge_federation.%I ENABLE ROW LEVEL SECURITY',target);
    EXECUTE format('CREATE POLICY federation_worker ON dge_federation.%I TO dge_identity_runtime USING (current_setting(''dge.worker'',true)=''federation'') WITH CHECK (current_setting(''dge.worker'',true)=''federation'')',target);
  END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA dge_federation TO dge_identity_runtime;
GRANT DELETE ON dge_federation.nonces TO dge_identity_runtime;

CREATE FUNCTION dge_federation.reject_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Federation evidence and decided envelopes are append-only';
END $$;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON dge_federation.envelopes
  FOR EACH ROW EXECUTE FUNCTION dge_federation.reject_change();
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON dge_federation.evidence
  FOR EACH ROW EXECUTE FUNCTION dge_federation.reject_change();
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON dge_federation.checkpoints
  FOR EACH ROW EXECUTE FUNCTION dge_federation.reject_change();

-- A federated decision cannot be closed before its disclosed cutoff, whatever
-- path issues the close. SECURITY DEFINER so the check needs no extra grant.
CREATE FUNCTION dge_federation.guard_decision_close() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$ BEGIN
  IF NEW.state='closed' AND OLD.state='open' AND EXISTS (
    SELECT 1 FROM dge_federation.decisions f
    WHERE f.tenant_id=NEW.tenant_id AND f.decision_id=NEW.id AND f.cutoff_at>NEW.closed_at) THEN
    RAISE EXCEPTION 'FEDERATED_CUTOFF_PENDING';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER federated_cutoff BEFORE UPDATE ON dge_decisions.decisions
  FOR EACH ROW EXECUTE FUNCTION dge_federation.guard_decision_close();
-- A mirror never creates a local document under an id another authority owns.
CREATE FUNCTION dge_federation.guard_mirrored_document() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$ BEGIN
  IF EXISTS (SELECT 1 FROM dge_federation.authorities a WHERE a.document_id=NEW.id AND NOT a.local) THEN
    RAISE EXCEPTION 'DOCUMENT_OWNED_BY_REMOTE_AUTHORITY';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER remote_authority BEFORE INSERT ON dge_documents.documents
  FOR EACH ROW EXECUTE FUNCTION dge_federation.guard_mirrored_document();
