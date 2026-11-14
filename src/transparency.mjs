// Append-only transparency log mathematics (RFC 6962 / RFC 9162 Merkle trees).
// Pure and synchronous so the same code runs in the service, the command-line
// verifier and the offline browser verifier. A log proves that a record was
// committed and that history was not rewritten; it does not prove that voters
// were honest, that every event was submitted, or that a record is lawful.
import { sha256 } from "./sha256.mjs";
import { canonicalize, invariant } from "./integrity-values.mjs";

export const LOG_ENTRY_SCHEMA = "quill-log-entry-v1";
export const LOG_CHECKPOINT_SCHEMA = "quill-log-checkpoint-v1";
export const LOG_RECEIPT_SCHEMA = "quill-log-receipt-v1";
export const MAX_LOG_SIZE = 2 ** 48;

const encoder = new TextEncoder();
const HEX = /^[a-f0-9]{64}$/;
export const toHex = (bytes) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
export function fromHex(hex) {
  invariant(typeof hex === "string" && /^(?:[a-f0-9]{2})*$/.test(hex), "Invalid hexadecimal value");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
const hash32 = (hex) => {
  invariant(typeof hex === "string" && HEX.test(hex), "Invalid log hash");
  return fromHex(hex);
};
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};
const size = (value) => {
  invariant(Number.isSafeInteger(value) && value >= 0 && value <= MAX_LOG_SIZE, "Invalid log size");
  return value;
};

export const EMPTY_ROOT = toHex(sha256(new Uint8Array()));
export const leafHash = (bytes) => toHex(sha256(concat(Uint8Array.of(0), bytes)));
export const nodeHash = (left, right) =>
  toHex(sha256(concat(Uint8Array.of(1), hash32(left), hash32(right))));

/** Canonical leaf record. A blinded entry carries only a salted commitment. */
export function logEntry({ kind, scope, subjectId, eventDigest }) {
  invariant(typeof kind === "string" && /^[a-z][a-z0-9-]{1,40}$/.test(kind), "Invalid entry kind");
  invariant(scope === "public" || scope === "blinded", "Invalid entry scope");
  invariant(typeof subjectId === "string" && /^[a-f0-9-]{36}$/.test(subjectId), "Invalid entry subject");
  invariant(typeof eventDigest === "string" && HEX.test(eventDigest), "Invalid event digest");
  return { schema: LOG_ENTRY_SCHEMA, kind, scope, subjectId, eventDigest };
}
export const entryLeafHash = (entry) => leafHash(encoder.encode(canonicalize(logEntry(entry))));

/**
 * Salted commitment for private workspaces that opt in to anchoring: the log
 * learns nothing guessable about the private event without the salt.
 */
export function blindedCommitment(eventDigest, saltHex) {
  invariant(typeof saltHex === "string" && HEX.test(saltHex), "A 32-byte salt is required");
  return toHex(sha256(concat(encoder.encode("quill-blinded-commitment-v1\0"), fromHex(saltHex), hash32(eventDigest))));
}

const largestPowerOfTwoBelow = (n) => {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
};
const levelOf = (width) => Math.log2(width);

/**
 * Nodes to persist when one leaf is appended to a log of `treeSize` leaves.
 * `getNode(level, index)` returns the stored hash of a complete subtree.
 */
export async function appendLeaf(treeSize, leaf, getNode) {
  size(treeSize);
  hash32(leaf);
  const created = [{ level: 0, index: treeSize, hash: leaf }];
  let index = treeSize, level = 0, current = leaf;
  while (index % 2 === 1) {
    const sibling = await getNode(level, index - 1);
    current = nodeHash(sibling, current);
    index = (index - 1) / 2;
    level += 1;
    created.push({ level, index, hash: current });
  }
  return created;
}

