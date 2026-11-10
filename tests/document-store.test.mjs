import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import {
  createIdentityStore,
  applyIdentityMigrations,
} from "../server/identity-store.mjs";
import {
  createDocumentStore,
  PUBLIC_DISCLOSURE,
} from "../server/document-store.mjs";
import { createDocumentRoutes } from "../server/document-http.mjs";
import { createPublicSharedDraft } from "../editor/shared-legal-draft.mjs";
import { createAccountHandler } from "../server/account-http.mjs";
import {
  createLegalDocument,
  legalDocumentDigest,
} from "../src/legal-schema.mjs";

let db, identity, documents, owner, reader, outsider, tenantId, handler;
const origin = "https://quill.example";
const transaction = (fn) =>
  db.transaction(async (tx) => {
    await tx.exec("SET LOCAL ROLE dge_identity_runtime");
    return fn(tx);
  });
before(async () => {
  db = await PGlite.create();
  await applyIdentityMigrations((fn) => db.transaction(fn));
});
after(async () => db?.close());
const user = async () => ({
  ...(await identity.establishSession({
    issuer: "https://provider.example",
    subject: randomUUID(),
    authenticatedAt: Date.now(),
  })),
  origin,
});
beforeEach(async () => {
  await db.exec(
    "TRUNCATE dge_identity.accounts,dge_identity.tenants,dge_identity.login_challenges CASCADE",
  );
  identity = createIdentityStore({
    transaction,
    origin,
    sessionKey: randomBytes(32),
    stateKey: randomBytes(32),
  });
  documents = createDocumentStore({ identity, transaction });
  owner = await user();
  reader = await user();
  outsider = await user();
  ({ tenantId } = await identity.createTenant(owner));
  const invite = await identity.invite(
    owner,
    tenantId,
    reader.accountId,
    "viewer",
  );
  await identity.acceptInvitation(reader, tenantId, invite.invitationToken);
  handler = createAccountHandler({
    store: identity,
    origin,
    login: {},
    extensions: [createDocumentRoutes({ documents })],
  });
});
const command = (document) => ({
  document,
  commandId: randomUUID(),
  disclosure: PUBLIC_DISCLOSURE,
});
const doc = () =>
  createLegalDocument({
    id: randomUUID(),
    tenantId,
    title: "Public test bill",
  });
