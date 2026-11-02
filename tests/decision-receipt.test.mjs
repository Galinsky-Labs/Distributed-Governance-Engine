import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {randomBytes,randomUUID} from "node:crypto";
import {PGlite} from "@electric-sql/pglite";
import {createIdentityStore,applyIdentityMigrations} from "../server/identity-store.mjs";
import {createDocumentStore} from "../server/document-store.mjs";
import {createProposalStore} from "../server/proposal-store.mjs";
import {createDecisionStore} from "../server/decision-store.mjs";
import {createDecisionRoutes} from "../server/decision-http.mjs";
import {createAccountHandler} from "../server/account-http.mjs";
import {createLegalDocument} from "../src/legal-structure.mjs";
import {verifyPublicDecisionReceipt} from "../src/decision-verification.mjs";

let db;
const origin="https://quill.example";
const transaction=fn=>db.transaction(async tx=>{await tx.exec("SET LOCAL ROLE dge_identity_runtime");return fn(tx);});
before(async()=>{db=await PGlite.create();await applyIdentityMigrations(fn=>db.transaction(fn));});
after(async()=>db?.close());
test("publicly verifiable closed decision exposes checksum without a private electorate",async()=>{
  const identity=createIdentityStore({transaction,origin,sessionKey:randomBytes(32),stateKey:randomBytes(32)});
  const session={...await identity.establishSession({
    issuer:"https://test.example",subject:randomUUID(),authenticatedAt:Date.now()
  }),origin};
  const {tenantId}=await identity.createTenant(session);
  const documents=createDocumentStore({identity,transaction}),proposals=createProposalStore({identity,transaction});
  let time=Date.now();
  const decisions=createDecisionStore({identity,transaction,clock:()=>time});
  const document=structuredClone(createLegalDocument({id:randomUUID(),tenantId,title:"Public receipt verification"}));
  document.content[0].inlines=[{kind:"text",text:"A council shall report annually."}];
  await documents.create(session,tenantId,{document,commandId:randomUUID(),disclosure:"publish-all-revisions-v1"});
  const proposal=await proposals.create(session,tenantId,document.id,{
    baseVersion:1,selection:{blockId:document.content[0].id,start:23,end:31,quote:"annually"},
    replacement:"quarterly",rationale:"Improve frequency.",
    commandId:randomUUID(),disclosure:"publish-proposal-v1"
  });
  const path="/api/public/documents/"+document.id+"/proposals/"+proposal.proposal.id+"/decision/receipt";
  const handler=createAccountHandler({
    origin,store:identity,login:{},extensions:[createDecisionRoutes({decisions})]
  });
  const publicGet=()=>handler(new Request(origin+path),{peerAddress:"127.0.0.1"});
  assert.equal((await publicGet()).status,404,"An open or missing vote cannot publish a receipt");
  await decisions.open(session,tenantId,document.id,proposal.proposal.id,{hours:1,commandId:randomUUID()});
  assert.equal((await publicGet()).status,404,"Open snapshots are strictly tenant private");
  time+=3600001;
  const closed=await decisions.close(session,tenantId,document.id,proposal.proposal.id);
  const response=await publicGet();
  assert.equal(response.status,200);
  const receipt=await response.json();
  assert.equal(receipt.certificateDigest,closed.certificateDigest);
  assert.equal(receipt.certificate.documentId,document.id);
  assert.equal(receipt.certificate.proposalId,proposal.proposal.id);
  assert.equal(receipt.legallyExecuted,false);
  assert.equal(receipt.externalAnchorVerified,false);
  assert.equal(verifyPublicDecisionReceipt(receipt,{documentId:document.id,proposalId:proposal.proposal.id}).checksumValid,true);
  const string=JSON.stringify(receipt);
  assert.equal(string.includes(session.accountId),false,"No per-account identity is published");
  assert.equal(string.includes("electorate"),false,"The frozen electorate roster is not public");
  assert.equal(verifyPublicDecisionReceipt({...receipt,certificateDigest:"0".repeat(64)}).checksumValid,false);
  assert.equal(verifyPublicDecisionReceipt({...receipt,documentId:randomUUID()}).checksumValid,false);
  assert.equal(verifyPublicDecisionReceipt({...receipt,certificate:{...receipt.certificate,executed:true}}).checksumValid,false);
  assert.equal((await transaction(tx=>tx.query("SELECT count(*)::int n FROM dge_decisions.decisions"))).rows[0].n,0,
    "Unscoped runtime role cannot enumerate closed decision records");
  await db.query("UPDATE dge_decisions.decisions SET certificate_digest=$1 WHERE id=$2",["0".repeat(64),closed.certificate.decisionId]);
  assert.equal((await publicGet()).status,503,"Tampering must fail server verification");
});
