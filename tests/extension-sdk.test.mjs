import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { ENGINE_CONTRACT_VERSION, MIN_SUPPORTED_CONTRACT, CAPABILITIES, FORBIDDEN_CAPABILITIES, satisfies, validateManifest, assertProfile, boundServices, defineExtension } from "../src/extension-sdk.mjs";
import { randomBytes } from "node:crypto";
import { createPlatform, validateExtension } from "../server/platform.mjs";
import { createIdentityStore } from "../server/identity-store.mjs";
import { civicFixture, civicManifest } from "./fixtures/consumers/civic.mjs";
import { charterFixture, charterManifest } from "./fixtures/consumers/charter.mjs";

test("contract range semantics are exact, caret and tilde only", () => {
  const table = [
    ["1.1.0", "^1.0.0", true], ["1.0.0", "^1.1.0", false], ["2.0.0", "^1.0.0", false], ["1.1.5", "~1.1.0", true],
    ["1.2.0", "~1.1.0", false], ["1.1.0", "1.1.0", true], ["1.1.1", "1.1.0", false], ["0.3.4", "^0.3.0", true], ["0.4.0", "^0.3.0", false],
  ];
  for (const [version, range, expected] of table) assert.equal(satisfies(version, range), expected, version + " " + range);
  assert.throws(() => satisfies("1.0", "^1.0.0"), /Invalid contract version/);
  assert.throws(() => satisfies("1.0.0", ">=1.0.0"), /Invalid contract version/);
  assert.ok(satisfies(ENGINE_CONTRACT_VERSION, "^" + MIN_SUPPORTED_CONTRACT));
});

// Two-consumer matrix against old, current and a future major engine contract.
const consumers = [["civic", civicFixture, civicManifest], ["charter", charterFixture, charterManifest]];
const engines = [["1.0.0", { civic: true, charter: false }], ["1.1.0", { civic: true, charter: true }], ["2.0.0", { civic: false, charter: false }]];
for (const [engine, expected] of engines) for (const [name, , manifest] of consumers) {
  test(`contract matrix: ${name} on engine contract ${engine}`, () => {
    if (expected[name]) assert.equal(validateManifest(manifest, { engineContract: engine }), manifest);
    else assert.throws(() => validateManifest(manifest, { engineContract: engine }), /Incompatible extension: requires engine contract/);
  });
}

test("forbidden, unknown and duplicate capabilities fail explicitly", () => {
  for (const capability of FORBIDDEN_CAPABILITIES)
    assert.throws(() => validateManifest({ engine: "^1.0.0", capabilities: [capability] }), /Forbidden extension capability/);
  assert.throws(() => validateManifest({ engine: "^1.0.0", capabilities: ["filesystem"] }), /Unknown extension capability/);
  assert.throws(() => validateManifest({ engine: "^1.0.0", capabilities: ["identity", "identity"] }), /Duplicate/);
  assert.throws(() => validateManifest({ engine: "^1.0.0", capabilities: [], hooks: [] }), /Unknown extension manifest field/);
  assert.throws(() => validateManifest({ capabilities: [] }), /engine contract range/);
  for (const forbidden of ["tally", "adoption", "crypto"]) assert.equal(Object.hasOwn(CAPABILITIES, forbidden), false);
});

test("SDK permission bounds: an extension sees only the services its capabilities name", () => {
  const services = Object.fromEntries(["identity", "transaction", "clock", "origin", "product", "documents", "decisions", "ledger", "billing", "entitlements", "isPlatformAdmin"].map((k) => [k, { k }]));
  const bounded = boundServices(services, civicManifest);
  assert.deepEqual(Object.keys(bounded).sort(), ["clock", "decisions", "documents", "identity", "origin", "product", "transaction"]);
  assert.equal(bounded.ledger, undefined);
  assert.equal(bounded.isPlatformAdmin, undefined);
  assert.ok(Object.isFrozen(bounded));
});

test("profiles must match the running product", () => {
  assert.doesNotThrow(() => assertProfile(civicManifest, "civic"));
  assert.throws(() => assertProfile(civicManifest, "charter"), /Incompatible extension profile/);
  assert.doesNotThrow(() => assertProfile({ ...civicManifest, profile: "any" }, "charter"));
});