const edit = (document, text) => ({
  ...structuredClone(document),
  revision: document.revision + 1,
  content: [
    {
      kind: "paragraph",
      id: document.content[0].id,
      inlines: [{ kind: "text", text }],
    },
  ],
});
const call = (path, { who = owner, method = "GET", body, headers = {} } = {}) =>
  handler(
    new Request(origin + path, {
      method,
      headers: {
        ...(who
          ? {
              cookie: "__Host-dge_session=" + who.sessionToken,
              origin,
              "x-dge-csrf": who.csrfToken,
            }
          : {}),
        ...headers,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    { peerAddress: "127.0.0.1" },
  );

test("durable public creation requires explicit disclosure, binds the legal context and reopens in a new store", async () => {
  const document = doc();
  await assert.rejects(
    documents.create(owner, tenantId, {
      ...command(document),
      disclosure: "private",
    }),
    /PUBLIC_DISCLOSURE_REQUIRED/,
  );
  const payload = command(document),
    created = await documents.create(owner, tenantId, payload);
  assert.equal(created.digest, legalDocumentDigest(document));
  assert.equal(created.anchorStatus, "pending");
  const reopened = createDocumentStore({ identity, transaction });
  assert.deepEqual(
    (await reopened.read(reader, tenantId, document.id)).document,
    document,
  );
  assert.deepEqual(
    (await documents.publicRead(document.id)).document,
    document,
  );
  assert.deepEqual(await documents.create(owner, tenantId, payload), created);
  await assert.rejects(
    documents.create(owner, tenantId, {
      ...payload,
      document: {
        ...document,
        metadata: { ...document.metadata, title: "Altered" },
      },
    }),
    /COMMAND_REUSED/,
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM dge_documents.anchor_outbox",
      )
    ).rows[0].n,
    1,
  );
});
test("workspace reads and writes enforce current membership and role, while public links disclose only consented content", async () => {
  const { document } = await documents.create(owner, tenantId, command(doc()));
  await assert.rejects(documents.list(outsider, tenantId));
  await assert.rejects(documents.read(outsider, tenantId, document.id));
  await assert.rejects(
    documents.save(reader, tenantId, document.id, {
      document: edit(document, "forged"),
      expectedVersion: 1,
      commandId: randomUUID(),
    }),
  );
  assert.equal((await documents.list(reader, tenantId)).viewerRole, "viewer");
  await identity.changeMember(owner, tenantId, reader.accountId, null);
  await assert.rejects(documents.read(reader, tenantId, document.id));
  assert.equal((await documents.publicRead(document.id)).visibility, "public");
  await transaction(async (tx) => {
    assert.equal(
      (await tx.query("SELECT * FROM dge_documents.documents")).rows.length,
      0,
    );
    await assert.rejects(
      tx.query("DELETE FROM dge_documents.versions"),
      /permission denied/,
    );
  });
});
test("exact storage versions prevent lost edits and old editions stay immutable with a linked digest and pending outbox", async () => {
  const initial = await documents.create(owner, tenantId, command(doc())),
    next = edit(initial.document, "The agency shall report quarterly.");
  const payload = {
      document: next,
      expectedVersion: 1,
      commandId: randomUUID(),
    },
    saved = await documents.save(owner, tenantId, next.id, payload);
  assert.equal(saved.version, 2);
  assert.equal(saved.previousDigest, initial.digest);
  assert.equal(
    (await documents.read(owner, tenantId, next.id)).previousDigest,
    initial.digest,
  );
  await assert.rejects(
    documents.save(owner, tenantId, next.id, {
      ...payload,
      commandId: randomUUID(),
      document: edit(next, "Stale overwrite"),
    }),
    /VERSION_CONFLICT/,
  );
  assert.deepEqual(
    await documents.save(owner, tenantId, next.id, payload),
    saved,
  );
  assert.deepEqual(
    (await documents.publicRead(next.id, { version: 1 })).document,
    initial.document,
  );
  const history = await documents.history(next.id, { limit: 1 });
  assert.equal(history.items[0].version, 2);
  assert.equal(history.nextCursor, 2);
  assert.equal(
    (await documents.history(next.id, { before: 2 })).items[0].version,
    1,
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM dge_documents.anchor_outbox",
      )
    ).rows[0].n,
    2,
  );
});
test("public-input freeze is idempotent, requires recent owner/admin authority and rejects source changes even by direct runtime SQL", async () => {
  const initial = await documents.create(owner, tenantId, command(doc())),
    payload = { expectedVersion: 1, commandId: randomUUID() };
  await assert.rejects(
    documents.freezeForInput(reader, tenantId, initial.document.id, payload),
  );
  const frozen = await documents.freezeForInput(
    owner,
    tenantId,
    initial.document.id,
    payload,
  );
  assert.equal(frozen.document.mode, "public-input");
  assert.equal(frozen.document.lifecycle, "published");
  assert.deepEqual(
    await documents.freezeForInput(
      owner,
      tenantId,
      initial.document.id,
      payload,
    ),
    frozen,
  );
  await assert.rejects(
    documents.save(owner, tenantId, initial.document.id, {
      expectedVersion: 2,
      commandId: randomUUID(),
      document: edit(initial.document, "forged"),
    }),
    /SOURCE_FROZEN/,
  );
  await assert.rejects(
    transaction(async (tx) => {
      await tx.query("SELECT set_config('dge.tenant_id',$1,true)", [tenantId]);
      await tx.query(
        "UPDATE dge_documents.documents SET current=$3,version=version+1 WHERE tenant_id=$1 AND id=$2",
        [tenantId, initial.document.id, initial.document],
      );
    }),
    /Frozen document source/,
  );
  assert.equal(
    (await documents.publicRead(initial.document.id)).digest,
    frozen.digest,
  );
});
test("budgets roll back the whole write without orphan pointers, versions or commitments", async () => {
  const limited = createDocumentStore({
    identity,
    transaction,
    maxStoredBytes: 1500,
    maxDocuments: 1,
    maxVersions: 2,
  });
  const initial = await limited.create(owner, tenantId, command(doc()));
  await assert.rejects(
    limited.create(owner, tenantId, command(doc())),
    /DOCUMENT_LIMIT_REACHED/,
  );
  await assert.rejects(
    limited.save(owner, tenantId, initial.document.id, {
      expectedVersion: 1,
      commandId: randomUUID(),
      document: edit(initial.document, "x".repeat(2000)),
    }),
    /STORAGE_LIMIT_REACHED/,
  );
  assert.equal(
    (await documents.read(owner, tenantId, initial.document.id)).version,
    1,
  );
  const next = await limited.save(owner, tenantId, initial.document.id, {
    expectedVersion: 1,
    commandId: randomUUID(),
    document: edit(initial.document, "small"),
  });
  await assert.rejects(
    limited.save(owner, tenantId, initial.document.id, {
      expectedVersion: 2,
      commandId: randomUUID(),
      document: edit(next.document, "third"),
    }),
    /VERSION_LIMIT_REACHED/,
  );
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM dge_documents.versions"))
      .rows[0].n,
    2,
  );
});
test("HTTP routes preserve session protections, bound payloads, expose no private author IDs and report conflicts correctly", async () => {
  const document = doc(),
    path = "/api/workspaces/" + tenantId + "/documents",
    payload = command(document);
  assert.equal(
    (
      await call(path, {
        method: "POST",
        body: payload,
        headers: { origin: "https://attacker.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(path, {
        method: "POST",
        body: { ...payload, visibility: "private" },
      })
    ).status,
    400,
  );
  assert.equal(
    (await call(path, { method: "POST", body: payload })).status,
    201,
  );
  const publicPath = "/api/public/documents/" + document.id,
    publicRead = await call(publicPath, { who: null });
  assert.equal(publicRead.status, 200);
  assert.ok(!(await publicRead.text()).includes(owner.accountId));
  assert.equal(
    (await call(publicPath + "?version=0", { who: null })).status,
    400,
  );
  assert.equal(
    (await call("/api/public/documents/" + randomUUID(), { who: null })).status,
    404,
  );
  assert.equal(
    (
      await call(path + "/" + document.id, {
        method: "PUT",
        body: {
          document: edit(document, "x".repeat(10000)),
          expectedVersion: 1,
          commandId: randomUUID(),
        },
      })
    ).status,
    200,
  );
  const stale = await call(path + "/" + document.id, {
    method: "PUT",
    body: {
      document: edit(document, "stale"),
      expectedVersion: 1,
      commandId: randomUUID(),
    },
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, "VERSION_CONFLICT");
  assert.equal((await call(publicPath + "/history?limit=101")).status, 400);
});

test('stored source corruption fails closed instead of presenting a mismatched digest as verified content',async()=>{
  const initial=await documents.create(owner,tenantId,command(doc()));
  await db.query('UPDATE dge_documents.versions SET digest=$1 WHERE document_id=$2',['0'.repeat(64),initial.document.id]);
  await assert.rejects(documents.publicRead(initial.document.id,{version:1}),/DOCUMENT_INTEGRITY_ERROR/);
});

test("Yjs snapshots persist atomically with public document version and are recovered under tenant authorization",async()=>{
 const initial=await documents.create(owner,tenantId,command(doc()));
 assert.equal(await documents.collaborationState(owner,tenantId,initial.document.id),null);
 const changed=edit(initial.document,"Durable collaborative text.");
 const shared=createPublicSharedDraft({classification:"public",document:changed});
 const crdtState=Buffer.from(shared.encodeState()).toString("base64url");
 shared.close();
 const request={document:changed,commandId:randomUUID(),expectedVersion:1,crdtState};
 const saved=await documents.save(owner,tenantId,changed.id,request);
 assert.equal(saved.version,2);
 const otherStore=createDocumentStore({identity,transaction});
 const restored=await otherStore.collaborationState(reader,tenantId,changed.id);
 assert.equal(restored.version,2);
 assert.equal(restored.state,crdtState);
 assert.deepEqual((await otherStore.read(reader,tenantId,changed.id)).document,changed);
 assert.deepEqual(await documents.save(owner,tenantId,changed.id,request),saved);
 await assert.rejects(otherStore.collaborationState(outsider,tenantId,changed.id));
 await assert.rejects(transaction(tx=>tx.query(
  "UPDATE dge_documents.crdt_states SET state=decode('00','hex')"
 )),/permission denied/);
 await assert.rejects(transaction(tx=>tx.query(
  "DELETE FROM dge_documents.crdt_states"
 )),/permission denied/);
 const tampered=edit(changed,"Different words");
 await assert.rejects(documents.save(owner,tenantId,changed.id,{
  document:tampered,commandId:randomUUID(),expectedVersion:2,crdtState
 }),/INVALID_CRDT_STATE/);
 assert.equal((await documents.read(owner,tenantId,changed.id)).version,2);
});

const restorationRequest=(initial,expectedVersion=2)=>({commandId:randomUUID(),expectedVersion,sourceVersion:initial.version,sourceDigest:initial.digest,disclosure:'restore-public-revision-v1'});
async function twoVersions(){
 const initial=await documents.create(owner,tenantId,command(doc()));
 const current=edit(initial.document,'The new public wording.');current.metadata.title='New title';
 const second=await documents.save(owner,tenantId,current.id,{document:current,expectedVersion:1,commandId:randomUUID()});
 return {initial,second};
}
test('restoration appends content and provenance atomically, preserves history and replays exactly once',async()=>{
 const {initial,second}=await twoVersions(),input=restorationRequest(initial);
 const results=await Promise.all([documents.restore(owner,tenantId,initial.document.id,input),documents.restore(owner,tenantId,initial.document.id,input)]);
 assert.deepEqual(results[0],results[1]);const restored=results[0];
 assert.equal(restored.version,3);assert.equal(restored.document.revision,second.document.revision+1);
 assert.deepEqual(restored.document.content,initial.document.content);assert.deepEqual(restored.document.metadata,initial.document.metadata);
 assert.equal(restored.previousDigest,second.digest);assert.equal(restored.document.mode,'collaboration');assert.equal(restored.document.lifecycle,'draft');
 assert.deepEqual((await documents.publicRead(initial.document.id,{version:2})).document,second.document);
 assert.deepEqual((await documents.publicRead(initial.document.id,{version:1})).document,initial.document);
 const history=await documents.history(initial.document.id);assert.equal(history.items.length,3);
 assert.deepEqual(history.items[0].restoration,{sourceVersion:1,sourceDigest:initial.digest});
 assert.equal(Object.hasOwn(history.items[1],'restoration'),false);
 const {digest}=await import('../src/integrity.mjs');
 assert.equal(history.items[0].eventDigest,digest('public-document-restoration-v1',{
  tenantId,documentId:initial.document.id,version:3,digest:restored.digest,previousDigest:second.digest,
  createdAt:new Date(history.items[0].createdAt).toISOString(),restoration:restored.restoration
 }));
 assert.equal((await db.query('SELECT count(*)::int n FROM dge_documents.restorations')).rows[0].n,1);
 assert.equal((await db.query('SELECT count(*)::int n FROM dge_documents.anchor_outbox')).rows[0].n,3);
 await assert.rejects(documents.restore(owner,tenantId,initial.document.id,{...input,sourceDigest:'0'.repeat(64)}),{code:'COMMAND_REUSED'});
 await assert.rejects(documents.restore(owner,tenantId,initial.document.id,{...input,expectedVersion:3}),{code:'COMMAND_REUSED'});
 assert.ok(!JSON.stringify(history).includes(owner.accountId));
});
test('restoration and a concurrent edit serialize against the exact current version',async()=>{
 const {initial,second}=await twoVersions(),input=restorationRequest(initial);
 const results=await Promise.allSettled([
  documents.restore(owner,tenantId,initial.document.id,input),
  documents.save(owner,tenantId,initial.document.id,{document:edit(second.document,'Concurrent edit.'),expectedVersion:2,commandId:randomUUID()})
 ]);
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
 assert.equal(results.find(result=>result.status==='rejected').reason.code,'VERSION_CONFLICT');
 const current=await documents.read(owner,tenantId,initial.document.id);assert.equal(current.version,3);
 assert.equal((await documents.history(initial.document.id)).items.length,3);
 assert.equal((await db.query('SELECT count(*)::int n FROM dge_documents.anchor_outbox')).rows[0].n,3);
});
test('restoration HTTP requires manager, actual recent OIDC authentication, exact-origin CSRF and strict inputs',async()=>{
 const {initial}=await twoVersions(),path='/api/workspaces/'+tenantId+'/documents/'+initial.document.id+'/restore',input=restorationRequest(initial);
 for(const who of [reader,outsider])assert.equal((await call(path,{who,method:'POST',body:input})).status,403);
 assert.equal((await call(path,{method:'POST',headers:{'x-dge-csrf':''},body:input})).status,403);
 assert.equal((await call(path+'?override=true',{method:'POST',body:input})).status,400);
 assert.equal((await call(path,{method:'POST',body:{...input,mode:'collaboration'}})).status,400);
 assert.equal((await call(path,{method:'POST',body:{...input,sourceDigest:'0'.repeat(64)}})).status,409);
 assert.equal((await call(path,{method:'POST',body:{...input,disclosure:'no'}})).status,400);
 await db.query("UPDATE dge_identity.sessions SET created_at=created_at-interval '6 minutes',authenticated_at=authenticated_at-interval '6 minutes' WHERE account_id=$1",[owner.accountId]);
 const stale=await call(path,{method:'POST',body:input});assert.equal(stale.status,403);assert.equal((await stale.json()).error,'REAUTHENTICATION_REQUIRED');
 assert.equal((await documents.publicRead(initial.document.id)).version,2);
});
test('restoration rejects frozen source, another document or tenant, current versions and schema rollback',async()=>{
 const {initial}=await twoVersions(),input=restorationRequest(initial),other=await documents.create(owner,tenantId,command(doc()));
 await assert.rejects(documents.restore(owner,tenantId,other.document.id,{...input,expectedVersion:1}),{code:'RESTORE_REQUIRES_OLDER_VERSION'});
 await documents.save(owner,tenantId,other.document.id,{document:edit(other.document,'Other document.'),expectedVersion:1,commandId:randomUUID()});
 await assert.rejects(documents.restore(owner,tenantId,other.document.id,input),{code:'SOURCE_DIGEST_MISMATCH'});
 await assert.rejects(documents.restore(owner,tenantId,initial.document.id,{...input,sourceVersion:2}),{code:'RESTORE_REQUIRES_OLDER_VERSION'});
 const external=await identity.createTenant(owner);await assert.rejects(documents.restore(owner,external.tenantId,initial.document.id,input),{code:'DOCUMENT_NOT_FOUND'});
 await documents.freezeForInput(owner,tenantId,initial.document.id,{commandId:randomUUID(),expectedVersion:2});
 await assert.rejects(documents.restore(owner,tenantId,initial.document.id,{...input,expectedVersion:3}),{code:'SOURCE_FROZEN'});
 const v1={...structuredClone(doc()),schemaVersion:1};const old=await documents.create(owner,tenantId,command(v1));
 const upgraded=edit(v1,'Migrated wording.');upgraded.schemaVersion=2;
 await documents.save(owner,tenantId,v1.id,{document:upgraded,expectedVersion:1,commandId:randomUUID()});
 await assert.rejects(documents.restore(owner,tenantId,v1.id,restorationRequest(old)),{code:'RESTORE_SCHEMA_MISMATCH'});
});
test('restoration failure rolls back source, provenance, byte charge and commitment together',async()=>{
 const {initial}=await twoVersions(),input=restorationRequest(initial),before=(await db.query('SELECT stored_bytes FROM dge_documents.usage WHERE tenant_id=$1',[tenantId])).rows[0].stored_bytes;
 const limited=createDocumentStore({identity,transaction,maxStoredBytes:1});
 await assert.rejects(limited.restore(owner,tenantId,initial.document.id,input),{code:'STORAGE_LIMIT_REACHED'});
 assert.equal((await documents.read(owner,tenantId,initial.document.id)).version,2);
 assert.equal((await db.query('SELECT count(*)::int n FROM dge_documents.restorations')).rows[0].n,0);
 assert.equal((await db.query('SELECT count(*)::int n FROM dge_documents.anchor_outbox')).rows[0].n,2);
 assert.equal((await db.query('SELECT stored_bytes FROM dge_documents.usage WHERE tenant_id=$1',[tenantId])).rows[0].stored_bytes,before);
 await db.query('UPDATE dge_documents.versions SET digest=$1 WHERE document_id=$2 AND version=1',['0'.repeat(64),initial.document.id]);
 await assert.rejects(documents.restore(owner,tenantId,initial.document.id,input),{code:'DOCUMENT_INTEGRITY_ERROR'});
 assert.equal((await documents.read(owner,tenantId,initial.document.id)).version,2);
});
test('restoration provenance is append-only and tenant-fenced; old Yjs state cannot attach to the new head',async()=>{
 const initial=await documents.create(owner,tenantId,command(doc())),changed=edit(initial.document,'Live wording.');
 const shared=createPublicSharedDraft({classification:'public',document:changed});const crdtState=Buffer.from(shared.encodeState()).toString('base64url');shared.close();
 await documents.save(owner,tenantId,changed.id,{document:changed,commandId:randomUUID(),expectedVersion:1,crdtState});
 assert.equal((await documents.collaborationState(owner,tenantId,changed.id)).version,2);
 await documents.restore(owner,tenantId,changed.id,restorationRequest(initial));
 assert.equal(await documents.collaborationState(owner,tenantId,changed.id),null);
 await transaction(async tx=>assert.equal((await tx.query('SELECT * FROM dge_documents.restorations')).rows.length,0));
 for(const sql of ['UPDATE dge_documents.restorations SET source_version=2','DELETE FROM dge_documents.restorations','TRUNCATE dge_documents.restorations'])await assert.rejects(transaction(tx=>tx.query(sql)),/permission denied/);
 assert.equal((await db.query('SELECT count(*)::int n FROM dge_documents.crdt_states')).rows[0].n,1,'Historical Yjs state stays append-only');
});

test('restoration preserves current schema and provenance instead of reinstating historical authority',async()=>{
 const {initial,second}=await twoVersions(),current=structuredClone(second.document);current.revision++;
 current.provenance={fromSchema:'foundation-blocks-v0',sourceDigest:'a'.repeat(64)};
 await documents.save(owner,tenantId,current.id,{document:current,expectedVersion:2,commandId:randomUUID()});
 const restored=await documents.restore(owner,tenantId,current.id,restorationRequest(initial,3));
 assert.equal(restored.version,4);assert.deepEqual(restored.document.provenance,current.provenance);
 assert.equal(restored.document.schemaVersion,current.schemaVersion);assert.equal(restored.document.id,current.id);assert.equal(restored.document.tenantId,tenantId);
 assert.deepEqual(restored.document.content,initial.document.content);
});
