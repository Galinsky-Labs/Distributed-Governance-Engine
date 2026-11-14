// Deterministic discrete-event harness for the federation protocol: a
// virtual clock, a seeded network that delays, drops, duplicates and reorders
// packets, and in-memory authority, mirror and voter nodes built only from
// src/federation.mjs and src/transparency.mjs. Same seed => same run.
import {
  FEDERATION_SCHEMAS, LOG_CHANNEL, signerFromCryptoKey, bytesToBase64, signObject, verifySignedObject,
  objectDigest, pinPeer, peerKey, authorityClaimBody, decisionDescriptorBody, keyBindingBody, verifyEnvelope,
  judgeEnvelope, receiptBody, receiptLogEntry, createBallotEnvelope, envelopeId, observeCheckpoint, recordCheckpoint,
  auditReceipt, verifySnapshotBundle, editionEventDigest, createMessage, verifyMessage, classifyIncoming,
  drainable, retryDelayMs, countAcceptedReceipts, relayStatusBody, receiptWithheld,
} from "../../src/federation.mjs";
import { memoryLog, entryLeafHash, checkpointBody, checkpointSigningInput, verifyCheckpoint, toHex } from "../../src/transparency.mjs";
import { createLegalDocument, legalDocumentDigest } from "../../src/legal-schema.mjs";

export const MINUTE = 60_000, HOUR = 3_600_000;

