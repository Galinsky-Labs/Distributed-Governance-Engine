// OpenTimestamps proof codec and offline verifier.
// Reads and writes the standard `.ots` format byte-for-byte, so proofs made
// here open in the reference `ots` tools and vice versa. Pure and synchronous
// (no Node or DOM imports) so the same code runs in the service and browsers.
// Only SHA-256 is built in; SHA-1, RIPEMD-160 and KECCAK-256 commitments parse
// and round-trip, and are evaluated only when a caller supplies `hashers`.
import { sha256 } from "./sha256.mjs";

export class TimestampError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TimestampError";
    this.code = code;
  }
}
const fail = (code, message) => { throw new TimestampError(code, message); };

export const LIMITS = Object.freeze({
  maxDepth: 256,
  maxOps: 10_000,
  maxBytes: 1_000_000,
  maxMessage: 4096,
  maxOpArg: 4096,
  maxPayload: 8192,
  maxUri: 1000,
});
const MAX_VARUINT = 2 ** 53;

const MAGIC = Uint8Array.of(
  0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00,
  0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94,
);
const MAJOR_VERSION = 1;
const FORK = 0xff;
const ATTESTATION = 0x00;
const TAGS = {
  bitcoin: "0588960d73d71901",
  pending: "83dfe30d2ef90c8e",
  litecoin: "06869a0d73d71b45",
};
const KIND_BY_TAG = new Map(Object.entries(TAGS).map(([kind, tag]) => [tag, kind]));
const URI_CHARS = /^[a-zA-Z0-9.\-_/:]*$/;

const OPS = new Map([
  [0x02, { name: "sha1", hashLength: 20 }],
  [0x03, { name: "ripemd160", hashLength: 20 }],
  [0x08, { name: "sha256", hashLength: 32 }],
  [0x67, { name: "keccak256", hashLength: 32 }],
  [0xf0, { name: "append", binary: true }],
  [0xf1, { name: "prepend", binary: true }],
  [0xf2, { name: "reverse" }],
  [0xf3, { name: "hexlify" }],
]);
const OP_BY_NAME = new Map([...OPS].map(([byte, op]) => [op.name, { ...op, byte }]));
const FILE_HASH_OPS = new Set(["sha1", "ripemd160", "sha256", "keccak256"]);

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
export function fromHex(hex) {
  if (typeof hex !== "string" || !/^(?:[0-9a-f]{2})*$/i.test(hex)) fail("invalid-argument", "Invalid hexadecimal value");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};
const equalBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const compareBytes = (a, b) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};
const isBytes = (value) => value instanceof Uint8Array;
const bytesArg = (value, name) => {
  if (isBytes(value)) return value;
  if (typeof value === "string") return fromHex(value);
  return fail("invalid-argument", `${name} must be bytes or hexadecimal`);
};

class Reader {
  constructor(bytes) { this.bytes = bytes; this.pos = 0; }
  byte() {
    if (this.pos >= this.bytes.length) fail("truncated", "Unexpected end of proof");
    return this.bytes[this.pos++];
  }
  take(length) {
    if (this.bytes.length - this.pos < length) fail("truncated", "Unexpected end of proof");
    return this.bytes.slice(this.pos, (this.pos += length));
  }
  varuint() {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      if (shift > 49) fail("varuint-overflow", "Integer exceeds 2^53");
      const b = this.byte();
      value += (b & 0x7f) * 2 ** shift;
      if (value >= MAX_VARUINT) fail("varuint-overflow", "Integer exceeds 2^53");
      if (!(b & 0x80)) {
        // A zero final byte means a shorter encoding existed; accepting it would make proofs malleable.
        if (b === 0 && shift > 0) fail("non-canonical-varuint", "Integer is not minimally encoded");
        return value;
      }
    }
  }
  varbytes(min, max) {
    const length = this.varuint();
    if (length < min || length > max) fail("invalid-length", `Length ${length} outside ${min}..${max}`);
    return this.take(length);
  }
  end() {
    if (this.pos !== this.bytes.length) fail("trailing-bytes", "Unexpected bytes after proof");
  }
}

class Writer {
  constructor() { this.parts = []; this.length = 0; }
  bytes(bytes) {
    this.length += bytes.length;
    if (this.length > LIMITS.maxBytes) fail("too-large", "Proof exceeds the size limit");
    this.parts.push(bytes);
  }
  byte(value) { this.bytes(Uint8Array.of(value)); }
  varuint(value) {
    if (!Number.isSafeInteger(value) || value < 0) fail("invalid-argument", "Invalid unsigned integer");
    const out = [];
    do {
      const low = value % 128;
      value = Math.floor(value / 128);
      out.push(value > 0 ? low | 0x80 : low);
    } while (value > 0);
    this.bytes(Uint8Array.from(out));
  }
  varbytes(bytes) { this.varuint(bytes.length); this.bytes(bytes); }
  result() { return concat(...this.parts); }
}

