// Signing intents, signature records and mass-signature manifests (DCE-026/027).
// Pure and portable: the service, the offline CLI and browsers share this code.
// A visual mark (typed name or drawn ink) is presentation only. Identity
// assurance comes from the authenticated session and, where required, a
// WebAuthn assertion bound to the signing digest; never from the mark itself.
import { digest, canonicalize, invariant, validDigest } from "./integrity.mjs";
import { leafHash, nodeHash, fromHex, verifyInclusion, EMPTY_ROOT } from "./transparency.mjs";

export const INTENT_SCHEMA = "quill-signature-intent-v1";
export const RECORD_SCHEMA = "quill-signature-record-v1";
export const MARK_SCHEMA = "quill-signature-mark-v1";
export const MANIFEST_SCHEMA = "quill-signature-manifest-v1";
export const RECEIPT_SCHEMA = "quill-signature-receipt-v1";
export const EDITION_SCHEMA = "quill-final-edition-v1";
export const LEAF_ENCODING = "rfc6962-sha256-leaf-of-record-digest-bytes";

export const EDITION_KINDS = Object.freeze(["adopted", "final", "consultation-source"]);
export const SIGNATURE_KINDS = Object.freeze(["support", "approval", "execution"]);
export const DISPUTE_REASONS = Object.freeze(["not-signer", "wrong-text", "coerced", "other"]);
/** Which signature kinds an edition kind accepts; execution needs a legally final text. */
export const EDITION_SIGNATURE_KINDS = Object.freeze({
  adopted: Object.freeze(["support", "approval", "execution"]),
  final: Object.freeze(["support", "approval", "execution"]),
  "consultation-source": Object.freeze(["support", "approval"]),
});
export const EDITION_LIFECYCLE = Object.freeze({ adopted: "adopted", final: "published", "consultation-source": "published" });

/** Versioned consent wording. A changed wording is a new version, never an edit. */
export const CONSENT = Object.freeze({
  support: Object.freeze({
    version: "support-consent-v1",
    text: "I support this exact edition. My support is recorded against the frozen text shown here; it can later be withdrawn, but the record of it cannot be erased.",
  }),
  approval: Object.freeze({
    version: "approval-consent-v1",
    text: "I approve this exact edition as shown. My approval is recorded against the frozen text; it can later be withdrawn or disputed, but the record of it cannot be erased.",
  }),
  execution: Object.freeze({
    version: "execution-consent-v1",
    text: "I intend to sign this exact edition in the capacity stated and agree to use an electronic record and electronic signature for it. My authenticated signing event, not my visual mark, identifies me. Whether this signature is legally effective depends on the applicable law and the agreement itself.",
  }),
});

/** Font ids whose licenses permit embedding in rendered signature marks. */
export const SIGNATURE_FONTS = Object.freeze([
  Object.freeze({ id: "dancing-script", family: "Dancing Script", license: "OFL-1.1" }),
  Object.freeze({ id: "caveat", family: "Caveat", license: "OFL-1.1" }),
  Object.freeze({ id: "great-vibes", family: "Great Vibes", license: "OFL-1.1" }),
  Object.freeze({ id: "system-serif", family: "serif", license: "system-font-not-embedded" }),
]);
export const INK_LIMITS = Object.freeze({ width: 1000, height: 400, strokes: 64, pointsPerStroke: 1000, points: 4000 });

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const HEX = /^[a-f0-9]{64}$/;
const uuid = (value, label) => { invariant(typeof value === "string" && UUID.test(value), "Invalid " + label); return value; };
const hex = (value, label) => { invariant(typeof value === "string" && HEX.test(value), "Invalid " + label); return value; };
const iso = (value, label) => {
  invariant(typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value, "Invalid " + label);
  return value;
};
const exactKeys = (value, keys, label) => {
  invariant(value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype, "Invalid " + label);
  invariant(Object.keys(value).sort().join(",") === [...keys].sort().join(","), "Unexpected " + label + " fields");
  return value;
};
const oneOf = (value, options, label) => { invariant(options.includes(value), "Invalid " + label); return value; };
// Control, bidirectional-override and zero-width formatting characters can
// make a displayed name differ from its recorded bytes.
const UNSAFE_TEXT = /[\p{Cc}​-‏‪-‮⁠-⁩﻿]/u;
/** Normalized human-readable label (signer name or capacity). */
export function displayText(value, max = 120) {
  invariant(typeof value === "string", "Text is required");
  const normalized = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  invariant(normalized.length >= 1 && normalized.length <= max && !UNSAFE_TEXT.test(normalized), "Invalid text");
  canonicalize(normalized);
  return normalized;
}
/** Case-insensitive key used for directory prefix search. */
export const nameKey = (name) => displayText(name).normalize("NFKC").toLowerCase();

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
export function base64url(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += B64[n & 63];
  }
  return out;
}

