// Anchors transparency-log checkpoint digests to Bitcoin through the free
// public OpenTimestamps calendars and checks the resulting proofs against
// several independent block sources. Every outbound request is https-only,
// time-bounded, size-bounded and refuses redirects; proof contents are never
// logged or echoed in errors.
import { randomBytes, createHash } from "node:crypto";

// Older calendar paths include SHA-1 and RIPEMD-160 operations; the server can
// compute them, so it follows those paths instead of reporting them unverifiable.
const nodeHash = (name) => (bytes) => new Uint8Array(createHash(name).update(bytes).digest());
const SERVER_HASHERS = Object.freeze({ sha1: nodeHash("sha1"), ripemd160: nodeHash("ripemd160") });
import {
  attachCalendarResponse, attestations, createDetachedTimestamp, fromHex,
  parseDetachedTimestamp, serializeDetachedTimestamp, toHex,
} from "../../src/opentimestamps.mjs";

export const DEFAULT_CALENDARS = Object.freeze([
  "https://alice.btc.calendar.opentimestamps.org",
  "https://bob.btc.calendar.opentimestamps.org",
  "https://finney.calendar.eternitywall.com",
  "https://btc.calendar.catallaxy.com",
]);
export const DEFAULT_ESPLORA_BASES = Object.freeze(["https://blockstream.info/api", "https://mempool.space/api"]);

const MAX_CALENDAR_RESPONSE = 10_000;
const MAX_SOURCE_RESPONSE = 10_000;
const MAX_PROOF_BYTES = 1_000_000;
const CALENDAR_HEADERS = { Accept: "application/vnd.opentimestamps.v1", "User-Agent": "opentimestamps-client" };
const HEX32 = /^[0-9a-f]{64}$/;

export class AnchorProviderError extends Error {
  constructor(code, message, { retryable = false, errors } = {}) {
    super(message);
    this.name = "AnchorProviderError";
    this.code = code;
    this.retryable = retryable;
    if (errors) this.errors = errors;
  }
}

function httpsUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new AnchorProviderError("invalid-url", "Invalid URL"); }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new AnchorProviderError("insecure-url", "Only https URLs without credentials may be contacted");
  }
  return url;
}

// The abort race keeps the deadline even if a fetch implementation ignores
// its signal.
async function boundedRequest(fetchImpl, url, { method = "GET", headers, body, timeoutMs, maxBytes }) {
  const target = httpsUrl(url);
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AnchorProviderError("timeout", "Request timed out", { retryable: true }));
    }, timeoutMs);
  });
  deadline.catch(() => {});
  try {
    const response = await Promise.race([
      fetchImpl(target.href, { method, headers, body, redirect: "error", signal: controller.signal }),
      deadline,
    ]);
    if (Number(response.headers?.get?.("content-length")) > maxBytes) {
      controller.abort();
      throw new AnchorProviderError("response-too-large", "Response exceeds the size limit");
    }
    const chunks = [];
    let total = 0;
    const reader = response.body?.getReader();
    while (reader) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        controller.abort();
        throw new AnchorProviderError("response-too-large", "Response exceeds the size limit");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { status: response.status, bytes };
  } catch (error) {
    if (error instanceof AnchorProviderError) throw error;
    throw new AnchorProviderError("network-error", "Request failed", { retryable: true });
  } finally {
    clearTimeout(timer);
  }
}

function withDeadline(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new AnchorProviderError("timeout", "Block source timed out", { retryable: true })), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

const text = (bytes) => new TextDecoder().decode(bytes).trim();
const statusError = (status) => new AnchorProviderError("http-status", `Unexpected HTTP status ${status}`, { retryable: status >= 500 });

/** Block source backed by an Esplora HTTP API (blockstream.info, mempool.space). */
export function esploraBlockSource(baseUrl, fetchImpl = globalThis.fetch, { timeoutMs = 10_000, id } = {}) {
  const base = httpsUrl(baseUrl).href.replace(/\/+$/, "");
  const get = (path) => boundedRequest(fetchImpl, base + path, { timeoutMs, maxBytes: MAX_SOURCE_RESPONSE });
  return {
    id: id ?? new URL(base).host,
    async header(height) {
      const located = await get(`/block-height/${height}`);
      if (located.status === 404) return null;
      if (located.status !== 200) throw statusError(located.status);
      const hash = text(located.bytes);
      if (!HEX32.test(hash)) throw new AnchorProviderError("invalid-response", "Malformed block hash");
      const block = await get(`/block/${hash}`);
      if (block.status !== 200) throw statusError(block.status);
      let json;
      try { json = JSON.parse(text(block.bytes)); } catch { throw new AnchorProviderError("invalid-response", "Malformed block"); }
      if (json?.id !== hash || json.height !== height || !HEX32.test(json.merkle_root ?? "") || !Number.isSafeInteger(json.timestamp)) {
        throw new AnchorProviderError("invalid-response", "Malformed block");
      }
      return { hash, merkleRootHex: json.merkle_root, time: json.timestamp };
    },
    async tipHeight() {
      const tip = await get("/blocks/tip/height");
      if (tip.status !== 200) throw statusError(tip.status);
      const value = text(tip.bytes);
      if (!/^\d{1,9}$/.test(value)) throw new AnchorProviderError("invalid-response", "Malformed tip height");
      return Number(value);
    },
  };
}