function decodeAttestation(tag, payload) {
  const tagHex = toHex(tag);
  const kind = KIND_BY_TAG.get(tagHex);
  if (!kind) return { kind: "unknown", tag, payload };
  const r = new Reader(payload);
  let attestation;
  if (kind === "pending") {
    const uriBytes = r.varbytes(0, LIMITS.maxUri);
    let uri;
    try { uri = decoder.decode(uriBytes); } catch { fail("invalid-pending-uri", "Pending URI is not UTF-8"); }
    if (!URI_CHARS.test(uri)) fail("invalid-pending-uri", "Pending URI contains a forbidden character");
    attestation = { kind, uri };
  } else {
    attestation = { kind, height: r.varuint() };
  }
  r.end();
  return attestation;
}

function encodeAttestation(attestation) {
  if (attestation?.kind === "unknown") {
    if (!isBytes(attestation.tag) || attestation.tag.length !== 8 || KIND_BY_TAG.has(toHex(attestation.tag))) {
      fail("invalid-attestation", "Unknown attestation needs an 8-byte unrecognised tag");
    }
    if (!isBytes(attestation.payload)) fail("invalid-attestation", "Unknown attestation needs a byte payload");
    return { tag: attestation.tag, payload: attestation.payload };
  }
  const tag = TAGS[attestation?.kind];
  if (!tag) fail("invalid-attestation", "Unsupported attestation kind");
  const w = new Writer();
  if (attestation.kind === "pending") {
    const { uri } = attestation;
    if (typeof uri !== "string" || !URI_CHARS.test(uri) || uri.length > LIMITS.maxUri) {
      fail("invalid-pending-uri", "Invalid pending URI");
    }
    w.varbytes(encoder.encode(uri));
  } else {
    w.varuint(attestation.height);
  }
  return { tag: fromHex(tag), payload: w.result() };
}

function readTimestamp(r, depth, state) {
  if (depth > LIMITS.maxDepth) fail("depth-exceeded", "Proof nesting exceeds the depth limit");
  const branches = [];
  let tag = r.byte();
  while (tag === FORK) {
    branches.push(readBranch(r, r.byte(), depth, state));
    tag = r.byte();
  }
  branches.push(readBranch(r, tag, depth, state));
  return { branches };
}

function readBranch(r, tag, depth, state) {
  if (tag === ATTESTATION) {
    const attestationTag = r.take(8);
    return { type: "attestation", attestation: decodeAttestation(attestationTag, r.varbytes(0, LIMITS.maxPayload)) };
  }
  const op = OPS.get(tag);
  if (!op) fail("unknown-op", `Unknown operation 0x${tag.toString(16).padStart(2, "0")}`);
  if (++state.ops > LIMITS.maxOps) fail("too-many-ops", "Proof exceeds the operation limit");
  const branch = { type: "op", op: op.name };
  if (op.binary) branch.arg = r.varbytes(1, LIMITS.maxOpArg);
  branch.timestamp = readTimestamp(r, depth + 1, state);
  return branch;
}

function writeTimestamp(w, node, depth) {
  if (depth > LIMITS.maxDepth) fail("depth-exceeded", "Proof nesting exceeds the depth limit");
  const branches = node?.branches;
  if (!Array.isArray(branches) || branches.length === 0) fail("empty-timestamp", "A timestamp needs at least one branch");
  branches.forEach((branch, i) => {
    if (i < branches.length - 1) w.byte(FORK);
    if (branch.type === "attestation") {
      const { tag, payload } = encodeAttestation(branch.attestation);
      if (payload.length > LIMITS.maxPayload) fail("invalid-length", "Attestation payload too large");
      w.byte(ATTESTATION);
      w.bytes(tag);
      w.varbytes(payload);
    } else {
      const op = OP_BY_NAME.get(branch.op);
      if (!op) fail("unknown-op", "Unknown operation");
      w.byte(op.byte);
      if (op.binary) w.varbytes(binaryArg(branch.arg));
      writeTimestamp(w, branch.timestamp, depth + 1);
    }
  });
}