/** mulberry32: small, fast, deterministic. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const PKCS8_ED25519 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
/** Ed25519 signer from a seeded 32-byte secret, so keys (and so ids and jitter) repeat across runs. */
export async function seededSigner(random) {
  const seed = Uint8Array.from({ length: 32 }, () => Math.floor(random() * 256));
  const pkcs8 = new Uint8Array([...PKCS8_ED25519, ...seed]);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", key);
  const raw = Uint8Array.from(atob(jwk.x.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  return signerFromCryptoKey(key, bytesToBase64(raw));
}
export const seededHex = (random, bytes) => toHex(Uint8Array.from({ length: bytes }, () => Math.floor(random() * 256)));

export class VirtualClock {
  constructor(start) { this.now = start; this.queue = []; this.counter = 0; }
  at(time, fn) { this.queue.push({ time: Math.max(time, this.now), order: this.counter++, fn }); }
  after(delay, fn) { this.at(this.now + delay, fn); }
  every(period, fn, until) {
    const run = async () => { await fn(); if (this.now + period <= until) this.after(period, run); };
    this.after(period, run);
  }
  async runUntil(time) {
    for (;;) {
      this.queue.sort((a, b) => a.time - b.time || a.order - b.order);
      const next = this.queue[0];
      if (!next || next.time > time) break;
      this.queue.shift();
      this.now = next.time;
      await next.fn();
    }
    this.now = Math.max(this.now, time);
  }
  iso(at = this.now) { return new Date(at).toISOString(); }
}

/**
 * Links are directional pairs with a one-way delay function of time, random
 * jitter (which reorders), duplicate and loss probabilities. A partition
 * drops every packet between two nodes during its window.
 */
export class Network {
  constructor(clock, random) {
    this.clock = clock; this.random = random; this.nodes = new Map(); this.links = new Map(); this.partitions = [];
    this.stats = { sent: 0, delivered: 0, dropped: 0, duplicated: 0, reordered: 0 };
    this.lastArrival = new Map();
  }
  add(node) { this.nodes.set(node.id, node); node.network = this; return node; }
  link(a, b, options) { this.links.set(a + ">" + b, options); this.links.set(b + ">" + a, options); }
  partition(a, b, from, to) { this.partitions.push({ a, b, from, to }); }
  partitioned(a, b, at) { return this.partitions.some((p) => ((p.a === a && p.b === b) || (p.a === b && p.b === a)) && at >= p.from && at < p.to); }
  send(from, to, packet) {
    const link = this.links.get(from + ">" + to);
    if (!link) throw Error(`no link ${from}->${to}`);
    this.stats.sent++;
    const copies = this.random() < (link.duplicate ?? 0) ? 2 : 1;
    if (copies === 2) this.stats.duplicated++;
    for (let i = 0; i < copies; i++) {
      if (this.partitioned(from, to, this.clock.now) || this.random() < (link.loss ?? 0)) { this.stats.dropped++; continue; }
      const arrival = this.clock.now + link.delay(this.clock.now) + Math.floor(this.random() * (link.jitterMs ?? 0));
      const key = from + ">" + to;
      if (arrival < (this.lastArrival.get(key) ?? 0)) this.stats.reordered++;
      this.lastArrival.set(key, Math.max(arrival, this.lastArrival.get(key) ?? 0));
      const copy = structuredClone(packet);
      this.clock.at(arrival, async () => {
        const node = this.nodes.get(to);
        if (node.down) { this.stats.dropped++; return; }
        this.stats.delivered++;
        await node.onPacket(from, copy);
      });
    }
  }
}
/** Earth–Mars one-way light time: 3 min at opposition to 22 min near conjunction (cosine over the synodic period). */
export const marsLightDelay = (start, periodMs = 4 * HOUR) => (t) =>
  Math.round(3 * MINUTE + (19 * MINUTE) * (1 - Math.cos(2 * Math.PI * ((t - start) % periodMs) / periodMs)) / 2);

/** Store-and-forward queue + ordered inbox shared by authority and mirror nodes. */
class Peer {
  constructor(id, signer, clock) {
    this.id = id; this.signer = signer; this.clock = clock;
    this.pins = new Map(); this.outbox = []; this.sequences = new Map(); this.channels = new Map(); this.evidence = [];
    this.down = false;
  }
  pin(other, maxDelayMs) { this.pins.set(other.id, pinPeer({ instanceId: other.id, origin: `https://${other.id}.example`, publicKey: other.signer.publicKey, maxDelayMs, pinnedAt: this.clock.iso(0) })); }
  async enqueue(to, documentId, type, payload) {
    const key = to + "|" + documentId, sequence = (this.sequences.get(key) ?? 0) + 1;
    this.sequences.set(key, sequence);
    const message = await createMessage({ from: this.id, to, documentId, sequence, type, payload, createdAt: this.clock.iso() }, this.signer);
    this.outbox.push({ message, attempts: 0, nextAt: this.clock.now, delivered: false });
  }
  /** Sends due messages; each unacknowledged one backs off with deterministic jitter. */
  pump() {
    if (this.down) return;
    const due = this.outbox.filter((e) => !e.delivered && e.nextAt <= this.clock.now);
    const byPeer = new Map();
    for (const entry of due) {
      entry.attempts++;
      entry.nextAt = this.clock.now + retryDelayMs(entry.attempts, entry.message.id, { baseMs: 2 * MINUTE, capMs: 2 * HOUR });
      byPeer.set(entry.message.body.to, [...(byPeer.get(entry.message.body.to) ?? []), entry.message]);
    }
    for (const [to, messages] of byPeer) this.network.send(this.id, to, { kind: "messages", messages });
  }
  async receiveMessages(from, messages) {
    const acknowledged = [], touched = new Set();
    const pin = this.pins.get(from);
    for (const message of messages) {
      const key = pin && peerKey(pin, message.keyId, Date.parse(message.body.createdAt));
      if (!key || !(await verifyMessage(message, key)) || message.body.from !== from || message.body.to !== this.id) continue;
      const channelKey = from + "|" + message.body.documentId;
      const channel = this.channels.get(channelKey) ?? { appliedThrough: 0, pending: new Map(), messages: new Map(), appliedIds: new Map() };
      this.channels.set(channelKey, channel);
      const verdict = classifyIncoming(channel, message, { appliedIds: channel.appliedIds });
      if (verdict === "conflict") {
        this.note({ kind: "sender-equivocation", peer: from, documentId: message.body.documentId, sequence: message.body.sequence });
        // Checkpoints and receipts are self-authenticating and order-insensitive,
        // so their content is still checked: it can prove a fork or a second receipt.
        if (message.body.type === "checkpoint" || message.body.type === "receipt") await this.apply(message);
        continue;
      }
      if (verdict === "too-far-ahead") continue;
      if (verdict === "ready" || verdict === "buffer") { channel.pending.set(message.body.sequence, message.id); channel.messages.set(message.body.sequence, message); }
      acknowledged.push(message.id);
      touched.add(message.body.documentId);
    }
    const channels = [...touched].map((documentId) => {
      const c = this.channels.get(from + "|" + documentId);
      let through = c.appliedThrough;
      while (c.pending.has(through + 1)) through++;
      return { documentId, receivedThrough: through };
    });
    this.network.send(this.id, from, { kind: "ack", acknowledged, channels });
    await this.drainAll();
  }
  receiveAck(from, { acknowledged, channels }) {
    for (const entry of this.outbox) if (entry.message.body.to === from && acknowledged.includes(entry.message.id)) entry.delivered = true;
    // A recipient restored from backup reports a lower position: resend after it.
    for (const c of channels)
      for (const entry of this.outbox)
        if (entry.delivered && entry.message.body.to === from && entry.message.body.documentId === c.documentId && entry.message.body.sequence > c.receivedThrough) {
          entry.delivered = false; entry.nextAt = this.clock.now;
        }
  }
  async drainAll() {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const channel of this.channels.values()) {
        for (const sequence of drainable(channel)) {
          const message = channel.messages.get(sequence);
          if ((await this.apply(message)) === "wait") break;
          channel.pending.delete(sequence); channel.messages.delete(sequence);
          channel.appliedIds.set(sequence, message.id);
          channel.appliedThrough = sequence;
          progressed = true;
        }
      }
    }
  }
  /** Records evidence once per distinct fact. */
  note(evidence) {
    const key = JSON.stringify([evidence.kind, evidence.peer, evidence.documentId ?? null, evidence.sequence ?? evidence.size ?? evidence.envelopeId ?? null]);
    if (!this.evidence.some((e) => e.key === key)) this.evidence.push({ ...evidence, key });
  }
  async onPacket(from, packet) {
    if (packet.kind === "messages") return this.receiveMessages(from, packet.messages);
    if (packet.kind === "ack") return this.receiveAck(from, packet);
    return this.onRequest(from, packet);
  }
}

