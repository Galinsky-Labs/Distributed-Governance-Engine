import {before,after,beforeEach,test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID,randomBytes,generateKeyPairSync,sign} from "node:crypto";
import {PGlite} from "@electric-sql/pglite";
import {createIdentityStore,applyIdentityMigrations} from "../server/identity-store.mjs";
import {createLegalDocument} from "../src/legal-structure.mjs";
import {createDocumentStore} from "../server/document-store.mjs";
import {createLedger,loadLogSigningKey,appendLedgerEvent} from "../server/ledger.mjs";
import {
  verifyInclusion,verifyConsistency,verifyCheckpoint,entryLeafHash,checkpointSigningInput,keyIdFor,
} from "../src/transparency.mjs";

const origin="https://quill.example";
let db,identity,documents,ledger,tenantId,owner,now,signingKey;
const transaction=fn=>db.transaction(async tx=>{await tx.exec("SET LOCAL ROLE dge_identity_runtime");return fn(tx);});
const user=async()=>({...await identity.establishSession({issuer:"https://provider.example",subject:randomUUID(),authenticatedAt:Date.now()}),origin});
const newKey=()=>{const {privateKey}=generateKeyPairSync("ed25519");return privateKey.export({format:"der",type:"pkcs8"}).toString("base64");};
const publish=async(text)=>{
  const document=structuredClone(createLegalDocument({id:randomUUID(),tenantId,title:"Ledger "+text}));
  document.content[0].inlines=[{kind:"text",text}];
  return documents.create(owner,tenantId,{document,commandId:randomUUID(),disclosure:"publish-all-revisions-v1"});
};
before(async()=>{db=await PGlite.create();await applyIdentityMigrations(fn=>db.transaction(fn));});
after(async()=>db?.close());
beforeEach(async()=>{
  await db.exec("TRUNCATE dge_identity.accounts,dge_identity.tenants,dge_identity.login_challenges,dge_ledger.entries,dge_ledger.nodes,dge_ledger.checkpoints,dge_ledger.anchors,dge_ledger.witness_keys,dge_ledger.witness_signatures CASCADE");
  await db.exec("ALTER TABLE dge_ledger.entries DISABLE TRIGGER USER; ALTER TABLE dge_ledger.nodes DISABLE TRIGGER USER; ALTER TABLE dge_ledger.checkpoints DISABLE TRIGGER USER; ALTER TABLE dge_ledger.head DISABLE TRIGGER USER; UPDATE dge_ledger.head SET size=0; ALTER TABLE dge_ledger.head ENABLE TRIGGER USER; ALTER TABLE dge_ledger.entries ENABLE TRIGGER USER; ALTER TABLE dge_ledger.nodes ENABLE TRIGGER USER; ALTER TABLE dge_ledger.checkpoints ENABLE TRIGGER USER");
  now=Date.UTC(2026,10,14,12);
  identity=createIdentityStore({transaction,origin,sessionKey:randomBytes(32),stateKey:randomBytes(32)});
  documents=createDocumentStore({identity,transaction});
  signingKey=loadLogSigningKey(newKey());
  ledger=createLedger({transaction,logId:"quill.test",signingKey,clock:()=>now});
  owner=await user();
  ({tenantId}=await identity.createTenant(owner));
});

test("committed public events are sequenced once, proven against signed checkpoints and history stays consistent",async()=>{
  const first=await publish("The agency shall report annually.");
  const second=await publish("Fees are waived for veterans.");
  assert.equal(await ledger.sequence(),2);
  assert.equal(await ledger.sequence(),0,"a second pass must not log anything twice");
  const cp1=await ledger.issueCheckpoint({force:true});
  assert.equal(cp1.body.size,2);
  assert.equal(await verifyCheckpoint(cp1,signingKey.publicKey),true);
  const forged={...cp1,body:{...cp1.body,size:3}};
  assert.equal(await verifyCheckpoint(forged,signingKey.publicKey),false);

  const history=await documents.history(first.document.id);
  const eventDigest=history.items[0].eventDigest;
  const result=await ledger.proof({eventDigest});
  assert.equal(result.status,"included");
  assert.equal(result.entry.leafHash,entryLeafHash({kind:"document-version",scope:"public",subjectId:first.document.id,eventDigest}));
  assert.equal(verifyInclusion({leaf:result.entry.leafHash,index:result.entry.seq,treeSize:2,proof:result.proof,root:result.checkpoint.body.rootHash}),true);

  for(let i=0;i<5;i++)await publish("Section "+i);
  now+=120000;
  assert.equal(await ledger.sequence(),5);
  const cp2=await ledger.issueCheckpoint();
  assert.equal(cp2.body.size,7);
  const {proof}=await ledger.consistency(2,7);
  assert.equal(verifyConsistency({first:2,second:7,firstRoot:cp1.body.rootHash,secondRoot:cp2.body.rootHash,proof}),true);
  assert.equal(verifyConsistency({first:2,second:7,firstRoot:cp2.body.rootHash,secondRoot:cp2.body.rootHash,proof}),false);
  const entries=await ledger.entries({subjectId:second.document.id});
  assert.deepEqual(entries.items.map(e=>e.kind),["document-version"]);
});

