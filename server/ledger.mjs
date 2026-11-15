// Transparency log service: sequences committed outbox events into the
// append-only Merkle log, issues Ed25519-signed checkpoints, accepts witness
// cosignatures and drives the durable anchor queue. The log holds digests
// only. Request handlers never write here; the worker runs in transactions
// that declare dge.worker='ledger', which the row policies require.
import { createPrivateKey, createPublicKey, sign, randomUUID } from "node:crypto";
import {
  appendLeaf, rootHash, inclusionProof, consistencyProof, entryLeafHash,
  checkpointBody, checkpointSigningInput, checkpointDigest, keyIdFor,
  verifyEd25519, EMPTY_ROOT, MAX_LOG_SIZE,
} from "../src/transparency.mjs";
import { DocumentError } from "./document-store.mjs";

const HEX = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const fail = (code, status = 400) => { throw new DocumentError(code, status); };
const check = (condition, code, status) => { if (!condition) fail(code, status); };

/**
 * Outbox sources: each maps an existing committed event table onto log
 * entries. `types` are the key column types, so the write-back compares the
 * columns themselves (index-usable) rather than their text casts.
 */
const SOURCES = [
  { table: "dge_documents.anchor_outbox", key: ["tenant_id", "document_id", "version"], types: ["uuid", "uuid", "integer"], kind: "'document-version'", subject: "document_id", scope: "'public'", final: "false" },
  { table: "dge_proposals.anchor_outbox", key: ["tenant_id", "document_id", "proposal_id"], types: ["uuid", "uuid", "uuid"], kind: "'proposal'", subject: "document_id", scope: "'public'", final: "false" },
  { table: "dge_discussion.anchor_outbox", key: ["tenant_id", "event_id"], types: ["uuid", "uuid"], kind: "'discussion-event'", subject: "document_id", scope: "'public'", final: "false" },
  { table: "dge_decisions.anchor_outbox", key: ["tenant_id", "event_id"], types: ["uuid", "uuid"], kind: "'decision-event'", subject: "decision_id", scope: "'public'", final: "false" },
  { table: "dge_ledger.outbox", key: ["id"], types: ["uuid"], kind: "kind", subject: "subject_id", scope: "scope", final: "finalization" },
];

export function loadLogSigningKey(base64Pkcs8) {
  check(typeof base64Pkcs8 === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(base64Pkcs8), "LOG_KEY_INVALID", 503);
  const privateKey = createPrivateKey({ key: Buffer.from(base64Pkcs8, "base64"), format: "der", type: "pkcs8" });
  check(privateKey.asymmetricKeyType === "ed25519", "LOG_KEY_INVALID", 503);
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const publicKey = Buffer.from(spki.subarray(spki.length - 32)).toString("base64");
  return Object.freeze({ privateKey, publicKey, keyId: keyIdFor(publicKey) });
}

const nodeReader = (db) => {
  const cache = new Map();
  const getNode = async (level, index) => {
    const key = level + ":" + index;
    if (!cache.has(key)) {
      const row = (await db.query("SELECT hash FROM dge_ledger.nodes WHERE level=$1 AND idx=$2", [level, index])).rows[0];
      if (!row) throw Error("Transparency log node missing");
      cache.set(key, row.hash);
    }
    return cache.get(key);
  };
  getNode.remember = (level, index, hash) => cache.set(level + ":" + index, hash);
  return getNode;
};
const isoTime = (value) => new Date(value).toISOString();
const publicAnchor = (row) => ({
  id: row.id, size: Number(row.size), provider: row.provider, network: row.network, reason: row.reason,
  status: row.status, checkpointDigest: row.checkpoint_digest, proof: row.proof ?? null,
  blockHeight: row.block_height === null ? null : Number(row.block_height), blockHash: row.block_hash ?? null,
  confirmations: row.confirmations ?? null, attempts: row.attempts, lastError: row.last_error ?? null,
  updatedAt: isoTime(row.updated_at),
});

