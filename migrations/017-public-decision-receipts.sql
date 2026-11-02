-- Public verification exposes only closed decision certificates.
-- The electorate snapshot and individual ballot ledger remain tenant-private.
CREATE POLICY public_closed_decision_receipt
  ON dge_decisions.decisions FOR SELECT TO dge_identity_runtime
  USING (
    state='closed'
    AND document_id::text=current_setting('dge.public_document_id',true)
  );
