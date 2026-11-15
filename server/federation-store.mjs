// DCE-037 federation service: authority-side acceptance of delayed ballot
// envelopes, signed portable snapshots, mirror verification and the durable
// store-and-forward queue between explicitly registered peers. Protocol rules
// live in src/federation.mjs; this module persists them. Instance identity is
// the transparency log identity and its Ed25519 log key.
import { sign, randomUUID } from "node:crypto";
import {
  FEDERATION_SCHEMAS, RECEIPT_KINDS, BINDING_KIND, LOG_CHANNEL,
  signObject, verifySignedObject, objectDigest, pinPeer, applyKeyRotation, peerKey,
  authorityClaimBody, compareAuthority, decisionDescriptorBody, keyBindingBody, bindingEventDigest,
  verifyEnvelope, judgeEnvelope, receiptBody, receiptLogEntry, observeCheckpoint, auditReceipt,
  verifySnapshotBundle, createMessage, verifyMessage, classifyIncoming, retryDelayMs, verifyRequest,
  signRequest, isUuid, isInstanceId, relayStatusBody,
} from "../src/federation.mjs";
import { verifyCheckpoint, keyIdFor, inclusionProof, consistencyProof } from "../src/transparency.mjs";
import { validateGovernanceSnapshot } from "../src/governance-snapshots.mjs";
import { appendLedgerEvent } from "./ledger.mjs";
import { DocumentError } from "./document-store.mjs";

const fail = (code, status = 400) => { throw new DocumentError(code, status); };
const check = (condition, code, status) => { if (!condition) fail(code, status); };
const managerial = ["owner", "admin"];
const voting = ["owner", "admin", "editor", "participant"];
const iso = (value) => new Date(value).toISOString();
const MAX_BATCH = 100;

// Log reads inside the caller's transaction (the ledger service would open a
// second one, which also deadlocks single-connection databases).
const nodeReader = (db) => {
  const cache = new Map();
  return async (level, index) => {
    const key = level + ":" + index;
    if (!cache.has(key)) {
      const row = (await db.query("SELECT hash FROM dge_ledger.nodes WHERE level=$1 AND idx=$2", [level, index])).rows[0];
      if (!row) throw Error("Transparency log node missing");
      cache.set(key, row.hash.trim());
    }
    return cache.get(key);
  };
};
async function logCheckpoint(db, size = null) {
  const row = (await db.query(size === null
    ? "SELECT body,key_id,signature FROM dge_ledger.checkpoints ORDER BY size DESC LIMIT 1"
    : "SELECT body,key_id,signature FROM dge_ledger.checkpoints WHERE size=$1", size === null ? [] : [size])).rows[0];
  return row ? { body: row.body, keyId: row.key_id.trim(), signature: row.signature } : null;
}
async function logInclusion(db, kind, eventDigest, checkpoint) {
  const entry = (await db.query("SELECT seq FROM dge_ledger.entries WHERE kind=$1 AND event_digest=$2", [kind, eventDigest])).rows[0];
  if (!entry || !checkpoint || Number(entry.seq) >= checkpoint.body.size) return null;
  return { index: Number(entry.seq), proof: await inclusionProof(Number(entry.seq), checkpoint.body.size, nodeReader(db)) };
}
const logConsistency = async (db, from, to) => ({ fromSize: from, proof: await consistencyProof(from, to, nodeReader(db)) });

/** Adapts the instance log key (node:crypto KeyObject) to the protocol signer. */
export const logKeySigner = (signingKey) => Object.freeze({
  keyId: signingKey.keyId, publicKey: signingKey.publicKey,
  sign: async (bytes) => sign(null, Buffer.from(bytes), signingKey.privateKey).toString("base64"),
});

