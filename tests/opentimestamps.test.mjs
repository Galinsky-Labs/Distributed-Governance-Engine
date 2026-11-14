import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { sha256 } from "../src/sha256.mjs";
import {
  TimestampError, LIMITS, toHex, fromHex,
  parseDetachedTimestamp, serializeDetachedTimestamp, parseTimestamp, serializeTimestamp,
  mergeTimestamps, attestations, createDetachedTimestamp, attachCalendarResponse,
  verifyAgainstHeader, describe,
} from "../src/opentimestamps.mjs";

const encode = (text) => new TextEncoder().encode(text);
const concat = (...parts) => Uint8Array.from(parts.flatMap((p) => [...p]));
const reverseHex = (bytes) => toHex(bytes.slice().reverse());
const rejects = (fn, code) => assert.throws(fn, (e) => e instanceof TimestampError && e.code === code);
const nodeHash = (name) => (bytes) => new Uint8Array(createHash(name).update(bytes).digest());

const attest = (attestation) => ({ type: "attestation", attestation });
const op = (name, ...rest) => {
  const timestamp = rest.pop();
  return rest.length ? { type: "op", op: name, arg: rest[0], timestamp } : { type: "op", op: name, timestamp };
};
const ts = (...branches) => ({ branches });
const bitcoin = (height) => attest({ kind: "bitcoin", height });
const pending = (uri) => attest({ kind: "pending", uri });

// Genuine proof from opentimestamps/opentimestamps-client examples/hello-world.txt.ots.
const HELLO_OTS = new Uint8Array(readFileSync(new URL("./fixtures/hello-world.txt.ots", import.meta.url)));
const HELLO_DIGEST = "03ba204e50d126e4674c005e04d82e84c21366780af1f43bd54a37816b6ab340";
// Block 358391 merkle root as block explorers display it; the attested message
// is its byte reverse, 007ee445…661b8a.
const HELLO_HEADER = { height: 358391, merkleRootHex: "8a1b66ecb7cbd07d8139a7e7d7f2c41aab1f5009b8364aaf61d03ad245e47e00" };
const RIPEMD = { hashers: { ripemd160: nodeHash("ripemd160") } };

test("genuine hello-world.txt.ots parses, round-trips byte-identically and verifies", () => {
  assert.equal(toHex(sha256(encode("Hello World!\n"))), HELLO_DIGEST);
  const detached = parseDetachedTimestamp(HELLO_OTS);
  assert.equal(detached.fileHashOp, "sha256");
  assert.equal(toHex(detached.digest), HELLO_DIGEST);
  assert.deepEqual(serializeDetachedTimestamp(detached), HELLO_OTS);

  const [only, ...rest] = attestations(detached);
  assert.equal(rest.length, 0);
  assert.equal(only.kind, "bitcoin");
  assert.equal(only.height, 358391);
  assert.equal(only.message, null);
  assert.equal(only.unsupported, "ripemd160");
  assert.equal(only.path[0].op, "ripemd160");
  rejects(() => verifyAgainstHeader(detached, HELLO_DIGEST, HELLO_HEADER), "unsupported-operation");

  const [resolved] = attestations(detached, RIPEMD);
  assert.equal(resolved.message, "007ee445d23ad061af4a36b809501fab1ac4f2d7e7a739817dd0cbb7ec661b8a");
  assert.equal(verifyAgainstHeader(detached, HELLO_DIGEST, HELLO_HEADER, RIPEMD), true);
  assert.equal(verifyAgainstHeader(detached, HELLO_DIGEST,
    { height: 358391, merkleRootHex: resolved.message }, RIPEMD), false, "internal byte order is not the explorer order");
  assert.equal(verifyAgainstHeader(detached, HELLO_DIGEST, { ...HELLO_HEADER, height: 358392 }, RIPEMD), false);
  assert.equal(verifyAgainstHeader(detached, toHex(sha256(encode("Hello World?\n"))), HELLO_HEADER, RIPEMD), false);
  const text = describe(detached);
  assert.match(text, /^File sha256 hash: 03ba204e/);
  assert.match(text, /verify BitcoinBlockHeaderAttestation\(358391\)$/);
});

