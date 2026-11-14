// Two real engine instances (separate PGlite databases) federating one
// document: authority "alpha" and read-only mirror "mars". HTTP between them
// goes through each instance's real route handler; only the transport is
// in-process. Clocks are virtual so cutoffs and merge delays are exercised.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, generateKeyPairSync } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { createIdentityStore, applyIdentityMigrations } from "../server/identity-store.mjs";
import { createLegalDocument } from "../src/legal-structure.mjs";
import { createDocumentStore } from "../server/document-store.mjs";
import { createProposalStore } from "../server/proposal-store.mjs";
import { createDecisionStore } from "../server/decision-store.mjs";
import { createDecisionRoutes } from "../server/decision-http.mjs";
import { createLedger, loadLogSigningKey } from "../server/ledger.mjs";
import { createLedgerRoutes } from "../server/ledger-http.mjs";
import { createAccountHandler } from "../server/account-http.mjs";
import { createFederationStore } from "../server/federation-store.mjs";
import { createFederationRoutes } from "../server/federation-http.mjs";
import {
  generateSigner, createBallotEnvelope, envelopeId, verifySignedObject, FEDERATION_SCHEMAS,
  signRequest, createMessage, LOG_CHANNEL, signObject, authorityClaimBody,
} from "../src/federation.mjs";
import { verifyInclusion, keyIdFor } from "../src/transparency.mjs";

let now = Date.UTC(2026, 10, 14, 12);
const instances = new Map();
const newKey = () => generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const transport = async (url, init = {}) => {
  const target = [...instances.values()].find((i) => url.startsWith(i.origin));
  if (!target || target.offline) throw Object.assign(Error("unreachable"), { code: "UNREACHABLE" });
  return target.handler(new Request(url, init), { peerAddress: "10.0.0.1" });
};

async function instance(name) {
  const db = await PGlite.create();
  await applyIdentityMigrations((fn) => db.transaction(fn));
  const origin = `https://${name}.example`, instanceId = `civic.${name}.test`;
  const transaction = (fn) => db.transaction(async (tx) => { await tx.exec("SET LOCAL ROLE dge_identity_runtime"); return fn(tx); });
  const identity = createIdentityStore({ transaction, origin, sessionKey: randomBytes(32), stateKey: randomBytes(32) });
  const signingKey = loadLogSigningKey(newKey());
  const clock = () => now;
  const ledger = createLedger({ transaction, logId: instanceId, signingKey, clock, checkpointIntervalMs: 1000 });
  const documents = createDocumentStore({ identity, transaction });
  const proposals = createProposalStore({ identity, transaction });
  const decisions = createDecisionStore({ identity, transaction, clock });
  const federation = createFederationStore({ transaction, identity, instanceId, origin, signingKey, clock, fetch: transport, maxMergeDelayMs: 60_000 });
  const handler = createAccountHandler({
    store: identity, login: {}, origin, budget: () => true,
    extensions: [createFederationRoutes({ federation }), createLedgerRoutes({ ledger }), createDecisionRoutes({ decisions })],
  });
  const user = async () => ({ ...await identity.establishSession({ issuer: "https://provider.example", subject: randomUUID(), authenticatedAt: Date.now() }), origin });
  const self = { name, db, origin, instanceId, identity, ledger, documents, proposals, decisions, federation, handler, signingKey, user, offline: false };
  instances.set(name, self);
  return self;
}
const call = (inst, path, { who, method = "GET", body, headers = {} } = {}) => inst.handler(new Request(inst.origin + path, {
  method,
  headers: {
    ...(who ? { cookie: "__Host-dge_session=" + who.sessionToken, origin: inst.origin, "x-dge-csrf": who.csrfToken } : {}),
    ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers,
  },
  ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
}), { peerAddress: "10.0.0.2" });
/** One round of every background duty on every instance. */
const round = async () => { for (const i of instances.values()) { if (!i.offline) { await i.ledger.tick(); await i.federation.tick(); } } };

