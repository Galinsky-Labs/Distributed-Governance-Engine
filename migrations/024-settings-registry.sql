-- DCE-028: versioned, append-only settings layers. Values are validated by
-- src/settings-registry.mjs in server/settings-store.mjs; the database keeps
-- tenant layers tenant-fenced and lets only listed platform administrators
-- append platform/product layers. Platform administrators are managed only
-- with the migration credential (scripts/grant-platform-admin.mjs).
CREATE SCHEMA dge_settings;
REVOKE ALL ON SCHEMA dge_settings FROM PUBLIC;
GRANT USAGE ON SCHEMA dge_settings TO dge_identity_runtime;

CREATE TABLE dge_settings.platform_admins (
  account_id uuid PRIMARY KEY REFERENCES dge_identity.accounts(id),
  granted_at timestamptz NOT NULL,
  granted_reason text NOT NULL CHECK (length(granted_reason) BETWEEN 1 AND 500),
  revoked_at timestamptz,
  revoked_reason text CHECK (revoked_reason IS NULL OR length(revoked_reason) BETWEEN 1 AND 500),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE TABLE dge_settings.platform_admin_events (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES dge_identity.accounts(id),
  kind text NOT NULL CHECK (kind IN ('granted','revoked')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  occurred_at timestamptz NOT NULL
);

CREATE TABLE dge_settings.versions (
  target text NOT NULL CHECK (target ~ '^(platform|product:(civic|charter)|tenant:[0-9a-f-]{36}|document:[0-9a-f-]{36}:[0-9a-f-]{36})$'),
  version integer NOT NULL CHECK (version BETWEEN 1 AND 1000000),
  scope text NOT NULL CHECK (scope IN ('platform','product','tenant','document')),
  product text CHECK (product IN ('civic','charter')),
  tenant_id uuid REFERENCES dge_identity.tenants(id),
  document_id uuid,
  overrides jsonb NOT NULL CHECK (jsonb_typeof(overrides)='object'),
  changes jsonb NOT NULL CHECK (jsonb_typeof(changes)='object'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  rollback_of integer CHECK (rollback_of IS NULL OR rollback_of BETWEEN 1 AND 1000000),
  actor_id uuid NOT NULL REFERENCES dge_identity.accounts(id),
  created_at timestamptz NOT NULL,
  digest char(64) NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  previous_digest char(64) CHECK (previous_digest ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (target,version),
  FOREIGN KEY (tenant_id,document_id) REFERENCES dge_documents.documents(tenant_id,id),
  CHECK ((version=1) = (previous_digest IS NULL)),
  CHECK (rollback_of IS NULL OR rollback_of<version),
  CHECK ((scope='platform' AND target='platform' AND product IS NULL AND tenant_id IS NULL AND document_id IS NULL) OR
         (scope='product' AND target='product:'||product AND tenant_id IS NULL AND document_id IS NULL) OR
         (scope='tenant' AND target='tenant:'||tenant_id AND product IS NULL AND document_id IS NULL) OR
         (scope='document' AND target='document:'||tenant_id||':'||document_id AND product IS NULL))
);
CREATE INDEX settings_tenant_versions ON dge_settings.versions(tenant_id) WHERE tenant_id IS NOT NULL;

-- Versions, administrator events and the administrator list never change in
-- place through the request role; history is append-only.
CREATE FUNCTION dge_settings.reject_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Append-only settings history';
END $$;
CREATE TRIGGER versions_append_only BEFORE UPDATE OR DELETE ON dge_settings.versions
  FOR EACH ROW EXECUTE FUNCTION dge_settings.reject_rewrite();
CREATE TRIGGER admin_events_append_only BEFORE UPDATE OR DELETE ON dge_settings.platform_admin_events
  FOR EACH ROW EXECUTE FUNCTION dge_settings.reject_rewrite();

DO $$ DECLARE target text; BEGIN
  FOREACH target IN ARRAY ARRAY['platform_admins','platform_admin_events','versions'] LOOP
    EXECUTE format('ALTER TABLE dge_settings.%I ENABLE ROW LEVEL SECURITY',target);
    EXECUTE format('ALTER TABLE dge_settings.%I FORCE ROW LEVEL SECURITY',target);
    -- The migration owner (the credential running this file) manages platform
    -- administrators; ordinary requests use dge_identity_runtime.
    EXECUTE format('CREATE POLICY owner_manage ON dge_settings.%I TO %I USING (true) WITH CHECK (true)',target,current_user);
  END LOOP;
END $$;
-- A request can only learn whether its own account is a platform administrator.
CREATE POLICY self_read ON dge_settings.platform_admins FOR SELECT TO dge_identity_runtime
  USING (account_id::text=current_setting('dge.account_id',true));
CREATE POLICY read_scope ON dge_settings.versions FOR SELECT TO dge_identity_runtime
  USING (tenant_id IS NULL OR tenant_id::text=current_setting('dge.tenant_id',true));
CREATE POLICY tenant_append ON dge_settings.versions FOR INSERT TO dge_identity_runtime
  WITH CHECK (scope IN ('tenant','document') AND tenant_id::text=current_setting('dge.tenant_id',true)
    AND actor_id::text=current_setting('dge.account_id',true));
CREATE POLICY platform_append ON dge_settings.versions FOR INSERT TO dge_identity_runtime
  WITH CHECK (scope IN ('platform','product') AND tenant_id IS NULL AND actor_id::text=current_setting('dge.account_id',true)
    AND EXISTS (SELECT 1 FROM dge_settings.platform_admins a WHERE a.account_id=actor_id AND a.revoked_at IS NULL));
GRANT SELECT ON dge_settings.platform_admins TO dge_identity_runtime;
GRANT SELECT,INSERT ON dge_settings.versions TO dge_identity_runtime;

-- Simulation of a platform/product change reports deployment-wide counts only.
-- The function runs as the migration owner, which receives read-only policies
-- for exactly these tables; callers receive three numbers and nothing else.
DO $$ BEGIN
  EXECUTE format('CREATE POLICY settings_impact_owner ON dge_identity.tenants FOR SELECT TO %I USING (true)',current_user);
  EXECUTE format('CREATE POLICY settings_impact_owner ON dge_documents.documents FOR SELECT TO %I USING (true)',current_user);
  EXECUTE format('CREATE POLICY settings_impact_owner ON dge_decisions.decisions FOR SELECT TO %I USING (true)',current_user);
END $$;
CREATE FUNCTION dge_settings.platform_impact() RETURNS TABLE(tenants bigint,documents bigint,open_decisions bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT (SELECT count(*) FROM dge_identity.tenants),(SELECT count(*) FROM dge_documents.documents),
         (SELECT count(*) FROM dge_decisions.decisions WHERE state='open')
  WHERE EXISTS (SELECT 1 FROM dge_settings.platform_admins
    WHERE account_id::text=current_setting('dge.account_id',true) AND revoked_at IS NULL)
$$;
REVOKE ALL ON FUNCTION dge_settings.platform_impact() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dge_settings.platform_impact() TO dge_identity_runtime;