export function validateIntent(intent) {
  exactKeys(intent, ["schema", "tenantId", "documentId", "editionId", "editionDigest", "artifactDigest", "kind", "capacity",
    "consentVersion", "consentText", "accountId", "nonce", "issuedAt", "expiresAt"], "intent");
  invariant(intent.schema === INTENT_SCHEMA, "Unsupported intent schema");
  uuid(intent.tenantId, "tenant"); uuid(intent.documentId, "document"); uuid(intent.editionId, "edition"); uuid(intent.accountId, "account");
  hex(intent.editionDigest, "edition digest"); hex(intent.nonce, "nonce");
  invariant(intent.artifactDigest === null || HEX.test(intent.artifactDigest), "Invalid artifact digest");
  oneOf(intent.kind, SIGNATURE_KINDS, "signature kind");
  invariant(intent.consentVersion === CONSENT[intent.kind].version && intent.consentText === CONSENT[intent.kind].text, "Unknown consent wording");
  invariant(intent.kind === "execution" ? intent.capacity === displayText(intent.capacity ?? "", 200) : intent.capacity === null || intent.capacity === displayText(intent.capacity, 200), "Invalid capacity");
  iso(intent.issuedAt, "issue time"); iso(intent.expiresAt, "expiry time");
  invariant(Date.parse(intent.expiresAt) > Date.parse(intent.issuedAt), "Intent expires before issue");
  return intent;
}
/** Server-issued statement of what will be signed; the signing digest commits to all of it. */
export function signatureIntent({ tenantId, documentId, editionId, editionDigest, artifactDigest = null, kind, capacity = null, accountId, nonce, issuedAt, expiresAt }) {
  oneOf(kind, SIGNATURE_KINDS, "signature kind");
  return validateIntent({
    schema: INTENT_SCHEMA, tenantId, documentId, editionId, editionDigest, artifactDigest, kind,
    capacity: capacity === null ? null : displayText(capacity, 200),
    consentVersion: CONSENT[kind].version, consentText: CONSENT[kind].text,
    accountId, nonce, issuedAt, expiresAt,
  });
}
export const signingDigest = (intent) => digest(INTENT_SCHEMA, validateIntent(intent));
/** WebAuthn challenge: the 32 raw signing-digest bytes, base64url without padding. */
export const signingChallenge = (digestHex) => base64url(fromHex(validDigest(digestHex)));

