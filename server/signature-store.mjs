// Signing ceremonies, append-only signature records and Merkle signature
// manifests (DCE-026/027). Identity evidence is the authenticated session and,
// where present, a WebAuthn assertion whose challenge is the signing digest.
// Marks, names and identities are never logged.
import { randomUUID, randomBytes } from "node:crypto";
import { appendLeaf, rootHash, inclusionProof, consistencyProof } from "../src/transparency.mjs";
import {
  SIGNATURE_KINDS, EDITION_SIGNATURE_KINDS, DISPUTE_REASONS, MANIFEST_SCHEMA, RECEIPT_SCHEMA, LEAF_ENCODING,
  signatureIntent, signingDigest, signingChallenge, signatureRecord, followUpRecord, recordDigest, recordLeaf,
  manifestDigest, validateMark, validateDisplay, displayText, nameKey,
} from "../src/signatures.mjs";
import { DocumentError } from "./document-store.mjs";
import { appendLedgerEvent } from "./ledger.mjs";

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const HEX = /^[a-f0-9]{64}$/;
const ZERO = "0".repeat(64);
const check = (condition, code, status = 400) => { if (!condition) throw new DocumentError(code, status); };
const managers = ["owner", "admin"];
const SIGNER_ROLES = Object.freeze({
  support: ["owner", "admin", "editor", "participant", "viewer"],
  approval: ["owner", "admin", "editor", "participant"],
  execution: ["owner", "admin", "editor", "participant", "viewer"],
});
export const MANIFEST_LEDGER_KIND = "signature-manifest";
const ids = (...values) => check(values.every((value) => UUID.test(value ?? "")), "INVALID_SIGNATURE_CONTEXT");
const kindOf = (kind) => { check(SIGNATURE_KINDS.includes(kind), "INVALID_SIGNATURE_KIND"); return kind; };
const iso = (value) => new Date(value).toISOString();

/** Keys of the complete subtrees that make up a tree of `size` leaves. */
function frontierKeys(size) {
  const keys = [];
  let start = 0;
  for (let level = 52; level >= 0; level--) {
    const width = 2 ** level;
    if (size - start >= width) { keys.push([level, start / width]); start += width; }
  }
  return keys;
}
async function loadNodes(db, editionId, kind, keys) {
  const found = new Map();
  if (!keys.length) return found;
  const rows = (await db.query(
    `SELECT n.level,n.idx,n.hash FROM unnest($3::smallint[],$4::bigint[]) AS k(level,idx)
     JOIN dge_signatures.manifest_nodes n ON n.edition_id=$1 AND n.kind=$2 AND n.level=k.level AND n.idx=k.idx`,
    [editionId, kind, keys.map((k) => k[0]), keys.map((k) => k[1])])).rows;
  for (const row of rows) found.set(row.level + ":" + Number(row.idx), row.hash);
  return found;
}
/**
 * Runs a pure proof computation twice: first to learn which stored subtree
 * hashes it reads (the access pattern does not depend on hash values), then
 * with those hashes fetched in one query. Keeps proofs at O(log n) rows.
 */
