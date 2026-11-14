import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sha256, sha256Hex } from "../src/sha256.mjs";

const encode = (text) => new TextEncoder().encode(text);
const nodeHex = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("FIPS 180-4 / NIST CAVS example vectors", () => {
  const vectors = [
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"],
    ["abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
      "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1"],
  ];
  for (const [input, expected] of vectors) assert.equal(sha256Hex(encode(input)), expected);
  assert.equal(sha256Hex(new Uint8Array(1_000_000).fill(0x61)),
    "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
});

test("matches node:crypto across every padding boundary", () => {
  for (let length = 0; length <= 300; length++) {
    const input = Uint8Array.from({ length }, (_, i) => (i * 131 + length) & 0xff);
    assert.equal(sha256Hex(input), nodeHex(input), `length ${length}`);
    assert.equal(sha256(input).length, 32);
  }
});

test("rejects non-byte input", () => {
  assert.throws(() => sha256("abc"), TypeError);
});
