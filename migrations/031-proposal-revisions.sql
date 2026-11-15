-- DCE-009: editing proposed wording publishes a new proposal that names the
-- one it revises. History is linear (each proposal is revised at most once),
-- append-only, and ballots never carry over: the new wording needs a new vote.
CREATE TABLE dge_proposals.revisions (
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  revises uuid NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, document_id, proposal_id),
  UNIQUE (tenant_id, document_id, revises),
  CHECK (proposal_id <> revises),
  FOREIGN KEY (tenant_id, document_id, proposal_id) REFERENCES dge_proposals.proposals(tenant_id, document_id, id),
  FOREIGN KEY (tenant_id, document_id, revises) REFERENCES dge_proposals.proposals(tenant_id, document_id, id)
);
ALTER TABLE dge_proposals.revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE dge_proposals.revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON dge_proposals.revisions TO dge_identity_runtime
  USING (tenant_id::text=current_setting('dge.tenant_id',true)) WITH CHECK (tenant_id::text=current_setting('dge.tenant_id',true));
CREATE POLICY public_revisions ON dge_proposals.revisions FOR SELECT TO dge_identity_runtime
  USING (document_id::text=current_setting('dge.public_document_id',true));
GRANT SELECT, INSERT ON dge_proposals.revisions TO dge_identity_runtime;