// Bitcoin pads odd merkle levels by pairing a hash with itself, so swapping
// append for prepend there commits to the same root; those flips are expected.
function selfPairedOps(node) {
  return node.branches.reduce((n, b) => n + (b.type !== "op" ? 0
    : selfPairedOps(b.timestamp) + (b.arg && node.message && toHex(b.arg) === toHex(node.message) ? 1 : 0)), 0);
}

function assertTamperEvident(bytes, digest, header, options) {
  const original = parseDetachedTimestamp(bytes, options);
  assert.equal(verifyAgainstHeader(original, digest, header, options), true);
  const equivalent = [];
  for (let i = 0; i < bytes.length; i++) {
    for (const mask of [0x01, 0x80]) {
      const tampered = bytes.slice();
      tampered[i] ^= mask;
      let verified = false;
      try {
        verified = verifyAgainstHeader(parseDetachedTimestamp(tampered, options), digest, header, options);
      } catch (error) {
        assert.ok(error instanceof TimestampError, `byte ${i}: ${error}`);
      }
      if (verified) {
        assert.ok(mask === 0x01 && (bytes[i] === 0xf0 || bytes[i] === 0xf1), `flipping byte ${i} with ${mask} still verified`);
        equivalent.push(i);
      }
    }
  }
  assert.equal(equivalent.length, selfPairedOps(original.timestamp));
}

test("bit flips in the genuine proof are detected", () => {
  assertTamperEvident(HELLO_OTS, HELLO_DIGEST, HELLO_HEADER, RIPEMD);
});

// A calendar-shaped continuation from `commitment` to a fake block: one
// calendar step, two merkle levels, then a Bitcoin attestation.
function fakeBlockPath(commitment, height, { withPending } = {}) {
  const left = sha256(encode("sibling-a")), right = sha256(encode("sibling-b"));
  const calendarSalt = encode("calendar");
  const leaf = sha256(concat(commitment, calendarSalt));
  const root = sha256(concat(sha256(concat(left, leaf)), right));
  const tail = op("prepend", left, ts(op("sha256", ts(op("append", right, ts(op("sha256", ts(bitcoin(height)))))))));
  const afterSalt = withPending ? ts(pending("https://alice.btc.calendar.opentimestamps.org"), tail) : ts(tail);
  const response = ts(op("append", calendarSalt, ts(op("sha256", afterSalt))));
  return { response, header: { height, merkleRootHex: reverseHex(root) } };
}

function handBuilt({ withPending } = {}) {
  const digest = sha256(encode("checkpoint 42"));
  const nonce = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
  const { detached, commitment } = createDetachedTimestamp(digest, { nonce });
  assert.deepEqual(commitment, sha256(concat(digest, nonce)));
  const { response, header } = fakeBlockPath(commitment, 800_000, { withPending });
  const proof = attachCalendarResponse(detached, commitment, serializeTimestamp(response));
  return { digest, proof, bytes: serializeDetachedTimestamp(proof), header, commitment };
}

test("hand-built proof from a commitment to a fake block header verifies", () => {
  const { digest, bytes, header } = handBuilt({ withPending: true });
  const parsed = parseDetachedTimestamp(bytes);
  assert.deepEqual(serializeDetachedTimestamp(parsed), bytes);
  assert.equal(verifyAgainstHeader(parsed, digest, header), true);
  assert.equal(verifyAgainstHeader(parsed, toHex(digest), header), true);
  assert.equal(verifyAgainstHeader(parsed, digest, { ...header, height: 800_001 }), false);
  assert.equal(verifyAgainstHeader(parsed, digest, { ...header, merkleRootHex: reverseHex(fromHex(header.merkleRootHex)) }), false);
  assert.equal(verifyAgainstHeader(parsed, sha256(encode("other")), header), false);
  const kinds = attestations(parsed).map((a) => a.kind);
  assert.deepEqual(kinds, ["pending", "bitcoin"]);
  rejects(() => verifyAgainstHeader(parsed, digest, { height: -1, merkleRootHex: header.merkleRootHex }), "invalid-argument");
  rejects(() => verifyAgainstHeader(parsed, digest, { height: 1, merkleRootHex: "00" }), "invalid-argument");
});

