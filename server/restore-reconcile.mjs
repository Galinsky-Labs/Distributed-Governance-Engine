// DCE-035: restore reconciliation. Computes a content-free manifest of the
// append-only governance record (revisions, ballots, receipts, keys and the
// anchor outboxes) and checks the internal invariants a restored database
// must satisfy before it may serve. Only counts, digests of row encodings and
// invariant names leave the database; no document text, ballot choice or
// identity is printed.

/** Tables whose exact rows a restore must reproduce. */
export const RECONCILED_TABLES = Object.freeze([
  // Revisions
  "dge_documents.documents", "dge_documents.versions", "dge_documents.restorations",
  "dge_proposals.proposals", "dge_editions.editions",
  // Ballots and decisions
  "dge_decisions.decisions", "dge_decisions.ballots", "dge_decisions.events",
  "dge_electorates.snapshots", "dge_electorates.proxy_ballots", "dge_electorates.challenges",
  // Receipts and certificates
  "dge_electorates.certificates", "dge_signatures.records", "dge_signatures.manifests",
  // Transparency log
  "dge_ledger.head", "dge_ledger.entries", "dge_ledger.checkpoints", "dge_ledger.anchors",
  // Keys (public material and credential references only)
  "dge_identity.passkey_credentials", "dge_private.device_keys", "dge_ledger.witness_keys",
  // Anchor outboxes
  "dge_ledger.outbox", "dge_documents.anchor_outbox", "dge_proposals.anchor_outbox",
  "dge_discussion.anchor_outbox", "dge_decisions.anchor_outbox",
]);
const NAME = /^dge_[a-z_]+\.[a-z_]+$/;

/** Invariants checked on a single database; each returns violating row count. */
export const INVARIANTS = Object.freeze({
  "document-head-matches-latest-version": `SELECT count(*)::int AS n FROM dge_documents.documents d
    LEFT JOIN LATERAL (SELECT version,digest FROM dge_documents.versions v WHERE v.tenant_id=d.tenant_id AND v.document_id=d.id ORDER BY version DESC LIMIT 1) v ON true
    WHERE v.version IS DISTINCT FROM d.version OR v.digest IS DISTINCT FROM d.digest`,
  "version-chain-is-linked": `SELECT count(*)::int AS n FROM dge_documents.versions v
    LEFT JOIN dge_documents.versions p ON p.tenant_id=v.tenant_id AND p.document_id=v.document_id AND p.version=v.version-1
    WHERE v.version>1 AND (p.digest IS NULL OR p.digest<>v.previous_digest)`,
  "ballots-reference-decisions": `SELECT count(*)::int AS n FROM dge_decisions.ballots b
    LEFT JOIN dge_decisions.decisions d ON d.tenant_id=b.tenant_id AND d.id=b.decision_id WHERE d.id IS NULL`,
  "closed-decisions-have-receipts": `SELECT count(*)::int AS n FROM dge_decisions.decisions
    WHERE state='closed' AND (certificate IS NULL OR certificate_digest IS NULL)`,
  "ledger-head-matches-entries": `SELECT (CASE WHEN (SELECT size FROM dge_ledger.head)=(SELECT count(*) FROM dge_ledger.entries)
    AND (SELECT coalesce(max(seq)+1,0) FROM dge_ledger.entries)=(SELECT size FROM dge_ledger.head) THEN 0 ELSE 1 END)::int AS n`,
});

const tableDigestSql = (table) => `SELECT count(*)::text AS rows,
  encode(sha256(convert_to(coalesce(string_agg(t::text, E'\\n' ORDER BY t::text), ''), 'UTF8')), 'hex') AS digest
  FROM ${table} t`;

/**
 * Builds the manifest with a read-only query function `query(sql)` that
 * returns `{rows}` (node-postgres pool/client or PGlite).
 */
export async function reconciliationManifest(query) {
  const tables = {};
  for (const table of RECONCILED_TABLES) {
    if (!NAME.test(table)) throw Error("Invalid reconciled table");
    const exists = (await query(`SELECT to_regclass('${table}') IS NOT NULL AS ok`)).rows[0].ok;
    tables[table] = exists ? (await query(tableDigestSql(table))).rows[0] : { rows: null, digest: null };
  }
  const invariants = {};
  for (const [name, sql] of Object.entries(INVARIANTS)) invariants[name] = Number((await query(sql)).rows[0].n);
  const pending = {};
  for (const table of RECONCILED_TABLES.filter((t) => t.endsWith("outbox"))) pending[table] = tables[table].rows;
  return { tables, invariants, pendingOutbox: pending };
}

/**
 * Compares the manifest of a source snapshot with the restored database.
 * A restore of the same point in time must match exactly, and the restored
 * database must satisfy every invariant on its own.
 */
export function compareManifests(source, restored) {
  const problems = [];
  for (const table of RECONCILED_TABLES) {
    const a = source.tables[table], b = restored.tables[table];
    if (!a || !b) { problems.push({ table, problem: "missing-from-manifest" }); continue; }
    if (a.rows !== b.rows) problems.push({ table, problem: "row-count-differs", source: a.rows, restored: b.rows });
    else if (a.digest !== b.digest) problems.push({ table, problem: "row-content-differs" });
  }
  for (const [name, count] of Object.entries(restored.invariants))
    if (count !== 0) problems.push({ invariant: name, problem: "invariant-violated", count });
  return { ok: problems.length === 0, problems };
}
