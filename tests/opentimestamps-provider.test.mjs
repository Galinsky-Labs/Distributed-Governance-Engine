import test from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "../src/sha256.mjs";
import {
  toHex, serializeTimestamp, parseDetachedTimestamp, verifyAgainstHeader,
  createDetachedTimestamp, attachCalendarResponse, serializeDetachedTimestamp,
} from "../src/opentimestamps.mjs";
import {
  createOpenTimestampsProvider, esploraBlockSource, AnchorProviderError, DEFAULT_CALENDARS,
} from "../server/anchor-providers/opentimestamps.mjs";

const encode = (text) => new TextEncoder().encode(text);
const concat = (...parts) => Uint8Array.from(parts.flatMap((p) => [...p]));
const op = (name, ...rest) => {
  const timestamp = rest.pop();
  return rest.length ? { type: "op", op: name, arg: rest[0], timestamp } : { type: "op", op: name, timestamp };
};
const ts = (...branches) => ({ branches });
const attest = (attestation) => ({ type: "attestation", attestation });
const DIGEST = toHex(sha256(encode("checkpoint 7")));
const NONCE = Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i);
const ALICE = "https://alice.test", BOB = "https://bob.test", CAROL = "https://carol.test";
const ESPLORA = ["https://esplora-a.test/api", "https://esplora-b.test/api"];

class FakeChain {
  constructor(height) { this.headers = new Map(); this.tip = height; }
  addBlock(internalRoot) {
    const height = ++this.tip;
    this.setHeader(height, toHex(internalRoot.slice().reverse()));
    return height;
  }
  setHeader(height, merkleRootHex) {
    this.headers.set(height, { hash: toHex(sha256(encode(`block ${height} ${merkleRootHex}`))), merkleRootHex, time: 1_700_000_000 + height });
  }
  advance(blocks) { for (let i = 0; i < blocks; i++) this.addBlock(sha256(encode(`filler ${this.tip}`))); }
}

// Calendar shape: append a salt, SHA-256, pending; once mined, the stored
// leaf continues through a fake merkle path to a Bitcoin attestation.
class FakeCalendar {
  constructor(origin) { this.origin = origin; this.leaves = []; this.continuations = new Map(); }
  respond(url, init) {
    if (init.method === "POST" && url.pathname === "/digest") {
      assert.equal(init.headers.Accept, "application/vnd.opentimestamps.v1");
      assert.equal(init.headers["Content-Type"], "application/x-www-form-urlencoded");
      const commitment = new Uint8Array(init.body);
      const salt = encode(this.origin).slice(-8);
      this.leaves.push(sha256(concat(commitment, salt)));
      return new Response(serializeTimestamp(ts(op("append", salt, ts(op("sha256", ts(attest({ kind: "pending", uri: this.origin }))))))));
    }
    const match = /^\/timestamp\/([0-9a-f]{2,8192})$/.exec(url.pathname);
    if (init.method === "GET" && match && this.continuations.has(match[1])) return new Response(this.continuations.get(match[1]));
    return new Response("Not found", { status: 404 });
  }
  mine(chain) {
    const filler = sha256(encode(`coinbase ${chain.tip}`));
    const root = sha256(concat(...this.leaves, filler));
    const height = chain.addBlock(root);
    this.leaves.forEach((leaf, i) => {
      const before = concat(...this.leaves.slice(0, i));
      const after = concat(...this.leaves.slice(i + 1), filler);
      const tail = op("append", after, ts(op("sha256", ts(attest({ kind: "bitcoin", height })))));
      this.continuations.set(toHex(leaf), serializeTimestamp(before.length ? ts(op("prepend", before, ts(tail))) : ts(tail)));
    });
    this.leaves = [];
    return height;
  }
}

function esploraResponder(chain) {
  return (url) => {
    const path = url.pathname.replace(/^\/api/, "");
    let m;
    if (path === "/blocks/tip/height") return new Response(String(chain.tip));
    if ((m = /^\/block-height\/(\d+)$/.exec(path))) {
      const header = chain.headers.get(Number(m[1]));
      return header ? new Response(header.hash) : new Response("Block not found", { status: 404 });
    }
    if ((m = /^\/block\/([0-9a-f]{64})$/.exec(path))) {
      for (const [height, h] of chain.headers) {
        if (h.hash === m[1]) return Response.json({ id: h.hash, height, merkle_root: h.merkleRootHex, timestamp: h.time });
      }
    }
    return new Response("Not found", { status: 404 });
  };
}