/** Merkle tree hash of leaves [start, end) using stored complete subtrees. */
export async function rangeHash(start, end, getNode) {
  size(start); size(end);
  invariant(end >= start, "Invalid log range");
  const width = end - start;
  if (width === 0) return EMPTY_ROOT;
  if ((width & (width - 1)) === 0 || Number.isInteger(Math.log2(width))) {
    if (start % width === 0) return getNode(levelOf(width), start / width);
  }
  const k = largestPowerOfTwoBelow(width);
  return nodeHash(await rangeHash(start, start + k, getNode), await rangeHash(start + k, end, getNode));
}
export const rootHash = (treeSize, getNode) => rangeHash(0, treeSize, getNode);

export async function inclusionProof(index, treeSize, getNode) {
  size(treeSize);
  invariant(Number.isSafeInteger(index) && index >= 0 && index < treeSize, "Leaf is outside the log");
  const path = [];
  let start = 0, end = treeSize, target = index;
  const pending = [];
  while (end - start > 1) {
    const k = largestPowerOfTwoBelow(end - start);
    if (target < start + k) { pending.push([start + k, end]); end = start + k; }
    else { pending.push([start, start + k]); start += k; }
  }
  for (const [from, to] of pending.reverse()) path.push(await rangeHash(from, to, getNode));
  return path;
}

export function verifyInclusion({ leaf, index, treeSize, proof, root }) {
  try {
    size(treeSize);
    invariant(Number.isSafeInteger(index) && index >= 0 && index < treeSize, "Leaf is outside the log");
    invariant(Array.isArray(proof) && proof.length <= 64, "Invalid inclusion proof");
    let fn = index, sn = treeSize - 1, current = hash32(leaf) && leaf;
    for (const step of proof) {
      if (sn === 0) return false;
      if (fn % 2 === 1 || fn === sn) {
        current = nodeHash(step, current);
        if (fn % 2 === 0) while (fn % 2 === 0 && fn !== 0) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); }
      } else current = nodeHash(current, step);
      fn = Math.floor(fn / 2); sn = Math.floor(sn / 2);
    }
    return sn === 0 && current === root && HEX.test(root);
  } catch { return false; }
}

async function consistencySubproof(m, start, end, complete, getNode) {
  const width = end - start;
  if (m === width) return complete ? [] : [await rangeHash(start, end, getNode)];
  const k = largestPowerOfTwoBelow(width);
  if (m <= k) return [
    ...(await consistencySubproof(m, start, start + k, complete, getNode)),
    await rangeHash(start + k, end, getNode),
  ];
  return [
    ...(await consistencySubproof(m - k, start + k, end, false, getNode)),
    await rangeHash(start, start + k, getNode),
  ];
}
/** Proof that the first `first` leaves of the `second`-leaf log are unchanged. */
export async function consistencyProof(first, second, getNode) {
  size(first); size(second);
  invariant(first > 0 && first <= second, "Invalid consistency range");
  if (first === second) return [];
  return consistencySubproof(first, 0, second, true, getNode);
}

export function verifyConsistency({ first, second, firstRoot, secondRoot, proof }) {
  try {
    size(first); size(second);
    hash32(firstRoot); hash32(secondRoot);
    invariant(first > 0 && first <= second && Array.isArray(proof) && proof.length <= 128, "Invalid consistency proof");
    if (first === second) return proof.length === 0 && firstRoot === secondRoot;
    const path = (first & (first - 1)) === 0 || Number.isInteger(Math.log2(first)) ? [firstRoot, ...proof] : [...proof];
    if (path.length === 0) return false;
    let fn = first - 1, sn = second - 1;
    while (fn % 2 === 1) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); }
    let fr = path[0], sr = path[0];
    for (const step of path.slice(1)) {
      if (sn === 0) return false;
      if (fn % 2 === 1 || fn === sn) {
        fr = nodeHash(step, fr); sr = nodeHash(step, sr);
        while (fn % 2 === 0 && fn !== 0) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); }
      } else sr = nodeHash(sr, step);
      fn = Math.floor(fn / 2); sn = Math.floor(sn / 2);
    }
    return sn === 0 && fr === firstRoot && sr === secondRoot;
  } catch { return false; }
}

