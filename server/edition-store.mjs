// Immutable final editions (DCE-019): an authorized manager freezes one exact
// saved public version. Editions are append-only copies, so later working-draft
// saves never change them. Each edition record is logged with finalization=true.
import { randomUUID } from "node:crypto";
import { digest } from "../src/integrity.mjs";
import {
  legalDocumentDigest, validateLegalDocument, finalizeLegalDocument, documentIssues,
} from "../src/legal-schema.mjs";
import { EDITION_KINDS, EDITION_LIFECYCLE, EDITION_SCHEMA, editionRecordDigest } from "../src/signatures.mjs";
import { DocumentError } from "./document-store.mjs";
import { appendLedgerEvent } from "./ledger.mjs";

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const HEX = /^[a-f0-9]{64}$/;
const check = (condition, code, status = 400) => { if (!condition) throw new DocumentError(code, status); };
const managers = ["owner", "admin"];
export const EDITION_LEDGER_KIND = "final-edition";

const summary = (row) => ({
  id: row.id, tenantId: row.tenant_id, documentId: row.document_id, sequence: row.sequence,
  kind: row.kind, lifecycle: row.lifecycle, sourceVersion: row.source_version, sourceDigest: row.source_digest,
  editionDigest: row.edition_digest,
  artifact: row.artifact_sha256 ? { sha256: row.artifact_sha256, mediaType: row.artifact_media_type } : null,
  decision: row.decision_id ? { decisionId: row.decision_id, certificateDigest: row.certificate_digest } : null,
  recordDigest: row.record_digest, frozenAt: new Date(row.created_at).toISOString(),
});
/** Re-verifies stored bytes before they are served; corruption fails closed. */
function verified(row, withDocument) {
  const value = summary(row);
  check(editionRecordDigest(row.record) === row.record_digest && row.record.editionId === row.id, "EDITION_INTEGRITY_ERROR", 503);
  if (withDocument) {
    const document = validateLegalDocument(row.document);
    check(legalDocumentDigest(document) === row.edition_digest, "EDITION_INTEGRITY_ERROR", 503);
    value.document = document;
    value.record = row.record;
  }
  return value;
}
async function ledgerStatus(db, eventDigest) {
  const entry = (await db.query("SELECT seq FROM dge_ledger.entries WHERE kind=$1 AND event_digest=$2", [EDITION_LEDGER_KIND, eventDigest])).rows[0];
  return entry ? { kind: EDITION_LEDGER_KIND, eventDigest, status: "logged", seq: Number(entry.seq) }
    : { kind: EDITION_LEDGER_KIND, eventDigest, status: "pending", seq: null };
}