function network() {
  const routes = new Map();
  const requests = [];
  const fetch = async (url, init = {}) => {
    assert.equal(init.redirect, "error");
    const parsed = new URL(url);
    requests.push({ url, method: init.method ?? "GET" });
    const route = routes.get(parsed.origin);
    if (!route) throw new TypeError("fetch failed");
    return route(parsed, { method: "GET", ...init });
  };
  return { routes, requests, fetch };
}

function setup({ calendars = [ALICE, BOB, CAROL], ...options } = {}) {
  const net = network();
  const chain = new FakeChain(99);
  const fakes = Object.fromEntries(calendars.map((origin) => [origin, new FakeCalendar(origin)]));
  for (const [origin, fake] of Object.entries(fakes)) net.routes.set(origin, (url, init) => fake.respond(url, init));
  for (const base of ESPLORA) net.routes.set(new URL(base).origin, esploraResponder(chain));
  const provider = createOpenTimestampsProvider({
    calendars, fetch: net.fetch, random: (n) => { assert.equal(n, 16); return NONCE.slice(); },
    blockSources: ESPLORA.map((base) => esploraBlockSource(base, net.fetch, { timeoutMs: 200 })),
    timeoutMs: 200, ...options,
  });
  return { net, chain, fakes, provider };
}

test("submit, pending, upgrade, confirmed and final against an in-process calendar", async () => {
  const { net, chain, fakes, provider } = setup();
  assert.equal(provider.id, "opentimestamps-bitcoin");
  assert.equal(provider.network, "bitcoin-mainnet");
  assert.equal(provider.costPerSubmission, 0);

  const submitted = await provider.submit(DIGEST);
  assert.equal(submitted.status, "submitted");
  assert.deepEqual(submitted.calendars, [ALICE, BOB, CAROL]);
  assert.deepEqual(submitted.errors, []);
  const posts = net.requests.filter((r) => r.method === "POST");
  assert.deepEqual(posts.map((r) => r.url), [`${ALICE}/digest`, `${BOB}/digest`, `${CAROL}/digest`]);

  assert.deepEqual(await provider.verify(submitted.proof, DIGEST), { status: "pending", checkedSources: [] });
  const stillPending = await provider.upgrade(submitted.proof);
  assert.equal(stillPending.changed, false);
  assert.equal(stillPending.proof, submitted.proof);
  assert.deepEqual(stillPending.attestations.map((a) => a.uri).sort(), [ALICE, BOB, CAROL]);

  const height = fakes[ALICE].mine(chain);
  const upgraded = await provider.upgrade(submitted.proof);
  assert.equal(upgraded.changed, true);
  assert.ok(upgraded.attestations.some((a) => a.kind === "bitcoin" && a.height === height));

  const confirmed = await provider.verify(upgraded.proof, DIGEST);
  assert.deepEqual(confirmed, {
    status: "confirmed", height, blockHash: chain.headers.get(height).hash, confirmations: 1,
    blockTime: chain.headers.get(height).time, checkedSources: ["esplora-a.test", "esplora-b.test"],
  });
  const detached = parseDetachedTimestamp(new Uint8Array(Buffer.from(upgraded.proof, "base64")));
  assert.equal(verifyAgainstHeader(detached, DIGEST, { height, merkleRootHex: chain.headers.get(height).merkleRootHex }), true);

  chain.advance(4);
  assert.equal((await provider.verify(upgraded.proof, DIGEST)).confirmations, 5);
  assert.equal((await provider.verify(upgraded.proof, DIGEST)).status, "confirmed");
  chain.advance(1);
  const final = await provider.verify(upgraded.proof, DIGEST);
  assert.equal(final.status, "final");
  assert.equal(final.confirmations, 6);

  net.requests.length = 0;
  const again = await provider.upgrade(upgraded.proof);
  assert.equal(again.changed, false);
  assert.deepEqual(net.requests.map((r) => new URL(r.url).origin).sort(), [BOB, CAROL], "a completed calendar is not polled again");
  assert.equal((await provider.verify(upgraded.proof, toHex(sha256(encode("other"))))).reason, "digest-mismatch");
});