/** In-memory log used by tests, simulations and the offline verifier. */
export function memoryLog() {
  const nodes = new Map(), leaves = [];
  const getNode = async (level, index) => {
    const value = nodes.get(level + ":" + index);
    invariant(value, "Missing log node");
    return value;
  };
  return {
    get size() { return leaves.length; },
    getNode,
    async append(leaf) {
      for (const node of await appendLeaf(leaves.length, leaf, getNode)) nodes.set(node.level + ":" + node.index, node.hash);
      leaves.push(leaf);
      return leaves.length - 1;
    },
    root: (treeSize = leaves.length) => rootHash(treeSize, getNode),
    inclusion: (index, treeSize = leaves.length) => inclusionProof(index, treeSize, getNode),
    consistency: (first, second = leaves.length) => consistencyProof(first, second, getNode),
  };
}

/** Exact bytes a log key signs and an anchor commits to. */
export function checkpointBody({ logId, size: treeSize, rootHash: root, issuedAt }) {
  invariant(typeof logId === "string" && /^[a-z0-9][a-z0-9.-]{2,80}$/.test(logId), "Invalid log identity");
  size(treeSize); hash32(root);
  invariant(typeof issuedAt === "string" && !Number.isNaN(Date.parse(issuedAt)) && new Date(issuedAt).toISOString() === issuedAt, "Invalid checkpoint time");
  return { schema: LOG_CHECKPOINT_SCHEMA, logId, size: treeSize, rootHash: root, issuedAt };
}
export const checkpointSigningInput = (body) =>
  encoder.encode(LOG_CHECKPOINT_SCHEMA + "\0" + canonicalize(checkpointBody(body)));
export const checkpointDigest = (body) => toHex(sha256(checkpointSigningInput(body)));

/** Promise to include an event; a missing entry later is evidence of omission. */
export function receiptBody({ logId, kind, eventDigest, issuedAt }) {
  invariant(typeof logId === "string" && /^[a-z0-9][a-z0-9.-]{2,80}$/.test(logId), "Invalid log identity");
  invariant(typeof kind === "string" && /^[a-z][a-z0-9-]{1,40}$/.test(kind), "Invalid entry kind");
  hash32(eventDigest);
  invariant(typeof issuedAt === "string" && new Date(issuedAt).toISOString() === issuedAt, "Invalid receipt time");
  return { schema: LOG_RECEIPT_SCHEMA, logId, kind, eventDigest, issuedAt };
}
export const receiptSigningInput = (body) =>
  encoder.encode(LOG_RECEIPT_SCHEMA + "\0" + canonicalize(receiptBody(body)));

const base64ToBytes = (value) => {
  invariant(typeof value === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(value), "Invalid base64 value");
  const binary = atob(value);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
};
export const keyIdFor = (publicKeyBase64) => toHex(sha256(base64ToBytes(publicKeyBase64)));

/** Ed25519 verification through WebCrypto (browsers and Node). */
export async function verifyEd25519(publicKeyBase64, signatureBase64, message) {
  try {
    const raw = base64ToBytes(publicKeyBase64), signature = base64ToBytes(signatureBase64);
    if (raw.length !== 32 || signature.length !== 64) return false;
    const key = await globalThis.crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
    return await globalThis.crypto.subtle.verify({ name: "Ed25519" }, key, signature, message);
  } catch { return false; }
}
export async function verifyCheckpoint(checkpoint, publicKeyBase64) {
  try {
    const body = checkpointBody(checkpoint.body);
    return checkpoint.keyId === keyIdFor(publicKeyBase64) &&
      await verifyEd25519(publicKeyBase64, checkpoint.signature, checkpointSigningInput(body));
  } catch { return false; }
}
export async function verifyReceipt(receipt, publicKeyBase64) {
  try {
    return receipt.keyId === keyIdFor(publicKeyBase64) &&
      await verifyEd25519(publicKeyBase64, receipt.signature, receiptSigningInput(receipt.body));
  } catch { return false; }
}