export function createLedger({
  transaction, logId, signingKey, clock = Date.now, anchorProviders = [],
  anchorIntervalMs = 3600000, checkpointIntervalMs = 60000, anchorMaxAttempts = 48,
  anchorSpendCap = 0n, batchSize = 500, onError = () => {},
}) {
  check(typeof transaction === "function" && signingKey?.privateKey && /^[a-z0-9][a-z0-9.-]{2,80}$/.test(logId ?? ""), "LEDGER_CONFIG", 503);
  const now = () => new Date(clock());
  const worker = async (fn) => transaction(async (db) => {
    await db.query("SELECT set_config('dge.worker','ledger',true)");
    return fn(db);
  });
  const publicRead = (fn) => transaction(fn);

  async function sequence() {
    return worker(async (db) => {
      const size = Number((await db.query("SELECT size FROM dge_ledger.head WHERE id FOR UPDATE")).rows[0].size);
      // Each source contributes at most one batch in the global order, so the
      // final sort never touches the whole backlog.
      const union = SOURCES.map((s, i) =>
        `(SELECT ${i} AS source, ${s.key.map((k, j) => `${k}::text AS k${j}`).join(",")}${s.key.length < 3 ? "," + Array.from({ length: 3 - s.key.length }, (_, j) => `NULL::text AS k${s.key.length + j}`).join(",") : ""},
          ${s.kind} AS kind, ${s.scope} AS scope, tenant_id, ${s.subject} AS subject_id, event_digest, ${s.final} AS finalization, created_at
          FROM ${s.table} WHERE ledger_seq IS NULL ORDER BY created_at, k0, k1, k2 LIMIT $1)`).join(" UNION ALL ");
      const rows = (await db.query(`SELECT * FROM (${union}) pending ORDER BY created_at, source, k0, k1, k2 LIMIT $1`, [batchSize])).rows;
      if (!rows.length) return 0;
      const getNode = nodeReader(db);
      let treeSize = size;
      const at = now();
      for (const row of rows) {
        check(treeSize < MAX_LOG_SIZE, "LOG_FULL", 503);
        const entry = { kind: row.kind, scope: row.scope, subjectId: row.subject_id, eventDigest: row.event_digest.trim() };
        const existing = (await db.query("SELECT seq FROM dge_ledger.entries WHERE kind=$1 AND event_digest=$2", [entry.kind, entry.eventDigest])).rows[0];
        let seq;
        if (existing) seq = Number(existing.seq); // Idempotent: an identical event is logged once.
        else {
          const leaf = entryLeafHash(entry);
          for (const node of await appendLeaf(treeSize, leaf, getNode)) {
            await db.query("INSERT INTO dge_ledger.nodes(level,idx,hash) VALUES($1,$2,$3)", [node.level, node.index, node.hash]);
            getNode.remember(node.level, node.index, node.hash);
          }
          await db.query(
            "INSERT INTO dge_ledger.entries(seq,kind,scope,tenant_id,subject_id,event_digest,leaf_hash,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
            [treeSize, entry.kind, entry.scope, row.tenant_id, entry.subjectId, entry.eventDigest, leaf, at]);
          seq = treeSize++;
        }
        const source = SOURCES[row.source];
        await db.query(`UPDATE ${source.table} SET ledger_seq=$1 WHERE ${source.key.map((k, j) => `${k}=$${j + 2}::${source.types[j]}`).join(" AND ")}`,
          [seq, ...source.key.map((_, j) => row["k" + j])]);
      }
      await db.query("UPDATE dge_ledger.head SET size=$1 WHERE id", [treeSize]);
      return rows.length;
    });
  }

  async function issueCheckpoint({ force = false } = {}) {
    return worker(async (db) => {
      const size = Number((await db.query("SELECT size FROM dge_ledger.head WHERE id FOR UPDATE")).rows[0].size);
      const last = (await db.query("SELECT size,issued_at FROM dge_ledger.checkpoints ORDER BY size DESC LIMIT 1")).rows[0];
      if (last && Number(last.size) === size) return null;
      if (!force && last && clock() - new Date(last.issued_at).getTime() < checkpointIntervalMs) return null;
      if (!last && size === 0 && !force) return null;
      const root = size === 0 ? EMPTY_ROOT : await rootHash(size, nodeReader(db));
      const body = checkpointBody({ logId, size, rootHash: root, issuedAt: now().toISOString() });
      const signature = sign(null, Buffer.from(checkpointSigningInput(body)), signingKey.privateKey).toString("base64");
      const digest = checkpointDigest(body);
      await db.query(
        "INSERT INTO dge_ledger.checkpoints(size,root_hash,issued_at,key_id,body,signature,checkpoint_digest) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [size, root, body.issuedAt, signingKey.keyId, body, signature, digest]);
      return { body, signature, keyId: signingKey.keyId, checkpointDigest: digest };
    });
  }

  /** Queue periodic anchors and immediate anchors for finalization events. */
  async function scheduleAnchors() {
    if (!anchorProviders.length) return 0;
    return worker(async (db) => {
      const latest = (await db.query("SELECT size,checkpoint_digest FROM dge_ledger.checkpoints WHERE size>0 ORDER BY size DESC LIMIT 1")).rows[0];
      if (!latest) return 0;
      const size = Number(latest.size);
      let created = 0;
      for (const provider of anchorProviders) {
        const last = (await db.query("SELECT size,created_at FROM dge_ledger.anchors WHERE provider=$1 ORDER BY size DESC LIMIT 1", [provider.id])).rows[0];
        if (last && Number(last.size) >= size) continue;
        const covered = last ? Number(last.size) : 0;
        const finalization = (await db.query(
          `SELECT 1 FROM dge_ledger.outbox o WHERE o.finalization AND o.ledger_seq IS NOT NULL AND o.ledger_seq>=$1 AND o.ledger_seq<$2 LIMIT 1`,
          [covered, size])).rows.length > 0;
        const due = !last || clock() - new Date(last.created_at).getTime() >= anchorIntervalMs;
        if (!finalization && !due) continue;
        await db.query(
          `INSERT INTO dge_ledger.anchors(id,size,checkpoint_digest,provider,network,reason,status,next_attempt_at,created_at,updated_at)
           VALUES($1,$2,$3,$4,$5,$6,'pending',$7,$7,$7) ON CONFLICT (size,provider) DO NOTHING`,
          [randomUUID(), size, latest.checkpoint_digest, provider.id, provider.network, finalization ? "finalization" : "periodic", now()]);
        created++;
      }
      return created;
    });
  }

  const backoff = (attempts) => Math.min(6 * 3600000, 60000 * 2 ** Math.min(attempts, 8));
  /** Advances due anchors. Network calls happen outside database transactions. */
  async function processAnchors(limit = 10) {
    const due = await worker(async (db) => {
      const rows = (await db.query(
        `SELECT * FROM dge_ledger.anchors WHERE status IN ('pending','submitted','confirmed') AND next_attempt_at<=$1
         ORDER BY next_attempt_at LIMIT $2 FOR UPDATE SKIP LOCKED`, [now(), limit])).rows;
      for (const row of rows) // Short lease so a concurrent worker skips it.
        await db.query("UPDATE dge_ledger.anchors SET next_attempt_at=$2,updated_at=$3 WHERE id=$1", [row.id, new Date(clock() + 300000), now()]);
      return rows;
    });
    for (const row of due) {
      const provider = anchorProviders.find((p) => p.id === row.provider);
      let update;
      try {
        if (!provider) throw Object.assign(Error("provider-unavailable"), { permanent: true });
        if (row.status === "pending") {
          const cost = BigInt(provider.costPerSubmission ?? 0);
          if (BigInt(row.cost_units) + cost > anchorSpendCap && cost > 0n)
            throw Object.assign(Error("spend-cap-reached"), { permanent: true });
          const submitted = await provider.submit(row.checkpoint_digest.trim());
          update = { status: "submitted", proof: submitted.proof, cost: BigInt(row.cost_units) + cost, next: clock() + 600000, error: null };
        } else {
          let proof = row.proof;
          if (row.status === "submitted") proof = (await provider.upgrade(proof)).proof;
          const result = await provider.verify(proof, row.checkpoint_digest.trim());
          if (result.status === "final")
            update = { status: "final", proof, height: result.height, hash: result.blockHash, confirmations: result.confirmations, next: clock(), error: null };
          else if (result.status === "confirmed")
            update = { status: "confirmed", proof, height: result.height, hash: result.blockHash, confirmations: result.confirmations, next: clock() + 1800000, error: null };
          else if (result.status === "invalid")
            update = { status: "submitted", proof, next: clock() + backoff(row.attempts), error: result.reason ?? "invalid" };
          else update = { status: "submitted", proof, next: clock() + (result.status === "pending" ? 1800000 : backoff(row.attempts)), error: result.status === "pending" ? null : (result.reason ?? result.status) };
        }
      } catch (error) {
        onError(error);
        const attempts = row.attempts + 1;
        const permanent = error?.permanent || attempts >= anchorMaxAttempts;
        update = { status: permanent ? "failed" : row.status, proof: row.proof, next: clock() + backoff(attempts),
          error: String(error?.code ?? error?.message ?? "anchor-error").replace(/[^a-z0-9 .:_-]/gi, "").slice(0, 120), attempts };
      }
      await worker((db) => db.query(
        `UPDATE dge_ledger.anchors SET status=$2,proof=$3,block_height=COALESCE($4,block_height),block_hash=COALESCE($5,block_hash),
           confirmations=COALESCE($6,confirmations),attempts=$7,next_attempt_at=$8,last_error=$9,cost_units=$10,updated_at=$11 WHERE id=$1`,
        [row.id, update.status, update.proof ?? null, update.height ?? null, update.hash ?? null, update.confirmations ?? null,
          update.attempts ?? (update.error ? row.attempts + 1 : row.attempts), new Date(update.next), update.error,
          String(update.cost ?? row.cost_units), now()]));
    }
    return due.length;
  }

  async function checkpointAt(db, size = null) {
    const row = (await db.query(
      size === null ? "SELECT * FROM dge_ledger.checkpoints ORDER BY size DESC LIMIT 1" : "SELECT * FROM dge_ledger.checkpoints WHERE size=$1",
      size === null ? [] : [size])).rows[0];
    if (!row) return null;
    const witnesses = (await db.query(
      `SELECT s.key_id,s.signature,w.name,w.public_key FROM dge_ledger.witness_signatures s JOIN dge_ledger.witness_keys w USING(key_id)
       WHERE s.size=$1 AND w.revoked_at IS NULL ORDER BY s.key_id`, [row.size])).rows;
    const anchors = (await db.query("SELECT * FROM dge_ledger.anchors WHERE size=$1 ORDER BY provider", [row.size])).rows;
    return {
      body: row.body, signature: row.signature, keyId: row.key_id, checkpointDigest: row.checkpoint_digest.trim(),
      witnesses: witnesses.map((w) => ({ keyId: w.key_id, name: w.name, publicKey: w.public_key, signature: w.signature })),
      anchors: anchors.map(publicAnchor),
    };
  }
  const logKey = () => ({ logId, keyId: signingKey.keyId, publicKey: signingKey.publicKey, algorithm: "Ed25519" });

  return Object.freeze({
    logId, publicKey: logKey,
    sequence, issueCheckpoint, scheduleAnchors, processAnchors,
    /** One pass of every background duty; safe to run concurrently. */
    async tick() {
      let sequenced = 0, pass;
      do { pass = await sequence(); sequenced += pass; } while (pass === batchSize);
      const checkpoint = await issueCheckpoint();
      const scheduled = await scheduleAnchors();
      const anchors = await processAnchors();
      return { sequenced, checkpoint: checkpoint?.body.size ?? null, scheduled, anchors };
    },
    latestCheckpoint: () => publicRead(async (db) => ({ key: logKey(), checkpoint: await checkpointAt(db) })),
    checkpoint: (size) => {
      check(Number.isSafeInteger(size) && size >= 0, "INVALID_LOG_SIZE");
      return publicRead(async (db) => {
        const result = await checkpointAt(db, size);
        check(result, "CHECKPOINT_NOT_FOUND", 404);
        return { key: logKey(), checkpoint: result };
      });
    },
    checkpoints: ({ before = null, limit = 50 } = {}) => {
      check((before === null || (Number.isSafeInteger(before) && before > 0)) && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, "INVALID_PAGE");
      return publicRead(async (db) => {
        const rows = (await db.query(
          "SELECT size,root_hash,issued_at,checkpoint_digest FROM dge_ledger.checkpoints WHERE ($1::bigint IS NULL OR size<$1) ORDER BY size DESC LIMIT $2",
          [before, limit + 1])).rows;
        return {
          items: rows.slice(0, limit).map((r) => ({ size: Number(r.size), rootHash: r.root_hash.trim(), issuedAt: isoTime(r.issued_at), checkpointDigest: r.checkpoint_digest.trim() })),
          nextCursor: rows.length > limit ? Number(rows[limit - 1].size) : null,
        };
      });
    },
    consistency: (first, second) => {
      check(Number.isSafeInteger(first) && Number.isSafeInteger(second) && first >= 1 && first <= second, "INVALID_LOG_RANGE");
      return publicRead(async (db) => {
        const sizes = (await db.query("SELECT size FROM dge_ledger.checkpoints WHERE size=$1 OR size=$2", [first, second])).rows.map((r) => Number(r.size));
        check(sizes.includes(first) && sizes.includes(second), "CHECKPOINT_NOT_FOUND", 404);
        return { first, second, proof: await consistencyProof(first, second, nodeReader(db)) };
      });
    },
    /** Inclusion proof for an event digest against a published checkpoint. */
    proof: ({ eventDigest, kind = null, size = null }) => {
      check(HEX.test(eventDigest ?? "") && (kind === null || /^[a-z][a-z0-9-]{1,40}$/.test(kind)), "INVALID_LOG_QUERY");
      return publicRead(async (db) => {
        const entry = (await db.query(
          "SELECT * FROM dge_ledger.entries WHERE event_digest=$1 AND ($2::text IS NULL OR kind=$2) ORDER BY seq LIMIT 1",
          [eventDigest, kind])).rows[0];
        if (!entry) return { status: "not-yet-logged", eventDigest };
        const cp = await checkpointAt(db, size);
        if (!cp || Number(cp.body.size) <= Number(entry.seq))
          return { status: "logged-awaiting-checkpoint", entry: publicEntry(entry) };
        return {
          status: "included", entry: publicEntry(entry), key: logKey(), checkpoint: cp,
          proof: await inclusionProof(Number(entry.seq), Number(cp.body.size), nodeReader(db)),
        };
      });
    },
    entries: ({ subjectId, after = null, limit = 100 }) => {
      check(UUID.test(subjectId ?? "") && (after === null || (Number.isSafeInteger(after) && after >= 0)) && Number.isSafeInteger(limit) && limit >= 1 && limit <= 500, "INVALID_LOG_QUERY");
      return publicRead(async (db) => {
        const rows = (await db.query(
          "SELECT * FROM dge_ledger.entries WHERE subject_id=$1 AND ($2::bigint IS NULL OR seq>$2) ORDER BY seq LIMIT $3",
          [subjectId, after, limit + 1])).rows;
        return { items: rows.slice(0, limit).map(publicEntry), nextCursor: rows.length > limit ? Number(rows[limit - 1].seq) : null };
      });
    },
    anchors: ({ limit = 50 } = {}) => publicRead(async (db) =>
      ({ items: (await db.query("SELECT * FROM dge_ledger.anchors ORDER BY size DESC, provider LIMIT $1", [Math.min(Math.max(limit, 1), 200)])).rows.map(publicAnchor) })),
    /** Platform-operator action; the caller must already be authorized. */
    registerWitness: ({ name, publicKey }) => {
      check(typeof name === "string" && name.trim().length >= 1 && name.length <= 120 && typeof publicKey === "string" && Buffer.from(publicKey, "base64").length === 32, "INVALID_WITNESS");
      return worker(async (db) => {
        const keyId = keyIdFor(publicKey);
        await db.query("INSERT INTO dge_ledger.witness_keys(key_id,name,public_key,added_at) VALUES($1,$2,$3,$4) ON CONFLICT (key_id) DO NOTHING",
          [keyId, name.trim(), publicKey, now()]);
        return { keyId };
      });
    },
    revokeWitness: (keyId) => {
      check(HEX.test(keyId ?? ""), "INVALID_WITNESS");
      return worker(async (db) => {
        check((await db.query("UPDATE dge_ledger.witness_keys SET revoked_at=$2 WHERE key_id=$1 AND revoked_at IS NULL RETURNING key_id", [keyId, now()])).rows.length, "WITNESS_NOT_FOUND", 404);
        return { revoked: true };
      });
    },
    /** A registered independent witness countersigns a checkpoint it verified. */
    cosign: async ({ size, keyId, signature }) => {
      check(Number.isSafeInteger(size) && size >= 0 && HEX.test(keyId ?? "") && typeof signature === "string" && signature.length <= 200, "INVALID_COSIGNATURE");
      return worker(async (db) => {
        const witness = (await db.query("SELECT * FROM dge_ledger.witness_keys WHERE key_id=$1 AND revoked_at IS NULL", [keyId])).rows[0];
        check(witness, "WITNESS_NOT_FOUND", 404);
        const cp = (await db.query("SELECT body FROM dge_ledger.checkpoints WHERE size=$1", [size])).rows[0];
        check(cp, "CHECKPOINT_NOT_FOUND", 404);
        check(await verifyEd25519(witness.public_key, signature, checkpointSigningInput(cp.body)), "INVALID_COSIGNATURE", 403);
        await db.query("INSERT INTO dge_ledger.witness_signatures(size,key_id,signature,received_at) VALUES($1,$2,$3,$4) ON CONFLICT (size,key_id) DO NOTHING",
          [size, keyId, signature, now()]);
        return { accepted: true };
      });
    },
  });
}
const publicEntry = (row) => ({
  seq: Number(row.seq), kind: row.kind, scope: row.scope, subjectId: row.subject_id,
  eventDigest: row.event_digest.trim(), leafHash: row.leaf_hash.trim(), recordedAt: isoTime(row.recorded_at),
});

/** Append to the shared outbox inside the caller's tenant-scoped transaction. */
export async function appendLedgerEvent(db, { tenantId, kind, subjectId, eventDigest, scope = "public", finalization = false, at }) {
  check(UUID.test(tenantId) && UUID.test(subjectId) && HEX.test(eventDigest) && /^[a-z][a-z0-9-]{1,40}$/.test(kind) && ["public", "blinded"].includes(scope), "INVALID_LEDGER_EVENT");
  await db.query(
    "INSERT INTO dge_ledger.outbox(id,tenant_id,kind,scope,subject_id,event_digest,finalization,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (kind,event_digest) DO NOTHING",
    [randomUUID(), tenantId, kind, scope, subjectId, eventDigest, finalization, at]);
}