test("partial calendar failures and timeouts respect minCalendars", async () => {
  const configure = (minCalendars) => {
    const env = setup({ minCalendars, timeoutMs: 50 });
    env.net.routes.set(BOB, () => new Promise(() => {}));
    env.net.routes.set(CAROL, () => new Response("down", { status: 503 }));
    return env;
  };
  const started = Date.now();
  const partial = await configure(1).provider.submit(DIGEST);
  assert.deepEqual(partial.calendars, [ALICE]);
  assert.deepEqual(partial.errors, [{ calendar: BOB, code: "timeout" }, { calendar: CAROL, code: "http-status", status: 503 }]);
  assert.ok(Date.now() - started < 2000);

  await assert.rejects(configure(2).provider.submit(DIGEST), (error) =>
    error instanceof AnchorProviderError && error.code === "insufficient-calendars" && error.retryable === true
    && error.errors.length === 2);
  const unreachable = setup();
  unreachable.net.routes.clear();
  await assert.rejects(unreachable.provider.submit(DIGEST), { code: "insufficient-calendars" });
  const malformed = setup({ calendars: [ALICE] });
  malformed.net.routes.set(ALICE, () => new Response(Uint8Array.of(0x00, 0x01)));
  await assert.rejects(malformed.provider.submit(DIGEST), (error) => error.errors[0].code === "truncated");
  assert.throws(() => createOpenTimestampsProvider({ calendars: [ALICE], minCalendars: 2 }), { code: "invalid-config" });
  await assert.rejects(setup().provider.submit("XYZ"), { code: "invalid-digest" });
});

test("a dropped or forged submission is never reported as confirmed", async () => {
  const { chain, provider, net } = setup({ calendars: [ALICE] });
  const { proof } = await provider.submit(DIGEST);
  for (let i = 0; i < 3; i++) {
    chain.advance(3);
    const upgraded = await provider.upgrade(proof);
    assert.equal(upgraded.changed, false);
    assert.deepEqual(await provider.verify(upgraded.proof, DIGEST), { status: "pending", checkedSources: [] });
  }

  net.routes.set(ALICE, (url) => url.pathname === "/digest"
    ? new Response(serializeTimestamp(ts(attest({ kind: "bitcoin", height: chain.tip }))))
    : new Response("", { status: 404 }));
  const forged = await provider.submit(DIGEST);
  const result = await provider.verify(forged.proof, DIGEST);
  assert.equal(result.status, "invalid");
  assert.equal(result.reason, "header-mismatch");
});

test("upgrade contacts only allowlisted calendar origins", async () => {
  const { net, fakes, chain, provider } = setup({ calendars: [ALICE] });
  const hostile = ["https://evil.test", "https://169.254.169.254", `${ALICE}/x`, `${ALICE}.evil.test`, "https://alice.test:8443", "http://alice.test"];
  const { detached, commitment } = createDetachedTimestamp(DIGEST, { nonce: NONCE });
  await provider.submit(DIGEST);
  fakes[ALICE].mine(chain);
  const salt = encode(ALICE).slice(-8);
  const response = ts(
    ...hostile.map((uri) => attest({ kind: "pending", uri })),
    op("append", salt, ts(op("sha256", ts(attest({ kind: "pending", uri: ALICE }))))),
  );
  const proof = Buffer.from(serializeDetachedTimestamp(attachCalendarResponse(detached, commitment, serializeTimestamp(response)))).toString("base64");

  net.requests.length = 0;
  const result = await provider.upgrade(proof);
  assert.equal(result.changed, true);
  assert.deepEqual(net.requests.map((r) => new URL(r.url).origin), [ALICE]);
  assert.deepEqual(result.errors.map((e) => e.code), hostile.map(() => "calendar-not-allowed"));
  assert.equal((await provider.verify(result.proof, DIGEST)).status, "confirmed");

  assert.throws(() => createOpenTimestampsProvider({ calendars: ["http://alice.test"] }), { code: "insecure-url" });
  assert.throws(() => createOpenTimestampsProvider({ calendars: [`${ALICE}/path`] }), { code: "invalid-url" });
  assert.deepEqual(createOpenTimestampsProvider().id, "opentimestamps-bitcoin");
  assert.equal(DEFAULT_CALENDARS.length, 4);
});

async function confirmedProof(env) {
  const { proof } = await env.provider.submit(DIGEST);
  const height = env.fakes[ALICE].mine(env.chain);
  return { proof: (await env.provider.upgrade(proof)).proof, height };
}

test("a reorg that replaces the attested header makes the proof invalid", async () => {
  const env = setup({ calendars: [ALICE] });
  const { proof, height } = await confirmedProof(env);
  assert.equal((await env.provider.verify(proof, DIGEST)).status, "confirmed");
  env.chain.setHeader(height, toHex(sha256(encode("replacement block"))));
  const result = await env.provider.verify(proof, DIGEST);
  assert.equal(result.status, "invalid");
  assert.equal(result.reason, "header-mismatch");
  assert.equal(result.height, height);
});