test("defineExtension rejects undeclared surfaces and freezes the manifest", () => {
  const ext = defineExtension(charterFixture, charterManifest);
  assert.ok(Object.isFrozen(ext.manifest) && Object.isFrozen(ext.manifest.capabilities));
  assert.throws(() => defineExtension(charterFixture, { ...charterManifest, surfaces: ["routes"] }), /surface not declared: migrations/);
});

const origin = "https://quill.example", transaction = async () => {};
const identity = createIdentityStore({ transaction, origin, sessionKey: randomBytes(32), stateKey: randomBytes(32) });
const platformArgs = (extensions, product) => ({ identity, transaction, login: {}, origin, product, extensions });

test("old (no manifest) and new (manifest) extensions both mount; the new one receives bounded services", () => {
  let legacySeen, boundedSeen;
  const legacy = { id: "legacy", createRoutes: (s) => { legacySeen = s; return []; } };
  const modern = defineExtension({ id: "modern", createRoutes: (s) => { boundedSeen = s; return []; } },
    { engine: "^1.1.0", profile: "civic", capabilities: ["identity", "decisions"], surfaces: ["routes"] });
  createPlatform(platformArgs([legacy, modern], "civic"));
  assert.ok(legacySeen.ledger !== undefined || "ledger" in legacySeen, "legacy extensions keep the 1.0.0 full service object");
  assert.ok(legacySeen.billing);
  assert.deepEqual(Object.keys(boundedSeen).sort(), ["clock", "decisions", "identity", "origin", "product", "transaction"]);
});

test("the platform refuses incompatible manifests and profiles before mounting anything", () => {
  const future = { id: "future", manifest: { engine: "^2.0.0", capabilities: [] } };
  assert.throws(() => validateExtension(future), /Incompatible extension/);
  assert.throws(() => createPlatform(platformArgs([defineExtension(civicFixture, civicManifest)], "charter")), /Incompatible extension profile/);
  assert.throws(() => validateExtension({ id: "worker", createWorkers: 1 }), /Invalid extension workers/);
});

test("upgrade rollback: a manifest built for the current contract also validates on the oldest supported contract when it asks for ^1.0.0", () => {
  const manifest = { engine: "^" + MIN_SUPPORTED_CONTRACT, capabilities: ["identity"] };
  assert.ok(validateManifest(manifest, { engineContract: MIN_SUPPORTED_CONTRACT }));
  assert.ok(validateManifest(manifest, { engineContract: ENGINE_CONTRACT_VERSION }));
});

test("the ledger event contract matches every kind the engine source can append", async () => {
  const contract = JSON.parse(await readFile(new URL("../docs/sdk/event-contract.json", import.meta.url), "utf8"));
  assert.equal(contract.contractVersion, ENGINE_CONTRACT_VERSION);
  const documented = new Set(contract.events.map((e) => e.kind));
  assert.equal(documented.size, contract.events.length);
  const sources = await Promise.all([
    ...(await readdir(new URL("../server/", import.meta.url))).filter((f) => f.endsWith(".mjs")).map((f) => readFile(new URL("../server/" + f, import.meta.url), "utf8")),
    readFile(new URL("../src/federation.mjs", import.meta.url), "utf8"),
  ]);
  const text = sources.join("\n");
  const found = new Set();
  for (const m of text.matchAll(/kind:\s*"((?:decision|moderation|federated)-[a-z-]+)"/g)) found.add(m[1]);
  for (const m of text.matchAll(/kind: "'([a-z-]+)'"/g)) found.add(m[1]);
  for (const m of text.matchAll(/(?:EDITION_LEDGER_KIND|MANIFEST_LEDGER_KIND|BINDING_KIND)\s*=\s*"([a-z-]+)"/g)) found.add(m[1]);
  for (const m of text.matchAll(/RECEIPT_KINDS = Object\.freeze\(\{ accepted: "([a-z-]+)", rejected: "([a-z-]+)" \}\)/g)) { found.add(m[1]); found.add(m[2]); }
  for (const m of text.matchAll(/"decision-(provisional|void|certificate)"/g)) found.add("decision-" + m[1]);
  for (const kind of found) assert.ok(documented.has(kind), "undocumented ledger event kind: " + kind);
  for (const kind of documented) assert.ok(found.has(kind), "documented kind no longer produced: " + kind);
});