/** Validates and normalizes a typed, drawn or absent visual mark. */
export function validateMark(mark, kind) {
  invariant(mark && typeof mark === "object" && !Array.isArray(mark), "Invalid mark");
  if (mark.type === "none") {
    exactKeys(mark, ["type"], "mark");
    invariant(kind === "support", "A visual mark is required for this signature kind");
    return { type: "none" };
  }
  if (mark.type === "typed") {
    exactKeys(mark, ["type", "text", "fontId"], "mark");
    invariant(SIGNATURE_FONTS.some((font) => font.id === mark.fontId), "Unlicensed or unknown signature font");
    return { type: "typed", text: displayText(mark.text), fontId: mark.fontId };
  }
  exactKeys(mark, ["type", "strokes"], "mark");
  invariant(mark.type === "drawn", "Unknown mark type");
  invariant(Array.isArray(mark.strokes) && mark.strokes.length >= 1 && mark.strokes.length <= INK_LIMITS.strokes, "Invalid number of strokes");
  let total = 0;
  const strokes = mark.strokes.map((stroke) => {
    invariant(Array.isArray(stroke) && stroke.length >= 2 && stroke.length % 2 === 0 && stroke.length <= INK_LIMITS.pointsPerStroke * 2, "Invalid stroke");
    total += stroke.length / 2;
    stroke.forEach((n, i) => invariant(Number.isSafeInteger(n) && n >= 0 && n <= (i % 2 ? INK_LIMITS.height : INK_LIMITS.width), "Ink coordinate out of bounds"));
    return [...stroke];
  });
  invariant(total <= INK_LIMITS.points, "Too many ink points");
  return { type: "drawn", strokes };
}
export const markDigest = (mark, kind) => digest(MARK_SCHEMA, validateMark(mark, kind));

export function validateDisplay(display) {
  invariant(display && typeof display === "object", "Invalid display preference");
  if (display.visibility === "private") { exactKeys(display, ["visibility"], "display"); return { visibility: "private" }; }
  exactKeys(display, ["visibility", "name"], "display");
  invariant(display.visibility === "public", "Invalid display preference");
  return { visibility: "public", name: displayText(display.name) };
}

const SIGN_KEYS = ["schema", "action", "tenantId", "editionId", "editionDigest", "artifactDigest", "kind", "intentDigest", "consentVersion",
  "consent", "capacity", "mark", "display", "publicName", "assurance", "method", "signedAt"];
const FOLLOW_KEYS = ["schema", "action", "tenantId", "editionId", "kind", "signatureRecordDigest", "reason", "raisedBy", "nonce", "at"];
export function validateRecord(record) {
  invariant(record && typeof record === "object" && record.schema === RECORD_SCHEMA, "Unsupported record schema");
  uuid(record.tenantId, "tenant"); uuid(record.editionId, "edition"); oneOf(record.kind, SIGNATURE_KINDS, "signature kind");
  if (record.action === "sign") {
    exactKeys(record, SIGN_KEYS, "record");
    hex(record.editionDigest, "edition digest"); hex(record.intentDigest, "intent digest");
    invariant(record.artifactDigest === null || HEX.test(record.artifactDigest), "Invalid artifact digest");
    invariant(record.consent === true && record.consentVersion === CONSENT[record.kind].version, "Explicit consent is required");
    invariant(record.capacity === null || record.capacity === displayText(record.capacity, 200), "Invalid capacity");
    invariant(record.kind !== "execution" || record.capacity !== null, "Execution requires a capacity");
    exactKeys(record.mark, record.mark?.type === "none" ? ["type"] : ["type", "digest"], "mark reference");
    oneOf(record.mark.type, ["none", "typed", "drawn"], "mark type");
    if (record.mark.type !== "none") hex(record.mark.digest, "mark digest");
    oneOf(record.display, ["public", "private"], "display");
    invariant(record.display === "public" ? record.publicName === displayText(record.publicName ?? "") : record.publicName === null, "Invalid public name");
    exactKeys(record.assurance, ["sessionAuthenticatedAt", "sessionAssurance", "passkey"], "assurance");
    iso(record.assurance.sessionAuthenticatedAt, "authentication time");
    oneOf(record.assurance.sessionAssurance, ["primary", "multifactor", "hardware-bound"], "session assurance");
    invariant(typeof record.assurance.passkey === "boolean", "Invalid passkey flag");
    invariant(record.kind !== "execution" || record.assurance.passkey, "Execution requires a passkey assertion");
    invariant(record.method === record.mark.type + (record.assurance.passkey ? "+passkey" : ""), "Invalid signing method");
    iso(record.signedAt, "signing time");
    return record;
  }
  exactKeys(record, FOLLOW_KEYS, "record");
  oneOf(record.action, ["withdraw", "dispute"], "record action");
  hex(record.signatureRecordDigest, "signature record digest"); hex(record.nonce, "nonce"); iso(record.at, "time");
  if (record.action === "withdraw") invariant(record.reason === null && record.raisedBy === "signer", "Only the signer withdraws");
  else invariant(DISPUTE_REASONS.includes(record.reason) && ["signer", "manager"].includes(record.raisedBy), "Invalid dispute");
  return record;
}
/** Canonical record of an authenticated signing event. */
export function signatureRecord({ intent, mark, display, assurance, signedAt }) {
  validateIntent(intent);
  const normalizedMark = validateMark(mark, intent.kind), shown = validateDisplay(display);
  return validateRecord({
    schema: RECORD_SCHEMA, action: "sign", tenantId: intent.tenantId, editionId: intent.editionId,
    editionDigest: intent.editionDigest, artifactDigest: intent.artifactDigest, kind: intent.kind,
    intentDigest: signingDigest(intent), consentVersion: intent.consentVersion, consent: true, capacity: intent.capacity,
    mark: normalizedMark.type === "none" ? { type: "none" } : { type: normalizedMark.type, digest: markDigest(normalizedMark, intent.kind) },
    display: shown.visibility, publicName: shown.visibility === "public" ? shown.name : null,
    assurance: { sessionAuthenticatedAt: assurance.sessionAuthenticatedAt, sessionAssurance: assurance.sessionAssurance, passkey: assurance.passkey },
    method: normalizedMark.type + (assurance.passkey ? "+passkey" : ""), signedAt,
  });
}
/** Withdrawal or dispute: a new event referencing the original; history is never erased. */
export function followUpRecord({ action, signature, reason = null, raisedBy = "signer", nonce, at }) {
  validateRecord(signature);
  invariant(signature.action === "sign", "Only a signing event can be withdrawn or disputed");
  return validateRecord({
    schema: RECORD_SCHEMA, action, tenantId: signature.tenantId, editionId: signature.editionId, kind: signature.kind,
    signatureRecordDigest: recordDigest(signature), reason, raisedBy, nonce, at,
  });
}
export const recordDigest = (record) => digest(RECORD_SCHEMA, validateRecord(record));
export const recordLeaf = (digestHex) => leafHash(fromHex(validDigest(digestHex)));