let alpha, mars, rogue, owner, member, tenantId, document, proposal, voter, descriptor, binding;
before(async () => {
  [alpha, mars, rogue] = [await instance("alpha"), await instance("mars"), await instance("rogue")];
  const pin = (at, peer, maxDelayMs) => at.federation.registerPeer({ instanceId: peer.instanceId, origin: peer.origin, publicKey: peer.signingKey.publicKey, maxDelayMs });
  await pin(alpha, mars, 22 * 60_000);
  await pin(mars, alpha, 22 * 60_000);
  await pin(mars, rogue, 0);
  await pin(rogue, mars, 0);
  owner = await alpha.user(); member = await alpha.user();
  ({ tenantId } = await alpha.identity.createTenant(owner));
  const invite = await alpha.identity.invite(owner, tenantId, member.accountId, "participant");
  await alpha.identity.acceptInvitation(member, tenantId, invite.invitationToken);
  document = structuredClone(createLegalDocument({ id: randomUUID(), tenantId, title: "Federated charter" }));
  document.content[0].inlines = [{ kind: "text", text: "The agency shall report annually." }];
  await alpha.documents.create(owner, tenantId, { document, commandId: randomUUID(), disclosure: "publish-all-revisions-v1" });
  proposal = (await alpha.proposals.create(member, tenantId, document.id, {
    baseVersion: 1, selection: { blockId: document.content[0].id, start: 24, end: 32, quote: "annually" },
    replacement: "quarterly", rationale: "Timely reporting.", commandId: randomUUID(), disclosure: "publish-proposal-v1",
  })).proposal;
  await alpha.decisions.open(owner, tenantId, document.id, proposal.id, { hours: 1, commandId: randomUUID() });
});
after(async () => { for (const i of instances.values()) await i.db.close(); });

test("an authority claims a document, discloses a delay class and binds a participant key", async () => {
  let response = await call(alpha, `/api/workspaces/${tenantId}/documents/${document.id}/federation`, { who: member, method: "POST", body: { replicas: [mars.instanceId] } });
  assert.equal(response.status, 403, "only workspace managers may federate a document");
  response = await call(alpha, `/api/workspaces/${tenantId}/documents/${document.id}/federation`, { who: owner, method: "POST", body: { replicas: [mars.instanceId] } });
  assert.equal(response.status, 200);
  const { claim } = await response.json();
  assert.equal(claim.body.authority, alpha.instanceId);
  assert.ok(await verifySignedObject(FEDERATION_SCHEMAS.authority, claim, alpha.signingKey.publicKey));
  response = await call(alpha, `/api/workspaces/${tenantId}/documents/${document.id}/proposals/${proposal.id}/decision/federation`, { who: owner, method: "POST", body: { delayClass: "mars" } });
  assert.equal(response.status, 200);
  descriptor = await response.json();
  assert.equal(Date.parse(descriptor.body.cutoffAt) - Date.parse(descriptor.body.closesAt), 3 * 3_600_000);
  voter = await generateSigner();
  response = await call(alpha, `/api/workspaces/${tenantId}/documents/${document.id}/proposals/${proposal.id}/decision/federation/keys`, { who: member, method: "POST", body: { publicKey: voter.publicKey } });
  assert.equal(response.status, 200);
  ({ binding } = await response.json());
  assert.equal(binding.body.voterKeyId, voter.keyId);
  const outsider = await alpha.user();
  response = await call(alpha, `/api/workspaces/${tenantId}/documents/${document.id}/proposals/${proposal.id}/decision/federation/keys`, { who: outsider, method: "POST", body: { publicKey: (await generateSigner()).publicKey } });
  assert.equal(response.status, 403);
});