export class SimAuthority extends Peer {
  constructor({ id, signer, clock, documentId, tenantId, maxMergeDelayMs = 10 * MINUTE }) {
    super(id, signer, clock);
    this.documentId = documentId; this.tenantId = tenantId; this.maxMergeDelayMs = maxMergeDelayMs;
    this.log = memoryLog(); this.leaves = []; this.checkpoints = []; this.replicas = []; this.checkpointSent = new Map();
    this.decided = new Map(); this.bindings = new Map(); this.receiptsSigned = new Map(); this.descriptor = null; this.claim = null;
  }
  async logEvent(entry) { await this.log.append(entryLeafHash(entry)); this.leaves.push(entry); }
  async publish(text) {
    const document = structuredClone(createLegalDocument({ id: this.documentId, tenantId: this.tenantId, title: "Interplanetary charter" }));
    document.content[0].inlines = [{ kind: "text", text }];
    this.edition = { tenantId: this.tenantId, documentId: this.documentId, version: 1, digest: legalDocumentDigest(document), previousDigest: null, createdAt: this.clock.iso(), restoration: null, document };
    await this.logEvent({ kind: "document-version", scope: "public", subjectId: this.documentId, eventDigest: editionEventDigest(this.edition) });
    this.claim = await signObject(FEDERATION_SCHEMAS.authority, authorityClaimBody({ documentId: this.documentId, authority: this.id, visibility: "public", claimedAt: this.clock.iso() }), this.signer);
  }
  async openDecision({ decisionId, electorateSize, opensAt, closesAt, delayClass }) {
    const body = decisionDescriptorBody({
      authority: this.id, documentId: this.documentId, decisionId, proposalDigest: "1".repeat(64), snapshotDigest: "2".repeat(64), policyDigest: "3".repeat(64),
      electorate: { electorateDigest: "4".repeat(64), size: electorateSize }, opensAt: this.clock.iso(opensAt), closesAt: this.clock.iso(closesAt), delayClass, issuedAt: this.clock.iso(),
    });
    this.descriptor = await signObject(FEDERATION_SCHEMAS.decision, body, this.signer);
    await this.logEvent({ kind: "federated-decision", scope: "public", subjectId: decisionId, eventDigest: objectDigest(FEDERATION_SCHEMAS.decision, body) });
    return this.descriptor;
  }
  async bind(voterSigner, memberId) {
    const generation = [...this.bindings.values()].filter((b) => b.memberId === memberId).length + 1;
    const body = keyBindingBody({ authority: this.id, decisionId: this.descriptor.body.decisionId, descriptorDigest: objectDigest(FEDERATION_SCHEMAS.decision, this.descriptor.body),
      voterKeyId: voterSigner.keyId, publicKey: voterSigner.publicKey, generation, boundAt: this.clock.iso() });
    const binding = await signObject(FEDERATION_SCHEMAS.keyBinding, body, this.signer);
    this.bindings.set(voterSigner.keyId, { binding, memberId, generation });
    return binding;
  }
  async checkpoint() {
    const size = this.log.size;
    if (this.checkpoints.at(-1)?.body.size === size) return this.checkpoints.at(-1);
    const body = checkpointBody({ logId: this.id, size, rootHash: await this.log.root(), issuedAt: this.clock.iso() });
    const cp = { body, keyId: this.signer.keyId, signature: await this.signer.sign(checkpointSigningInput(body)) };
    this.checkpoints.push(cp);
    for (const peer of this.replicas) await this.sendCheckpoint(peer, null);
    return cp;
  }
  async sendCheckpoint(peer, fromSize) {
    const cp = this.checkpoints.at(-1);
    if (!cp) return;
    const from = fromSize ?? this.checkpointSent.get(peer) ?? 0;
    const consistency = from > 0 && from <= cp.body.size ? { fromSize: from, proof: await this.log.consistency(from, cp.body.size) } : null;
    await this.enqueue(peer, LOG_CHANNEL, "checkpoint", { checkpoint: cp, consistency });
    this.checkpointSent.set(peer, cp.body.size);
    await this.enqueue(peer, this.documentId, "snapshot", await this.snapshot());
  }
  async snapshot() {
    const cp = this.checkpoints.at(-1);
    const index = this.leaves.findIndex((l) => l.kind === "document-version");
    return signObject(FEDERATION_SCHEMAS.snapshot, {
      schema: FEDERATION_SCHEMAS.snapshot, authority: this.id, documentId: this.documentId, sequence: cp.body.size, issuedAt: this.clock.iso(),
      claim: this.claim, edition: this.edition, decisions: this.descriptor ? [{ descriptor: this.descriptor, certificateDigest: null }] : [], checkpoint: cp,
      evidence: [{ kind: "document-version", subjectId: this.documentId, eventDigest: this.leaves[index].eventDigest, index, proof: await this.log.inclusion(index, cp.body.size) }],
    }, this.signer);
  }
  /** Decides one envelope in receive order; duplicates return the original receipt. */
  async decide(envelope, via) {
    const verified = await verifyEnvelope(envelope, { descriptor: this.descriptor, authorityKey: this.signer.publicKey });
    if (!verified.ok) return { error: verified.reason };
    const bound = this.bindings.get(verified.body.voterKeyId);
    if (!bound) return { error: "unknown-voter-key" };
    const history = [...this.decided.values()].filter((d) => d.voterKeyId === verified.body.voterKeyId);
    const currentGeneration = Math.max(...[...this.bindings.values()].filter((b) => b.memberId === bound.memberId).map((b) => b.generation));
    const verdict = judgeEnvelope({ descriptor: this.descriptor, envelopeIdentity: verified.id, body: verified.body, binding: verified.binding, receivedAt: this.clock.now, history, currentGeneration });
    if (verdict.status === "duplicate") return { receipt: verdict.decided.receipt, duplicate: true };
    const receipt = await signObject(FEDERATION_SCHEMAS.receipt, receiptBody({
      authority: this.id, decisionId: verified.body.decisionId, envelopeId: verified.id, voterKeyId: verified.body.voterKeyId, sequence: verified.body.sequence,
      status: verdict.status, reason: verdict.reason, receivedAt: this.clock.iso(), cutoffAt: this.descriptor.body.cutoffAt,
    }), this.signer);
    this.receiptsSigned.set(verified.id, (this.receiptsSigned.get(verified.id) ?? 0) + 1);
    this.decided.set(verified.id, { envelopeId: verified.id, voterKeyId: verified.body.voterKeyId, sequence: verified.body.sequence, status: verdict.status, receipt, via, choice: verified.body.choice, memberId: bound.memberId });
    await this.logEvent(receiptLogEntry(receipt.body));
    return { receipt, duplicate: false };
  }
  async apply(message) {
    const { type, payload, from, documentId } = message.body;
    if (type === "ballot") {
      const decided = await this.decide(payload, from);
      if (decided.receipt) await this.enqueue(from, documentId, "receipt", decided.receipt);
      return "applied";
    }
    if (type === "sync-request") { await this.sendCheckpoint(from, payload.fromSize); return "applied"; }
    return "ignored";
  }
  async onRequest(from, packet) {
    if (packet.kind === "submit") {
      const decided = await this.decide(packet.envelope, null);
      this.network.send(this.id, from, { kind: "receipt", envelopeId: envelopeId(packet.envelope), receipt: decided.receipt ?? null });
    } else if (packet.kind === "receipt-query") {
      this.network.send(this.id, from, { kind: "receipt", envelopeId: packet.envelopeId, receipt: this.decided.get(packet.envelopeId)?.receipt ?? null });
    } else if (packet.kind === "proof-query") {
      const cp = this.checkpoints.at(-1), index = this.leaves.findIndex((l) => l.kind === packet.kind2 && l.eventDigest === packet.eventDigest);
      const inclusion = cp && index >= 0 && index < cp.body.size ? { index, proof: await this.log.inclusion(index, cp.body.size) } : null;
      this.network.send(this.id, from, { kind: "proof", eventDigest: packet.eventDigest, checkpoint: cp, inclusion });
    }
  }
  /** Final count: highest accepted sequence per voter key, among receipts issued by the cutoff. */
  tally() { return countAcceptedReceipts([...this.decided.values()].map((d) => d.receipt)); }
  backup() {
    return structuredClone({ leaves: this.leaves, checkpoints: this.checkpoints, decided: [...this.decided], channels: [...this.channels], checkpointSent: [...this.checkpointSent], sequences: [...this.sequences], outbox: this.outbox });
  }
  /** Disaster recovery from an older backup: everything after it is lost. */
  async restore(backup) {
    const copy = structuredClone(backup);
    this.log = memoryLog();
    for (const leaf of copy.leaves) await this.log.append(entryLeafHash(leaf));
    this.leaves = copy.leaves; this.checkpoints = copy.checkpoints; this.decided = new Map(copy.decided);
    this.channels = new Map(copy.channels); this.checkpointSent = new Map(copy.checkpointSent); this.sequences = new Map(copy.sequences); this.outbox = copy.outbox;
  }
}