export function createFederationStore({
  transaction, identity, instanceId, origin, signingKey, clock = Date.now,
  fetch = globalThis.fetch, maxMergeDelayMs = 3_600_000, deliveryBatch = 50, onError = () => {},
}) {
  check(typeof transaction === "function" && identity && isInstanceId(instanceId) &&
    signingKey?.privateKey && typeof origin === "string" && origin.startsWith("https://"), "FEDERATION_CONFIG", 503);
  const signer = logKeySigner(signingKey);
  const now = () => {
    const ms = clock();
    check(Number.isSafeInteger(ms) && ms >= 0, "CLOCK_UNAVAILABLE", 503);
    return ms;
  };
  const enter = (db) => db.query("SELECT set_config('dge.worker','federation',true)");
  const worker = (fn) => transaction(async (db) => { await enter(db); return fn(db); });
  const tenantScope = (db, tenantId) => db.query("SELECT set_config('dge.tenant_id',$1,true)", [tenantId]);
  const peerRow = async (db, id) => (await db.query("SELECT * FROM dge_federation.peers WHERE instance_id=$1", [id])).rows[0];
  const activePeer = async (db, id) => {
    const row = await peerRow(db, id);
    return row?.status === "active" ? row.record : null;
  };
  const recordEvidence = (db, peer, kind, documentId, details) => db.query(
    "INSERT INTO dge_federation.evidence(id,peer,kind,document_id,details,observed_at) VALUES($1,$2,$3,$4,$5,$6)",
    [randomUUID(), peer, kind, documentId, details, new Date(now())]);

  /** Appends one signed message to the (recipient, document) channel. */
  async function enqueue(db, recipient, documentId, type, payload) {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["federation-outbox:" + recipient + ":" + documentId]);
    const sequence = Number((await db.query(
      "SELECT COALESCE(max(sequence),0)+1 AS n FROM dge_federation.outbox WHERE recipient=$1 AND document_id=$2", [recipient, documentId])).rows[0].n);
    const at = new Date(now());
    const message = await createMessage({ from: instanceId, to: recipient, documentId, sequence, type, payload, createdAt: at.toISOString() }, signer);
    await db.query(
      "INSERT INTO dge_federation.outbox(id,recipient,document_id,sequence,message,created_at,next_attempt_at) VALUES($1,$2,$3,$4,$5,$6,$6)",
      [message.id, recipient, documentId, sequence, message, at]);
    return message.id;
  }

  async function localDecision(db, decisionId) {
    const row = (await db.query("SELECT * FROM dge_federation.decisions WHERE decision_id=$1", [decisionId])).rows[0];
    return row ?? null;
  }

  /** Authority: decides one envelope in receive order; returns the signed receipt. */
  async function decideEnvelope(db, envelope, via) {
    const decisionId = envelope?.body?.decisionId;
    check(isUuid(decisionId), "INVALID_ENVELOPE");
    const federated = await localDecision(db, decisionId);
    check(federated, "DECISION_NOT_FEDERATED", 404);
    await tenantScope(db, federated.tenant_id);
    // Shares the decision lock with local ballots; closure waits for it.
    const decision = (await db.query("SELECT id,state,snapshot_digest FROM dge_decisions.decisions WHERE tenant_id=$1 AND id=$2 FOR SHARE",
      [federated.tenant_id, decisionId])).rows[0];
    check(decision, "DECISION_NOT_FOUND", 404);
    const verified = await verifyEnvelope(envelope, { descriptor: federated.descriptor, authorityKey: signer.publicKey });
    check(verified.ok, "INVALID_ENVELOPE", 400);
    const { id, body, binding } = verified;
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["federation-voter:" + decisionId + ":" + body.voterKeyId]);
    const history = (await db.query(
      "SELECT envelope_id,sequence,status,receipt FROM dge_federation.envelopes WHERE decision_id=$1 AND voter_key_id=$2",
      [decisionId, body.voterKeyId])).rows.map((r) => ({ envelopeId: r.envelope_id, sequence: r.sequence, status: r.status, receipt: r.receipt }));
    const bound = (await db.query(
      "SELECT b.account_id,b.generation,(SELECT max(generation) FROM dge_federation.key_bindings c WHERE c.decision_id=b.decision_id AND c.account_id=b.account_id AND c.active) AS current FROM dge_federation.key_bindings b WHERE b.decision_id=$1 AND b.voter_key_id=$2",
      [decisionId, body.voterKeyId])).rows[0];
    check(bound, "UNKNOWN_VOTER_KEY", 403);
    const receivedAt = now();
    let verdict = judgeEnvelope({
      descriptor: federated.descriptor, envelopeIdentity: id, body, binding, receivedAt, history,
      currentGeneration: bound.current === null ? -1 : Number(bound.current),
    });
    if (verdict.status === "duplicate") return { receipt: verdict.decided.receipt, duplicate: true };
    if (verdict.status === "accepted" && decision.state !== "open") verdict = { status: "rejected", reason: "decision-closed" };
    const at = new Date(receivedAt);
    const receipt = await signObject(FEDERATION_SCHEMAS.receipt, receiptBody({
      authority: instanceId, decisionId, envelopeId: id, voterKeyId: body.voterKeyId, sequence: body.sequence,
      status: verdict.status, reason: verdict.reason, receivedAt: at.toISOString(), cutoffAt: federated.descriptor.body.cutoffAt,
    }), signer);
    await db.query(
      "INSERT INTO dge_federation.envelopes(envelope_id,decision_id,voter_key_id,sequence,status,reason,via,envelope,receipt,received_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [id, decisionId, body.voterKeyId, body.sequence, verdict.status, verdict.reason, via, envelope, receipt, at]);
    if (verdict.status === "accepted") {
      const prior = (await db.query("SELECT version FROM dge_decisions.ballots WHERE tenant_id=$1 AND decision_id=$2 AND account_id=$3",
        [federated.tenant_id, decisionId, bound.account_id])).rows[0];
      const version = (prior?.version ?? 0) + 1;
      check(version <= 100, "BALLOT_CHANGE_LIMIT_REACHED", 429);
      await db.query(
        "INSERT INTO dge_decisions.ballots(tenant_id,decision_id,account_id,choice,version,cast_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,decision_id,account_id) DO UPDATE SET choice=excluded.choice,version=excluded.version,cast_at=excluded.cast_at",
        [federated.tenant_id, decisionId, bound.account_id, body.choice, version, new Date(body.castAt)]);
      const eventId = randomUUID(), commandId = [id.slice(0, 8), id.slice(8, 12), "4" + id.slice(13, 16), "8" + id.slice(17, 20), id.slice(20, 32)].join("-");
      const result = { decisionId, version, receiptEventDigest: receipt.body.eventDigest };
      const eventDigest = objectDigest(FEDERATION_SCHEMAS.receipt, receipt.body);
      await db.query(
        "INSERT INTO dge_decisions.events(tenant_id,id,decision_id,actor_id,command_id,request_digest,result,event_digest,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [federated.tenant_id, eventId, decisionId, bound.account_id, commandId, id, result, eventDigest, at]);
    }
    await appendLedgerEvent(db, { tenantId: federated.tenant_id, ...receiptLogEntry(receipt.body), at });
    return { receipt, duplicate: false };
  }

  /** Signed bundle for one locally owned document, or null until its edition is in a checkpoint. */
  async function exportBundle(db, documentId) {
    const authority = (await db.query("SELECT * FROM dge_federation.authorities WHERE document_id=$1 AND local", [documentId])).rows[0];
    check(authority, "NOT_AUTHORITY", 404);
    await tenantScope(db, authority.tenant_id);
    const claim = authority.claim;
    let edition, checkpoint, evidence = [];
    if (claim.body.visibility === "public") {
      const v = (await db.query(
        `SELECT v.*, r.source_version, r.source_digest FROM dge_documents.versions v
         LEFT JOIN dge_documents.restorations r ON r.tenant_id=v.tenant_id AND r.document_id=v.document_id AND r.version=v.version
         WHERE v.tenant_id=$1 AND v.document_id=$2 ORDER BY v.version DESC LIMIT 1`, [authority.tenant_id, documentId])).rows[0];
      check(v, "DOCUMENT_NOT_FOUND", 404);
      edition = {
        tenantId: v.tenant_id, documentId, version: v.version, digest: v.digest.trim(), previousDigest: v.previous_digest?.trim() ?? null,
        createdAt: iso(v.created_at), restoration: v.source_version === null ? null : { sourceVersion: v.source_version, sourceDigest: v.source_digest.trim() },
        document: v.document,
      };
      checkpoint = await logCheckpoint(db);
      const included = await logInclusion(db, "document-version", v.event_digest.trim(), checkpoint);
      if (!included) return null;
      evidence = [{ kind: "document-version", subjectId: documentId, eventDigest: v.event_digest.trim(), ...included }];
    } else {
      const v = (await db.query(
        "SELECT version,digest,octet_length(ciphertext) AS bytes FROM dge_private.versions WHERE tenant_id=$1 AND document_id=$2 ORDER BY version DESC LIMIT 1",
        [authority.tenant_id, documentId])).rows[0];
      check(v, "DOCUMENT_NOT_FOUND", 404);
      edition = {
        version: v.version, ciphertextDigest: v.digest.trim(), byteLength: Number(v.bytes),
        ciphertextUri: origin + "/api/workspaces/" + authority.tenant_id + "/private-documents/" + documentId,
      };
      checkpoint = await logCheckpoint(db);
      if (!checkpoint || checkpoint.body.size === 0) return null;
    }
    const decisions = (await db.query(
      `SELECT f.descriptor, d.snapshot->'policy' AS policy, d.certificate_digest FROM dge_federation.decisions f JOIN dge_decisions.decisions d ON d.tenant_id=f.tenant_id AND d.id=f.decision_id
       WHERE f.document_id=$1 ORDER BY f.created_at LIMIT 200`, [documentId])).rows
      .map((r) => ({ descriptor: r.descriptor, policy: r.policy, certificateDigest: r.certificate_digest?.trim() ?? null }));
    const body = {
      schema: FEDERATION_SCHEMAS.snapshot, authority: instanceId, documentId, sequence: Number(checkpoint.body.size),
      issuedAt: new Date(now()).toISOString(), claim, edition, decisions, checkpoint, evidence,
    };
    return signObject(FEDERATION_SCHEMAS.snapshot, body, signer);
  }

  /** Queues the latest checkpoint (with a consistency proof) and changed snapshots to every replica peer. */
  async function exportDue() {
    let queued = 0;
    const peers = await worker(async (db) => (await db.query(
      "SELECT DISTINCT p.instance_id FROM dge_federation.peers p JOIN dge_federation.replicas r ON r.peer=p.instance_id WHERE p.status='active'")).rows);
    for (const peer of peers) {
      await worker(async (db) => {
        const latest = await logCheckpoint(db);
        const sent = Number((await db.query("SELECT checkpoint_sent FROM dge_federation.peers WHERE instance_id=$1 FOR UPDATE", [peer.instance_id])).rows[0].checkpoint_sent);
        if (!latest || latest.body.size <= sent) return;
        const consistency = sent > 0 ? await logConsistency(db, sent, latest.body.size) : null;
        await enqueue(db, peer.instance_id, LOG_CHANNEL, "checkpoint", { checkpoint: latest, consistency });
        await db.query("UPDATE dge_federation.peers SET checkpoint_sent=$2,updated_at=$3 WHERE instance_id=$1", [peer.instance_id, latest.body.size, new Date(now())]);
        queued++;
      });
    }
    const replicas = await worker(async (db) => (await db.query(
      "SELECT r.document_id,r.peer,r.snapshot_digest FROM dge_federation.replicas r JOIN dge_federation.peers p ON p.instance_id=r.peer WHERE p.status='active' AND p.checkpoint_sent>0 ORDER BY r.document_id")).rows);
    for (const replica of replicas) {
      await worker(async (db) => {
        const bundle = await exportBundle(db, replica.document_id);
        if (!bundle || bundle.body.checkpoint.body.size > Number((await peerRow(db, replica.peer)).checkpoint_sent)) return;
        // Content digest ignores the log position, so an unchanged document is not resent.
        const { claim, edition, decisions } = bundle.body;
        const digest = objectDigest(FEDERATION_SCHEMAS.snapshot, { claim, edition, decisions });
        if (digest === replica.snapshot_digest?.trim()) return;
        await enqueue(db, replica.peer, replica.document_id, "snapshot", bundle);
        await db.query("UPDATE dge_federation.replicas SET snapshot_sequence=$3,snapshot_digest=$4 WHERE document_id=$1 AND peer=$2",
          [replica.document_id, replica.peer, bundle.body.sequence, digest]);
        queued++;
      });
    }
    return queued;
  }

  /** Applies one in-order inbox message. Returns "wait" to retry the channel later. */
  async function applyMessage(db, message) {
    const { from, type, payload, documentId } = message.body;
    const peer = await activePeer(db, from);
    if (!peer) return "wait";
    if (type === "checkpoint") {
      const cp = payload.checkpoint;
      const key = peerKey(peer, cp?.keyId, Date.parse(cp?.body?.issuedAt));
      if (!key || cp.body.logId !== from || !(await verifyCheckpoint(cp, key))) {
        await recordEvidence(db, from, "invalid-message", null, { messageId: message.id, reason: "invalid-checkpoint" });
        return "rejected";
      }
      const history = (await db.query("SELECT size,root_hash FROM dge_federation.checkpoints WHERE instance_id=$1 ORDER BY size", [from])).rows
        .map((r) => ({ size: Number(r.size), rootHash: r.root_hash.trim() }));
      const observed = observeCheckpoint(history, cp, payload.consistency);
      if (observed.status === "split-view") {
        await recordEvidence(db, from, "split-view", null, { previous: observed.previous, checkpoint: cp, consistency: payload.consistency, reason: observed.reason });
        return "split-view";
      }
      if (observed.status === "needs-consistency") {
        await enqueue(db, from, LOG_CHANNEL, "sync-request", { fromSize: observed.fromSize });
        return "sync-requested";
      }
      if (observed.status === "extends")
        await db.query("INSERT INTO dge_federation.checkpoints(instance_id,size,root_hash,checkpoint,observed_at) VALUES($1,$2,$3,$4,$5)",
          [from, cp.body.size, cp.body.rootHash, cp, new Date(now())]);
      return observed.status;
    }
    if (type === "sync-request") {
      // Answer from this log: an honest log can always prove extension.
      const latest = await logCheckpoint(db);
      if (!latest) return "no-checkpoint";
      const fromSize = Number(payload.fromSize);
      const consistency = Number.isSafeInteger(fromSize) && fromSize >= 1 && fromSize <= latest.body.size
        ? await logConsistency(db, fromSize, latest.body.size) : null;
      await enqueue(db, from, LOG_CHANNEL, "checkpoint", { checkpoint: latest, consistency });
      return "answered";
    }
    if (type === "snapshot") {
      const local = (await db.query("SELECT * FROM dge_federation.authorities WHERE document_id=$1", [documentId])).rows[0];
      if (local?.local) {
        await recordEvidence(db, from, "authority-conflict", documentId, { claimed: payload.body?.claim, reason: "document-owned-locally" });
        return "authority-conflict";
      }
      const history = (await db.query("SELECT size,root_hash FROM dge_federation.checkpoints WHERE instance_id=$1 ORDER BY size", [from])).rows
        .map((r) => ({ size: Number(r.size), rootHash: r.root_hash.trim() }));
      const previous = (await db.query("SELECT sequence FROM dge_federation.mirror_documents WHERE document_id=$1", [documentId])).rows[0];
      const key = peerKey(peer, payload?.keyId, Date.parse(payload?.body?.issuedAt));
      const result = payload?.body?.documentId === documentId && payload?.body?.authority === from && key
        ? await verifySnapshotBundle(payload, { authorityKey: key, claim: local?.claim.body ?? null, history, previousSequence: Number(previous?.sequence ?? 0) })
        : { status: "rejected", reason: "wrong-sender" };
      if (result.status === "awaiting-checkpoint") return "wait";
      if (result.status === "accepted") {
        if (!local) await db.query("INSERT INTO dge_federation.authorities(document_id,tenant_id,authority,local,claim,accepted_at) VALUES($1,NULL,$2,false,$3,$4)",
          [documentId, from, payload.body.claim, new Date(now())]);
        await db.query(
          `INSERT INTO dge_federation.mirror_documents(document_id,authority,sequence,bundle,verified_at) VALUES($1,$2,$3,$4,$5)
           ON CONFLICT (document_id) DO UPDATE SET sequence=excluded.sequence,bundle=excluded.bundle,verified_at=excluded.verified_at`,
          [documentId, from, payload.body.sequence, payload, new Date(now())]);
        return "accepted";
      }
      if (result.status === "stale") return "stale";
      const kind = result.reason === "authority-conflict" ? "authority-conflict" : result.reason === "split-view" ? "split-view" : "invalid-message";
      await recordEvidence(db, from, kind, documentId, { messageId: message.id, reason: result.reason, ...(result.conflict ? { conflict: result.conflict } : {}) });
      return result.reason;
    }
    if (type === "ballot") {
      let decided;
      try { decided = await decideEnvelope(db, payload, from); }
      catch (error) {
        if (!(error instanceof DocumentError)) throw error;
        await recordEvidence(db, from, "invalid-message", documentId, { messageId: message.id, reason: error.code });
        return error.code;
      }
      await enqueue(db, from, documentId, "receipt", decided.receipt);
      return decided.receipt.body.status;
    }
    if (type === "receipt") {
      const key = peerKey(peer, payload?.keyId, Date.parse(payload?.body?.receivedAt));
      if (!key || payload.body.authority !== from || !(await verifySignedObject(FEDERATION_SCHEMAS.receipt, payload, key))) {
        await recordEvidence(db, from, "invalid-message", documentId, { messageId: message.id, reason: "invalid-receipt" });
        return "rejected";
      }
      const relay = (await db.query("SELECT receipt FROM dge_federation.relays WHERE envelope_id=$1 FOR UPDATE", [payload.body.envelopeId])).rows[0];
      if (relay?.receipt && relay.receipt.signature !== payload.signature)
        await recordEvidence(db, from, "conflicting-receipts", documentId, { first: relay.receipt, second: payload });
      await db.query("UPDATE dge_federation.relays SET receipt=$2 WHERE envelope_id=$1 AND receipt IS NULL", [payload.body.envelopeId, payload]);
      return "stored";
    }
    return "unsupported";
  }

  /** Applies stored inbox messages strictly in sequence per (sender, document). */
  async function applyInbox(limit = 200) {
    const channels = await worker(async (db) => (await db.query(
      "SELECT DISTINCT sender,document_id FROM dge_federation.inbox WHERE applied_at IS NULL LIMIT 100")).rows);
    let applied = 0;
    for (const channel of channels) {
      for (;;) {
        if (applied >= limit) return applied;
        const progressed = await worker(async (db) => {
          await db.query("INSERT INTO dge_federation.channels(sender,document_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [channel.sender, channel.document_id]);
          const cursor = Number((await db.query("SELECT applied_through FROM dge_federation.channels WHERE sender=$1 AND document_id=$2 FOR UPDATE",
            [channel.sender, channel.document_id])).rows[0].applied_through);
          const next = (await db.query("SELECT * FROM dge_federation.inbox WHERE sender=$1 AND document_id=$2 AND sequence=$3 AND applied_at IS NULL",
            [channel.sender, channel.document_id, cursor + 1])).rows[0];
          if (!next) return false;
          const outcome = await applyMessage(db, next.message);
          if (outcome === "wait") return false;
          await db.query("UPDATE dge_federation.inbox SET applied_at=$2,outcome=$3 WHERE id=$1", [next.id, new Date(now()), outcome.slice(0, 60)]);
          await db.query("UPDATE dge_federation.channels SET applied_through=$3 WHERE sender=$1 AND document_id=$2", [channel.sender, channel.document_id, cursor + 1]);
          return true;
        });
        if (!progressed) break;
        applied++;
      }
    }
    return applied;
  }

  /** Sends due messages, one signed POST per recipient; unacknowledged ones back off. */
  async function deliver() {
    const due = await worker(async (db) => {
      const rows = (await db.query(
        `SELECT o.*, p.record FROM dge_federation.outbox o JOIN dge_federation.peers p ON p.instance_id=o.recipient
         WHERE o.delivered_at IS NULL AND o.next_attempt_at<=$1 AND p.status='active'
         ORDER BY o.recipient,o.document_id,o.sequence LIMIT $2 FOR UPDATE OF o SKIP LOCKED`, [new Date(now()), deliveryBatch])).rows;
      for (const row of rows) // Lease so a concurrent worker does not resend.
        await db.query("UPDATE dge_federation.outbox SET next_attempt_at=$2 WHERE id=$1", [row.id, new Date(now() + 60_000)]);
      return rows;
    });
    const byPeer = new Map();
    for (const row of due) byPeer.set(row.recipient, [...(byPeer.get(row.recipient) ?? []), row]);
    let delivered = 0;
    for (const [recipient, rows] of byPeer) {
      let acknowledged = new Set(), received = [], error = null;
      try {
        const path = "/api/federation/inbox";
        const body = new TextEncoder().encode(JSON.stringify({ messages: rows.map((r) => r.message) }));
        const headers = await signRequest({ method: "POST", path, body, instanceId, signer, timestamp: new Date(now()).toISOString() });
        const response = await fetch(rows[0].record.origin + path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body });
        if (!response.ok) throw Object.assign(Error("peer-status-" + response.status), { code: "PEER_" + response.status });
        const reply = await response.json();
        acknowledged = new Set(Array.isArray(reply.acknowledged) ? reply.acknowledged : []);
        received = Array.isArray(reply.channels) ? reply.channels : [];
      } catch (cause) { error = String(cause?.code ?? cause?.message ?? "delivery-error").replace(/[^a-z0-9 .:_-]/gi, "").slice(0, 120); onError(cause); }
      await worker(async (db) => {
        for (const row of rows) {
          if (acknowledged.has(row.id)) {
            await db.query("UPDATE dge_federation.outbox SET delivered_at=$2,attempts=attempts+1,last_error=NULL WHERE id=$1", [row.id, new Date(now())]);
            delivered++;
          } else {
            const attempts = row.attempts + 1;
            await db.query("UPDATE dge_federation.outbox SET attempts=$2,next_attempt_at=$3,last_error=$4 WHERE id=$1",
              [row.id, attempts, new Date(now() + retryDelayMs(attempts, row.id)), error ?? "not-acknowledged"]);
          }
        }
        // A recipient that restored from backup reports a lower position:
        // resend everything after it, still in the original order.
        for (const c of received) {
          if (!isUuid(c?.documentId) || !Number.isSafeInteger(c?.receivedThrough)) continue;
          await db.query("UPDATE dge_federation.outbox SET delivered_at=NULL,next_attempt_at=$4 WHERE recipient=$1 AND document_id=$2 AND sequence>$3 AND delivered_at IS NOT NULL",
            [recipient, c.documentId, c.receivedThrough, new Date(now())]);
        }
      });
    }
    return delivered;
  }

  /** Mirror: checks relayed receipts against the authority's log once the merge delay has passed. */
  async function auditRelays(limit = 20) {
    const pending = await worker(async (db) => (await db.query(
      `SELECT r.*, p.record, (SELECT checkpoint FROM dge_federation.checkpoints c WHERE c.instance_id=r.authority ORDER BY size DESC LIMIT 1) AS latest
       FROM dge_federation.relays r JOIN dge_federation.peers p ON p.instance_id=r.authority
       WHERE r.receipt IS NOT NULL AND r.audited IS NULL LIMIT $1`, [limit])).rows);
    let audited = 0;
    for (const row of pending) {
      if (!row.latest) continue;
      const receipt = row.receipt;
      let verdict;
      try {
        const url = row.record.origin + "/api/public/ledger/proof?digest=" + receipt.body.eventDigest + "&kind=" + receiptLogEntry(receipt.body).kind;
        const response = await fetch(url, { headers: { accept: "application/json" } });
        if (!response.ok) throw Error("proof-status-" + response.status);
        const proof = await response.json();
        if (proof.status === "included") {
          const key = peerKey(row.record, proof.checkpoint.keyId, Date.parse(proof.checkpoint.body.issuedAt));
          if (!key || !(await verifyCheckpoint(proof.checkpoint, key))) throw Error("unverifiable-checkpoint");
          verdict = auditReceipt({ receipt, checkpoint: proof.checkpoint, inclusion: { index: proof.entry.seq, proof: proof.proof }, maxMergeDelayMs }).status;
        } else verdict = auditReceipt({ receipt, checkpoint: row.latest, inclusion: null, maxMergeDelayMs }).status;
      } catch (cause) { onError(cause); continue; }
      if (verdict !== "included" && verdict !== "omitted") continue;
      await worker(async (db) => {
        await db.query("UPDATE dge_federation.relays SET audited=$2 WHERE envelope_id=$1", [row.envelope_id, verdict]);
        if (verdict === "omitted") await recordEvidence(db, row.authority, "omission", null, { receipt, checkpoint: row.latest });
      });
      audited++;
    }
    return audited;
  }

  return Object.freeze({
    instanceId,
    instance: () => ({ instanceId, origin, publicKey: signer.publicKey, keyId: signer.keyId, algorithm: "Ed25519", protocol: "quill-federation-v1" }),

    /** Operator action (caller must be authorized): pins a peer's key. No discovery, no auto-trust. */
    registerPeer: ({ instanceId: peerId, origin: peerOrigin, publicKey, maxDelayMs = 0 }) => {
      let record;
      try { record = pinPeer({ instanceId: peerId, origin: peerOrigin, publicKey, maxDelayMs, pinnedAt: new Date(now()).toISOString() }); }
      catch { fail("INVALID_PEER"); }
      check(peerId !== instanceId, "INVALID_PEER");
      return worker(async (db) => {
        const existing = await peerRow(db, peerId);
        if (existing) {
          check(existing.record.keys.at(-1).publicKey === publicKey && existing.record.origin === peerOrigin, "PEER_ALREADY_PINNED", 409);
          return { instanceId: peerId, keyId: existing.record.keys.at(-1).keyId };
        }
        await db.query("INSERT INTO dge_federation.peers(instance_id,record,registered_at,updated_at) VALUES($1,$2,$3,$3)", [peerId, record, new Date(now())]);
        return { instanceId: peerId, keyId: record.keys[0].keyId };
      });
    },
    setPeerStatus: (peerId, status) => {
      check(isInstanceId(peerId) && ["active", "suspended"].includes(status), "INVALID_PEER");
      return worker(async (db) => {
        check((await db.query("UPDATE dge_federation.peers SET status=$2,updated_at=$3 WHERE instance_id=$1 RETURNING 1", [peerId, status, new Date(now())])).rows.length, "PEER_NOT_FOUND", 404);
        return { instanceId: peerId, status };
      });
    },
    /** Self-authenticating: accepted only if signed by the key already pinned for that peer. */
    applyRotation: (rotation) => worker(async (db) => {
      const peerId = rotation?.body?.instanceId;
      check(isInstanceId(peerId ?? ""), "INVALID_ROTATION");
      const row = (await db.query("SELECT * FROM dge_federation.peers WHERE instance_id=$1 FOR UPDATE", [peerId])).rows[0];
      check(row, "PEER_NOT_FOUND", 404);
      const result = await applyKeyRotation(row.record, rotation);
      check(result.ok, "INVALID_ROTATION", 403);
      await db.query("UPDATE dge_federation.peers SET record=$2,updated_at=$3 WHERE instance_id=$1", [peerId, result.peer, new Date(now())]);
      return { instanceId: peerId, keyId: result.peer.keys.at(-1).keyId, sequence: result.peer.rotationSequence };
    }),

    /** Workspace owner/admin declares this instance the document's authority and names mirrors. */
    claimAuthority: (credentials, tenantId, documentId, { replicas = [] } = {}) => {
      check(isUuid(tenantId) && isUuid(documentId) && Array.isArray(replicas) && replicas.length <= 20 && replicas.every(isInstanceId), "INVALID_FEDERATION_REQUEST");
      return identity.withTenant(credentials, tenantId, { write: true, recent: true, roles: managerial }, async (db) => {
        await enter(db);
        const visibility = (await db.query("SELECT 1 FROM dge_documents.documents WHERE tenant_id=$1 AND id=$2", [tenantId, documentId])).rows.length ? "public"
          : (await db.query("SELECT 1 FROM dge_private.documents WHERE tenant_id=$1 AND id=$2", [tenantId, documentId])).rows.length ? "private" : null;
        check(visibility, "DOCUMENT_NOT_FOUND", 404);
        let existing = (await db.query("SELECT * FROM dge_federation.authorities WHERE document_id=$1 FOR UPDATE", [documentId])).rows[0];
        check(!existing || (existing.local && existing.tenant_id === tenantId), "AUTHORITY_CONFLICT", 409);
        if (!existing) {
          const claim = await signObject(FEDERATION_SCHEMAS.authority, authorityClaimBody({ documentId, authority: instanceId, visibility, claimedAt: new Date(now()).toISOString() }), signer);
          await db.query("INSERT INTO dge_federation.authorities(document_id,tenant_id,authority,local,claim,accepted_at) VALUES($1,$2,$3,true,$4,$5)",
            [documentId, tenantId, instanceId, claim, new Date(now())]);
          await appendLedgerEvent(db, { tenantId, kind: "federated-authority", subjectId: documentId, eventDigest: objectDigest(FEDERATION_SCHEMAS.authority, claim.body), at: new Date(now()) });
          existing = { claim };
        }
        for (const peer of replicas) {
          check(await activePeer(db, peer), "PEER_NOT_FOUND", 404);
          await db.query("INSERT INTO dge_federation.replicas(document_id,peer) VALUES($1,$2) ON CONFLICT DO NOTHING", [documentId, peer]);
        }
        return { claim: existing.claim, replicas };
      });
    },

    /** Declares the delay class (and so the cutoff) of an open decision before any ballot is cast. */
    federateDecision: (credentials, tenantId, documentId, proposalId, { delayClass }) => {
      check(isUuid(tenantId) && isUuid(documentId) && isUuid(proposalId), "INVALID_FEDERATION_REQUEST");
      return identity.withTenant(credentials, tenantId, { write: true, recent: true, roles: managerial }, async (db) => {
        await enter(db);
        const authority = (await db.query("SELECT * FROM dge_federation.authorities WHERE document_id=$1 AND local AND tenant_id=$2", [documentId, tenantId])).rows[0];
        check(authority, "NOT_AUTHORITY", 409);
        const decision = (await db.query("SELECT * FROM dge_decisions.decisions WHERE tenant_id=$1 AND document_id=$2 AND proposal_id=$3 FOR UPDATE",
          [tenantId, documentId, proposalId])).rows[0];
        check(decision, "DECISION_NOT_FOUND", 404);
        const prior = await localDecision(db, decision.id);
        if (prior) return prior.descriptor;
        let snapshot;
        try { snapshot = validateGovernanceSnapshot(decision.snapshot); } catch { fail("DECISION_INTEGRITY_ERROR", 503); }
        check(decision.state === "open" && now() < snapshot.policy.closesAt, "VOTE_CLOSED", 409);
        // Finality rules are fixed before anyone votes; they never change mid-vote.
        check(!(await db.query("SELECT 1 FROM dge_decisions.ballots WHERE tenant_id=$1 AND decision_id=$2 LIMIT 1", [tenantId, decision.id])).rows.length,
          "BALLOTS_ALREADY_CAST", 409);
        let body;
        try {
          body = decisionDescriptorBody({
            authority: instanceId, documentId, decisionId: decision.id, proposalDigest: snapshot.proposalDigest,
            snapshotDigest: snapshot.snapshotDigest, policyDigest: snapshot.policyDigest,
            electorate: { electorateDigest: snapshot.electorateDigest, size: snapshot.electorate.members.length },
            opensAt: iso(snapshot.policy.opensAt), closesAt: iso(snapshot.policy.closesAt), delayClass, issuedAt: new Date(now()).toISOString(),
          });
        } catch { fail("INVALID_DELAY_CLASS"); }
        const descriptor = await signObject(FEDERATION_SCHEMAS.decision, body, signer);
        const digest = objectDigest(FEDERATION_SCHEMAS.decision, body);
        await db.query(
          "INSERT INTO dge_federation.decisions(decision_id,tenant_id,document_id,proposal_id,descriptor,descriptor_digest,cutoff_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [decision.id, tenantId, documentId, proposalId, descriptor, digest, new Date(body.cutoffAt), new Date(now())]);
        await appendLedgerEvent(db, { tenantId, kind: "federated-decision", subjectId: decision.id, eventDigest: digest, at: new Date(now()), finalization: true });
        return descriptor;
      });
    },

    /** A frozen-electorate member binds a device key; a new binding supersedes the old one. */
    bindVoterKey: (credentials, tenantId, documentId, proposalId, { publicKey }) => {
      check(isUuid(tenantId) && isUuid(documentId) && isUuid(proposalId), "INVALID_FEDERATION_REQUEST");
      return identity.withTenant(credentials, tenantId, { write: true, roles: voting }, async (db, actor) => {
        await enter(db);
        const decision = (await db.query("SELECT id,state,snapshot FROM dge_decisions.decisions WHERE tenant_id=$1 AND document_id=$2 AND proposal_id=$3 FOR SHARE",
          [tenantId, documentId, proposalId])).rows[0];
        check(decision, "DECISION_NOT_FOUND", 404);
        const federated = await localDecision(db, decision.id);
        check(federated, "DECISION_NOT_FEDERATED", 404);
        check(decision.state === "open" && now() < Date.parse(federated.descriptor.body.closesAt), "VOTE_CLOSED", 409);
        check(decision.snapshot.electorate.members.some((m) => m.principalId === actor.accountId), "NOT_IN_FROZEN_ELECTORATE", 403);
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["federation-binding:" + decision.id + ":" + actor.accountId]);
        const previous = (await db.query("SELECT max(generation) AS g FROM dge_federation.key_bindings WHERE decision_id=$1 AND account_id=$2",
          [decision.id, actor.accountId])).rows[0].g;
        let body;
        try {
          body = keyBindingBody({ authority: instanceId, decisionId: decision.id, descriptorDigest: federated.descriptor_digest.trim(),
            voterKeyId: keyIdFor(publicKey), publicKey, generation: Number(previous ?? 0) + 1, boundAt: new Date(now()).toISOString() });
        } catch { fail("INVALID_VOTER_KEY"); }
        check(!(await db.query("SELECT 1 FROM dge_federation.key_bindings WHERE decision_id=$1 AND voter_key_id=$2", [decision.id, body.voterKeyId])).rows.length,
          "VOTER_KEY_ALREADY_BOUND", 409);
        const binding = await signObject(FEDERATION_SCHEMAS.keyBinding, body, signer);
        await db.query("UPDATE dge_federation.key_bindings SET active=false WHERE decision_id=$1 AND account_id=$2 AND active", [decision.id, actor.accountId]);
        await db.query(
          "INSERT INTO dge_federation.key_bindings(decision_id,voter_key_id,tenant_id,account_id,generation,binding,active,bound_at) VALUES($1,$2,$3,$4,$5,$6,true,$7)",
          [decision.id, body.voterKeyId, tenantId, actor.accountId, body.generation, binding, new Date(now())]);
        await appendLedgerEvent(db, { tenantId, kind: BINDING_KIND, subjectId: decision.id, eventDigest: bindingEventDigest(body), at: new Date(now()) });
        return { binding, descriptor: federated.descriptor };
      });
    },

    /** True while a federated decision's disclosed cutoff is still ahead (closure must wait). */
    cutoffPending: (tenantId, documentId, proposalId) => {
      if (!isUuid(tenantId) || !isUuid(documentId) || !isUuid(proposalId)) return false;
      return worker(async (db) => {
        const row = (await db.query("SELECT cutoff_at FROM dge_federation.decisions WHERE tenant_id=$1 AND document_id=$2 AND proposal_id=$3",
          [tenantId, documentId, proposalId])).rows[0];
        return Boolean(row) && now() < new Date(row.cutoff_at).getTime();
      });
    },

    descriptor: (decisionId) => {
      check(isUuid(decisionId), "INVALID_DECISION_ID");
      return worker(async (db) => {
        const row = await localDecision(db, decisionId);
        if (row) return { descriptor: row.descriptor, authority: instanceId, servedBy: instanceId };
        const mirrored = (await db.query(
          "SELECT authority,d AS descriptor FROM dge_federation.mirror_documents m, jsonb_array_elements(m.bundle->'body'->'decisions') e, LATERAL (SELECT e->'descriptor' AS d) x WHERE x.d->'body'->>'decisionId'=$1 LIMIT 1",
          [decisionId])).rows[0];
        check(mirrored, "DECISION_NOT_FOUND", 404);
        return { descriptor: mirrored.descriptor, authority: mirrored.authority, servedBy: instanceId, readOnly: true };
      });
    },

    /**
     * Ballot envelope from a device or relay. The authority answers with a
     * signed receipt (accepted, or rejected with a reason). A mirror verifies
     * what it can, queues the envelope to the authority and answers "relayed";
     * it never decides or counts a ballot for a document it does not own.
     */
    submitEnvelope: (envelope) => worker(async (db) => {
      const decisionId = envelope?.body?.decisionId;
      check(isUuid(decisionId ?? ""), "INVALID_ENVELOPE");
      if (await localDecision(db, decisionId)) {
        const { receipt, duplicate } = await decideEnvelope(db, envelope, null);
        return { status: receipt.body.status, final: receipt.body.status === "accepted", duplicate, receipt };
      }
      const mirrored = (await db.query(
        "SELECT m.authority,m.document_id,x.d AS descriptor FROM dge_federation.mirror_documents m, jsonb_array_elements(m.bundle->'body'->'decisions') e, LATERAL (SELECT e->'descriptor' AS d) x WHERE x.d->'body'->>'decisionId'=$1 LIMIT 1",
        [decisionId])).rows[0];
      check(mirrored, "DECISION_NOT_FOUND", 404);
      const peer = await activePeer(db, mirrored.authority);
      check(peer, "AUTHORITY_UNAVAILABLE", 503);
      const key = peerKey(peer, mirrored.descriptor.keyId, Date.parse(mirrored.descriptor.body.issuedAt));
      const verified = await verifyEnvelope(envelope, { descriptor: mirrored.descriptor, authorityKey: key });
      check(verified.ok, "INVALID_ENVELOPE");
      const inserted = (await db.query(
        "INSERT INTO dge_federation.relays(envelope_id,authority,decision_id,relayed_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING 1",
        [verified.id, mirrored.authority, decisionId, new Date(now())])).rows.length;
      if (inserted) await enqueue(db, mirrored.authority, mirrored.document_id, "ballot", envelope);
      return { status: "relayed", final: false, authority: mirrored.authority, envelopeId: verified.id, cutoffAt: mirrored.descriptor.body.cutoffAt };
    }),

    receipt: (envelopeIdentity) => {
      check(/^[a-f0-9]{64}$/.test(envelopeIdentity ?? ""), "INVALID_ENVELOPE_ID");
      return worker(async (db) => {
        const own = (await db.query("SELECT receipt FROM dge_federation.envelopes WHERE envelope_id=$1", [envelopeIdentity])).rows[0];
        if (own) return { receipt: own.receipt, servedBy: instanceId };
        const relayed = (await db.query("SELECT authority,receipt FROM dge_federation.relays WHERE envelope_id=$1", [envelopeIdentity])).rows[0];
        check(relayed, "RECEIPT_NOT_FOUND", 404);
        // Signed, so a voter can prove this mirror withheld a receipt it held.
        const statement = await signObject(FEDERATION_SCHEMAS.relayStatus, relayStatusBody({
          mirror: instanceId, envelopeId: envelopeIdentity, status: relayed.receipt ? "receipt-available" : "awaiting-authority", at: new Date(now()).toISOString(),
        }), signer);
        return { receipt: relayed.receipt, statement, authority: relayed.authority, servedBy: instanceId };
      });
    },

    /** Public read: a locally owned document is exported fresh; a mirrored one is served read-only with its origin. */
    document: (documentId) => {
      check(isUuid(documentId), "INVALID_DOCUMENT_ID");
      return worker(async (db) => {
        const authority = (await db.query("SELECT local,authority,claim FROM dge_federation.authorities WHERE document_id=$1", [documentId])).rows[0];
        // Private snapshots travel only to registered peers; the public endpoint never reveals them.
        check(authority && authority.claim.body.visibility === "public", "DOCUMENT_NOT_FOUND", 404);
        if (authority.local) {
          const bundle = await exportBundle(db, documentId);
          check(bundle, "SNAPSHOT_NOT_READY", 503);
          return { authority: instanceId, servedBy: instanceId, readOnly: false, bundle };
        }
        const mirrored = (await db.query("SELECT bundle,verified_at FROM dge_federation.mirror_documents WHERE document_id=$1", [documentId])).rows[0];
        check(mirrored, "DOCUMENT_NOT_FOUND", 404);
        return { authority: authority.authority, servedBy: instanceId, readOnly: true, verifiedAt: iso(mirrored.verified_at), bundle: mirrored.bundle };
      });
    },

    evidence: ({ before = null, limit = 50 } = {}) => {
      check((before === null || isUuid(before)) && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, "INVALID_PAGE");
      return worker(async (db) => {
        const rows = (await db.query(
          "SELECT id,peer,kind,document_id,details,observed_at FROM dge_federation.evidence ORDER BY observed_at DESC,id LIMIT $1", [limit])).rows;
        return { items: rows.map((r) => ({ id: r.id, peer: r.peer, kind: r.kind, documentId: r.document_id, details: r.details, observedAt: iso(r.observed_at) })) };
      });
    },

    /** Authenticates a peer request by its signature and a single-use nonce. */
    authenticatePeer: ({ method, path, headers, body }) => worker(async (db) => {
      const peerId = typeof headers.get === "function" ? headers.get("x-quill-federation-instance") : null;
      check(isInstanceId(peerId ?? ""), "PEER_AUTHENTICATION_REQUIRED", 401);
      const peer = await activePeer(db, peerId);
      check(peer, "PEER_AUTHENTICATION_REQUIRED", 401);
      const result = await verifyRequest({ method, path, headers, body, peer, now: now() });
      check(result.ok, "PEER_AUTHENTICATION_REQUIRED", 401);
      await db.query("DELETE FROM dge_federation.nonces WHERE expires_at<$1", [new Date(now())]);
      check((await db.query("INSERT INTO dge_federation.nonces(instance_id,nonce,expires_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING 1",
        [peerId, result.nonce, new Date(result.expiresAt)])).rows.length, "REQUEST_REPLAYED", 401);
      return peerId;
    }),

    /** Stores authenticated messages; acknowledges what is durably stored or already seen. */
    receive: (sender, messages) => {
      check(Array.isArray(messages) && messages.length <= MAX_BATCH, "INVALID_MESSAGES");
      return worker(async (db) => {
        const peer = await activePeer(db, sender);
        check(peer, "PEER_AUTHENTICATION_REQUIRED", 401);
        const acknowledged = [], rejected = [], touched = new Set();
        for (const message of messages) {
          const key = peerKey(peer, message?.keyId, Date.parse(message?.body?.createdAt));
          if (!key || !(await verifyMessage(message, key)) || message.body.from !== sender || message.body.to !== instanceId) {
            rejected.push({ id: typeof message?.id === "string" ? message.id.slice(0, 64) : null, reason: "invalid-message" });
            continue;
          }
          const { documentId, sequence } = message.body;
          touched.add(documentId);
          const cursor = Number((await db.query("SELECT applied_through FROM dge_federation.channels WHERE sender=$1 AND document_id=$2", [sender, documentId])).rows[0]?.applied_through ?? 0);
          const atSequence = (await db.query("SELECT id FROM dge_federation.inbox WHERE sender=$1 AND document_id=$2 AND sequence=$3", [sender, documentId, sequence])).rows[0];
          const channel = { appliedThrough: cursor, pending: new Map(atSequence && sequence > cursor ? [[sequence, atSequence.id.trim()]] : []) };
          const appliedIds = atSequence && sequence <= cursor ? new Map([[sequence, atSequence.id.trim()]]) : new Map();
          const verdict = classifyIncoming(channel, message, { appliedIds });
          if (verdict === "conflict") {
            const known = (await db.query("SELECT 1 FROM dge_federation.evidence WHERE peer=$1 AND kind='sender-equivocation' AND details->>'received'=$2",
              [sender, message.id])).rows.length;
            if (!known) await recordEvidence(db, sender, "sender-equivocation", documentId, { sequence, stored: atSequence?.id.trim() ?? null, received: message.id });
            // Checkpoints and receipts are self-authenticating and order-insensitive:
            // their content can still prove a forked log or a second receipt.
            if (!known && (message.body.type === "checkpoint" || message.body.type === "receipt")) await applyMessage(db, message);
            rejected.push({ id: message.id, reason: "sequence-conflict" });
          } else if (verdict === "too-far-ahead") rejected.push({ id: message.id, reason: "too-far-ahead" });
          else {
            if (verdict !== "duplicate")
              await db.query("INSERT INTO dge_federation.inbox(id,sender,document_id,sequence,message,received_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
                [message.id, sender, documentId, sequence, message, new Date(now())]);
            acknowledged.push(message.id);
          }
        }
        const channels = [];
        // Highest contiguous stored sequence, so a sender can detect a recipient restored from backup.
        for (const documentId of touched) {
          let through = Number((await db.query("SELECT applied_through FROM dge_federation.channels WHERE sender=$1 AND document_id=$2", [sender, documentId])).rows[0]?.applied_through ?? 0);
          for (const r of (await db.query("SELECT sequence FROM dge_federation.inbox WHERE sender=$1 AND document_id=$2 AND sequence>$3 ORDER BY sequence LIMIT 1000",
            [sender, documentId, through])).rows) {
            if (Number(r.sequence) !== through + 1) break;
            through++;
          }
          channels.push({ documentId, receivedThrough: through });
        }
        return { acknowledged, rejected, channels };
      });
    },

    exportDue, applyInbox, deliver, auditRelays,
    /** One pass of every federation duty. Network calls happen outside database transactions. */
    async tick() {
      const exported = await exportDue();
      const applied = await applyInbox();
      const delivered = await deliver();
      const audited = await auditRelays();
      return { exported, applied, delivered, audited };
    },
  });
}