test("the mirror verifies signed checkpoints and snapshots and serves them read-only with their origin", async () => {
  await round(); await round();
  const response = await call(mars, `/api/federation/documents/${document.id}`);
  assert.equal(response.status, 200);
  const served = await response.json();
  assert.equal(served.readOnly, true);
  assert.equal(served.authority, alpha.instanceId);
  assert.equal(served.servedBy, mars.instanceId);
  assert.deepEqual(served.bundle.body.edition.document, document);
  assert.equal(served.bundle.body.decisions[0].descriptor.body.decisionId, descriptor.body.decisionId);
  assert.equal(served.bundle.body.decisions[0].policy.closesAt, Date.parse(descriptor.body.closesAt), "the frozen policy travels with its signed digest");
  const copy = structuredClone(document);
  await assert.rejects(mars.db.query("INSERT INTO dge_identity.tenants(id,created_at) VALUES($1,now())", [tenantId]).then(() =>
    mars.db.query("INSERT INTO dge_documents.documents(tenant_id,id,version,current,digest,visibility,disclosure,created_at) SELECT $1,$2,1,$3,repeat('a',64),'public','publish-all-revisions-v1',now()", [tenantId, copy.id, copy])),
  /DOCUMENT_OWNED_BY_REMOTE_AUTHORITY/, "a mirror never creates a local document under the authority's id");
});

test("a relayed delayed ballot is accepted once by the authority, receipted, logged and counted after the cutoff", async () => {
  now += 10 * 60_000;
  const envelope = await createBallotEnvelope({ descriptor, binding, signer: voter, sequence: 1, choice: "yes", castAt: new Date(now).toISOString() });
  let response = await call(mars, "/api/federation/ballots", { method: "POST", body: envelope });
  assert.equal(response.status, 200);
  const relayed = await response.json();
  assert.deepEqual([relayed.status, relayed.final, relayed.authority], ["relayed", false, alpha.instanceId]);
  // A partition: the authority is unreachable, the mirror keeps the envelope queued.
  alpha.offline = true;
  await round();
  assert.equal((await mars.db.query("SELECT attempts,delivered_at FROM dge_federation.outbox WHERE message->'body'->>'type'='ballot'")).rows[0].delivered_at, null);
  alpha.offline = false;
  now += 3 * 3_600_000 - 20 * 60_000; // past closesAt, inside the 3 h Mars grace
  for (let i = 0; i < 4; i++) { await round(); now += 30_000; }
  response = await call(mars, `/api/federation/receipts/${envelopeId(envelope)}`);
  const { receipt, statement } = await response.json();
  assert.equal(receipt.body.status, "accepted");
  assert.equal(statement.body.status, "receipt-available");
  assert.ok(await verifySignedObject(FEDERATION_SCHEMAS.relayStatus, statement, mars.signingKey.publicKey), "the mirror signs what it says about a relay");
  assert.ok(Date.parse(receipt.body.receivedAt) > Date.parse(descriptor.body.closesAt), "received during the grace period");
  assert.ok(await verifySignedObject(FEDERATION_SCHEMAS.receipt, receipt, alpha.signingKey.publicKey));
  // Duplicate submission straight to the authority is idempotent.
  response = await call(alpha, "/api/federation/ballots", { method: "POST", body: envelope });
  const again = await response.json();
  assert.equal(again.duplicate, true);
  assert.deepEqual(again.receipt, receipt);
  assert.equal((await alpha.db.query("SELECT count(*)::int AS n FROM dge_decisions.ballots")).rows[0].n, 1);
  // Closing before the disclosed cutoff is refused by the route and by the database.
  response = await call(alpha, `/api/workspaces/${tenantId}/documents/${document.id}/proposals/${proposal.id}/decision/close`, { who: owner, method: "POST", body: {} });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "FEDERATED_CUTOFF_PENDING");
  await assert.rejects(alpha.decisions.close(owner, tenantId, document.id, proposal.id), /FEDERATED_CUTOFF_PENDING/);
  // After the cutoff a late envelope gets a signed, logged rejection.
  now = Date.parse(descriptor.body.cutoffAt) + 1;
  const late = await createBallotEnvelope({ descriptor, binding, signer: voter, sequence: 2, choice: "no", castAt: new Date(Date.parse(descriptor.body.closesAt) - 1000).toISOString() });
  response = await call(alpha, "/api/federation/ballots", { method: "POST", body: late });
  const rejection = await response.json();
  assert.deepEqual([rejection.status, rejection.receipt.body.reason], ["rejected", "received-after-cutoff"]);
  assert.ok(await verifySignedObject(FEDERATION_SCHEMAS.receipt, rejection.receipt, alpha.signingKey.publicKey));
  const closed = await alpha.decisions.close(owner, tenantId, document.id, proposal.id);
  assert.equal(closed.certificate.outcome.counts.participating, 1);
  assert.equal(closed.certificate.outcome.weights.yes, "1");
  now += 5000;
  await round(); await round();
  for (const r of [receipt, rejection.receipt]) {
    const proof = await alpha.ledger.proof({ eventDigest: r.body.eventDigest, kind: r.body.status === "accepted" ? "federated-ballot" : "federated-rejection" });
    assert.equal(proof.status, "included");
    assert.ok(verifyInclusion({ leaf: proof.entry.leafHash, index: proof.entry.seq, treeSize: proof.checkpoint.body.size, proof: proof.proof, root: proof.checkpoint.body.rootHash }));
  }
  now += 120_000;
  await round(); await round();
  assert.equal((await mars.db.query("SELECT audited FROM dge_federation.relays")).rows[0].audited, "included");
});