export class SimMirror extends Peer {
  constructor({ id, signer, clock, maxMergeDelayMs = 10 * MINUTE }) {
    super(id, signer, clock);
    this.maxMergeDelayMs = maxMergeDelayMs; this.history = new Map(); this.claims = new Map(); this.documents = new Map(); this.relays = new Map();
    this.censorReceipts = false; this.syncRequested = new Set();
  }
  /** Checks an authority checkpoint against this mirror's verified view of that log. */
  async observe(from, { checkpoint: cp, consistency }) {
    const pin = this.pins.get(from), history = this.history.get(from) ?? [];
    const key = pin && peerKey(pin, cp.keyId, Date.parse(cp.body.issuedAt));
    if (!key || cp.body.logId !== from || !(await verifyCheckpoint(cp, key))) return this.note({ kind: "invalid-checkpoint", peer: from, size: cp?.body?.size });
    const observed = observeCheckpoint(history, cp, consistency);
    if (observed.status === "split-view") this.note({ kind: "split-view", peer: from, size: cp.body.size, previous: observed.previous, checkpoint: cp });
    else if (observed.status === "needs-consistency" && !this.syncRequested.has(from + ":" + observed.fromSize + ":" + cp.body.size)) {
      this.syncRequested.add(from + ":" + observed.fromSize + ":" + cp.body.size);
      await this.enqueue(from, LOG_CHANNEL, "sync-request", { fromSize: observed.fromSize });
    } else if (observed.status === "extends") this.history.set(from, recordCheckpoint(history, cp));
  }
  /** Operator-initiated rebuild after losing local state: pins are re-entered, everything else is relearned. */
  wipe() {
    for (const key of ["pins", "sequences", "channels", "history", "claims", "documents", "relays"]) this[key] = new Map();
    this.outbox = []; this.syncRequested = new Set();
  }
  async apply(message) {
    const { type, payload, from, documentId } = message.body;
    const pin = this.pins.get(from);
    if (type === "checkpoint") { await this.observe(from, payload); return "applied"; }
    if (type === "snapshot") {
      const key = peerKey(pin, payload.keyId, Date.parse(payload.body.issuedAt));
      const result = await verifySnapshotBundle(payload, {
        authorityKey: key, claim: this.claims.get(documentId) ?? null, history: this.history.get(from) ?? [],
        previousSequence: this.documents.get(documentId)?.body.sequence ?? 0,
      });
      if (result.status === "awaiting-checkpoint") return "wait";
      if (result.status === "accepted") {
        if (!this.claims.has(documentId)) this.claims.set(documentId, payload.body.claim.body);
        this.documents.set(documentId, payload);
      } else if (result.status === "rejected") this.note({ kind: result.reason, peer: from, documentId });
      return "applied";
    }
    if (type === "receipt") {
      const key = peerKey(pin, payload.keyId, Date.parse(payload.body.receivedAt));
      if (!(await verifySignedObject(FEDERATION_SCHEMAS.receipt, payload, key))) { this.note({ kind: "invalid-receipt", peer: from, envelopeId: payload.body?.envelopeId }); return "applied"; }
      const relay = this.relays.get(payload.body.envelopeId);
      if (relay && relay.receipt && relay.receipt.signature !== payload.signature) this.note({ kind: "conflicting-receipts", peer: from, envelopeId: payload.body.envelopeId, first: relay.receipt, second: payload });
      if (relay && !relay.receipt) relay.receipt = payload;
      return "applied";
    }
    return "ignored";
  }
  descriptorFor(decisionId) {
    for (const bundle of this.documents.values())
      for (const d of bundle.body.decisions) if (d.descriptor.body.decisionId === decisionId) return { descriptor: d.descriptor, authority: bundle.body.authority, documentId: bundle.body.documentId };
    return null;
  }
  /** Signed statement of what this mirror knows about a relayed envelope. */
  async statement(id) {
    const relay = this.relays.get(id);
    const receipt = relay?.receipt && !this.censorReceipts ? relay.receipt : null;
    return { statement: await signObject(FEDERATION_SCHEMAS.relayStatus, relayStatusBody({ mirror: this.id, envelopeId: id, status: receipt ? "receipt-available" : relay ? "awaiting-authority" : "unknown", at: this.clock.iso() }), this.signer), receipt };
  }
  async onRequest(from, packet) {
    if (packet.kind === "submit") {
      const found = this.descriptorFor(packet.envelope.body.decisionId);
      const pin = found && this.pins.get(found.authority);
      const verified = found ? await verifyEnvelope(packet.envelope, { descriptor: found.descriptor, authorityKey: peerKey(pin, found.descriptor.keyId, Date.parse(found.descriptor.body.issuedAt)) }) : { ok: false };
      if (verified.ok && !this.relays.has(verified.id)) {
        this.relays.set(verified.id, { authority: found.authority, receipt: null, relayedAt: this.clock.now });
        await this.enqueue(found.authority, found.documentId, "ballot", packet.envelope);
      }
      this.network.send(this.id, from, { kind: "relay-status", ...(verified.ok ? await this.statement(verified.id) : { error: "unknown-or-invalid" }) });
    } else if (packet.kind === "status-query") this.network.send(this.id, from, { kind: "relay-status", ...(await this.statement(packet.envelopeId)) });
    else if (packet.kind === "proof") await this.auditAnswer(from, packet);
  }
  /** Asks the authority to prove each relayed receipt is logged once the merge delay has passed. */
  auditRelays() {
    for (const [id, relay] of this.relays) {
      if (!relay.receipt || relay.audit) continue;
      if (this.clock.now < Date.parse(relay.receipt.body.receivedAt) + this.maxMergeDelayMs) continue;
      this.network.send(this.id, relay.authority, { kind: "proof-query", kind2: receiptLogEntry(relay.receipt.body).kind, eventDigest: relay.receipt.body.eventDigest, envelopeId: id });
    }
  }
  async auditAnswer(from, { eventDigest, checkpoint, inclusion }) {
    for (const relay of this.relays.values()) {
      if (relay.receipt?.body.eventDigest !== eventDigest || relay.audit) continue;
      const known = (this.history.get(from) ?? []).find((h) => h.size === checkpoint?.body.size);
      if (!checkpoint || !known || known.rootHash !== checkpoint.body.rootHash) continue; // only judge against a verified view
      const verdict = auditReceipt({ receipt: relay.receipt, checkpoint, inclusion, maxMergeDelayMs: this.maxMergeDelayMs }).status;
      if (verdict === "included" || verdict === "omitted") relay.audit = verdict;
      if (verdict === "omitted") this.note({ kind: "omission", peer: from, envelopeId: relay.receipt.body.envelopeId, receipt: relay.receipt, checkpoint });
    }
  }
}