test("block sources must agree; silent sources are excluded", async () => {
  const env = setup({ calendars: [ALICE] });
  const { proof, height } = await confirmedProof(env);
  const honest = { id: "honest", header: async (h) => env.chain.headers.get(h) ?? null, tipHeight: async () => env.chain.tip };
  const make = (...blockSources) => createOpenTimestampsProvider({ calendars: [ALICE], fetch: env.net.fetch, blockSources, timeoutMs: 50 });

  const liar = { id: "liar", header: async (h) => ({ ...env.chain.headers.get(h), merkleRootHex: "00".repeat(32) }), tipHeight: async () => env.chain.tip + 100 };
  assert.deepEqual(await make(honest, liar).verify(proof, DIGEST),
    { status: "unverifiable", reason: "sources-disagree", height, checkedSources: ["honest", "liar"] });
  const unaware = { id: "unaware", header: async () => null, tipHeight: async () => height - 1 };
  assert.equal((await make(honest, unaware).verify(proof, DIGEST)).reason, "sources-disagree");
  assert.equal((await make(unaware).verify(proof, DIGEST)).reason, "block-not-found");

  const down = { id: "down", header: async () => { throw new Error("offline"); }, tipHeight: async () => { throw new Error("offline"); } };
  const hung = { id: "hung", header: () => new Promise(() => {}), tipHeight: () => new Promise(() => {}) };
  const garbage = { id: "garbage", header: async () => ({ hash: "nope" }), tipHeight: async () => -5 };
  assert.deepEqual(await make(down, hung).verify(proof, DIGEST), { status: "unverifiable", reason: "no-sources", height, checkedSources: [] });
  const partial = await make(honest, down, hung, garbage).verify(proof, DIGEST);
  assert.equal(partial.status, "confirmed");
  assert.deepEqual(partial.checkedSources, ["honest"]);

  env.chain.advance(10);
  const lowTip = { id: "lagging", header: honest.header, tipHeight: async () => height + 2 };
  const conservative = await make(honest, lowTip).verify(proof, DIGEST);
  assert.equal(conservative.status, "confirmed");
  assert.equal(conservative.confirmations, 3);
  assert.equal((await make(honest).verify(proof, DIGEST)).status, "final");
});

test("oversized and malformed responses are rejected", async () => {
  const env = setup({ calendars: [ALICE, BOB] });
  env.net.routes.set(ALICE, () => new Response(new Uint8Array(10_001)));
  env.net.routes.set(BOB, () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(4096)); },
  })));
  await assert.rejects(env.provider.submit(DIGEST), (error) =>
    error.errors.every((e) => e.code === "response-too-large"));
  env.net.routes.set(BOB, () => new Response("x", { headers: { "content-length": "20000" } }));
  await assert.rejects(env.provider.submit(DIGEST), (error) => error.errors[1].code === "response-too-large");

  const source = esploraBlockSource(ESPLORA[0], env.net.fetch, { timeoutMs: 100 });
  env.chain.advance(1);
  assert.equal((await source.header(env.chain.tip)).merkleRootHex, env.chain.headers.get(env.chain.tip).merkleRootHex);
  assert.equal(await source.header(env.chain.tip + 1), null);
  assert.equal(await source.tipHeight(), env.chain.tip);
  const origin = new URL(ESPLORA[0]).origin;
  env.net.routes.set(origin, (url) => url.pathname.includes("/block-height/")
    ? new Response("ab".repeat(32)) : Response.json({ id: "ab".repeat(32), height: 1, merkle_root: "cd".repeat(32), timestamp: 1 }));
  await assert.rejects(source.header(2), { code: "invalid-response" });
  env.net.routes.set(origin, () => new Response("9".repeat(20_000)));
  await assert.rejects(source.tipHeight(), { code: "response-too-large" });
  env.net.routes.set(origin, () => new Response("<html>"));
  await assert.rejects(source.header(1), { code: "invalid-response" });
  assert.throws(() => esploraBlockSource("http://esplora.test/api"), { code: "insecure-url" });

  assert.deepEqual(await env.provider.verify("not base64!", DIGEST), { status: "invalid", reason: "malformed-proof", checkedSources: [] });
  assert.deepEqual(await env.provider.verify(Buffer.from("junk").toString("base64"), DIGEST), { status: "invalid", reason: "malformed-proof", checkedSources: [] });
  await assert.rejects(env.provider.upgrade("AAAA"), { code: "invalid-proof" });
});

test("proofs on paths without a built-in hash are unverifiable, not confirmed", async () => {
  const env = setup({ calendars: [ALICE] });
  const { detached, commitment } = createDetachedTimestamp(DIGEST, { nonce: NONCE });
  const response = ts(op("ripemd160", ts(attest({ kind: "bitcoin", height: 100 }))));
  const proof = Buffer.from(serializeDetachedTimestamp(attachCalendarResponse(detached, commitment, serializeTimestamp(response)))).toString("base64");
  assert.deepEqual(await env.provider.verify(proof, DIGEST), { status: "unverifiable", reason: "unsupported-operation", checkedSources: [] });
});