test("bit flips in a hand-built proof are detected", () => {
  const { digest, bytes, header } = handBuilt();
  assertTamperEvident(bytes, digest, header);
});

test("verification recomputes messages instead of trusting stored ones", () => {
  const { digest, proof, header } = handBuilt();
  const forged = structuredClone(proof);
  forged.timestamp.branches[0].arg = new Uint8Array(16);
  forged.timestamp.branches[0].timestamp.message = proof.timestamp.branches[0].timestamp.message;
  assert.equal(verifyAgainstHeader(forged, digest, header), false);
});

test("forks, unknown attestations and every operation round-trip losslessly", () => {
  const message = sha256(encode("root"));
  const unknown = { kind: "unknown", tag: fromHex("0102030405060708"), payload: encode("opaque payload") };
  const timestamp = {
    message,
    branches: [
      attest(unknown),
      bitcoin(2 ** 53 - 1),
      attest({ kind: "litecoin", height: 1234 }),
      pending("https://bob.btc.calendar.opentimestamps.org"),
      op("sha1", ts(bitcoin(1))),
      op("ripemd160", ts(op("sha256", ts(bitcoin(2))))),
      op("keccak256", ts(bitcoin(3))),
      op("reverse", ts(op("hexlify", ts(attest(unknown), bitcoin(4))))),
      op("append", encode("x"), ts(op("prepend", new Uint8Array(4000), ts(bitcoin(5))))),
      op("sha256", ts(attest({ kind: "unknown", tag: fromHex("ffffffffffffffff"), payload: new Uint8Array() }))),
    ],
  };
  const bytes = serializeTimestamp(timestamp);
  const parsed = parseTimestamp(bytes, message);
  assert.deepEqual(serializeTimestamp(parsed), bytes);
  assert.deepEqual(parsed.branches[0].attestation, unknown);

  const list = attestations(parsed);
  assert.equal(list.length, 11);
  const byHeight = (h) => list.find((a) => a.height === h && a.kind === "bitcoin");
  assert.equal(byHeight(1).unsupported, "sha1");
  assert.equal(byHeight(2).unsupported, "ripemd160");
  assert.equal(byHeight(3).unsupported, "keccak256");
  assert.equal(byHeight(4).message, toHex(encode(toHex(message.slice().reverse()))));
  assert.deepEqual(byHeight(4).path, [{ op: "reverse" }, { op: "hexlify" }]);
  assert.equal(list.find((a) => a.kind === "litecoin").height, 1234);
  assert.equal(list.find((a) => a.kind === "unknown").tag, "0102030405060708");
  assert.equal(attestations(parsed, { hashers: { sha1: nodeHash("sha1") } })
    .find((a) => a.height === 1).message, createHash("sha1").update(message).digest("hex"));

  const detached = { fileHashOp: "sha256", digest: message, timestamp: parsed };
  rejects(() => verifyAgainstHeader(detached, message, { height: 3, merkleRootHex: "00".repeat(32) }), "unsupported-operation");
  assert.match(describe(detached), / -> verify UnknownAttestation\(0102030405060708, /);

  for (const fileHashOp of ["sha1", "ripemd160", "keccak256"]) {
    const length = fileHashOp === "keccak256" ? 32 : 20;
    const other = { fileHashOp, digest: new Uint8Array(length).fill(7), timestamp: ts(bitcoin(9)) };
    const otherBytes = serializeDetachedTimestamp(other);
    const reparsed = parseDetachedTimestamp(otherBytes);
    assert.equal(reparsed.fileHashOp, fileHashOp);
    assert.deepEqual(serializeDetachedTimestamp(reparsed), otherBytes);
  }
});

const header = fromHex("004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294" + "01" + "08");
const detachedBytes = (body, digest = new Uint8Array(32)) => concat(header, digest, body);
const BITCOIN_TAIL = fromHex("000588960d73d719010101");

test("structural limits and malformed encodings raise stable codes", () => {
  rejects(() => parseDetachedTimestamp(detachedBytes(BITCOIN_TAIL).slice(1)), "bad-magic");
  const v2 = detachedBytes(BITCOIN_TAIL); v2[31] = 2;
  rejects(() => parseDetachedTimestamp(v2), "unsupported-version");
  const badOp = detachedBytes(BITCOIN_TAIL); badOp[32] = 0xf0;
  rejects(() => parseDetachedTimestamp(badOp), "unknown-file-hash-op");
  rejects(() => parseDetachedTimestamp(detachedBytes(concat([0x09], BITCOIN_TAIL))), "unknown-op");
  rejects(() => parseDetachedTimestamp(concat(detachedBytes(BITCOIN_TAIL), [0])), "trailing-bytes");
  rejects(() => parseDetachedTimestamp(new Uint8Array(LIMITS.maxBytes + 1)), "too-large");
  rejects(() => parseDetachedTimestamp("not bytes"), "invalid-argument");

  const valid = detachedBytes(concat([0xff], BITCOIN_TAIL, [0xf0, 0x01, 0xaa], BITCOIN_TAIL));
  parseDetachedTimestamp(valid);
  for (let end = 0; end < valid.length; end++) {
    assert.throws(() => parseDetachedTimestamp(valid.slice(0, end)), TimestampError, `prefix ${end}`);
  }

  const chain = (n) => detachedBytes(concat(new Array(n).fill(0x08), BITCOIN_TAIL));
  parseDetachedTimestamp(chain(LIMITS.maxDepth));
  rejects(() => parseDetachedTimestamp(chain(LIMITS.maxDepth + 1)), "depth-exceeded");
  rejects(() => parseDetachedTimestamp(chain(100_000)), "depth-exceeded");

  const fanOut = (n) => detachedBytes(concat(...Array.from({ length: n }, (_, i) =>
    concat(i < n - 1 ? [0xff] : [], [0xf0, 0x01, i & 0xff], BITCOIN_TAIL))));
  parseDetachedTimestamp(fanOut(LIMITS.maxOps));
  rejects(() => parseDetachedTimestamp(fanOut(LIMITS.maxOps + 1)), "too-many-ops");

  rejects(() => parseDetachedTimestamp(detachedBytes(concat([0xf0, 0x81, 0x20], new Uint8Array(4097), BITCOIN_TAIL))), "invalid-length");
  rejects(() => parseDetachedTimestamp(detachedBytes(concat([0xf0, 0x00], BITCOIN_TAIL))), "invalid-length");
  rejects(() => parseDetachedTimestamp(detachedBytes(fromHex("00010203040506070881ff7f"))), "invalid-length");
  rejects(() => parseDetachedTimestamp(detachedBytes(concat(fromHex("0083dfe30d2ef90c8eeb07e907"), new Uint8Array(1001).fill(0x61)))), "invalid-length");
  rejects(() => parseDetachedTimestamp(detachedBytes(concat(fromHex("0083dfe30d2ef90c8e0302"), encode("a?")))), "invalid-pending-uri");
  rejects(() => parseDetachedTimestamp(detachedBytes(fromHex("000588960d73d71901020100"))), "trailing-bytes");
  rejects(() => parseDetachedTimestamp(detachedBytes(fromHex("000588960d73d71901028000"))), "non-canonical-varuint");
  rejects(() => parseDetachedTimestamp(detachedBytes(fromHex("000588960d73d71901088080808080808010"))), "varuint-overflow");
  rejects(() => parseDetachedTimestamp(detachedBytes(fromHex("000588960d73d71901" + "0a" + "ff".repeat(9) + "01"))), "varuint-overflow");
  const maxHeight = parseDetachedTimestamp(detachedBytes(fromHex("000588960d73d7190108ffffffffffffff0f")));
  assert.equal(attestations(maxHeight)[0].height, 2 ** 53 - 1);

  const grow = concat(...new Array(5).fill([0xf0, 0x80, 0x08, ...new Array(1024).fill(1)]), BITCOIN_TAIL);
  rejects(() => parseDetachedTimestamp(detachedBytes(grow)), "message-too-long");
  rejects(() => parseTimestamp(BITCOIN_TAIL, new Uint8Array(4097)), "invalid-argument");
  rejects(() => parseTimestamp(fromHex("f2" + "000588960d73d719010101"), new Uint8Array()), "invalid-message");
  rejects(() => serializeTimestamp(ts()), "empty-timestamp");
  rejects(() => serializeTimestamp(ts(op("append", new Uint8Array(), ts(bitcoin(1))))), "invalid-length");
  rejects(() => serializeTimestamp(ts(pending("http://bad uri"))), "invalid-pending-uri");
  rejects(() => serializeTimestamp(ts(attest({ kind: "unknown", tag: fromHex("0588960d73d71901"), payload: new Uint8Array() }))), "invalid-attestation");
});

test("merging is deduplicating, canonical and order-independent", () => {
  const message = sha256(encode("merge"));
  const a = { message, branches: [op("sha256", ts(pending("https://bob.btc.calendar.opentimestamps.org"))), bitcoin(10)] };
  const b = { message, branches: [
    op("append", encode("z"), ts(bitcoin(7))),
    op("sha256", ts(bitcoin(12), pending("https://alice.btc.calendar.opentimestamps.org"), pending("https://bob.btc.calendar.opentimestamps.org"))),
    pending("https://alice.btc.calendar.opentimestamps.org"),
    op("append", encode("a"), ts(bitcoin(7))),
  ] };
  const ab = serializeTimestamp(mergeTimestamps(a, b));
  assert.deepEqual(serializeTimestamp(mergeTimestamps(b, a)), ab);
  assert.deepEqual(serializeTimestamp(mergeTimestamps(a, b, a, b)), ab);
  assert.deepEqual(serializeTimestamp(mergeTimestamps(parseTimestamp(ab, message))), ab);

  const merged = parseTimestamp(ab, message);
  assert.deepEqual(merged.branches.map((x) => x.type === "op" ? `${x.op}${x.arg ? toHex(x.arg) : ""}` : x.attestation.kind),
    ["bitcoin", "pending", "sha256", "append61", "append7a"]);
  const underSha = merged.branches[2].timestamp.branches.map((x) => x.attestation.uri ?? x.attestation.height);
  assert.deepEqual(underSha, [12, "https://alice.btc.calendar.opentimestamps.org", "https://bob.btc.calendar.opentimestamps.org"]);
  rejects(() => mergeTimestamps(a, { ...b, message: sha256(message) }), "message-mismatch");
  rejects(() => mergeTimestamps(), "invalid-argument");
});

test("creating and attaching validate their inputs", () => {
  const digest = sha256(encode("x"));
  rejects(() => createDetachedTimestamp(digest, {}), "invalid-argument");
  rejects(() => createDetachedTimestamp(digest.slice(1), { nonce: new Uint8Array(16) }), "invalid-argument");
  const { detached, commitment } = createDetachedTimestamp(toHex(digest), { nonce: new Uint8Array(16) });
  rejects(() => serializeDetachedTimestamp(detached), "empty-timestamp");
  rejects(() => attachCalendarResponse(detached, sha256(commitment), serializeTimestamp(ts(bitcoin(1)))), "commitment-not-found");
  rejects(() => attachCalendarResponse(detached, commitment, concat(serializeTimestamp(ts(bitcoin(1))), [0])), "trailing-bytes");
  const once = attachCalendarResponse(detached, commitment, serializeTimestamp(ts(pending("https://a.example"))));
  const twice = attachCalendarResponse(once, commitment, serializeTimestamp(ts(pending("https://a.example"))));
  assert.deepEqual(serializeDetachedTimestamp(twice), serializeDetachedTimestamp(once));
});