/** A participant device: signs envelopes locally, submits through a path, keeps receipts and statements. */
export class SimVoter {
  constructor({ id, signer, clock, memberId, maxMergeDelayMs = 10 * MINUTE }) {
    this.id = id; this.signer = signer; this.clock = clock; this.memberId = memberId; this.maxMergeDelayMs = maxMergeDelayMs;
    this.receipts = new Map(); this.statements = new Map(); this.audits = new Map(); this.sent = []; this.censorship = [];
  }
  async cast({ descriptor, binding, choice, via, sequence = 1, nonce, castAt = this.clock.now }) {
    const envelope = await createBallotEnvelope({ descriptor, binding, signer: this.signer, sequence, choice, castAt: this.clock.iso(castAt), nonce });
    this.sent.push({ envelope, via, at: this.clock.now });
    this.network.send(this.id, via, { kind: "submit", envelope });
    return envelope;
  }
  /** Client retry: resend envelopes nobody has acknowledged yet (a mirror may not know the decision yet). */
  resubmit() {
    for (const { envelope, via } of this.sent) {
      const id = envelopeId(envelope), status = this.statements.get(id)?.statement.body.status;
      if (!this.receipts.has(id) && (!status || status === "unknown")) this.network.send(this.id, via, { kind: "submit", envelope });
    }
  }
  /** Asks the authority (over this voter's own path) to prove a held receipt is in its log. */
  audit(authority, id) {
    const receipt = this.receipts.get(id);
    if (receipt) this.network.send(this.id, authority, { kind: "proof-query", kind2: receiptLogEntry(receipt.body).kind, eventDigest: receipt.body.eventDigest });
  }
  async onPacket(from, packet) {
    if (packet.kind === "proof") {
      for (const [id, receipt] of this.receipts) {
        if (receipt.body.eventDigest !== packet.eventDigest || !packet.checkpoint) continue;
        this.audits.set(id, auditReceipt({ receipt, checkpoint: packet.checkpoint, inclusion: packet.inclusion, maxMergeDelayMs: this.maxMergeDelayMs }).status);
      }
    }
    if (packet.kind === "receipt" && packet.receipt && !this.receipts.has(packet.envelopeId)) this.receipts.set(packet.envelopeId, packet.receipt);
    if (packet.kind === "relay-status" && packet.statement) {
      this.statements.set(packet.statement.body.envelopeId, { statement: packet.statement, from });
      if (packet.receipt) this.receipts.set(packet.statement.body.envelopeId, packet.receipt);
    }
  }
  /** Compares a mirror's signed "no receipt yet" statement with the authority's receipt fetched independently. */
  checkCensorship(deliveryBoundMs) {
    for (const [id, { statement }] of this.statements) {
      const receipt = this.receipts.get(id);
      if (receipt && receiptWithheld({ statement, receipt, deliveryBoundMs })) this.censorship.push({ envelopeId: id, statement, receipt });
    }
    return this.censorship;
  }
}