export function createEditionStore({ identity, transaction, clock = Date.now, maxEditionsPerDocument = 1000 }) {
  check(identity && typeof identity.withTenant === "function" && typeof transaction === "function" && typeof clock === "function" &&
    Number.isSafeInteger(maxEditionsPerDocument) && maxEditionsPerDocument >= 1 && maxEditionsPerDocument <= 1000, "EDITION_STORE_CONFIG", 503);
  const now = () => {
    const ms = clock();
    check(Number.isSafeInteger(ms) && ms >= 0, "CLOCK_UNAVAILABLE", 503);
    return new Date(ms);
  };
  const publicScope = (fn, setting, value) => transaction(async (db) => {
    await db.query("SELECT set_config($1,$2,true)", [setting, value]);
    return fn(db);
  });

  async function freeze(credentials, tenantId, documentId, input) {
    const { commandId, kind, sourceVersion, sourceDigest, decisionId = null, certificateDigest = null, artifact = null } = input ?? {};
    check(UUID.test(tenantId ?? "") && UUID.test(documentId ?? ""), "INVALID_DOCUMENT_ID");
    check(UUID.test(commandId ?? ""), "INVALID_COMMAND_ID");
    check(EDITION_KINDS.includes(kind) && Number.isSafeInteger(sourceVersion) && sourceVersion >= 1 && sourceVersion <= 1000000 &&
      HEX.test(sourceDigest ?? ""), "INVALID_EDITION");
    check(artifact === null || (artifact && typeof artifact === "object" && Object.keys(artifact).sort().join(",") === "mediaType,sha256" &&
      HEX.test(artifact.sha256) && typeof artifact.mediaType === "string" && /^[a-z]+\/[a-z0-9.+-]{1,80}$/.test(artifact.mediaType)), "INVALID_ARTIFACT");
    if (kind === "adopted") check(UUID.test(decisionId ?? "") && HEX.test(certificateDigest ?? ""), "DECISION_CERTIFICATE_REQUIRED");
    else check(decisionId === null && certificateDigest === null, "INVALID_EDITION");
    const requestDigest = digest("final-edition-command-v1", { documentId, kind, sourceVersion, sourceDigest, decisionId, certificateDigest, artifact });
    return identity.withTenant(credentials, tenantId, { write: true, recent: true, roles: managers }, async (db, actor) => {
      const prior = (await db.query("SELECT * FROM dge_editions.editions WHERE tenant_id=$1 AND command_id=$2", [tenantId, commandId])).rows[0];
      if (prior) {
        check(prior.request_digest === requestDigest, "COMMAND_REUSED", 409);
        return { ...verified(prior, false), ledger: await ledgerStatus(db, prior.record_digest) };
      }
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["dge-edition:" + documentId]);
      const source = (await db.query("SELECT document,digest FROM dge_documents.versions WHERE tenant_id=$1 AND document_id=$2 AND version=$3",
        [tenantId, documentId, sourceVersion])).rows[0];
      check(source, "SOURCE_VERSION_NOT_FOUND", 404);
      check(source.digest === sourceDigest, "SOURCE_DIGEST_MISMATCH", 409);
      check(legalDocumentDigest(source.document) === source.digest, "DOCUMENT_INTEGRITY_ERROR", 503);
      const consultation = kind === "consultation-source";
      check(source.document.mode === (consultation ? "public-input" : "collaboration"), "EDITION_KIND_MODE_MISMATCH", 409);
      let document;
      try {
        if (consultation) {
          document = validateLegalDocument(source.document, { forFinalization: true });
          if (documentIssues(document).length) throw Error("issues");
        } else document = finalizeLegalDocument(source.document, EDITION_LIFECYCLE[kind]);
      } catch { throw new DocumentError("LEGAL_REFERENCE_ISSUES", 409); }
      if (kind === "adopted") {
        const decision = (await db.query("SELECT document_id,state,certificate,certificate_digest FROM dge_decisions.decisions WHERE tenant_id=$1 AND id=$2",
          [tenantId, decisionId])).rows[0];
        check(decision && decision.document_id === documentId, "DECISION_NOT_FOUND", 404);
        check(decision.state === "closed" && decision.certificate_digest === certificateDigest &&
          digest("governance-decision-certificate-v1", decision.certificate) === decision.certificate_digest, "DECISION_CERTIFICATE_MISMATCH", 409);
        const certificate = decision.certificate;
        check(certificate.outcome?.status === "passed" && certificate.application === "applied-to-public-draft" &&
          certificate.appliedVersion === sourceVersion && certificate.appliedDigest === sourceDigest, "DECISION_DID_NOT_PRODUCE_VERSION", 409);
      }
      const existing = (await db.query("SELECT count(*)::int AS n, count(*) FILTER (WHERE source_version=$3 AND kind=$4)::int AS same FROM dge_editions.editions WHERE tenant_id=$1 AND document_id=$2",
        [tenantId, documentId, sourceVersion, kind])).rows[0];
      check(existing.same === 0, "EDITION_EXISTS", 409);
      check(existing.n < maxEditionsPerDocument, "EDITION_LIMIT_REACHED", 429);
      const id = randomUUID(), at = now(), editionDigest = legalDocumentDigest(document);
      const record = {
        schema: EDITION_SCHEMA, tenantId, editionId: id, documentId, sequence: existing.n + 1, kind, lifecycle: EDITION_LIFECYCLE[kind],
        sourceVersion, sourceDigest, editionDigest, artifact, decision: kind === "adopted" ? { decisionId, certificateDigest } : null,
        frozenAt: at.toISOString(),
      };
      const recordDigest = editionRecordDigest(record);
      try {
        await db.query(
          `INSERT INTO dge_editions.editions(tenant_id,id,document_id,sequence,kind,lifecycle,source_version,source_digest,document,edition_digest,
            artifact_sha256,artifact_media_type,decision_id,certificate_digest,record,record_digest,command_id,request_digest,created_by,created_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
          [tenantId, id, documentId, record.sequence, kind, record.lifecycle, sourceVersion, sourceDigest, document, editionDigest,
            artifact?.sha256 ?? null, artifact?.mediaType ?? null, decisionId, certificateDigest, record, recordDigest, commandId, requestDigest,
            actor.accountId, at]);
      } catch (cause) {
        if (cause?.code === "23505") throw new DocumentError("EDITION_EXISTS", 409);
        if (cause?.code === "P0001") throw new DocumentError("EDITION_INVARIANT_VIOLATION", 409);
        throw cause;
      }
      await appendLedgerEvent(db, { tenantId, kind: EDITION_LEDGER_KIND, subjectId: documentId, eventDigest: recordDigest, finalization: true, at });
      return {
        ...summary({ id, tenant_id: tenantId, document_id: documentId, sequence: record.sequence, kind, lifecycle: record.lifecycle,
          source_version: sourceVersion, source_digest: sourceDigest, edition_digest: editionDigest, artifact_sha256: artifact?.sha256,
          artifact_media_type: artifact?.mediaType, decision_id: decisionId, certificate_digest: certificateDigest, record_digest: recordDigest, created_at: at }),
        ledger: { kind: EDITION_LEDGER_KIND, eventDigest: recordDigest, status: "pending", seq: null },
      };
    });
  }

  const page = (after, limit) => check((after === null || (Number.isSafeInteger(after) && after >= 0)) &&
    Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, "INVALID_PAGE");
  const listing = async (db, documentId, after, limit) => {
    const rows = (await db.query(
      `SELECT id,tenant_id,document_id,sequence,kind,lifecycle,source_version,source_digest,edition_digest,artifact_sha256,artifact_media_type,
        decision_id,certificate_digest,record,record_digest,created_at FROM dge_editions.editions
       WHERE document_id=$1 AND ($2::int IS NULL OR sequence>$2) ORDER BY sequence LIMIT $3`, [documentId, after, limit + 1])).rows;
    return { items: rows.slice(0, limit).map((row) => verified(row, false)), nextCursor: rows.length > limit ? rows[limit - 1].sequence : null };
  };

  return Object.freeze({
    freeze,
    list(credentials, tenantId, documentId, { after = null, limit = 50 } = {}) {
      check(UUID.test(tenantId ?? "") && UUID.test(documentId ?? ""), "INVALID_DOCUMENT_ID");
      page(after, limit);
      return identity.withTenant(credentials, tenantId, {}, async (db, actor) =>
        ({ ...(await listing(db, documentId, after, limit)), viewerRole: actor.role }));
    },
    publicList(documentId, { after = null, limit = 50 } = {}) {
      check(UUID.test(documentId ?? ""), "INVALID_DOCUMENT_ID");
      page(after, limit);
      return publicScope((db) => listing(db, documentId, after, limit), "dge.public_document_id", documentId);
    },
    publicRead(editionId) {
      check(UUID.test(editionId ?? ""), "INVALID_EDITION_ID");
      return publicScope(async (db) => {
        const row = (await db.query("SELECT * FROM dge_editions.editions WHERE id=$1", [editionId])).rows[0];
        check(row, "EDITION_NOT_FOUND", 404);
        return { ...verified(row, true), ledger: await ledgerStatus(db, row.record_digest) };
      }, "dge.public_edition_id", editionId);
    },
  });
}
