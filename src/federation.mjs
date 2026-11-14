// DCE-037 federation and delayed-network protocol (pure, browser-safe).
//
// Every document has exactly one authority instance: the instance whose
// transparency log orders its votes and editions. Other instances mirror
// signed snapshots read-only and relay signed ballot envelopes through durable
// store-and-forward queues. Nothing here provides instantaneous or global
// consensus: an authority decides alone, in its own receive order, and a
// ballot is final only when the authority received it before the disclosed
// cutoff (closesAt + the decision's declared grace) and logged a signed
// receipt. Signatures are Ed25519 through WebCrypto; hashes are SHA-256.
import { sha256 } from "./sha256.mjs";
import { canonicalize, invariant } from "./integrity-values.mjs";
import { digest } from "./integrity.mjs";
import { legalDocumentDigest } from "./legal-schema.mjs";
import {
  toHex, keyIdFor, verifyEd25519, verifyCheckpoint, verifyInclusion, verifyConsistency,
  checkpointBody, entryLeafHash,
} from "./transparency.mjs";

export const FEDERATION_SCHEMAS = Object.freeze({
  keyRotation: "quill-federation-key-rotation-v1",
  authority: "quill-federation-authority-v1",
  decision: "quill-federation-decision-v1",
  keyBinding: "quill-federation-key-binding-v1",
  ballot: "quill-federation-ballot-v1",
  receipt: "quill-federation-receipt-v1",
  relayStatus: "quill-federation-relay-status-v1",
  snapshot: "quill-federation-snapshot-v1",
  message: "quill-federation-message-v1",
  request: "quill-federation-request-v1",
});

/**
 * Disclosed grace for ballots in transit. The grace must cover the worst
 * one-way delay of the class plus store-and-forward retries; it is not a
 * second voting window. Inside the grace the authority cannot distinguish an
 * honest delayed envelope from one signed after closesAt with an earlier
 * client timestamp, so classes should be no longer than the path requires.
 */
export const DELAY_CLASSES = Object.freeze({
  terrestrial: Object.freeze({ id: "terrestrial", graceMs: 5 * 60_000, maxOneWayDelayMs: 2_000 }),
  cislunar: Object.freeze({ id: "cislunar", graceMs: 15 * 60_000, maxOneWayDelayMs: 2_000 }),
  mars: Object.freeze({ id: "mars", graceMs: 3 * 3_600_000, maxOneWayDelayMs: 22 * 60_000 }),
});
export const MAX_GRACE_MS = 7 * 24 * 3_600_000;
export const MAX_BALLOT_SEQUENCE = 100;
export const MESSAGE_TYPES = Object.freeze(["checkpoint", "sync-request", "snapshot", "ballot", "receipt"]);
/** Ordering channel for an authority's log checkpoints (not a document). */
export const LOG_CHANNEL = "00000000-0000-0000-0000-000000000000";
export const RECEIPT_KINDS = Object.freeze({ accepted: "federated-ballot", rejected: "federated-rejection" });
export const BINDING_KIND = "federated-key-binding";

const encoder = new TextEncoder();
const HEX64 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const INSTANCE = /^[a-z0-9][a-z0-9.-]{2,80}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export const isInstanceId = (v) => typeof v === "string" && INSTANCE.test(v);
export const isUuid = (v) => typeof v === "string" && UUID.test(v);
const iso = (v, label) => {
  invariant(typeof v === "string" && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString() === v, "Invalid " + label);
  return v;
};
const ms = (v) => Date.parse(v);
const hex64 = (v, label) => { invariant(typeof v === "string" && HEX64.test(v), "Invalid " + label); return v; };
const uuid = (v, label) => { invariant(isUuid(v), "Invalid " + label); return v; };
const instance = (v, label = "instance identity") => { invariant(isInstanceId(v), "Invalid " + label); return v; };
const publicKey32 = (v) => {
  invariant(typeof v === "string" && BASE64.test(v) && atob(v).length === 32, "Invalid Ed25519 public key");
  return v;
};
const exactKeys = (value, keys, label) => {
  invariant(value && typeof value === "object" && !Array.isArray(value), "Invalid " + label);
  const present = Object.keys(value);
  invariant(present.length === keys.length && present.every((k) => keys.includes(k)), "Unexpected " + label + " fields");
};

export const bytesToBase64 = (bytes) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
export const base64ToBytes = (value) => {
  invariant(typeof value === "string" && BASE64.test(value), "Invalid base64 value");
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
};
export const sha256Hex = (bytes) => toHex(sha256(bytes));

