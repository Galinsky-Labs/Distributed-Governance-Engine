import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, generateKeyPairSync } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { createIdentityStore, applyIdentityMigrations } from "../server/identity-store.mjs";
import { createLegalDocument } from "../src/legal-structure.mjs";
import { createDocumentStore } from "../server/document-store.mjs";
import { createDocumentRoutes } from "../server/document-http.mjs";
import { createAccountHandler } from "../server/account-http.mjs";
import { createImmutableEditionRoutes, createImmutableEditionExtension, IMMUTABLE_EDITION_CACHE } from "../server/public-edition-cache-http.mjs";
import { createPlatform } from "../server/platform.mjs";
import { loadLogSigningKey } from "../server/ledger.mjs";
import { createFederationExtension } from "../server/federation-http.mjs";

const origin = "https://quill.example";
let db, handler, plain, document;
before(async () => {
  db = await PGlite.create();
  await applyIdentityMigrations((fn) => db.transaction(fn));
  const transaction = (fn) => db.transaction(async (tx) => { await tx.exec("SET LOCAL ROLE dge_identity_runtime"); return fn(tx); });
  const identity = createIdentityStore({ transaction, origin, sessionKey: randomBytes(32), stateKey: randomBytes(32) });
  const documents = createDocumentStore({ identity, transaction });
  const owner = { ...await identity.establishSession({ issuer: "https://provider.example", subject: randomUUID(), authenticatedAt: Date.now() }), origin };
  const { tenantId } = await identity.createTenant(owner);
  document = structuredClone(createLegalDocument({ id: randomUUID(), tenantId, title: "Cached edition" }));
  document.content[0].inlines = [{ kind: "text", text: "Editions never change." }];
  await documents.create(owner, tenantId, { document, commandId: randomUUID(), disclosure: "publish-all-revisions-v1" });
  const budget = () => true;
  handler = createAccountHandler({ store: identity, login: {}, origin, budget, extensions: [createImmutableEditionRoutes({ documents }), createDocumentRoutes({ documents })] });
  plain = createAccountHandler({ store: identity, login: {}, origin, budget, extensions: [createDocumentRoutes({ documents })] });
});
after(async () => db?.close());
const get = (h, path, headers = {}) => h(new Request(origin + path, { headers }), { peerAddress: "127.0.0.1" });

test("an exact edition is served with immutable cache headers, the same body and digest revalidation", async () => {
  const path = `/api/public/documents/${document.id}?version=1`;
  const cached = await get(handler, path), reference = await get(plain, path);
  assert.equal(cached.status, 200);
  assert.equal(cached.headers.get("cache-control"), IMMUTABLE_EDITION_CACHE);
  assert.equal(reference.headers.get("cache-control"), "no-store");
  const body = await cached.json();
  assert.deepEqual(body, await reference.json());
  assert.equal(cached.headers.get("etag"), `"${body.digest}"`);
  assert.equal(cached.headers.get("x-content-type-options"), "nosniff", "hardening headers are kept");
  const revalidated = await get(handler, path, { "if-none-match": `"${body.digest}"` });
  assert.equal(revalidated.status, 304);
});

test("changing reads stay uncacheable and invalid or missing editions keep the document route's errors", async () => {
  const current = await get(handler, `/api/public/documents/${document.id}`);
  assert.equal(current.status, 200);
  assert.equal(current.headers.get("cache-control"), "no-store");
  assert.equal((await get(handler, `/api/public/documents/${document.id}?version=abc`)).status, 400);
  const missing = await get(handler, `/api/public/documents/${document.id}?version=99`);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), "no-store", "a not-yet-existing edition is never cached");
});

test("both extensions mount through createPlatform with their routes and the federation worker", async () => {
  const transaction = (fn) => db.transaction(async (tx) => { await tx.exec("SET LOCAL ROLE dge_identity_runtime"); return fn(tx); });
  const identity = createIdentityStore({ transaction, origin, sessionKey: randomBytes(32), stateKey: randomBytes(32) });
  const logSigningKey = loadLogSigningKey(generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"));
  const platform = createPlatform({
    identity, transaction, login: {}, origin, logId: "quill.mount.test", logSigningKey,
    extensions: [createImmutableEditionExtension(), createFederationExtension({ origin, signingKey: logSigningKey })],
  });
  assert.deepEqual(platform.workers.map((w) => w.name), ["ledger", "federation"]);
  const edition = await platform.application(new Request(`${origin}/api/public/documents/${document.id}?version=1`), { peerAddress: "127.0.0.1" });
  assert.equal(edition.headers.get("cache-control"), IMMUTABLE_EDITION_CACHE);
  const instance = await (await platform.application(new Request(`${origin}/api/federation/instance`), { peerAddress: "127.0.0.1" })).json();
  assert.deepEqual([instance.instanceId, instance.publicKey], ["quill.mount.test", logSigningKey.publicKey]);
  assert.equal(platform.bodyLimit("/api/federation/inbox"), 4 * 1024 * 1024);
  assert.deepEqual(await platform.workers[1].tick(), { exported: 0, applied: 0, delivered: 0, audited: 0 });
});