export function validateEditionRecord(record) {
  exactKeys(record, ["schema", "tenantId", "editionId", "documentId", "sequence", "kind", "lifecycle", "sourceVersion", "sourceDigest",
    "editionDigest", "artifact", "decision", "frozenAt"], "edition record");
  invariant(record.schema === EDITION_SCHEMA, "Unsupported edition schema");
  uuid(record.tenantId, "tenant"); uuid(record.editionId, "edition"); uuid(record.documentId, "document");
  invariant(Number.isSafeInteger(record.sequence) && record.sequence >= 1 && Number.isSafeInteger(record.sourceVersion) && record.sourceVersion >= 1, "Invalid edition position");
  oneOf(record.kind, EDITION_KINDS, "edition kind");
  invariant(record.lifecycle === EDITION_LIFECYCLE[record.kind], "Invalid edition lifecycle");
  hex(record.sourceDigest, "source digest"); hex(record.editionDigest, "edition digest"); iso(record.frozenAt, "freeze time");
  if (record.artifact !== null) {
    exactKeys(record.artifact, ["sha256", "mediaType"], "artifact");
    hex(record.artifact.sha256, "artifact digest");
    invariant(typeof record.artifact.mediaType === "string" && /^[a-z]+\/[a-z0-9.+-]{1,80}$/.test(record.artifact.mediaType), "Invalid artifact media type");
  }
  if (record.kind === "adopted") {
    exactKeys(record.decision, ["decisionId", "certificateDigest"], "decision reference");
    uuid(record.decision.decisionId, "decision"); hex(record.decision.certificateDigest, "certificate digest");
  } else invariant(record.decision === null, "Only adopted editions reference a decision");
  return record;
}
export const editionRecordDigest = (record) => digest(EDITION_SCHEMA, validateEditionRecord(record));