/** Exact bytes signed for any federation object. */
export const signingInput = (schema, body) => encoder.encode(schema + "\0" + canonicalize(body));
export const objectDigest = (schema, body) => sha256Hex(signingInput(schema, body));

/** A signer holds an Ed25519 key; `sign(bytes)` returns a base64 signature. */
export async function generateSigner() {
  const pair = await globalThis.crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
  const raw = new Uint8Array(await globalThis.crypto.subtle.exportKey("raw", pair.publicKey));
  return signerFromCryptoKey(pair.privateKey, bytesToBase64(raw));
}
export function signerFromCryptoKey(privateKey, publicKeyBase64) {
  publicKey32(publicKeyBase64);
  return Object.freeze({
    publicKey: publicKeyBase64, keyId: keyIdFor(publicKeyBase64),
    sign: async (bytes) => bytesToBase64(new Uint8Array(await globalThis.crypto.subtle.sign({ name: "Ed25519" }, privateKey, bytes))),
  });
}

export async function signObject(schema, body, signer) {
  return { body, keyId: signer.keyId, signature: await signer.sign(signingInput(schema, body)) };
}
export async function verifySignedObject(schema, signed, publicKey) {
  try {
    return signed?.keyId === keyIdFor(publicKey) &&
      await verifyEd25519(publicKey, signed.signature, signingInput(schema, signed.body));
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Peer identity: an instance is its log identity plus a pinned Ed25519 key.

/**
 * A key rotation is signed by the currently pinned key (authorization) and
 * by the next key (proof of possession). Peers only follow rotations signed
 * by a key they already pinned; anything else needs an operator re-pin.
 */
export async function createKeyRotation({ instanceId, sequence, effectiveAt, previous, next }) {
  const body = keyRotationBody({ instanceId, sequence, effectiveAt, previousKeyId: previous.keyId, nextPublicKey: next.publicKey, nextKeyId: next.keyId });
  const input = signingInput(FEDERATION_SCHEMAS.keyRotation, body);
  return { body, signatures: { previous: await previous.sign(input), next: await next.sign(input) } };
}
export function keyRotationBody({ instanceId, sequence, effectiveAt, previousKeyId, nextPublicKey, nextKeyId }) {
  instance(instanceId);
  invariant(Number.isSafeInteger(sequence) && sequence >= 1, "Invalid rotation sequence");
  iso(effectiveAt, "rotation time");
  hex64(previousKeyId, "previous key");
  publicKey32(nextPublicKey);
  invariant(nextKeyId === keyIdFor(nextPublicKey) && nextKeyId !== previousKeyId, "Invalid next key");
  return { schema: FEDERATION_SCHEMAS.keyRotation, instanceId, sequence, effectiveAt, previousKeyId, nextPublicKey, nextKeyId };
}

/** Peer record: `keys` is the pinned history, newest last, with validity windows. */
export function pinPeer({ instanceId, origin, publicKey, maxDelayMs = 0, pinnedAt }) {
  instance(instanceId);
  invariant(typeof origin === "string" && new URL(origin).origin === origin && origin.startsWith("https://"), "Peer origin must be an exact HTTPS origin");
  invariant(Number.isSafeInteger(maxDelayMs) && maxDelayMs >= 0 && maxDelayMs <= MAX_GRACE_MS, "Invalid peer delay");
  iso(pinnedAt, "pin time");
  return { instanceId, origin, maxDelayMs, rotationSequence: 0, keys: [{ keyId: keyIdFor(publicKey32(publicKey)), publicKey, validFrom: pinnedAt, validUntil: null }] };
}
export async function applyKeyRotation(peer, rotation) {
  let body;
  try { body = keyRotationBody(rotation.body); } catch { return { ok: false, reason: "malformed-rotation" }; }
  if (body.instanceId !== peer.instanceId) return { ok: false, reason: "wrong-instance" };
  if (body.sequence <= peer.rotationSequence) return { ok: false, reason: "stale-rotation" };
  const current = peer.keys.at(-1);
  if (current.keyId !== body.previousKeyId) return { ok: false, reason: "not-signed-by-pinned-key" };
  const input = signingInput(FEDERATION_SCHEMAS.keyRotation, body);
  if (!(await verifyEd25519(current.publicKey, rotation.signatures?.previous, input))) return { ok: false, reason: "invalid-authorization" };
  if (!(await verifyEd25519(body.nextPublicKey, rotation.signatures?.next, input))) return { ok: false, reason: "invalid-possession" };
  if (ms(body.effectiveAt) < ms(current.validFrom)) return { ok: false, reason: "rotation-predates-key" };
  const keys = peer.keys.slice(0, -1).concat(
    { ...current, validUntil: body.effectiveAt },
    { keyId: body.nextKeyId, publicKey: body.nextPublicKey, validFrom: body.effectiveAt, validUntil: null });
  return { ok: true, peer: { ...peer, rotationSequence: body.sequence, keys } };
}
/** The pinned key `keyId` if it was valid at `atMs`; signatures by retired keys stay verifiable for their window. */
export function peerKey(peer, keyId, atMs) {
  const key = peer?.keys.find((k) => k.keyId === keyId);
  if (!key) return null;
  if (atMs < ms(key.validFrom) || (key.validUntil !== null && atMs >= ms(key.validUntil))) return null;
  return key.publicKey;
}

// ---------------------------------------------------------------------------
// Authority and finality domains.

export function authorityClaimBody({ documentId, authority, visibility, claimedAt }) {
  uuid(documentId, "document");
  instance(authority, "authority");
  invariant(visibility === "public" || visibility === "private", "Invalid visibility");
  iso(claimedAt, "claim time");
  return { schema: FEDERATION_SCHEMAS.authority, documentId, authority, visibility, claimedAt };
}
/**
 * The first verified claim a mirror accepts for a document is binding.
 * A different instance claiming the same document is a conflict, never a
 * takeover; authority transfer requires an operator decision on each mirror.
 */
export function compareAuthority(existing, incoming) {
  if (!existing) return "new";
  if (existing.documentId !== incoming.documentId) throw Error("Claims for different documents");
  return existing.authority === incoming.authority && existing.visibility === incoming.visibility ? "same" : "conflict";
}

export function resolveDelayClass(delayClass) {
  if (typeof delayClass === "string") {
    invariant(Object.hasOwn(DELAY_CLASSES, delayClass), "Unknown delay class");
    return DELAY_CLASSES[delayClass];
  }
  exactKeys(delayClass, ["id", "graceMs", "maxOneWayDelayMs"], "delay class");
  invariant(/^[a-z][a-z0-9-]{1,40}$/.test(delayClass.id), "Invalid delay class id");
  invariant(Number.isSafeInteger(delayClass.graceMs) && delayClass.graceMs >= 0 && delayClass.graceMs <= MAX_GRACE_MS, "Invalid grace");
  invariant(Number.isSafeInteger(delayClass.maxOneWayDelayMs) && delayClass.maxOneWayDelayMs >= 0 && delayClass.maxOneWayDelayMs <= delayClass.graceMs + 2_000, "Grace must cover the declared one-way delay");
  return Object.freeze({ ...delayClass });
}

/** Signed, logged disclosure of when a ballot for this decision is final. */
export function decisionDescriptorBody({
  authority, documentId, decisionId, proposalDigest, snapshotDigest, policyDigest,
  electorate, opensAt, closesAt, delayClass, issuedAt,
}) {
  instance(authority, "authority");
  uuid(documentId, "document"); uuid(decisionId, "decision");
  hex64(proposalDigest, "proposal digest"); hex64(snapshotDigest, "snapshot digest"); hex64(policyDigest, "policy digest");
  exactKeys(electorate, ["electorateDigest", "size"], "electorate commitment");
  hex64(electorate.electorateDigest, "electorate digest");
  invariant(Number.isSafeInteger(electorate.size) && electorate.size >= 1 && electorate.size <= 100000, "Invalid electorate size");
  iso(opensAt, "opening time"); iso(closesAt, "closing time"); iso(issuedAt, "issue time");
  invariant(ms(closesAt) > ms(opensAt), "Invalid voting window");
  const cls = resolveDelayClass(delayClass);
  const cutoffAt = new Date(ms(closesAt) + cls.graceMs).toISOString();
  return {
    schema: FEDERATION_SCHEMAS.decision, authority, documentId, decisionId, proposalDigest, snapshotDigest, policyDigest,
    electorate: { electorateDigest: electorate.electorateDigest, size: electorate.size },
    opensAt, closesAt, delayClass: { id: cls.id, graceMs: cls.graceMs, maxOneWayDelayMs: cls.maxOneWayDelayMs }, cutoffAt, issuedAt,
  };
}
export const descriptorDigest = (body) => objectDigest(FEDERATION_SCHEMAS.decision, decisionDescriptorBody(body));

/** Authority statement that a participant key votes for one frozen-electorate member. */
export function keyBindingBody({ authority, decisionId, descriptorDigest: descriptor, voterKeyId, publicKey, generation, boundAt }) {
  instance(authority, "authority"); uuid(decisionId, "decision"); hex64(descriptor, "descriptor digest");
  publicKey32(publicKey);
  invariant(voterKeyId === keyIdFor(publicKey), "Voter key id mismatch");
  invariant(Number.isSafeInteger(generation) && generation >= 1 && generation <= 100, "Invalid binding generation");
  iso(boundAt, "binding time");
  return { schema: FEDERATION_SCHEMAS.keyBinding, authority, decisionId, descriptorDigest: descriptor, voterKeyId, publicKey, generation, boundAt };
}
/** Log digest of a binding: reveals neither the member nor the key. */
export const bindingEventDigest = (body) => digest("federated-key-binding-event-v1", { bindingDigest: objectDigest(FEDERATION_SCHEMAS.keyBinding, body) });

// ---------------------------------------------------------------------------
// Ballot envelopes, judgement and receipts.

export function ballotBody({ authority, decisionId, descriptorDigest: descriptor, voterKeyId, sequence, choice, castAt, nonce }) {
  instance(authority, "authority"); uuid(decisionId, "decision"); hex64(descriptor, "descriptor digest"); hex64(voterKeyId, "voter key");
  invariant(Number.isSafeInteger(sequence) && sequence >= 1 && sequence <= MAX_BALLOT_SEQUENCE, "Invalid ballot sequence");
  invariant(["yes", "no", "abstain"].includes(choice), "Invalid ballot choice");
  iso(castAt, "client timestamp");
  invariant(typeof nonce === "string" && /^[a-f0-9]{32}$/.test(nonce), "Invalid nonce");
  return { schema: FEDERATION_SCHEMAS.ballot, authority, decisionId, descriptorDigest: descriptor, voterKeyId, sequence, choice, castAt, nonce };
}
const randomNonce = () => toHex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
/** Built on the participant's device; the private key never leaves it. */
export async function createBallotEnvelope({ descriptor, binding, signer, sequence, choice, castAt, nonce = randomNonce() }) {
  const body = ballotBody({
    authority: descriptor.body.authority, decisionId: descriptor.body.decisionId,
    descriptorDigest: objectDigest(FEDERATION_SCHEMAS.decision, descriptor.body),
    voterKeyId: signer.keyId, sequence, choice, castAt, nonce,
  });
  return { body, publicKey: signer.publicKey, signature: await signer.sign(signingInput(FEDERATION_SCHEMAS.ballot, body)), binding };
}
export const envelopeId = (envelope) => objectDigest(FEDERATION_SCHEMAS.ballot, ballotBody(envelope.body));

/**
 * Checks everything a relay or the authority can check without its database:
 * the voter signature, the authority-signed key binding and the descriptor.
 */
export async function verifyEnvelope(envelope, { descriptor, authorityKey }) {
  let body;
  try {
    exactKeys(envelope, ["body", "publicKey", "signature", "binding"], "envelope");
    body = ballotBody(envelope.body);
  } catch { return { ok: false, reason: "malformed-envelope" }; }
  if (!descriptor || body.decisionId !== descriptor.body.decisionId || body.authority !== descriptor.body.authority)
    return { ok: false, reason: "unknown-decision" };
  if (body.descriptorDigest !== objectDigest(FEDERATION_SCHEMAS.decision, descriptor.body)) return { ok: false, reason: "descriptor-mismatch" };
  if (keyIdFor(envelope.publicKey) !== body.voterKeyId) return { ok: false, reason: "voter-key-mismatch" };
  if (!(await verifyEd25519(envelope.publicKey, envelope.signature, signingInput(FEDERATION_SCHEMAS.ballot, body))))
    return { ok: false, reason: "invalid-voter-signature" };
  let binding;
  try { binding = keyBindingBody(envelope.binding?.body); } catch { return { ok: false, reason: "malformed-binding" }; }
  if (binding.decisionId !== body.decisionId || binding.voterKeyId !== body.voterKeyId || binding.publicKey !== envelope.publicKey ||
    binding.descriptorDigest !== body.descriptorDigest || binding.authority !== body.authority)
    return { ok: false, reason: "binding-mismatch" };
  if (!(await verifySignedObject(FEDERATION_SCHEMAS.keyBinding, envelope.binding, authorityKey))) return { ok: false, reason: "invalid-binding-signature" };
  return { ok: true, id: envelopeId(envelope), body, binding };
}

/**
 * The authority's deterministic acceptance rule, applied in its own receive
 * order. `history` lists earlier decided envelopes for the same voter key;
 * `currentGeneration` is the voter's active binding generation.
 */
export function judgeEnvelope({ descriptor, envelopeIdentity, body, binding, receivedAt, history, currentGeneration, clockSkewMs = 120_000 }) {
  const prior = history.find((h) => h.envelopeId === envelopeIdentity);
  if (prior) return { status: "duplicate", decided: prior };
  const d = descriptor.body;
  if (receivedAt > ms(d.cutoffAt)) return { status: "rejected", reason: "received-after-cutoff" };
  if (binding.generation !== currentGeneration) return { status: "rejected", reason: "binding-superseded" };
  const castAt = ms(body.castAt);
  if (castAt < ms(d.opensAt) || castAt >= ms(d.closesAt)) return { status: "rejected", reason: "cast-outside-window" };
  if (castAt > receivedAt + clockSkewMs) return { status: "rejected", reason: "client-time-in-future" };
  if (receivedAt < ms(d.opensAt)) return { status: "rejected", reason: "received-before-opening" };
  const accepted = history.filter((h) => h.status === "accepted");
  if (accepted.some((h) => h.sequence === body.sequence)) return { status: "rejected", reason: "sequence-equivocation" };
  if (accepted.some((h) => h.sequence > body.sequence)) return { status: "rejected", reason: "superseded-sequence" };
  return { status: "accepted", reason: null };
}

/** Deterministic from public facts, so a voter can look for it in the log. */
export function receiptEventDigest({ authority, decisionId, envelopeId: id, status }) {
  instance(authority, "authority"); uuid(decisionId, "decision"); hex64(id, "envelope id");
  invariant(status === "accepted" || status === "rejected", "Invalid receipt status");
  return digest("federated-receipt-event-v1", { authority, decisionId, envelopeId: id, status });
}
export function receiptBody({ authority, decisionId, envelopeId: id, voterKeyId, sequence, status, reason, receivedAt, cutoffAt }) {
  invariant(status === "accepted" ? reason === null : typeof reason === "string" && /^[a-z][a-z0-9-]{2,40}$/.test(reason), "Invalid receipt reason");
  hex64(voterKeyId, "voter key");
  invariant(Number.isSafeInteger(sequence) && sequence >= 1 && sequence <= MAX_BALLOT_SEQUENCE, "Invalid ballot sequence");
  iso(receivedAt, "receive time"); iso(cutoffAt, "cutoff");
  return {
    schema: FEDERATION_SCHEMAS.receipt, authority, decisionId, envelopeId: id, voterKeyId, sequence, status, reason,
    receivedAt, cutoffAt, eventDigest: receiptEventDigest({ authority, decisionId, envelopeId: id, status }),
  };
}
export const receiptLogEntry = (body) => ({
  kind: RECEIPT_KINDS[body.status], scope: "public", subjectId: body.decisionId, eventDigest: body.eventDigest,
});

/**
 * A mirror's signed statement about an envelope it relayed. Signing it turns
 * "the mirror told me there is no receipt" into checkable evidence.
 */
export function relayStatusBody({ mirror, envelopeId: id, status, at }) {
  instance(mirror, "mirror"); hex64(id, "envelope id"); iso(at, "statement time");
  invariant(["receipt-available", "awaiting-authority", "unknown"].includes(status), "Invalid relay status");
  return { schema: FEDERATION_SCHEMAS.relayStatus, mirror, envelopeId: id, status, at };
}
/**
 * True when a mirror still denied having a receipt later than the declared
 * delivery bound for its path (one-way delay plus retry allowance) after the
 * authority issued it. Inside the bound a missing receipt is indistinguishable
 * from ordinary delay, so this never fires early.
 */
export function receiptWithheld({ statement, receipt, deliveryBoundMs }) {
  const s = relayStatusBody(statement.body), r = receipt.body;
  return s.envelopeId === r.envelopeId && s.status !== "receipt-available" && ms(s.at) > ms(r.receivedAt) + deliveryBoundMs;
}

/** Final counted ballot per voter key: the highest accepted sequence. */
export function countAcceptedReceipts(receipts) {
  const latest = new Map();
  for (const r of receipts) {
    if (r.body.status !== "accepted") continue;
    const prior = latest.get(r.body.voterKeyId);
    if (!prior || prior.body.sequence < r.body.sequence) latest.set(r.body.voterKeyId, r);
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Checkpoint history, split views and omissions.

/**
 * Compares a newly verified checkpoint with what this observer saw before.
 * `history` is [{size, rootHash}] sorted by size. A shrinking or forked log is
 * reported, never silently adopted; an older checkpoint delivered late by a
 * delay-tolerant path is only compared with the root seen at that size.
 */
export function observeCheckpoint(history, checkpoint, consistency = null) {
  const { size, rootHash } = checkpointBody(checkpoint.body);
  const same = history.find((h) => h.size === size);
  if (same) return same.rootHash === rootHash ? { status: "known" } : { status: "split-view", reason: "same-size-different-root", previous: same };
  const latest = history.at(-1);
  if (!latest || latest.size === 0) return { status: "extends" };
  if (size < latest.size) {
    const older = history.filter((h) => h.size < size).at(-1);
    if (!older) return { status: "stale-unverified" };
    if (!consistency || consistency.fromSize !== older.size) return { status: "stale-unverified" };
    return verifyConsistency({ first: older.size, second: size, firstRoot: older.rootHash, secondRoot: rootHash, proof: consistency.proof })
      ? { status: "stale" } : { status: "split-view", reason: "inconsistent-history", previous: older };
  }
  if (!consistency || consistency.fromSize !== latest.size) return { status: "needs-consistency", fromSize: latest.size };
  return verifyConsistency({ first: latest.size, second: size, firstRoot: latest.rootHash, secondRoot: rootHash, proof: consistency.proof })
    ? { status: "extends" } : { status: "split-view", reason: "inconsistent-history", previous: latest };
}
export const recordCheckpoint = (history, checkpoint) => {
  const { size, rootHash } = checkpoint.body;
  if (history.some((h) => h.size === size)) return history;
  return [...history, { size, rootHash, checkpoint }].sort((a, b) => a.size - b.size);
};

/**
 * Audits a signed receipt against a later signed checkpoint. A receipt is a
 * promise to log the event within `maxMergeDelayMs`; a checkpoint issued after
 * that without a valid inclusion proof is evidence of omission.
 */
export function auditReceipt({ receipt, checkpoint, inclusion, maxMergeDelayMs }) {
  const r = receipt.body, cp = checkpointBody(checkpoint.body);
  if (inclusion) {
    const leaf = entryLeafHash(receiptLogEntry(r));
    return verifyInclusion({ leaf, index: inclusion.index, treeSize: cp.size, proof: inclusion.proof, root: cp.rootHash })
      ? { status: "included" } : { status: "invalid-proof" };
  }
  return ms(cp.issuedAt) >= ms(r.receivedAt) + maxMergeDelayMs ? { status: "omitted" } : { status: "pending" };
}

// ---------------------------------------------------------------------------
// Portable signed snapshots.

/** Event digest the document store logs for a public edition. */
export function editionEventDigest(edition) {
  const fields = {
    tenantId: uuid(edition.tenantId, "tenant"), documentId: uuid(edition.documentId, "document"), version: edition.version,
    digest: hex64(edition.digest, "edition digest"), previousDigest: edition.previousDigest, createdAt: iso(edition.createdAt, "edition time"),
  };
  invariant(Number.isSafeInteger(edition.version) && edition.version >= 1, "Invalid edition version");
  return edition.restoration
    ? digest("public-document-restoration-v1", { ...fields, restoration: edition.restoration })
    : digest("public-document-version-v1", fields);
}

/**
 * Verifies a bundle against the pinned authority key and this mirror's view
 * of the authority's log. The bundle's checkpoint must already be in the
 * mirror's verified history (checkpoints travel, with consistency proofs, on
 * the ordered LOG_CHANNEL); otherwise the bundle waits. Nothing is served
 * unless status is "accepted".
 */
export async function verifySnapshotBundle(bundle, { authorityKey, claim: knownClaim = null, history = [], previousSequence = 0 }) {
  const reject = (reason, extra = {}) => ({ status: "rejected", reason, ...extra });
  try { exactKeys(bundle, ["body", "keyId", "signature"], "snapshot"); } catch { return reject("malformed-snapshot"); }
  const b = bundle.body;
  if (!(await verifySignedObject(FEDERATION_SCHEMAS.snapshot, bundle, authorityKey))) return reject("invalid-authority-signature");
  try {
    exactKeys(b, ["schema", "authority", "documentId", "sequence", "issuedAt", "claim", "edition", "decisions", "checkpoint", "evidence"], "snapshot body");
    invariant(b.schema === FEDERATION_SCHEMAS.snapshot && Number.isSafeInteger(b.sequence) && b.sequence >= 1, "Invalid snapshot header");
    instance(b.authority); uuid(b.documentId, "document"); iso(b.issuedAt, "snapshot time");
    authorityClaimBody(b.claim.body);
    invariant(Array.isArray(b.decisions) && b.decisions.length <= 200 && Array.isArray(b.evidence) && b.evidence.length <= 400, "Snapshot too large");
  } catch { return reject("malformed-snapshot"); }
  if (b.claim.body.documentId !== b.documentId || b.claim.body.authority !== b.authority) return reject("claim-mismatch");
  if (!(await verifySignedObject(FEDERATION_SCHEMAS.authority, b.claim, authorityKey))) return reject("invalid-claim-signature");
  if (compareAuthority(knownClaim, b.claim.body) === "conflict") return reject("authority-conflict", { conflict: { known: knownClaim, claimed: b.claim } });
  if (b.sequence <= previousSequence) return { status: "stale", reason: "older-snapshot" };
  if (b.checkpoint.body?.logId !== b.authority || !(await verifyCheckpoint(b.checkpoint, authorityKey))) return reject("invalid-checkpoint");
  const known = history.find((h) => h.size === b.checkpoint.body.size);
  if (!known) return { status: "awaiting-checkpoint", size: b.checkpoint.body.size };
  if (known.rootHash !== b.checkpoint.body.rootHash) return reject("split-view", { evidence: { previous: known, checkpoint: b.checkpoint } });
  const root = b.checkpoint.body.rootHash, treeSize = b.checkpoint.body.size;
  const proven = new Set();
  for (const item of b.evidence) {
    try {
      const leaf = entryLeafHash({ kind: item.kind, scope: "public", subjectId: item.subjectId, eventDigest: item.eventDigest });
      if (!verifyInclusion({ leaf, index: item.index, treeSize, proof: item.proof, root })) return reject("invalid-inclusion-proof");
    } catch { return reject("invalid-inclusion-proof"); }
    proven.add(item.kind + ":" + item.eventDigest);
  }
  const e = b.edition;
  try {
    if (b.claim.body.visibility === "public") {
      exactKeys(e, ["tenantId", "documentId", "version", "digest", "previousDigest", "createdAt", "restoration", "document"], "edition");
      invariant(e.documentId === b.documentId && legalDocumentDigest(e.document) === e.digest, "Edition digest mismatch");
      if (!proven.has("document-version:" + editionEventDigest(e))) return reject("edition-not-logged");
    } else {
      exactKeys(e, ["version", "ciphertextDigest", "ciphertextUri", "byteLength"], "private edition");
      invariant(Number.isSafeInteger(e.version) && e.version >= 1 && Number.isSafeInteger(e.byteLength) && e.byteLength >= 0, "Invalid private edition");
      hex64(e.ciphertextDigest, "ciphertext digest");
      invariant(typeof e.ciphertextUri === "string" && e.ciphertextUri.startsWith("https://") && e.ciphertextUri.length <= 2048, "Invalid ciphertext reference");
    }
  } catch { return reject("invalid-edition"); }
  for (const d of b.decisions) {
    try {
      exactKeys(d, ["descriptor", "certificateDigest"], "decision entry");
      decisionDescriptorBody(d.descriptor.body);
      invariant(d.descriptor.body.documentId === b.documentId && d.descriptor.body.authority === b.authority, "Foreign decision");
      invariant(d.certificateDigest === null || HEX64.test(d.certificateDigest), "Invalid certificate digest");
    } catch { return reject("invalid-decision"); }
    if (!(await verifySignedObject(FEDERATION_SCHEMAS.decision, d.descriptor, authorityKey))) return reject("invalid-decision-signature");
  }
  return { status: "accepted" };
}

// ---------------------------------------------------------------------------
// Store-and-forward messages between instances.

export function messageBody({ from, to, documentId, sequence, type, payload, createdAt }) {
  instance(from, "sender"); instance(to, "recipient"); uuid(documentId, "document");
  invariant(from !== to, "A message needs a remote recipient");
  invariant(Number.isSafeInteger(sequence) && sequence >= 1, "Invalid message sequence");
  invariant(MESSAGE_TYPES.includes(type), "Invalid message type");
  iso(createdAt, "message time");
  canonicalize(payload);
  return { schema: FEDERATION_SCHEMAS.message, from, to, documentId, sequence, type, payload, createdAt };
}
export async function createMessage(fields, signer) {
  const body = messageBody(fields);
  return { id: objectDigest(FEDERATION_SCHEMAS.message, body), ...(await signObject(FEDERATION_SCHEMAS.message, body, signer)) };
}
export async function verifyMessage(message, publicKey) {
  try {
    exactKeys(message, ["id", "body", "keyId", "signature"], "message");
    const body = messageBody(message.body);
    return message.id === objectDigest(FEDERATION_SCHEMAS.message, body) && await verifySignedObject(FEDERATION_SCHEMAS.message, message, publicKey);
  } catch { return false; }
}

/**
 * Per-(sender, document) ordering. `channel` = {appliedThrough, pending:
 * Map<sequence, id>}. Messages apply strictly in sequence; later ones wait
 * (bounded) for the gap, duplicates are acknowledged and dropped, and a second
 * message claiming an applied or pending sequence is sender equivocation.
 */
export function classifyIncoming(channel, message, { maxAhead = 1000, appliedIds = null } = {}) {
  const seq = message.body.sequence;
  if (seq <= channel.appliedThrough) {
    if (appliedIds && appliedIds.get(seq) !== undefined && appliedIds.get(seq) !== message.id) return "conflict";
    return "duplicate";
  }
  const pending = channel.pending.get(seq);
  if (pending !== undefined) return pending === message.id ? "duplicate" : "conflict";
  if (seq > channel.appliedThrough + maxAhead) return "too-far-ahead";
  return seq === channel.appliedThrough + 1 ? "ready" : "buffer";
}
/** Sequences now applicable, in order, once `channel.pending` holds the new message. */
export function drainable(channel) {
  const ready = [];
  for (let s = channel.appliedThrough + 1; channel.pending.has(s); s++) ready.push(s);
  return ready;
}

/** Exponential backoff with deterministic jitter derived from the message id. */
export function retryDelayMs(attempts, id, { baseMs = 2_000, capMs = 6 * 3_600_000 } = {}) {
  invariant(Number.isSafeInteger(attempts) && attempts >= 1, "Invalid attempt count");
  const exponential = Math.min(capMs, baseMs * 2 ** Math.min(attempts - 1, 30));
  const jitter = parseInt(hex64(id, "message id").slice(0, 8), 16) / 0xffffffff;
  return Math.round(exponential / 2 + jitter * exponential / 2);
}

// ---------------------------------------------------------------------------
// Peer-authenticated HTTP requests (signed, never cookie-based).

export const REQUEST_HEADERS = Object.freeze({
  instance: "x-quill-federation-instance", keyId: "x-quill-federation-key-id", timestamp: "x-quill-federation-timestamp",
  nonce: "x-quill-federation-nonce", signature: "x-quill-federation-signature",
});
export function requestSigningInput({ method, path, instanceId, keyId, timestamp, nonce, bodyDigest }) {
  invariant(/^(GET|POST)$/.test(method) && typeof path === "string" && path.startsWith("/api/federation/"), "Invalid signed request target");
  instance(instanceId); hex64(keyId, "key id"); iso(timestamp, "request time"); hex64(bodyDigest, "body digest");
  invariant(typeof nonce === "string" && /^[a-f0-9]{32}$/.test(nonce), "Invalid request nonce");
  return signingInput(FEDERATION_SCHEMAS.request, { method, path, instanceId, keyId, timestamp, nonce, bodyDigest });
}
export async function signRequest({ method, path, body = new Uint8Array(), instanceId, signer, timestamp, nonce = randomNonce() }) {
  const input = requestSigningInput({ method, path, instanceId, keyId: signer.keyId, timestamp, nonce, bodyDigest: sha256Hex(body) });
  return {
    [REQUEST_HEADERS.instance]: instanceId, [REQUEST_HEADERS.keyId]: signer.keyId, [REQUEST_HEADERS.timestamp]: timestamp,
    [REQUEST_HEADERS.nonce]: nonce, [REQUEST_HEADERS.signature]: await signer.sign(input),
  };
}
/**
 * Verifies a signed request. The freshness window is the clock-skew allowance
 * plus the peer's declared one-way delay: a request from a light-minutes-away
 * peer is legitimately old on arrival. Replays are stopped by `nonceUnused`.
 */
export async function verifyRequest({ method, path, headers, body, peer, now, clockSkewMs = 300_000 }) {
  const get = (name) => (typeof headers.get === "function" ? headers.get(name) : headers[name]) ?? null;
  try {
    const instanceId = get(REQUEST_HEADERS.instance), keyId = get(REQUEST_HEADERS.keyId), timestamp = get(REQUEST_HEADERS.timestamp);
    const nonce = get(REQUEST_HEADERS.nonce), signature = get(REQUEST_HEADERS.signature);
    if (!peer || peer.instanceId !== instanceId) return { ok: false, reason: "unknown-peer" };
    const input = requestSigningInput({ method, path, instanceId, keyId, timestamp, nonce, bodyDigest: sha256Hex(body) });
    const at = ms(timestamp);
    if (at > now + clockSkewMs || at < now - clockSkewMs - peer.maxDelayMs) return { ok: false, reason: "stale-request" };
    const key = peerKey(peer, keyId, at);
    if (!key) return { ok: false, reason: "unpinned-key" };
    if (!(await verifyEd25519(key, signature, input))) return { ok: false, reason: "invalid-signature" };
    return { ok: true, instanceId, nonce, expiresAt: at + clockSkewMs + peer.maxDelayMs };
  } catch { return { ok: false, reason: "malformed-request" }; }
}