function calendarOrigin(value) {
  const url = httpsUrl(value);
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new AnchorProviderError("invalid-url", "Calendar must be a bare https origin");
  }
  return url.origin;
}

function digestBytes(digestHex) {
  if (typeof digestHex !== "string" || !HEX32.test(digestHex)) {
    throw new AnchorProviderError("invalid-digest", "Digest must be 64 lowercase hexadecimal characters");
  }
  return fromHex(digestHex);
}

function decodeProof(proofBase64) {
  if (typeof proofBase64 !== "string" || proofBase64.length > Math.ceil(MAX_PROOF_BYTES / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(proofBase64)) {
    throw new AnchorProviderError("invalid-proof", "Proof must be standard base64");
  }
  try {
    return parseDetachedTimestamp(new Uint8Array(Buffer.from(proofBase64, "base64")), { hashers: SERVER_HASHERS });
  } catch (error) {
    throw new AnchorProviderError("invalid-proof", `Proof is malformed (${error.code ?? "unknown"})`);
  }
}

const encodeProof = (detached) => Buffer.from(serializeDetachedTimestamp(detached)).toString("base64");

const summarize = (list) => list.map(({ kind, height, uri, message }) => {
  const entry = { kind, message };
  if (height !== undefined) entry.height = height;
  if (uri !== undefined) entry.uri = uri;
  return entry;
});

const isPrefix = (prefix, path) =>
  prefix.length <= path.length && prefix.every((step, i) => step.op === path[i].op && step.arg === path[i].arg);

function validHeader(header) {
  return header === null || (header && HEX32.test(header.hash ?? "") && HEX32.test(header.merkleRootHex ?? "")
    && Number.isSafeInteger(header.time));
}

export function createOpenTimestampsProvider({
  calendars = DEFAULT_CALENDARS,
  fetch: fetchImpl = globalThis.fetch,
  blockSources,
  finalityDepth = 6,
  minCalendars = 1,
  timeoutMs = 10_000,
  random = (length) => new Uint8Array(randomBytes(length)),
} = {}) {
  const origins = [...new Set(calendars.map(calendarOrigin))];
  if (!Number.isSafeInteger(minCalendars) || minCalendars < 1 || minCalendars > origins.length) {
    throw new AnchorProviderError("invalid-config", "minCalendars must be between 1 and the number of calendars");
  }
  if (!Number.isSafeInteger(finalityDepth) || finalityDepth < 1) throw new AnchorProviderError("invalid-config", "Invalid finalityDepth");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new AnchorProviderError("invalid-config", "Invalid timeoutMs");
  const sources = blockSources ?? DEFAULT_ESPLORA_BASES.map((base) => esploraBlockSource(base, fetchImpl, { timeoutMs }));
  if (!Array.isArray(sources) || sources.length === 0) throw new AnchorProviderError("invalid-config", "At least one block source is required");
  const allowed = new Set(origins);

  async function submit(digestHex) {
    const digest = digestBytes(digestHex);
    const nonce = random(16);
    let { detached, commitment } = createDetachedTimestamp(digest, { nonce });
    const results = await Promise.allSettled(origins.map((origin) => boundedRequest(fetchImpl, `${origin}/digest`, {
      method: "POST",
      headers: { ...CALENDAR_HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
      body: commitment,
      timeoutMs,
      maxBytes: MAX_CALENDAR_RESPONSE,
    })));
    const accepted = [];
    const errors = [];
    results.forEach((result, i) => {
      const calendar = origins[i];
      if (result.status === "rejected") return errors.push({ calendar, code: result.reason.code });
      if (result.value.status !== 200) return errors.push({ calendar, code: "http-status", status: result.value.status });
      try {
        detached = attachCalendarResponse(detached, commitment, result.value.bytes, { hashers: SERVER_HASHERS });
        accepted.push(calendar);
      } catch (error) {
        errors.push({ calendar, code: error.code ?? "invalid-response" });
      }
    });
    if (accepted.length < minCalendars) {
      throw new AnchorProviderError("insufficient-calendars",
        `${accepted.length} calendar(s) accepted; ${minCalendars} required`, { retryable: true, errors });
    }
    return { status: "submitted", proof: encodeProof(detached), calendars: accepted, errors };
  }

  async function upgrade(proofBase64) {
    let detached = decodeProof(proofBase64);
    const before = encodeProof(detached);
    const list = attestations(detached, { hashers: SERVER_HASHERS });
    const complete = list.filter((a) => a.kind === "bitcoin");
    const targets = new Map();
    for (const a of list) {
      if (a.kind !== "pending" || a.message === null) continue;
      if (complete.some((b) => isPrefix(a.path, b.path))) continue;
      targets.set(`${a.uri} ${a.message}`, a);
    }
    const errors = [];
    const fetchable = [...targets.values()].filter((a) => {
      if (allowed.has(a.uri)) return true;
      errors.push({ calendar: a.uri, code: "calendar-not-allowed" });
      return false;
    });
    const results = await Promise.allSettled(fetchable.map((a) => boundedRequest(fetchImpl, `${a.uri}/timestamp/${a.message}`, {
      headers: CALENDAR_HEADERS, timeoutMs, maxBytes: MAX_CALENDAR_RESPONSE,
    })));
    results.forEach((result, i) => {
      const { uri: calendar, message } = fetchable[i];
      if (result.status === "rejected") return errors.push({ calendar, code: result.reason.code });
      if (result.value.status === 404) return;
      if (result.value.status !== 200) return errors.push({ calendar, code: "http-status", status: result.value.status });
      try {
        detached = attachCalendarResponse(detached, fromHex(message), result.value.bytes, { hashers: SERVER_HASHERS });
      } catch (error) {
        errors.push({ calendar, code: error.code ?? "invalid-response" });
      }
    });
    const proof = encodeProof(detached);
    return { changed: proof !== before, proof, attestations: summarize(attestations(detached, { hashers: SERVER_HASHERS })), errors };
  }

  async function settle(call) {
    const results = await Promise.allSettled(sources.map((source) => withDeadline(call(source), timeoutMs)));
    return results.map((result, i) => ({ id: sources[i].id, result }));
  }

  async function checkHeight(height, messages, tips) {
    const answers = (await settle((source) => source.header(height)))
      .filter(({ result }) => result.status === "fulfilled" && validHeader(result.value))
      .map(({ id, result }) => ({ id, header: result.value }));
    const checkedSources = answers.map((a) => a.id);
    if (answers.length === 0) return { status: "unverifiable", reason: "no-sources", height, checkedSources };
    const [first] = answers;
    const agree = answers.every(({ header }) => header === first.header || (header && first.header
      && header.hash === first.header.hash && header.merkleRootHex === first.header.merkleRootHex));
    if (!agree) return { status: "unverifiable", reason: "sources-disagree", height, checkedSources };
    const block = first.header;
    if (block === null) return { status: "unverifiable", reason: "block-not-found", height, checkedSources };
    const internalRoot = toHex(fromHex(block.merkleRootHex).reverse());
    if (!messages.has(internalRoot)) {
      return { status: "invalid", reason: "header-mismatch", height, blockHash: block.hash, checkedSources };
    }
    // The lowest reported tip is used so one source cannot hasten finality.
    const tip = tips.length ? Math.max(height, Math.min(...tips)) : height;
    const confirmations = tip - height + 1;
    return {
      status: confirmations >= finalityDepth ? "final" : "confirmed",
      height, blockHash: block.hash, confirmations, blockTime: block.time, checkedSources,
    };
  }

  async function verify(proofBase64, digestHex) {
    const expected = digestBytes(digestHex);
    let detached;
    try { detached = decodeProof(proofBase64); } catch {
      return { status: "invalid", reason: "malformed-proof", checkedSources: [] };
    }
    if (detached.fileHashOp !== "sha256" || toHex(detached.digest) !== toHex(expected)) {
      return { status: "invalid", reason: "digest-mismatch", checkedSources: [] };
    }
    const bitcoin = attestations(detached, { hashers: SERVER_HASHERS }).filter((a) => a.kind === "bitcoin");
    const checkable = bitcoin.filter((a) => a.message !== null && a.message.length === 64);
    if (checkable.length === 0) {
      return bitcoin.length
        ? { status: "unverifiable", reason: "unsupported-operation", checkedSources: [] }
        : { status: "pending", checkedSources: [] };
    }
    const byHeight = new Map();
    for (const a of checkable) {
      if (!byHeight.has(a.height)) byHeight.set(a.height, new Set());
      byHeight.get(a.height).add(a.message);
    }
    const tips = (await settle((source) => source.tipHeight()))
      .filter(({ result }) => result.status === "fulfilled" && Number.isSafeInteger(result.value) && result.value >= 0)
      .map(({ result }) => result.value);
    const outcomes = [];
    for (const height of [...byHeight.keys()].sort((a, b) => a - b)) {
      const outcome = await checkHeight(height, byHeight.get(height), tips);
      if (outcome.status === "confirmed" || outcome.status === "final") return outcome;
      outcomes.push(outcome);
    }
    if (checkable.length < bitcoin.length) {
      outcomes.push({ status: "unverifiable", reason: "unsupported-operation", checkedSources: [] });
    }
    return outcomes.find((o) => o.status === "unverifiable") ?? outcomes[0];
  }

  return { id: "opentimestamps-bitcoin", network: "bitcoin-mainnet", costPerSubmission: 0, submit, upgrade, verify };
}