function binaryArg(arg) {
  if (!isBytes(arg) || arg.length < 1 || arg.length > LIMITS.maxOpArg) {
    fail("invalid-length", `Operation argument must be 1..${LIMITS.maxOpArg} bytes`);
  }
  return arg;
}

// `message` is null when an earlier hash on the path has no available
// implementation; its length is still known so size limits stay enforced.
function applyOp(name, arg, message, length, hashers) {
  const op = OP_BY_NAME.get(name);
  let result;
  let resultLength;
  if (op.hashLength) {
    resultLength = op.hashLength;
    const hash = name === "sha256" ? sha256 : hashers?.[name];
    if (message && typeof hash === "function") {
      result = hash(message);
      if (!isBytes(result) || result.length !== op.hashLength) fail("invalid-argument", `Bad ${name} hasher output`);
    }
  } else if (name === "append" || name === "prepend") {
    binaryArg(arg);
    resultLength = length + arg.length;
    if (message) result = name === "append" ? concat(message, arg) : concat(arg, message);
  } else {
    if (length === 0) fail("invalid-message", `Cannot ${name} an empty message`);
    resultLength = name === "hexlify" ? length * 2 : length;
    if (message) result = name === "hexlify" ? encoder.encode(toHex(message)) : message.slice().reverse();
  }
  if (resultLength > LIMITS.maxMessage) fail("message-too-long", "Operation result exceeds 4096 bytes");
  return { message: result ?? null, length: resultLength };
}

// Rebuilds a tree with every message recomputed from `message`, so verification
// never trusts message fields stored on caller-supplied structures.
function materialize(node, message, length, hashers, depth = 0, state = { ops: 0 }) {
  if (depth > LIMITS.maxDepth) fail("depth-exceeded", "Proof nesting exceeds the depth limit");
  if (!Array.isArray(node?.branches)) fail("invalid-argument", "Timestamp needs a branches array");
  const branches = node.branches.map((branch) => {
    if (branch?.type === "attestation") {
      encodeAttestation(branch.attestation);
      return { type: "attestation", attestation: branch.attestation };
    }
    if (branch?.type !== "op" || !OP_BY_NAME.has(branch.op)) fail("unknown-op", "Unknown operation");
    if (++state.ops > LIMITS.maxOps) fail("too-many-ops", "Proof exceeds the operation limit");
    const result = applyOp(branch.op, branch.arg, message, length, hashers);
    const out = { type: "op", op: branch.op };
    if (OP_BY_NAME.get(branch.op).binary) out.arg = branch.arg;
    out.timestamp = materialize(branch.timestamp, result.message, result.length, hashers, depth + 1, state);
    return out;
  });
  return { message, branches };
}

function rootMessage(message) {
  if (!isBytes(message) || message.length > LIMITS.maxMessage) fail("invalid-argument", "Message must be at most 4096 bytes");
  return message;
}

function checkSize(bytes) {
  if (!isBytes(bytes)) fail("invalid-argument", "Proof must be a Uint8Array");
  if (bytes.length > LIMITS.maxBytes) fail("too-large", "Proof exceeds the size limit");
}

/** Parses a serialized Timestamp committing to `message`. */
export function parseTimestamp(bytes, message, { hashers } = {}) {
  checkSize(bytes);
  rootMessage(message);
  const r = new Reader(bytes);
  const structure = readTimestamp(r, 0, { ops: 0 });
  r.end();
  return materialize(structure, message, message.length, hashers);
}

export function serializeTimestamp(timestamp) {
  const w = new Writer();
  writeTimestamp(w, timestamp, 0);
  return w.result();
}

export function parseDetachedTimestamp(bytes, { hashers } = {}) {
  checkSize(bytes);
  const r = new Reader(bytes);
  if (!equalBytes(r.take(MAGIC.length), MAGIC)) fail("bad-magic", "Not an OpenTimestamps proof");
  if (r.varuint() !== MAJOR_VERSION) fail("unsupported-version", "Unsupported proof major version");
  const op = OPS.get(r.byte());
  if (!op || !FILE_HASH_OPS.has(op.name)) fail("unknown-file-hash-op", "Unsupported file hash operation");
  const digest = r.take(op.hashLength);
  const structure = readTimestamp(r, 0, { ops: 0 });
  r.end();
  return { fileHashOp: op.name, digest, timestamp: materialize(structure, digest, digest.length, hashers) };
}