test("peer endpoints require a pinned signature, reject replays and never accept session cookies", async () => {
  const body = new TextEncoder().encode(JSON.stringify({ messages: [] }));
  let response = await call(alpha, "/api/federation/inbox", { who: owner, method: "POST", body: '{"messages":[]}' });
  assert.equal(response.status, 401);
  const marsSigner = { keyId: mars.signingKey.keyId, publicKey: mars.signingKey.publicKey, sign: (await import("../server/federation-store.mjs")).logKeySigner(mars.signingKey).sign };
  const headers = await signRequest({ method: "POST", path: "/api/federation/inbox", body, instanceId: mars.instanceId, signer: marsSigner, timestamp: new Date(now).toISOString() });
  response = await call(alpha, "/api/federation/inbox", { method: "POST", body: '{"messages":[]}', headers });
  assert.equal(response.status, 200);
  response = await call(alpha, "/api/federation/inbox", { method: "POST", body: '{"messages":[]}', headers });
  assert.equal(response.status, 401, "a captured request cannot be replayed");
  const forged = await signRequest({ method: "POST", path: "/api/federation/inbox", body, instanceId: mars.instanceId, signer: await generateSigner(), timestamp: new Date(now).toISOString() });
  response = await call(alpha, "/api/federation/inbox", { method: "POST", body: '{"messages":[]}', headers: forged });
  assert.equal(response.status, 401, "an unpinned key is refused");
  const old = await signRequest({ method: "POST", path: "/api/federation/inbox", body, instanceId: mars.instanceId, signer: marsSigner, timestamp: new Date(now - 30 * 60_000).toISOString() });
  response = await call(alpha, "/api/federation/inbox", { method: "POST", body: '{"messages":[]}', headers: old });
  assert.equal(response.status, 401, "older than the skew allowance plus the peer's declared light delay");
  const delayed = await signRequest({ method: "POST", path: "/api/federation/inbox", body, instanceId: mars.instanceId, signer: marsSigner, timestamp: new Date(now - 20 * 60_000).toISOString() });
  response = await call(alpha, "/api/federation/inbox", { method: "POST", body: '{"messages":[]}', headers: delayed });
  assert.equal(response.status, 200, "a request delayed by Mars light time is still fresh");
});

