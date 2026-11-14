import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID,randomBytes,generateKeyPairSync} from "node:crypto";
import {PGlite} from "@electric-sql/pglite";
import {createIdentityStore,applyIdentityMigrations} from "../server/identity-store.mjs";
import {createLegalDocument} from "../src/legal-structure.mjs";
import {createPlatform} from "../server/platform.mjs";
import {loadLogSigningKey} from "../server/ledger.mjs";
import {verifyPackage} from "../src/verification-package.mjs";

const origin="https://quill.example";
let db,platform,owner,tenantId,documentId,key;
const transaction=fn=>db.transaction(async tx=>{await tx.exec("SET LOCAL ROLE dge_identity_runtime");return fn(tx);});
const get=async path=>{
  const response=await platform.application(new Request(origin+path),{peerAddress:"127.0.0.1"});
  return {status:response.status,body:await response.json()};
};
before(async()=>{
  db=await PGlite.create();await applyIdentityMigrations(fn=>db.transaction(fn));
  const identity=createIdentityStore({transaction,origin,sessionKey:randomBytes(32),stateKey:randomBytes(32)});
  key=loadLogSigningKey(generateKeyPairSync("ed25519").privateKey.export({format:"der",type:"pkcs8"}).toString("base64"));
  platform=createPlatform({identity,transaction,login:{},origin,logId:"quill.test",logSigningKey:key});
  owner={...await identity.establishSession({issuer:"https://provider.example",subject:randomUUID(),authenticatedAt:Date.now()}),origin};
  ({tenantId}=await identity.createTenant(owner));
  const document=structuredClone(createLegalDocument({id:randomUUID(),tenantId,title:"Verified bill"}));
  document.content[0].inlines=[{kind:"text",text:"Every agency shall publish its budget."}];
  documentId=document.id;
  await platform.services.documents.create(owner,tenantId,{document,commandId:randomUUID(),disclosure:"publish-all-revisions-v1"});
});
after(async()=>db?.close());

test("an edition's package is unverified until logged, then verifies offline and detects tampering",async()=>{
  let {status,body}=await get("/api/public/documents/"+documentId+"/verification-package");
  assert.equal(status,200);
  let report=await verifyPackage(body);
  assert.equal(report.checks.find(c=>c.id==="content").state,"verified");
  assert.equal(report.checks.find(c=>c.id==="log-inclusion").state,"unverified");
  assert.equal(report.overall,"incomplete");

  await platform.services.ledger.sequence();
  await platform.services.ledger.issueCheckpoint({force:true});
  ({body}=await get("/api/public/documents/"+documentId+"/verification-package"));
  report=await verifyPackage(body);
  assert.equal(report.overall,"consistent");
  assert.equal(report.checks.find(c=>c.id==="log-inclusion").state,"verified");
  assert.equal(report.checks.find(c=>c.id==="checkpoint-signature").state,"limited","an unpinned key is not full trust");
  assert.equal((await verifyPackage(body,{trustedLogKeys:[key.publicKey]})).checks.find(c=>c.id==="checkpoint-signature").state,"verified");
  assert.equal(report.checks.find(c=>c.id==="anchor").state,"unverified");

  const altered=structuredClone(body);
  altered.edition.document.content[0].inlines[0].text="Every agency may publish its budget.";
  assert.equal((await verifyPackage(altered)).overall,"failed");
  const rewritten=structuredClone(body);
  rewritten.edition.createdAt=new Date(0).toISOString();
  assert.equal((await verifyPackage(rewritten)).checks.find(c=>c.id==="log-inclusion").state,"failed");
  const forgedRoot=structuredClone(body);
  forgedRoot.ledger.checkpoint.body.rootHash="0".repeat(64);
  assert.equal((await verifyPackage(forgedRoot,{trustedLogKeys:[key.publicKey]})).overall,"failed");
  const otherKey=loadLogSigningKey(generateKeyPairSync("ed25519").privateKey.export({format:"der",type:"pkcs8"}).toString("base64"));
  const substituted=structuredClone(body);substituted.ledger.key.publicKey=otherKey.publicKey;
  assert.equal((await verifyPackage(substituted)).checks.find(c=>c.id==="checkpoint-signature").state,"failed");
});
