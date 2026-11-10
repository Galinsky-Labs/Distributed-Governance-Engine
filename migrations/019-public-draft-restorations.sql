-- Restoration appends a new public working revision; it never rewrites history.
CREATE TABLE dge_documents.restorations (
 tenant_id uuid NOT NULL,
 document_id uuid NOT NULL,
 version integer NOT NULL,
 source_version integer NOT NULL,
 source_digest char(64) NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(tenant_id,document_id,version),
 FOREIGN KEY(tenant_id,document_id,version)
  REFERENCES dge_documents.versions(tenant_id,document_id,version),
 FOREIGN KEY(tenant_id,document_id,source_version)
  REFERENCES dge_documents.versions(tenant_id,document_id,version),
 CHECK(source_version>=1 AND source_version<version)
);
ALTER TABLE dge_documents.restorations ENABLE ROW LEVEL SECURITY;
ALTER TABLE dge_documents.restorations FORCE ROW LEVEL SECURITY;
CREATE POLICY restoration_tenant_read ON dge_documents.restorations
 FOR SELECT TO dge_identity_runtime
 USING(tenant_id::text=current_setting('dge.tenant_id',true));
CREATE POLICY restoration_public_read ON dge_documents.restorations
 FOR SELECT TO dge_identity_runtime
 USING(document_id::text=current_setting('dge.public_document_id',true));
CREATE POLICY restoration_tenant_append ON dge_documents.restorations
 FOR INSERT TO dge_identity_runtime
 WITH CHECK(tenant_id::text=current_setting('dge.tenant_id',true));
GRANT SELECT,INSERT ON dge_documents.restorations TO dge_identity_runtime;
REVOKE UPDATE,DELETE,TRUNCATE ON dge_documents.restorations FROM dge_identity_runtime;
