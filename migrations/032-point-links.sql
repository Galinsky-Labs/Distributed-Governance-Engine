-- DCE-015: a published point is never edited in place. A revision by its
-- author, or a moderator's duplicate merge, links the old point to the point
-- that now carries the thesis. Links are append-only; ratings stay with the
-- point they were cast on and never transfer.
CREATE TABLE dge_discussion.point_links (
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  point_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('revision','duplicate')),
  target_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES dge_identity.accounts(id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, document_id, proposal_id, point_id),
  CHECK (point_id <> target_id),
  FOREIGN KEY (tenant_id, document_id, proposal_id, point_id) REFERENCES dge_discussion.points(tenant_id, document_id, proposal_id, id),
  FOREIGN KEY (tenant_id, document_id, proposal_id, target_id) REFERENCES dge_discussion.points(tenant_id, document_id, proposal_id, id)
);
ALTER TABLE dge_discussion.point_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE dge_discussion.point_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON dge_discussion.point_links TO dge_identity_runtime
  USING (tenant_id::text=current_setting('dge.tenant_id',true)) WITH CHECK (tenant_id::text=current_setting('dge.tenant_id',true));
CREATE POLICY public_read ON dge_discussion.point_links FOR SELECT TO dge_identity_runtime
  USING (document_id::text=current_setting('dge.public_document_id',true));
GRANT SELECT, INSERT ON dge_discussion.point_links TO dge_identity_runtime;
