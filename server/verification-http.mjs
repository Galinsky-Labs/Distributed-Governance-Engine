import { HttpError } from "./account-http.mjs";
import { DocumentError } from "./document-store.mjs";
import { VERIFICATION_PACKAGE_SCHEMA } from "../src/verification-package.mjs";

export const verificationBodyLimit = () => 4096;
const route = /^\/api\/public\/documents\/([a-f0-9-]{36})\/verification-package$/;

/** Assembles an offline verification package for one public document version. */
export function createVerificationRoutes({ transaction, ledger, decisions, clock = Date.now }) {
  return async ({ url, method }) => {
    const match = url.pathname.match(route);
    if (!match) return null;
    method(["GET"]);
    for (const key of url.searchParams.keys()) if (key !== "version") throw new HttpError(400, "INVALID_QUERY");
    const documentId = match[1];
    const requested = url.searchParams.has("version") ? Number(url.searchParams.get("version")) : null;
    if (requested !== null && !(Number.isSafeInteger(requested) && requested >= 1)) throw new HttpError(400, "INVALID_QUERY");
    try {
      const { edition, closed } = await transaction(async (db) => {
        await db.query("SELECT set_config('dge.public_document_id',$1,true)", [documentId]);
        const row = (await db.query(
          `SELECT v.*, r.source_version, r.source_digest FROM dge_documents.versions v
           LEFT JOIN dge_documents.restorations r ON r.tenant_id=v.tenant_id AND r.document_id=v.document_id AND r.version=v.version
           WHERE v.document_id=$1 AND v.version=COALESCE($2::int,(SELECT version FROM dge_documents.documents WHERE id=$1))`,
          [documentId, requested])).rows[0];
        if (!row) throw new DocumentError("DOCUMENT_NOT_FOUND", 404);
        const closed = (await db.query("SELECT proposal_id FROM dge_decisions.decisions WHERE document_id=$1 AND state='closed' ORDER BY closed_at LIMIT 50", [documentId])).rows;
        return {
          closed,
          edition: {
            documentId, tenantId: row.tenant_id, version: row.version, digest: row.digest.trim(),
            previousDigest: row.previous_digest?.trim() ?? null, createdAt: new Date(row.created_at).toISOString(),
            eventDigest: row.event_digest.trim(), document: row.document,
            ...(row.source_version ? { restoration: { sourceVersion: row.source_version, sourceDigest: row.source_digest.trim() } } : {}),
          },
        };
      });
      const proof = ledger ? await ledger.proof({ eventDigest: edition.eventDigest, kind: "document-version" }) : { status: "ledger-unavailable" };
      const receipts = [];
      for (const { proposal_id } of closed) receipts.push(await decisions.publicReceipt(documentId, proposal_id));
      const body = {
        schema: VERIFICATION_PACKAGE_SCHEMA, generatedAt: new Date(clock()).toISOString(),
        edition, ledger: proof, decisions: receipts,
        instructions: "Verify offline with `node scripts/quill-verify.mjs <file>` or the /verify page. Recomputes content, log inclusion, checkpoint signature, witnesses and Bitcoin anchors.",
      };
      return new Response(JSON.stringify(body), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="quill-verification-${documentId}-v${edition.version}.json"`,
        },
      });
    } catch (cause) {
      if (cause instanceof DocumentError) throw new HttpError(cause.status, cause.code);
      throw cause;
    }
  };
}
