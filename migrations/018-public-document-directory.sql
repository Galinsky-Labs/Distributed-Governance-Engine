-- Only the public document catalog is discoverable. Document and
-- revision contents remain covered by the existing exact-ID public policy.
CREATE POLICY public_document_directory
  ON dge_documents.documents FOR SELECT TO dge_identity_runtime
  USING(
    visibility='public'
    AND current_setting('dge.public_document_directory',true)='enabled'
  );
