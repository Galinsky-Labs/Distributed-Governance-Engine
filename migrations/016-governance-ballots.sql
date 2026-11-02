-- DCE-011/012/013: tenant-fenced, version-bound decisions and durable ballots.
-- Records are internal membership data. Never expose snapshot elector IDs or
-- per-account ballot events through a public endpoint.
CREATE SCHEMA dge_decisions;
REVOKE ALL ON SCHEMA dge_decisions FROM PUBLIC;
GRANT USAGE ON SCHEMA dge_decisions TO dge_identity_runtime;

CREATE TABLE dge_decisions.decisions (
  tenant_id uuid NOT NULL REFERENCES dge_identity.tenants(id),
  id uuid NOT NULL,
  document_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  base_version integer NOT NULL CHECK (base_version BETWEEN 1 AND 1000000),
  snapshot jsonb NOT NULL,
  snapshot_digest char(64) NOT NULL,
  created_by uuid NOT NULL REFERENCES dge_identity.accounts(id),
  created_at timestamptz NOT NULL,
  closes_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed')),
  closed_at timestamptz,
  certificate jsonb,
  certificate_digest char(64),
  command_id uuid NOT NULL,
  request_digest char(64) NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,document_id,proposal_id),
  UNIQUE (tenant_id,command_id),
  FOREIGN KEY (tenant_id,document_id,proposal_id)
    REFERENCES dge_proposals.proposals(tenant_id,document_id,id),
  CHECK ((state='open' AND closed_at IS NULL AND certificate IS NULL AND certificate_digest IS NULL) OR
         (state='closed' AND closed_at IS NOT NULL AND certificate IS NOT NULL AND certificate_digest IS NOT NULL))
);
CREATE TABLE dge_decisions.ballots (
  tenant_id uuid NOT NULL,
  decision_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES dge_identity.accounts(id),
  choice text NOT NULL CHECK (choice IN ('yes','no','abstain')),
  version integer NOT NULL CHECK (version BETWEEN 1 AND 100),
  cast_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,decision_id,account_id),
  FOREIGN KEY (tenant_id,decision_id)
    REFERENCES dge_decisions.decisions(tenant_id,id)
);
CREATE TABLE dge_decisions.events (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  decision_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES dge_identity.accounts(id),
  command_id uuid NOT NULL,
  request_digest char(64) NOT NULL,
  result jsonb NOT NULL,
  event_digest char(64) NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,actor_id,command_id),
  FOREIGN KEY (tenant_id,decision_id)
    REFERENCES dge_decisions.decisions(tenant_id,id)
);
CREATE TABLE dge_decisions.anchor_outbox (
  tenant_id uuid NOT NULL,
  event_id uuid NOT NULL,
  decision_id uuid NOT NULL,
  event_digest char(64) NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,event_id),
  FOREIGN KEY (tenant_id,decision_id)
    REFERENCES dge_decisions.decisions(tenant_id,id)
);
DO $$ DECLARE target text; BEGIN
  FOREACH target IN ARRAY ARRAY['decisions','ballots','events','anchor_outbox'] LOOP
    EXECUTE format('ALTER TABLE dge_decisions.%I ENABLE ROW LEVEL SECURITY',target);
    EXECUTE format('ALTER TABLE dge_decisions.%I FORCE ROW LEVEL SECURITY',target);
    EXECUTE format('CREATE POLICY tenant_scope ON dge_decisions.%I TO dge_identity_runtime USING (tenant_id::text=current_setting(''dge.tenant_id'',true)) WITH CHECK (tenant_id::text=current_setting(''dge.tenant_id'',true))',target);
  END LOOP;
END $$;
GRANT SELECT,INSERT ON dge_decisions.decisions TO dge_identity_runtime;
GRANT UPDATE (state,closed_at,certificate,certificate_digest) ON dge_decisions.decisions TO dge_identity_runtime;
GRANT SELECT,INSERT,UPDATE (choice,version,cast_at) ON dge_decisions.ballots TO dge_identity_runtime;
GRANT SELECT,INSERT ON dge_decisions.events,dge_decisions.anchor_outbox TO dge_identity_runtime;
CREATE INDEX dge_decision_document_lookup ON dge_decisions.decisions(tenant_id,document_id);
CREATE INDEX dge_decision_ballots_lookup ON dge_decisions.ballots(tenant_id,decision_id);