function checkDetached(detached) {
  const op = OP_BY_NAME.get(detached?.fileHashOp);
  if (!op || !FILE_HASH_OPS.has(op.name)) fail("unknown-file-hash-op", "Unsupported file hash operation");
  if (!isBytes(detached.digest) || detached.digest.length !== op.hashLength) {
    fail("invalid-argument", `File digest must be ${op.hashLength} bytes`);
  }
  return op;
}

export function serializeDetachedTimestamp(detached) {
  const op = checkDetached(detached);
  const w = new Writer();
  w.bytes(MAGIC);
  w.varuint(MAJOR_VERSION);
  w.byte(op.byte);
  w.bytes(detached.digest);
  writeTimestamp(w, detached.timestamp, 0);
  return w.result();
}

const attestationKey = (attestation) => {
  const { tag, payload } = encodeAttestation(attestation);
  return toHex(tag) + toHex(payload);
};
function compareAttestations(a, b) {
  const byTag = compareBytes(encodeAttestation(a).tag, encodeAttestation(b).tag);
  if (byTag) return byTag;
  if (a.kind === "pending") return a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0;
  if (a.kind === "unknown") return compareBytes(a.payload, b.payload);
  return a.height - b.height;
}
function compareOps(a, b) {
  return OP_BY_NAME.get(a.op).byte - OP_BY_NAME.get(b.op).byte || compareBytes(a.arg ?? new Uint8Array(), b.arg ?? new Uint8Array());
}

function mergeNodes(nodes) {
  const attestations = new Map();
  const ops = new Map();
  for (const node of nodes) {
    for (const branch of node.branches) {
      if (branch.type === "attestation") {
        attestations.set(attestationKey(branch.attestation), branch);
      } else {
        const key = `${branch.op}:${branch.arg ? toHex(branch.arg) : ""}`;
        if (!ops.has(key)) ops.set(key, { op: branch.op, arg: branch.arg, children: [] });
        ops.get(key).children.push(branch.timestamp);
      }
    }
  }
  const mergedOps = [...ops.values()].sort(compareOps).map(({ op, arg, children }) => {
    const branch = { type: "op", op };
    if (arg) branch.arg = arg;
    branch.timestamp = mergeNodes(children);
    return branch;
  });
  const sortedAttestations = [...attestations.values()].sort((a, b) => compareAttestations(a.attestation, b.attestation));
  return { message: nodes[0].message, branches: [...sortedAttestations, ...mergedOps] };
}

/**
 * Merges timestamps for the same message: duplicate attestations and
 * operations collapse, and branches take a canonical order (attestations by
 * tag then value, then operations by opcode then argument), so equal inputs in
 * any order serialize to identical bytes.
 */
export function mergeTimestamps(...timestamps) {
  if (timestamps.length === 0) fail("invalid-argument", "Nothing to merge");
  const message = rootMessage(timestamps[0]?.message);
  for (const ts of timestamps) {
    if (!isBytes(ts?.message) || !equalBytes(ts.message, message)) fail("message-mismatch", "Timestamps commit to different messages");
  }
  const nodes = timestamps.map((ts) => materialize(ts, message, message.length));
  return materialize(mergeNodes(nodes), message, message.length);
}

function walkAttestations(node, path, unsupported, out) {
  for (const branch of node.branches) {
    if (branch.type === "attestation") {
      const a = branch.attestation;
      const entry = { kind: a.kind };
      if (a.kind === "bitcoin" || a.kind === "litecoin") entry.height = a.height;
      if (a.kind === "pending") entry.uri = a.uri;
      if (a.kind === "unknown") { entry.tag = toHex(a.tag); entry.payload = toHex(a.payload); }
      entry.message = node.message ? toHex(node.message) : null;
      if (unsupported) entry.unsupported = unsupported;
      entry.path = path;
      out.push(entry);
    } else {
      const step = branch.arg ? { op: branch.op, arg: toHex(branch.arg) } : { op: branch.op };
      const blocked = unsupported ?? (node.message && !branch.timestamp.message ? branch.op : undefined);
      walkAttestations(branch.timestamp, [...path, step], blocked, out);
    }
  }
}

const rootOf = (value, hashers) => {
  if (value && "digest" in value) {
    checkDetached(value);
    return materialize(value.timestamp, value.digest, value.digest.length, hashers);
  }
  const message = rootMessage(value?.message);
  return materialize(value, message, message.length, hashers);
};

/**
 * Lists every attestation in a Timestamp or detached proof with the message it
 * attests (hex), recomputed from the root. `message` is null and `unsupported`
 * names the operation when the path uses a hash with no implementation.
 */