export function validateManifest(record) {
  exactKeys(record, ["schema", "tenantId", "editionId", "editionDigest", "artifactDigest", "kind", "version", "size", "rootHash",
    "previousSize", "previousRootHash", "activeSigners", "publicSigners", "leafEncoding", "frozenAt"], "manifest");
  invariant(record.schema === MANIFEST_SCHEMA && record.leafEncoding === LEAF_ENCODING, "Unsupported manifest schema");
  uuid(record.tenantId, "tenant"); uuid(record.editionId, "edition"); hex(record.editionDigest, "edition digest");
  invariant(record.artifactDigest === null || HEX.test(record.artifactDigest), "Invalid artifact digest");
  oneOf(record.kind, SIGNATURE_KINDS, "signature kind");
  for (const key of ["version", "size", "previousSize", "activeSigners", "publicSigners"])
    invariant(Number.isSafeInteger(record[key]) && record[key] >= 0, "Invalid manifest " + key);
  invariant(record.version >= 1 && record.size > record.previousSize && record.publicSigners <= record.activeSigners && record.activeSigners <= record.size, "Inconsistent manifest counts");
  hex(record.rootHash, "manifest root");
  invariant(record.previousSize === 0 ? record.previousRootHash === null : HEX.test(record.previousRootHash ?? ""), "Invalid previous root");
  iso(record.frozenAt, "freeze time");
  return record;
}
export const manifestDigest = (record) => digest(MANIFEST_SCHEMA, validateManifest(record));

/**
 * RFC 6962 root over record digests with O(log n) memory, for independent
 * recomputation of a downloaded manifest. Accepts any iterable.
 */
export function manifestRoot(digests) {
  const stack = [];
  let count = 0;
  for (const value of digests) {
    let node = { hash: recordLeaf(value), width: 1 };
    while (stack.length && stack[stack.length - 1].width === node.width) {
      const left = stack.pop();
      node = { hash: nodeHash(left.hash, node.hash), width: left.width * 2 };
    }
    stack.push(node);
    count++;
  }
  if (!stack.length) return { size: 0, rootHash: EMPTY_ROOT };
  let root = stack.pop().hash;
  while (stack.length) root = nodeHash(stack.pop().hash, root);
  return { size: count, rootHash: root };
}

/**
 * Offline verification of a personal inclusion receipt. Each check is
 * reported separately; a receipt proves inclusion in a manifest, not
 * identity, legal effect or that the manifest was externally anchored.
 */
export function verifySignatureReceipt(receipt) {
  const checks = { recordDigest: null, intentDigest: null, manifestDigest: false, inclusion: false, ledgerBinding: false };
  try {
    invariant(receipt && typeof receipt === "object" && receipt.schema === RECEIPT_SCHEMA, "Unsupported receipt");
    canonicalize(receipt);
    const manifest = validateManifest(receipt.manifest.record);
    checks.manifestDigest = manifestDigest(manifest) === receipt.manifest.digest;
    hex(receipt.recordDigest, "record digest");
    if (receipt.record) {
      const record = validateRecord(receipt.record);
      checks.recordDigest = recordDigest(record) === receipt.recordDigest &&
        record.editionId === manifest.editionId && record.kind === manifest.kind && record.tenantId === manifest.tenantId &&
        (record.action !== "sign" || record.editionDigest === manifest.editionDigest);
      if (receipt.intent) checks.intentDigest = record.action === "sign" && signingDigest(receipt.intent) === record.intentDigest;
    }
    checks.inclusion = verifyInclusion({ leaf: recordLeaf(receipt.recordDigest), index: receipt.position, treeSize: manifest.size, proof: receipt.proof, root: manifest.rootHash });
    checks.ledgerBinding = receipt.ledger?.kind === "signature-manifest" && receipt.ledger.subjectId === manifest.editionId && receipt.ledger.eventDigest === receipt.manifest.digest;
  } catch { /* fall through with the checks recorded so far */ }
  const valid = checks.manifestDigest && checks.inclusion && checks.ledgerBinding && checks.recordDigest !== false && checks.intentDigest !== false;
  return { valid, checks, externalAnchorVerified: false, identityProven: false };
}