test("log rows cannot be rewritten or truncated, and request transactions cannot write to the log",async()=>{
  await publish("Immutable history.");
  await ledger.sequence();
  await ledger.issueCheckpoint({force:true});
  await assert.rejects(transaction(tx=>tx.query("SELECT set_config('dge.worker','ledger',true)").then(()=>tx.query("UPDATE dge_ledger.entries SET kind='forged'"))),/append-only|permission denied/);
  await assert.rejects(transaction(tx=>tx.query("DELETE FROM dge_ledger.checkpoints")),/permission denied|append-only/);
  await assert.rejects(transaction(tx=>tx.query("INSERT INTO dge_ledger.entries(seq,kind,scope,tenant_id,subject_id,event_digest,leaf_hash,recorded_at) VALUES(99,'x1','public',$1,$1,$2,$2,now())",[tenantId,"a".repeat(64)])),/row-level security|permission denied/);
  await assert.rejects(transaction(tx=>tx.query("SELECT set_config('dge.worker','ledger',true)").then(()=>tx.query("UPDATE dge_ledger.head SET size=0"))),/cannot shrink/);
});

test("finalization events trigger an anchor immediately; failures stay visible and never claim confirmation",async()=>{
  let submitted=[],verifyStatus="pending",failNext=false;
  const provider={id:"test-chain",network:"test",costPerSubmission:0,
    async submit(d){if(failNext){failNext=false;throw Error("calendar unavailable");}submitted.push(d);return {proof:"proof-"+d.slice(0,8)};},
    async upgrade(p){return {proof:p+"+"};},
    async verify(p){return verifyStatus==="final"?{status:"final",height:900001,blockHash:"b".repeat(64),confirmations:6}:{status:verifyStatus};}};
  ledger=createLedger({transaction,logId:"quill.test",signingKey,clock:()=>now,anchorProviders:[provider],anchorIntervalMs:3600000});
  const doc=await publish("Adopted text.");
  await transaction(async tx=>{
    await tx.query("SELECT set_config('dge.tenant_id',$1,true)",[tenantId]);
    await appendLedgerEvent(tx,{tenantId,kind:"edition-finalized",subjectId:doc.document.id,eventDigest:"c".repeat(64),finalization:true,at:new Date(now)});
  });
  failNext=true;
  let pass=await ledger.tick();
  assert.equal(pass.sequenced,2);
  assert.equal(pass.scheduled,1);
  let [anchor]=(await ledger.anchors()).items;
  assert.equal(anchor.reason,"finalization");
  assert.equal(anchor.status,"pending");
  assert.match(anchor.lastError,/calendar unavailable/);
  now+=3600000;
  await ledger.processAnchors();
  [anchor]=(await ledger.anchors()).items;
  assert.equal(anchor.status,"submitted");
  assert.deepEqual(submitted,[anchor.checkpointDigest]);
  now+=3600000;
  await ledger.processAnchors();
  [anchor]=(await ledger.anchors()).items;
  assert.equal(anchor.status,"submitted","a pending blockchain attestation is not reported as anchored");
  verifyStatus="final";
  now+=3600000;
  await ledger.processAnchors();
  [anchor]=(await ledger.anchors()).items;
  assert.equal(anchor.status,"final");
  assert.equal(anchor.blockHeight,900001);
  const latest=await ledger.latestCheckpoint();
  assert.equal(latest.checkpoint.anchors[0].status,"final");
});

test("only registered, unrevoked witnesses can countersign the exact checkpoint bytes",async()=>{
  await publish("Witnessed.");
  await ledger.sequence();
  const cp=await ledger.issueCheckpoint({force:true});
  const witness=generateKeyPairSync("ed25519");
  const raw=witness.publicKey.export({format:"der",type:"spki"}).subarray(-32).toString("base64");
  const {keyId}=await ledger.registerWitness({name:"Independent monitor",publicKey:raw});
  assert.equal(keyId,keyIdFor(raw));
  const good=sign(null,Buffer.from(checkpointSigningInput(cp.body)),witness.privateKey).toString("base64");
  const bad=sign(null,Buffer.from(checkpointSigningInput({...cp.body,rootHash:"0".repeat(64)})),witness.privateKey).toString("base64");
  await assert.rejects(ledger.cosign({size:cp.body.size,keyId,signature:bad}),/INVALID_COSIGNATURE/);
  assert.deepEqual(await ledger.cosign({size:cp.body.size,keyId,signature:good}),{accepted:true});
  assert.equal((await ledger.latestCheckpoint()).checkpoint.witnesses.length,1);
  await ledger.revokeWitness(keyId);
  assert.equal((await ledger.latestCheckpoint()).checkpoint.witnesses.length,0);
  await assert.rejects(ledger.cosign({size:cp.body.size,keyId,signature:good}),/WITNESS_NOT_FOUND/);
});