async function withStoredNodes(db, editionId, kind, compute) {
  const wanted = new Map();
  await compute(async (level, index) => { wanted.set(level + ":" + index, [level, index]); return ZERO; });
  const nodes = await loadNodes(db, editionId, kind, [...wanted.values()]);
  return compute(async (level, index) => {
    const hash = nodes.get(level + ":" + index);
    check(hash, "MANIFEST_INTEGRITY_ERROR", 503);
    return hash;
  });
}
const csvField = (value) => {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text; // Spreadsheet formula injection.
  return /[",\n\r']/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
};
const publicEntry = (row) => row.display === "public"
  ? { position: Number(row.position), recordDigest: row.record_digest, action: row.action, display: "public",
      name: row.public_record?.publicName ?? null, signedAt: row.public_record?.signedAt ?? row.public_record?.at ?? null,
      method: row.public_record?.method ?? null, capacity: row.public_record?.capacity ?? null }
  : { position: Number(row.position), recordDigest: row.record_digest, action: row.action, display: "private" };
export const MANIFEST_CSV_HEADER = "position,record_digest,action,display,public_name,signed_at,method,capacity\n";

export function createSignatureStore({
  identity, transaction, origin, clock = Date.now, verifyPasskeyAuthentication,
  intentTtlMs = 900000, maxLeavesPerFreeze = 50000, freezeChunk = 2000, exportChunk = 1000,
}) {
  check(identity && typeof identity.withTenant === "function" && typeof identity.sessionInfo === "function" &&
    typeof transaction === "function" && typeof clock === "function", "SIGNATURE_STORE_CONFIG", 503);
  check(typeof origin === "string" && new URL(origin).origin === origin && origin.startsWith("https://"), "SIGNATURE_STORE_CONFIG", 503);
  check(verifyPasskeyAuthentication === undefined || typeof verifyPasskeyAuthentication === "function", "SIGNATURE_STORE_CONFIG", 503);
  for (const [value, max] of [[intentTtlMs, 86400000], [maxLeavesPerFreeze, 1000000], [freezeChunk, 10000], [exportChunk, 10000]])
    check(Number.isSafeInteger(value) && value >= 1 && value <= max, "SIGNATURE_STORE_CONFIG", 503);
  const rpId = new URL(origin).hostname;
  const now = () => {
    const ms = clock();
    check(Number.isSafeInteger(ms) && ms >= 0, "CLOCK_UNAVAILABLE", 503);
    return new Date(ms);
  };
  const publicScope = (editionId, fn) => transaction(async (db) => {
    await db.query("SELECT set_config('dge.public_edition_id',$1,true)", [editionId]);
    return fn(db);
  });
  async function edition(db, tenantId, editionId) {
    const row = (await db.query("SELECT id,document_id,kind,edition_digest,artifact_sha256 FROM dge_editions.editions WHERE tenant_id=$1 AND id=$2",
      [tenantId, editionId])).rows[0];
    check(row, "EDITION_NOT_FOUND", 404);
    return row;
  }
  async function signatoryOf(db, editionId, accountId) {
    return (await db.query("SELECT position,capacity FROM dge_signatures.signatories WHERE edition_id=$1 AND account_id=$2", [editionId, accountId])).rows[0];
  }
  async function orderSatisfied(db, editionId, position) {
    return !(await db.query(
      `SELECT 1 FROM dge_signatures.signatories s WHERE s.edition_id=$1 AND s.position<$2 AND NOT EXISTS
        (SELECT 1 FROM dge_signatures.active a WHERE a.edition_id=s.edition_id AND a.kind='execution' AND a.account_id=s.account_id) LIMIT 1`,
      [editionId, position])).rows.length;
  }
  const activeFor = async (db, editionId, kind, accountId) =>
    (await db.query("SELECT record_id FROM dge_signatures.active WHERE edition_id=$1 AND kind=$2 AND account_id=$3", [editionId, kind, accountId])).rows[0];
  async function passkeyCredentials(db, accountId) {
    return (await db.query(
      `SELECT id,credential_id AS "credentialId",public_key AS "publicKey",sign_count::text AS counter,transports
       FROM dge_identity.passkey_credentials WHERE account_id=$1 AND revoked_at IS NULL ORDER BY created_at,id`, [accountId])).rows
      .map((row) => ({ ...row, counter: Number(row.counter) }));
  }
  async function bumpTally(db, tenantId, editionId, kind, active, publicDelta) {
    await db.query(
      `INSERT INTO dge_signatures.tallies(tenant_id,edition_id,kind,shard,active_count,public_count) VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (edition_id,kind,shard) DO UPDATE SET active_count=dge_signatures.tallies.active_count+excluded.active_count,
         public_count=dge_signatures.tallies.public_count+excluded.public_count`,
      [tenantId, editionId, kind, randomBytes(1)[0] & 15, active, publicDelta]);
  }
  async function appendRecord(db, { tenantId, editionId, kind, action, targetId = null, record, display, publicMark = null, accountId, intentId = null, mark, passkeyCredentialId = null, at }) {
    const id = randomUUID(), digestHex = recordDigest(record);
    const seq = Number((await db.query(
      `INSERT INTO dge_signatures.records(tenant_id,id,edition_id,kind,action,target_id,record_digest,display,public_record,public_mark,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING seq`,
      [tenantId, id, editionId, kind, action, targetId, digestHex, display, display === "public" ? record : null, publicMark, at])).rows[0].seq);
    await db.query(
      "INSERT INTO dge_signatures.evidence(tenant_id,record_id,edition_id,account_id,intent_id,record,mark,passkey_credential_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [tenantId, id, editionId, accountId, intentId, record, mark, passkeyCredentialId]);
    await db.query("INSERT INTO dge_signatures.manifest_queue(tenant_id,edition_id,kind,seq,record_id) VALUES($1,$2,$3,$4,$5)",
      [tenantId, editionId, kind, seq, id]);
    return { id, seq, recordDigest: digestHex };
  }
  const pgCode = (cause, map) => {
    if (cause instanceof DocumentError) throw cause;
    const code = map[cause?.code];
    if (code) throw new DocumentError(code[0], code[1]);
    throw cause;
  };

  async function verifyPasskey(db, accountId, digestHex, response) {
    check(typeof verifyPasskeyAuthentication === "function", "PASSKEY_VERIFIER_UNAVAILABLE", 503);
    check(response && typeof response === "object" && !Array.isArray(response), "PASSKEY_VERIFICATION_FAILED", 403);
    const credentials = await passkeyCredentials(db, accountId);
    check(credentials.length, "PASSKEY_NOT_ENROLLED", 409);
    const result = await verifyPasskeyAuthentication({
      response, credentials, expectedChallenge: signingChallenge(digestHex), expectedOrigin: origin, expectedRpId: rpId, accountId,
    });
    const credential = result?.verified === true && result.userVerified === true && credentials.find((item) => item.credentialId === result.credentialId);
    check(credential && Number.isSafeInteger(result.newCounter) && result.newCounter >= 0, "PASSKEY_VERIFICATION_FAILED", 403);
    const current = Number((await db.query("SELECT sign_count::text AS counter FROM dge_identity.passkey_credentials WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL FOR UPDATE",
      [credential.id, accountId])).rows[0]?.counter ?? NaN);
    check(Number.isFinite(current) && ((current === 0 && result.newCounter === 0) || result.newCounter > current), "PASSKEY_COUNTER_ROLLBACK", 403);
    await db.query("UPDATE dge_identity.passkey_credentials SET sign_count=$2,last_used_at=$3 WHERE id=$1", [credential.id, result.newCounter, now()]);
    return credential.id;
  }

  async function personalReceipt(db, recordId) {
    const row = (await db.query(
      `SELECT r.id,r.edition_id,r.kind,r.record_digest,e.position,ev.record,i.intent FROM dge_signatures.records r
       JOIN dge_signatures.evidence ev ON ev.record_id=r.id LEFT JOIN dge_signatures.intents i ON i.id=ev.intent_id
       LEFT JOIN dge_signatures.manifest_entries e ON e.record_id=r.id WHERE r.id=$1`, [recordId])).rows[0];
    check(row, "SIGNATURE_NOT_FOUND", 404);
    return inclusion(db, row, { record: row.record, intent: row.intent ?? null });
  }
  async function inclusion(db, row, disclosed) {
    const base = { schema: RECEIPT_SCHEMA, recordDigest: row.record_digest, ...disclosed };
    if (row.position === null || row.position === undefined) return { ...base, status: "awaiting-manifest" };
    const manifest = (await db.query("SELECT record,manifest_digest FROM dge_signatures.manifests WHERE edition_id=$1 AND kind=$2 ORDER BY version DESC LIMIT 1",
      [row.edition_id, row.kind])).rows[0];
    check(manifest && manifestDigest(manifest.record) === manifest.manifest_digest, "MANIFEST_INTEGRITY_ERROR", 503);
    const position = Number(row.position), size = manifest.record.size;
    check(position < size, "MANIFEST_INTEGRITY_ERROR", 503);
    const proof = await withStoredNodes(db, row.edition_id, row.kind, (getNode) => inclusionProof(position, size, getNode));
    const ledger = (await db.query("SELECT seq FROM dge_ledger.entries WHERE kind=$1 AND event_digest=$2", [MANIFEST_LEDGER_KIND, manifest.manifest_digest])).rows[0];
    return {
      ...base, status: "included", position, proof,
      manifest: { record: manifest.record, digest: manifest.manifest_digest },
      ledger: { kind: MANIFEST_LEDGER_KIND, subjectId: row.edition_id, eventDigest: manifest.manifest_digest, seq: ledger ? Number(ledger.seq) : null },
    };
  }

  async function freezeManifest(credentials, tenantId, editionId, { kind } = {}) {
    ids(tenantId, editionId); kindOf(kind);
    return identity.withTenant(credentials, tenantId, { write: true, roles: managers }, async (db, actor) => {
      const ed = await edition(db, tenantId, editionId);
      await db.query("INSERT INTO dge_signatures.manifest_heads(tenant_id,edition_id,kind,size,version,active_count,public_count) VALUES($1,$2,$3,0,0,0,0) ON CONFLICT DO NOTHING",
        [tenantId, editionId, kind]);
      const head = (await db.query("SELECT size,version,active_count,public_count FROM dge_signatures.manifest_heads WHERE edition_id=$1 AND kind=$2 FOR UPDATE",
        [editionId, kind])).rows[0];
      const previousSize = Number(head.size);
      let size = previousSize, active = Number(head.active_count), shown = Number(head.public_count), lastSeq = -1;
      const nodes = await loadNodes(db, editionId, kind, frontierKeys(size));
      check(nodes.size === frontierKeys(size).length, "MANIFEST_INTEGRITY_ERROR", 503);
      const getNode = async (level, index) => {
        const hash = nodes.get(level + ":" + index);
        check(hash, "MANIFEST_INTEGRITY_ERROR", 503);
        return hash;
      };
      const previousRoot = size ? await rootHash(size, getNode) : null;
      while (size - previousSize < maxLeavesPerFreeze) {
        const rows = (await db.query(
          `SELECT q.seq,q.record_id,r.record_digest,r.action,r.display FROM dge_signatures.manifest_queue q JOIN dge_signatures.records r ON r.id=q.record_id
           WHERE q.edition_id=$1 AND q.kind=$2 AND q.seq>$3 ORDER BY q.seq LIMIT $4`,
          [editionId, kind, lastSeq, Math.min(freezeChunk, maxLeavesPerFreeze - (size - previousSize))])).rows;
        if (!rows.length) break;
        const created = [], positions = [];
        for (const row of rows) {
          for (const node of await appendLeaf(size, recordLeaf(row.record_digest), getNode)) {
            nodes.set(node.level + ":" + node.index, node.hash);
            created.push(node);
          }
          positions.push(size++);
          if (row.action === "sign") { active++; if (row.display === "public") shown++; }
          else if (row.action === "withdraw") { active--; if (row.display === "public") shown--; }
          lastSeq = Number(row.seq);
        }
        await db.query(
          `INSERT INTO dge_signatures.manifest_nodes(tenant_id,edition_id,kind,level,idx,hash)
           SELECT $1,$2,$3,* FROM unnest($4::smallint[],$5::bigint[],$6::char(64)[])`,
          [tenantId, editionId, kind, created.map((n) => n.level), created.map((n) => n.index), created.map((n) => n.hash)]);
        await db.query(
          `INSERT INTO dge_signatures.manifest_entries(tenant_id,edition_id,kind,position,record_id,record_digest)
           SELECT $1,$2,$3,* FROM unnest($4::bigint[],$5::uuid[],$6::char(64)[])`,
          [tenantId, editionId, kind, positions, rows.map((r) => r.record_id), rows.map((r) => r.record_digest)]);
        await db.query("DELETE FROM dge_signatures.manifest_queue WHERE record_id=ANY($1::uuid[])", [rows.map((r) => r.record_id)]);
        const keep = new Set(frontierKeys(size).map(([l, i]) => l + ":" + i));
        for (const key of nodes.keys()) if (!keep.has(key)) nodes.delete(key);
      }
      const pending = (await db.query("SELECT 1 FROM dge_signatures.manifest_queue WHERE edition_id=$1 AND kind=$2 LIMIT 1", [editionId, kind])).rows.length > 0;
      if (size === previousSize) {
        check(previousSize > 0, "MANIFEST_EMPTY", 409);
        const latest = (await db.query("SELECT record,manifest_digest,consistency FROM dge_signatures.manifests WHERE edition_id=$1 AND kind=$2 AND version=$3",
          [editionId, kind, head.version])).rows[0];
        return { manifest: latest.record, digest: latest.manifest_digest, consistency: latest.consistency, created: false, pending };
      }
      const root = await rootHash(size, getNode), at = now();
      const consistency = previousSize
        ? await withStoredNodes(db, editionId, kind, (read) => consistencyProof(previousSize, size, read))
        : [];
      const record = {
        schema: MANIFEST_SCHEMA, tenantId, editionId, editionDigest: ed.edition_digest, artifactDigest: ed.artifact_sha256 ?? null, kind,
        version: Number(head.version) + 1, size, rootHash: root, previousSize, previousRootHash: previousRoot,
        activeSigners: active, publicSigners: shown, leafEncoding: LEAF_ENCODING, frozenAt: at.toISOString(),
      };
      const digestHex = manifestDigest(record);
      await db.query(
        `INSERT INTO dge_signatures.manifests(tenant_id,edition_id,kind,version,size,root_hash,consistency,record,manifest_digest,created_by,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [tenantId, editionId, kind, record.version, size, root, JSON.stringify(consistency), record, digestHex, actor.accountId, at]);
      await db.query("UPDATE dge_signatures.manifest_heads SET size=$3,version=$4,active_count=$5,public_count=$6 WHERE edition_id=$1 AND kind=$2",
        [editionId, kind, size, record.version, active, shown]);
      await appendLedgerEvent(db, { tenantId, kind: MANIFEST_LEDGER_KIND, subjectId: editionId, eventDigest: digestHex, finalization: true, at });
      return { manifest: record, digest: digestHex, consistency, created: true, pending };
    });
  }

  function readManifest(editionId, kind, version) {
    ids(editionId); kindOf(kind);
    check(Number.isSafeInteger(version) && version >= 1, "INVALID_MANIFEST_VERSION");
    return publicScope(editionId, async (db) => {
      const row = (await db.query("SELECT record,manifest_digest,consistency FROM dge_signatures.manifests WHERE edition_id=$1 AND kind=$2 AND version=$3",
        [editionId, kind, version])).rows[0];
      check(row, "MANIFEST_NOT_FOUND", 404);
      check(manifestDigest(row.record) === row.manifest_digest, "MANIFEST_INTEGRITY_ERROR", 503);
      const ledger = (await db.query("SELECT seq FROM dge_ledger.entries WHERE kind=$1 AND event_digest=$2", [MANIFEST_LEDGER_KIND, row.manifest_digest])).rows[0];
      return { manifest: row.record, digest: row.manifest_digest, consistency: row.consistency,
        ledger: { kind: MANIFEST_LEDGER_KIND, subjectId: editionId, eventDigest: row.manifest_digest, seq: ledger ? Number(ledger.seq) : null } };
    });
  }

  return Object.freeze({
    /** Manager configures execution order and capacities once; append-only. */
    configureSignatories(credentials, tenantId, editionId, { signatories } = {}) {
      ids(tenantId, editionId);
      check(Array.isArray(signatories) && signatories.length >= 1 && signatories.length <= 100, "INVALID_SIGNATORIES");
      const list = signatories.map((item) => {
        check(item && typeof item === "object" && Object.keys(item).sort().join(",") === "accountId,capacity" && UUID.test(item.accountId ?? ""), "INVALID_SIGNATORIES");
        try { return { accountId: item.accountId, capacity: displayText(item.capacity, 200) }; } catch { throw new DocumentError("INVALID_SIGNATORIES"); }
      });
      check(new Set(list.map((item) => item.accountId)).size === list.length, "INVALID_SIGNATORIES");
      return identity.withTenant(credentials, tenantId, { write: true, recent: true, roles: managers }, async (db, actor) => {
        const ed = await edition(db, tenantId, editionId);
        check(EDITION_SIGNATURE_KINDS[ed.kind].includes("execution"), "EXECUTION_NOT_ALLOWED", 409);
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["dge-signatories:" + editionId]);
        check(!(await db.query("SELECT 1 FROM dge_signatures.signatories WHERE edition_id=$1 LIMIT 1", [editionId])).rows.length, "SIGNATORIES_ALREADY_CONFIGURED", 409);
        const members = (await db.query("SELECT account_id FROM dge_identity.memberships WHERE tenant_id=$1 AND active=true AND account_id=ANY($2::uuid[])",
          [tenantId, list.map((item) => item.accountId)])).rows.length;
        check(members === list.length, "SIGNATORY_NOT_MEMBER", 409);
        const at = now();
        for (const [index, item] of list.entries())
          await db.query("INSERT INTO dge_signatures.signatories(tenant_id,edition_id,position,account_id,capacity,configured_by,configured_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
            [tenantId, editionId, index + 1, item.accountId, item.capacity, actor.accountId, at]);
        return { editionId, signatories: list.map((item, index) => ({ position: index + 1, ...item, signed: false })) };
      });
    },
    signatories(credentials, tenantId, editionId) {
      ids(tenantId, editionId);
      return identity.withTenant(credentials, tenantId, {}, async (db) => {
        await edition(db, tenantId, editionId);
        const rows = (await db.query(
          `SELECT s.position,s.account_id,s.capacity,EXISTS(SELECT 1 FROM dge_signatures.active a WHERE a.edition_id=s.edition_id AND a.kind='execution' AND a.account_id=s.account_id) AS signed
           FROM dge_signatures.signatories s WHERE s.edition_id=$1 ORDER BY s.position`, [editionId])).rows;
        return { editionId, signatories: rows.map((r) => ({ position: r.position, accountId: r.account_id, capacity: r.capacity, signed: r.signed })) };
      });
    },
    createIntent(credentials, tenantId, editionId, { kind, capacity = null } = {}) {
      ids(tenantId, editionId); kindOf(kind);
      check(capacity === null || (typeof capacity === "string" && capacity.length <= 400), "INVALID_CAPACITY");
      check(kind !== "execution" || capacity === null, "CAPACITY_IS_CONFIGURED");
      return identity.withTenant(credentials, tenantId, { write: true, roles: SIGNER_ROLES[kind] }, async (db, actor) => {
        const ed = await edition(db, tenantId, editionId);
        check(EDITION_SIGNATURE_KINDS[ed.kind].includes(kind), "SIGNATURE_KIND_NOT_ALLOWED", 409);
        check(!(await activeFor(db, editionId, kind, actor.accountId)), "ALREADY_SIGNED", 409);
        let signedCapacity = capacity;
        if (kind === "execution") {
          const place = await signatoryOf(db, editionId, actor.accountId);
          check(place, "NOT_A_SIGNATORY", 403);
          check(await orderSatisfied(db, editionId, place.position), "SIGNING_ORDER_VIOLATION", 409);
          signedCapacity = place.capacity;
        }
        const keys = typeof verifyPasskeyAuthentication === "function" ? await passkeyCredentials(db, actor.accountId) : [];
        check(kind !== "execution" || typeof verifyPasskeyAuthentication === "function", "PASSKEY_VERIFIER_UNAVAILABLE", 503);
        check(kind !== "execution" || keys.length, "PASSKEY_NOT_ENROLLED", 409);
        const at = now(), id = randomUUID();
        let intent;
        try {
          intent = signatureIntent({
            tenantId, documentId: ed.document_id, editionId, editionDigest: ed.edition_digest, artifactDigest: ed.artifact_sha256 ?? null,
            kind, capacity: signedCapacity, accountId: actor.accountId, nonce: randomBytes(32).toString("hex"),
            issuedAt: at.toISOString(), expiresAt: new Date(at.getTime() + intentTtlMs).toISOString(),
          });
        } catch { throw new DocumentError("INVALID_CAPACITY"); }
        const digestHex = signingDigest(intent);
        await db.query(
          "INSERT INTO dge_signatures.intents(tenant_id,id,edition_id,kind,account_id,intent,signing_digest,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [tenantId, id, editionId, kind, actor.accountId, intent, digestHex, at, intent.expiresAt]);
        return {
          intentId: id, intent, signingDigest: digestHex,
          passkey: keys.length ? {
            required: kind === "execution", challenge: signingChallenge(digestHex), rpId,
            allowCredentials: keys.map((item) => ({ id: item.credentialId, transports: item.transports })),
          } : null,
        };
      });
    },
    declineIntent(credentials, tenantId, editionId, intentId) {
      ids(tenantId, editionId, intentId);
      return identity.withTenant(credentials, tenantId, { write: true }, async (db, actor) => {
        const row = (await db.query("SELECT edition_id,outcome FROM dge_signatures.intents WHERE tenant_id=$1 AND id=$2 AND account_id=$3 FOR UPDATE",
          [tenantId, intentId, actor.accountId])).rows[0];
        check(row && row.edition_id === editionId, "INTENT_NOT_FOUND", 404);
        check(row.outcome === null, "INTENT_ALREADY_USED", 409);
        await db.query("UPDATE dge_signatures.intents SET outcome='declined',closed_at=$2 WHERE id=$1", [intentId, now()]);
        return { intentId, outcome: "declined" };
      });
    },
    async sign(credentials, tenantId, editionId, { intentId, signingDigest: submitted, consent, mark, display, passkey = null } = {}) {
      ids(tenantId, editionId, intentId);
      check(HEX.test(submitted ?? ""), "INVALID_SIGNING_DIGEST");
      check(consent === true, "CONSENT_REQUIRED");
      // Assurance is read just before the tenant transaction; both must
      // resolve to the same account or the signature is refused.
      const session = await identity.sessionInfo(credentials?.sessionToken);
      return identity.withTenant(credentials, tenantId, { write: true }, async (db, actor) => {
        check(session.accountId === actor.accountId, "SESSION_CHANGED", 409);
        const intentRow = (await db.query("SELECT * FROM dge_signatures.intents WHERE tenant_id=$1 AND id=$2 AND account_id=$3 FOR UPDATE",
          [tenantId, intentId, actor.accountId])).rows[0];
        check(intentRow, "INTENT_NOT_FOUND", 404);
        check(intentRow.edition_id === editionId, "INTENT_EDITION_MISMATCH", 409);
        check(intentRow.signing_digest === submitted, "INTENT_DIGEST_MISMATCH", 409);
        check(intentRow.outcome === null, "INTENT_ALREADY_USED", 409);
        const at = now();
        check(new Date(intentRow.expires_at).getTime() > at.getTime(), "INTENT_EXPIRED", 409);
        const intent = intentRow.intent, kind = intentRow.kind;
        check(signingDigest(intent) === intentRow.signing_digest, "INTENT_INTEGRITY_ERROR", 503);
        check(SIGNER_ROLES[kind].includes(actor.role), "ACCESS_DENIED", 403);
        const ed = await edition(db, tenantId, editionId);
        check(ed.edition_digest === intent.editionDigest && (ed.artifact_sha256 ?? null) === intent.artifactDigest, "INTENT_EDITION_MISMATCH", 409);
        check(!(await activeFor(db, editionId, kind, actor.accountId)), "ALREADY_SIGNED", 409);
        if (kind === "execution") {
          const place = await signatoryOf(db, editionId, actor.accountId);
          check(place && place.capacity === intent.capacity, "NOT_A_SIGNATORY", 403);
          check(await orderSatisfied(db, editionId, place.position), "SIGNING_ORDER_VIOLATION", 409);
          check(passkey !== null, "PASSKEY_REQUIRED", 403);
        }
        let normalizedMark, record;
        try {
          normalizedMark = validateMark(mark, kind);
          record = signatureRecord({
            intent, mark: normalizedMark, display: validateDisplay(display),
            assurance: { sessionAuthenticatedAt: iso(session.authenticatedAt), sessionAssurance: session.authenticationAssurance, passkey: passkey !== null },
            signedAt: at.toISOString(),
          });
        } catch { throw new DocumentError("INVALID_SIGNATURE"); }
        const passkeyCredentialId = passkey !== null ? await verifyPasskey(db, actor.accountId, intentRow.signing_digest, passkey) : null;
        try {
          const appended = await appendRecord(db, {
            tenantId, editionId, kind, action: "sign", record, display: record.display,
            publicMark: record.display === "public" && normalizedMark.type !== "none" ? normalizedMark : null,
            accountId: actor.accountId, intentId, mark: normalizedMark, passkeyCredentialId, at,
          });
          await db.query("INSERT INTO dge_signatures.active(tenant_id,edition_id,kind,account_id,record_id,display) VALUES($1,$2,$3,$4,$5,$6)",
            [tenantId, editionId, kind, actor.accountId, appended.id, record.display]);
          if (record.display === "public")
            await db.query("INSERT INTO dge_signatures.directory(tenant_id,edition_id,kind,record_id,seq,public_name,name_key,signed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
              [tenantId, editionId, kind, appended.id, appended.seq, record.publicName, nameKey(record.publicName), at]);
          await bumpTally(db, tenantId, editionId, kind, 1, record.display === "public" ? 1 : 0);
          await db.query("UPDATE dge_signatures.intents SET outcome='signed',closed_at=$2 WHERE id=$1", [intentId, at]);
          return { signatureId: appended.id, recordDigest: appended.recordDigest, record, status: "awaiting-manifest" };
        } catch (cause) {
          pgCode(cause, { 23505: ["ALREADY_SIGNED", 409], P0001: ["SIGNING_ORDER_VIOLATION", 409] });
        }
      });
    },
    withdraw(credentials, tenantId, editionId, signatureId) {
      ids(tenantId, editionId, signatureId);
      return identity.withTenant(credentials, tenantId, { write: true }, async (db, actor) => {
        const row = (await db.query(
          `DELETE FROM dge_signatures.active a USING dge_signatures.evidence ev WHERE ev.record_id=a.record_id
           AND a.tenant_id=$1 AND a.edition_id=$2 AND a.record_id=$3 AND a.account_id=$4 RETURNING a.kind,a.display,ev.record`,
          [tenantId, editionId, signatureId, actor.accountId])).rows[0];
        check(row, "SIGNATURE_NOT_ACTIVE", 409);
        await db.query("DELETE FROM dge_signatures.directory WHERE record_id=$1", [signatureId]);
        const at = now();
        const record = followUpRecord({ action: "withdraw", signature: row.record, nonce: randomBytes(32).toString("hex"), at: at.toISOString() });
        const appended = await appendRecord(db, { tenantId, editionId, kind: row.kind, action: "withdraw", targetId: signatureId, record,
          display: row.display, accountId: actor.accountId, mark: {}, at });
        await bumpTally(db, tenantId, editionId, row.kind, -1, row.display === "public" ? -1 : 0);
        return { withdrawalId: appended.id, recordDigest: appended.recordDigest, record, status: "awaiting-manifest" };
      });
    },
    dispute(credentials, tenantId, editionId, signatureId, { reason } = {}) {
      ids(tenantId, editionId, signatureId);
      check(DISPUTE_REASONS.includes(reason), "INVALID_DISPUTE");
      return identity.withTenant(credentials, tenantId, { write: true }, async (db, actor) => {
        const row = (await db.query(
          `SELECT r.kind,r.display,ev.record,ev.account_id FROM dge_signatures.records r JOIN dge_signatures.evidence ev ON ev.record_id=r.id
           WHERE r.tenant_id=$1 AND r.edition_id=$2 AND r.id=$3 AND r.action='sign'`, [tenantId, editionId, signatureId])).rows[0];
        check(row, "SIGNATURE_NOT_FOUND", 404);
        const raisedBy = row.account_id === actor.accountId ? "signer" : managers.includes(actor.role) ? "manager" : null;
        check(raisedBy, "ACCESS_DENIED", 403);
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["dge-dispute:" + signatureId]);
        check(!(await db.query(
          `SELECT 1 FROM dge_signatures.records r JOIN dge_signatures.evidence ev ON ev.record_id=r.id
           WHERE r.target_id=$1 AND r.action='dispute' AND ev.account_id=$2`, [signatureId, actor.accountId])).rows.length, "DISPUTE_EXISTS", 409);
        const at = now();
        const record = followUpRecord({ action: "dispute", signature: row.record, reason, raisedBy, nonce: randomBytes(32).toString("hex"), at: at.toISOString() });
        const appended = await appendRecord(db, { tenantId, editionId, kind: row.kind, action: "dispute", targetId: signatureId, record,
          display: row.display, accountId: actor.accountId, mark: {}, at });
        return { disputeId: appended.id, recordDigest: appended.recordDigest, record, status: "awaiting-manifest" };
      });
    },
    /** The signer's own records, including private marks. */
    mine(credentials, tenantId, editionId) {
      ids(tenantId, editionId);
      return identity.withTenant(credentials, tenantId, {}, async (db, actor) => {
        await edition(db, tenantId, editionId);
        const rows = (await db.query(
          `SELECT r.id,r.kind,r.action,r.target_id,r.record_digest,r.display,ev.record,ev.mark,
             EXISTS(SELECT 1 FROM dge_signatures.active a WHERE a.record_id=r.id) AS active
           FROM dge_signatures.evidence ev JOIN dge_signatures.records r ON r.id=ev.record_id
           WHERE ev.account_id=$1 AND ev.edition_id=$2 ORDER BY r.seq LIMIT 200`, [actor.accountId, editionId])).rows;
        return { items: rows.map((r) => ({ id: r.id, kind: r.kind, action: r.action, targetId: r.target_id, recordDigest: r.record_digest,
          display: r.display, active: r.active, record: r.record, mark: r.action === "sign" ? r.mark : null })) };
      });
    },
    /** Managers see private evidence, including private marks, for their workspace. */
    list(credentials, tenantId, editionId, { kind, after = null, limit = 100 } = {}) {
      ids(tenantId, editionId); kindOf(kind);
      check((after === null || (Number.isSafeInteger(after) && after >= 0)) && Number.isSafeInteger(limit) && limit >= 1 && limit <= 200, "INVALID_PAGE");
      return identity.withTenant(credentials, tenantId, { roles: managers }, async (db) => {
        await edition(db, tenantId, editionId);
        const rows = (await db.query(
          `SELECT r.id,r.seq,r.action,r.target_id,r.record_digest,r.display,ev.account_id,ev.record,ev.mark,ev.passkey_credential_id IS NOT NULL AS passkey
           FROM dge_signatures.records r JOIN dge_signatures.evidence ev ON ev.record_id=r.id
           WHERE r.edition_id=$1 AND r.kind=$2 AND ($3::bigint IS NULL OR r.seq>$3) ORDER BY r.seq LIMIT $4`,
          [editionId, kind, after, limit + 1])).rows;
        return {
          items: rows.slice(0, limit).map((r) => ({ id: r.id, action: r.action, targetId: r.target_id, recordDigest: r.record_digest, display: r.display,
            accountId: r.account_id, record: r.record, mark: r.action === "sign" ? r.mark : null, passkey: r.passkey })),
          nextCursor: rows.length > limit ? Number(rows[limit - 1].seq) : null,
        };
      });
    },
    receipt(credentials, tenantId, editionId, recordId) {
      ids(tenantId, editionId, recordId);
      return identity.withTenant(credentials, tenantId, {}, async (db, actor) => {
        const owner = (await db.query("SELECT account_id FROM dge_signatures.evidence WHERE record_id=$1 AND edition_id=$2", [recordId, editionId])).rows[0];
        check(owner, "SIGNATURE_NOT_FOUND", 404);
        check(owner.account_id === actor.accountId || managers.includes(actor.role), "SIGNATURE_NOT_FOUND", 404);
        return personalReceipt(db, recordId);
      });
    },
    freezeManifest,
    manifests(editionId, { kind, before = null, limit = 50 } = {}) {
      ids(editionId); kindOf(kind);
      check((before === null || (Number.isSafeInteger(before) && before >= 1)) && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, "INVALID_PAGE");
      return publicScope(editionId, async (db) => {
        const rows = (await db.query(
          `SELECT version,record,manifest_digest,consistency FROM dge_signatures.manifests WHERE edition_id=$1 AND kind=$2 AND ($3::int IS NULL OR version<$3)
           ORDER BY version DESC LIMIT $4`, [editionId, kind, before, limit + 1])).rows;
        return {
          items: rows.slice(0, limit).map((r) => ({ manifest: r.record, digest: r.manifest_digest, consistency: r.consistency })),
          nextCursor: rows.length > limit ? rows[limit - 1].version : null,
        };
      });
    },
    manifest: readManifest,
    /**
     * Full manifest export as bounded chunks. Each chunk is read in its own
     * short public transaction; private signers appear only as record digests.
     */
    async *exportManifest(editionId, kind, version, format = "json") {
      check(format === "json" || format === "csv", "INVALID_FORMAT");
      const { manifest, digest: digestHex } = await readManifest(editionId, kind, version);
      yield format === "csv" ? MANIFEST_CSV_HEADER : '{"manifest":' + JSON.stringify(manifest) + ',"digest":' + JSON.stringify(digestHex) + ',"entries":[';
      for (let from = 0; from < manifest.size; from += exportChunk) {
        const rows = await publicScope(editionId, async (db) => (await db.query(
          `SELECT e.position,e.record_digest,r.action,r.display,r.public_record FROM dge_signatures.manifest_entries e
           JOIN dge_signatures.records r ON r.id=e.record_id WHERE e.edition_id=$1 AND e.kind=$2 AND e.position>=$3 AND e.position<$4 ORDER BY e.position`,
          [editionId, kind, from, Math.min(from + exportChunk, manifest.size)])).rows);
        check(rows.length === Math.min(exportChunk, manifest.size - from), "MANIFEST_INTEGRITY_ERROR", 503);
        const entries = rows.map(publicEntry);
        yield format === "csv"
          ? entries.map((e) => [e.position, e.recordDigest, e.action, e.display, e.name, e.signedAt, e.method, e.capacity].map(csvField).join(",") + "\n").join("")
          : (from ? "," : "") + entries.map((e) => JSON.stringify(e)).join(",");
      }
      if (format === "json") yield "]}";
    },
    /** Public signer directory: opted-in names only, cursor-paginated, prefix search. */
    directory(editionId, { kind, q = null, after = null, limit = 50 } = {}) {
      ids(editionId); kindOf(kind);
      check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, "INVALID_PAGE");
      let prefix = null, upper = null, cursor = null;
      if (q !== null) {
        try { prefix = nameKey(q); } catch { throw new DocumentError("INVALID_QUERY"); }
        const chars = Array.from(prefix), last = chars.pop().codePointAt(0);
        upper = last < 0x10ffff ? chars.join("") + String.fromCodePoint(last + 1 + (last + 1 >= 0xd800 && last + 1 <= 0xdfff ? 0x800 : 0)) : null;
      }
      if (after !== null) {
        try {
          cursor = JSON.parse(Buffer.from(after, "base64url").toString("utf8"));
          check(Array.isArray(cursor) && cursor.length === 2 && Number.isSafeInteger(cursor[1]) && (q === null ? cursor[0] === null : typeof cursor[0] === "string" && cursor[0].length <= 480), "INVALID_PAGE");
        } catch { throw new DocumentError("INVALID_PAGE"); }
      }
      return publicScope(editionId, async (db) => {
        const exists = (await db.query("SELECT 1 FROM dge_editions.editions WHERE id=$1", [editionId])).rows.length;
        check(exists, "EDITION_NOT_FOUND", 404);
        const rows = q === null
          ? (await db.query(
            `SELECT d.seq,d.public_name,d.name_key,d.signed_at,r.record_digest FROM dge_signatures.directory d JOIN dge_signatures.records r ON r.id=d.record_id
             WHERE d.edition_id=$1 AND d.kind=$2 AND ($3::bigint IS NULL OR d.seq>$3) ORDER BY d.seq LIMIT $4`,
            [editionId, kind, cursor?.[1] ?? null, limit + 1])).rows
          : (await db.query(
            `SELECT d.seq,d.public_name,d.name_key,d.signed_at,r.record_digest FROM dge_signatures.directory d JOIN dge_signatures.records r ON r.id=d.record_id
             WHERE d.edition_id=$1 AND d.kind=$2 AND d.name_key>=$3 AND ($4::text IS NULL OR d.name_key<$4)
               AND ($5::text IS NULL OR (d.name_key,d.seq)>($5::text COLLATE "C",$6::bigint)) ORDER BY d.name_key,d.seq LIMIT $7`,
            [editionId, kind, prefix, upper, cursor?.[0] ?? null, cursor?.[1] ?? 0, limit + 1])).rows;
        const counts = (await db.query("SELECT COALESCE(sum(active_count),0)::bigint AS active,COALESCE(sum(public_count),0)::bigint AS shown FROM dge_signatures.tallies WHERE edition_id=$1 AND kind=$2",
          [editionId, kind])).rows[0];
        const last = rows[limit - 1];
        return {
          kind, total: Number(counts.active), publiclyNamed: Number(counts.shown),
          items: rows.slice(0, limit).map((r) => ({ name: r.public_name, signedAt: iso(r.signed_at), recordDigest: r.record_digest })),
          nextCursor: rows.length > limit ? Buffer.from(JSON.stringify([q === null ? null : last.name_key, Number(last.seq)])).toString("base64url") : null,
        };
      });
    },
    /** Public lookup by record digest: inclusion proof, plus the record only if public. */
    publicReceipt(editionId, digestHex) {
      ids(editionId);
      check(HEX.test(digestHex ?? ""), "INVALID_RECORD_DIGEST");
      return publicScope(editionId, async (db) => {
        const row = (await db.query(
          `SELECT r.id,r.edition_id,r.kind,r.action,r.record_digest,r.display,r.public_record,r.public_mark,e.position FROM dge_signatures.records r
           LEFT JOIN dge_signatures.manifest_entries e ON e.record_id=r.id WHERE r.edition_id=$1 AND r.record_digest=$2`, [editionId, digestHex])).rows[0];
        check(row, "SIGNATURE_NOT_FOUND", 404);
        const receipt = await inclusion(db, row, { record: row.public_record ?? null, intent: null });
        return { ...receipt, kind: row.kind, action: row.action, display: row.display, mark: row.public_mark ?? null };
      });
    },
  });
}