test("a second instance claiming the same document is rejected and recorded as evidence", async () => {
  const rogueSigner = { keyId: rogue.signingKey.keyId, publicKey: rogue.signingKey.publicKey, sign: (await import("../server/federation-store.mjs")).logKeySigner(rogue.signingKey).sign };
  const claim = await signObject(FEDERATION_SCHEMAS.authority, authorityClaimBody({ documentId: document.id, authority: rogue.instanceId, visibility: "public", claimedAt: new Date(now).toISOString() }), rogueSigner);
  const checkpointBody = { schema: "quill-log-checkpoint-v1", logId: rogue.instanceId, size: 0, rootHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", issuedAt: new Date(now).toISOString() };
  const { checkpointSigningInput } = await import("../src/transparency.mjs");
  const checkpoint = { body: checkpointBody, keyId: rogueSigner.keyId, signature: await rogueSigner.sign(checkpointSigningInput(checkpointBody)) };
  const snapshot = await signObject(FEDERATION_SCHEMAS.snapshot, {
    schema: FEDERATION_SCHEMAS.snapshot, authority: rogue.instanceId, documentId: document.id, sequence: 99, issuedAt: new Date(now).toISOString(),
    claim, edition: { version: 1, ciphertextDigest: "a".repeat(64), ciphertextUri: "https://rogue.example/x", byteLength: 1 }, decisions: [], checkpoint, evidence: [],
  }, rogueSigner);
  const messages = [
    await createMessage({ from: rogue.instanceId, to: mars.instanceId, documentId: LOG_CHANNEL, sequence: 1, type: "checkpoint", payload: { checkpoint, consistency: null }, createdAt: new Date(now).toISOString() }, rogueSigner),
    await createMessage({ from: rogue.instanceId, to: mars.instanceId, documentId: document.id, sequence: 1, type: "snapshot", payload: snapshot, createdAt: new Date(now).toISOString() }, rogueSigner),
  ];
  assert.equal((await mars.federation.receive(rogue.instanceId, messages)).acknowledged.length, 2);
  await mars.federation.applyInbox();
  const evidence = await (await call(mars, "/api/federation/evidence")).json();
  assert.ok(evidence.items.some((e) => e.kind === "authority-conflict" && e.documentId === document.id && e.peer === rogue.instanceId));
  const served = await (await call(mars, `/api/federation/documents/${document.id}`)).json();
  assert.equal(served.authority, alpha.instanceId, "the first verified authority stays authoritative");
  // A message reusing an applied sequence with different content is sender equivocation.
  const equivocation = await createMessage({ from: rogue.instanceId, to: mars.instanceId, documentId: LOG_CHANNEL, sequence: 1, type: "checkpoint", payload: { checkpoint, consistency: { fromSize: 0, proof: [] } }, createdAt: new Date(now).toISOString() }, rogueSigner);
  const result = await mars.federation.receive(rogue.instanceId, [equivocation]);
  assert.deepEqual(result.rejected.map((r) => r.reason), ["sequence-conflict"]);
});

test("key rotation is followed only when signed by the pinned key", async () => {
  const { createKeyRotation } = await import("../src/federation.mjs");
  const current = { keyId: alpha.signingKey.keyId, publicKey: alpha.signingKey.publicKey, sign: (await import("../server/federation-store.mjs")).logKeySigner(alpha.signingKey).sign };
  const next = await generateSigner();
  const forged = await createKeyRotation({ instanceId: alpha.instanceId, sequence: 1, effectiveAt: new Date(now).toISOString(), previous: await generateSigner(), next });
  let response = await call(mars, "/api/federation/rotations", { method: "POST", body: forged });
  assert.equal(response.status, 403);
  const rotation = await createKeyRotation({ instanceId: alpha.instanceId, sequence: 1, effectiveAt: new Date(now).toISOString(), previous: current, next });
  response = await call(mars, "/api/federation/rotations", { method: "POST", body: rotation });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).keyId, keyIdFor(next.publicKey));
  response = await call(mars, "/api/federation/rotations", { method: "POST", body: rotation });
  assert.equal(response.status, 403, "a rotation cannot be replayed");
});
