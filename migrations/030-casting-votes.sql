-- DCE-010: one immutable casting vote per tied decision, recorded only by the
-- presiding principal named in the frozen policy snapshot. Tenant-fenced and
-- append-only for the runtime role (no UPDATE or DELETE grant).
CREATE TABLE dge_decisions.casting_votes (
  tenant_id uuid NOT NULL,
  decision_id uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES dge_identity.accounts(id),
  choice text NOT NULL CHECK (choice IN ('yes','no')),
  command_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, decision_id),
  FOREIGN KEY (tenant_id, decision_id) REFERENCES dge_decisions.decisions(tenant_id, id)
);
ALTER TABLE dge_decisions.casting_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE dge_decisions.casting_votes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON dge_decisions.casting_votes TO dge_identity_runtime
  USING (tenant_id::text=current_setting('dge.tenant_id',true)) WITH CHECK (tenant_id::text=current_setting('dge.tenant_id',true));
GRANT SELECT, INSERT ON dge_decisions.casting_votes TO dge_identity_runtime;