export function attestations(timestampOrDetached, { hashers } = {}) {
  const out = [];
  walkAttestations(rootOf(timestampOrDetached, hashers), [], undefined, out);
  return out;
}

/** Starts a proof the way the standard client does: append a nonce, then SHA-256. */
export function createDetachedTimestamp(fileDigest, { nonce } = {}) {
  const digest = bytesArg(fileDigest, "File digest");
  if (digest.length !== 32) fail("invalid-argument", "File digest must be a 32-byte SHA-256 digest");
  if (!isBytes(nonce) || nonce.length !== 16) fail("invalid-argument", "Nonce must be 16 random bytes");
  const salted = concat(digest, nonce);
  const commitment = sha256(salted);
  const timestamp = {
    message: digest,
    branches: [{
      type: "op", op: "append", arg: nonce.slice(),
      timestamp: { message: salted, branches: [{ type: "op", op: "sha256", timestamp: { message: commitment, branches: [] } }] },
    }],
  };
  return { detached: { fileHashOp: "sha256", digest: digest.slice(), timestamp }, commitment };
}

/**
 * Merges a calendar response (a serialized Timestamp for `commitment`) into
 * every node of the proof whose message equals `commitment`.
 */
export function attachCalendarResponse(detached, commitment, responseBytes, { hashers } = {}) {
  const target = rootMessage(bytesArg(commitment, "Commitment"));
  const response = parseTimestamp(responseBytes, target, { hashers });
  let found = 0;
  const graft = (node) => {
    if (node.message && equalBytes(node.message, target)) {
      found++;
      return mergeNodes([node, response]);
    }
    return {
      message: node.message,
      branches: node.branches.map((b) => (b.type === "op" ? { ...b, timestamp: graft(b.timestamp) } : b)),
    };
  };
  const timestamp = graft(rootOf(detached, hashers));
  if (found === 0) fail("commitment-not-found", "The proof does not contain that commitment");
  return { fileHashOp: detached.fileHashOp, digest: detached.digest, timestamp: materialize(timestamp, detached.digest, detached.digest.length, hashers) };
}

/**
 * True when the proof commits `expectedFileDigest` to the given Bitcoin block
 * header. A Bitcoin attestation's message is the block merkle root in internal
 * byte order, the reverse of the hex shown by block explorers.
 */
export function verifyAgainstHeader(detached, expectedFileDigest, { height, merkleRootHex }, { hashers } = {}) {
  if (!Number.isSafeInteger(height) || height < 0) fail("invalid-argument", "Invalid block height");
  if (typeof merkleRootHex !== "string" || !/^[0-9a-f]{64}$/i.test(merkleRootHex)) fail("invalid-argument", "Invalid merkle root");
  checkDetached(detached);
  if (!equalBytes(bytesArg(expectedFileDigest, "Expected digest"), detached.digest)) return false;
  const expected = toHex(fromHex(merkleRootHex.toLowerCase()).reverse());
  const candidates = attestations(detached, { hashers }).filter((a) => a.kind === "bitcoin" && a.height === height);
  if (candidates.some((a) => a.message === expected)) return true;
  const blocked = candidates.find((a) => a.message === null);
  if (blocked) fail("unsupported-operation", `Cannot evaluate ${blocked.unsupported} without a hasher`);
  return false;
}

const ATTESTATION_LABEL = {
  bitcoin: (a) => `BitcoinBlockHeaderAttestation(${a.height})`,
  litecoin: (a) => `LitecoinBlockHeaderAttestation(${a.height})`,
  pending: (a) => `PendingAttestation('${a.uri}')`,
  unknown: (a) => `UnknownAttestation(${toHex(a.tag)}, ${toHex(a.payload)})`,
};

/** Human-readable outline in the style of `ots info`. */
export function describe(detached, { hashers } = {}) {
  const root = rootOf(detached, hashers);
  const lines = [`File ${detached.fileHashOp} hash: ${toHex(detached.digest)}`, "Timestamp:"];
  const visit = (node, indent) => {
    const forked = node.branches.length > 1;
    for (const branch of node.branches) {
      const prefix = forked ? `${indent} -> ` : indent;
      const inner = forked ? `${indent}    ` : indent;
      if (branch.type === "attestation") {
        lines.push(`${prefix}verify ${ATTESTATION_LABEL[branch.attestation.kind](branch.attestation)}`);
      } else {
        lines.push(`${prefix}${branch.op}${branch.arg ? ` ${toHex(branch.arg)}` : ""}`);
        visit(branch.timestamp, inner);
      }
    }
  };
  visit(root, "");
  return lines.join("\n");
}
