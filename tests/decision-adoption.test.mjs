import {before,after,beforeEach,test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID,randomBytes} from "node:crypto";
import {PGlite} from "@electric-sql/pglite";
import {createIdentityStore,applyIdentityMigrations} from "../server/identity-store.mjs";
import {createDocumentStore} from "../server/document-store.mjs";
import {createProposalStore} from "../server/proposal-store.mjs";
import {createDecisionStore} from "../server/decision-store.mjs";
import {digest} from "../src/integrity.mjs";
import {createLegalDocument} from "../src/legal-structure.mjs";

let db,identity,documents,proposals,decisions,owner,member,tenantId,source,proposal,clock;
const origin="https://quill.example";
const transaction=fn=>db.transaction(async tx=>{await tx.exec("SET LOCAL ROLE dge_identity_runtime");return fn(tx);});
const user=async()=>({...await identity.establishSession({
  issuer:"https://provider.example",subject:randomUUID(),authenticatedAt:Date.now()
}),origin});
before(async()=>{db=await PGlite.create();await applyIdentityMigrations(fn=>db.transaction(fn));});
after(async()=>db?.close());
beforeEach(async()=>{
  await db.exec("TRUNCATE dge_identity.accounts,dge_identity.tenants,dge_identity.login_challenges CASCADE");
  identity=createIdentityStore({transaction,origin,sessionKey:randomBytes(32),stateKey:randomBytes(32)});
  documents=createDocumentStore({identity,transaction});
  proposals=createProposalStore({identity,transaction});
  clock=Date.now();
  decisions=createDecisionStore({identity,clock:()=>clock});
  owner=await user();member=await user();
  ({tenantId}=await identity.createTenant(owner));
  const invitation=await identity.invite(owner,tenantId,member.accountId,"participant");
  await identity.acceptInvitation(member,tenantId,invitation.invitationToken);
  source=structuredClone(createLegalDocument({id:randomUUID(),tenantId,title:"Adoption integration"}));
  source.content[0].inlines=[{kind:"text",text:"Report annually."}];
  await documents.create(owner,tenantId,{document:source,commandId:randomUUID(),disclosure:"publish-all-revisions-v1"});
  proposal=await proposals.create(member,tenantId,source.id,{
    baseVersion:1,selection:{blockId:source.content[0].id,start:7,end:15,quote:"annually"},
    replacement:"quarterly",rationale:"More responsive public reporting.",
    commandId:randomUUID(),disclosure:"publish-proposal-v1"
  });
});
const open=async()=>decisions.open(owner,tenantId,source.id,proposal.proposal.id,{
  hours:1,commandId:randomUUID()
});
const ballot=async(who,choice)=>decisions.cast(who,tenantId,source.id,proposal.proposal.id,{
  choice,expectedVersion:0,commandId:randomUUID()
});
const close=async()=>decisions.close(owner,tenantId,source.id,proposal.proposal.id);

test("passed frozen vote atomically applies exact proposal as new public working revision and anchors event",async()=>{
  await open();
  await ballot(owner,"yes");await ballot(member,"yes");
  clock+=3600001;
  const results=await Promise.all([close(),close()]);
  assert.deepEqual(results[0],results[1],"duplicate closers must return same certificate");
  const {certificate,certificateDigest}=results[0];
  assert.equal(certificate.outcome.status,"passed");
  assert.equal(certificate.application,"applied-to-public-draft");
  assert.equal(certificate.appliedVersion,2);
  assert.equal(certificate.executed,false);
  assert.equal(certificate.canAdopt,false);
  assert.match(certificateDigest,/^[a-f0-9]{64}$/);
  assert.equal(certificate.ballotsDigestVersion,2);
  assert.match(certificate.ballotsDigest,/^[a-f0-9]{64}$/);
  const rawBallots=(await db.query("SELECT account_id,choice,version,cast_at FROM dge_decisions.ballots ORDER BY account_id")).rows;
  const canonicalBallots=rawBallots.map(r=>({
    accountId:r.account_id,choice:r.choice,version:r.version,castAt:new Date(r.cast_at).toISOString()
  }));
  const unsalted=digest("frozen-decision-ballots-v1",canonicalBallots);
  assert.notEqual(certificate.ballotsDigest,unsalted,
    "The public certificate must not reveal an easily enumerated ballot commitment");
  const privateEvents=(await db.query("SELECT result FROM dge_decisions.events")).rows;
  const audit=privateEvents.find(e=>typeof e.result?.ballotSalt==="string")?.result;
  assert.match(audit?.ballotSalt??"",/^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(certificate).includes(audit.ballotSalt));
  assert.equal(certificate.ballotsDigest,digest("frozen-decision-ballots-v2",{
    salt:audit.ballotSalt,ballots:canonicalBallots
  }));
  const version=await documents.read(owner,tenantId,source.id);
  assert.equal(version.version,2);
  assert.equal(version.previousDigest,(await documents.history(source.id)).items[1].digest);
  assert.equal(version.document.content[0].inlines[0].text,"Report quarterly.");
  assert.equal(version.document.lifecycle,"draft");
  assert.equal((await documents.history(source.id)).items.length,2);
  assert.equal((await db.query("SELECT count(*)::int n FROM dge_documents.anchor_outbox")).rows[0].n,2);
  assert.deepEqual(await close(),results[0],"closing a third time must not append a duplicate");
});

test("no quorum or majority closes without rewriting the draft",async()=>{
  await open();
  await ballot(owner,"no");
  clock+=3600001;
  const {certificate}=await close();
  assert.equal(certificate.outcome.status,"failed");
  assert.equal(certificate.application,"not-passed");
  assert.equal(certificate.appliedVersion,null);
  assert.equal((await documents.read(owner,tenantId,source.id)).version,1);
});

test("editing source before voting ends does not silently rebase passed amendment",async()=>{
  await open();
  await ballot(owner,"yes");await ballot(member,"yes");
  const doc=structuredClone(source);
  doc.revision=source.revision+1;
  doc.content[0].inlines=[{kind:"text",text:"An unrelated draft edit."}];
  await documents.save(owner,tenantId,source.id,{document:doc,expectedVersion:1,commandId:randomUUID()});
  clock+=3600001;
  const {certificate}=await close();
  assert.equal(certificate.outcome.status,"passed");
  assert.equal(certificate.application,"stale-source");
  assert.equal(certificate.sourceIsCurrent,false);
  assert.equal(certificate.appliedVersion,null);
  const current=await documents.read(owner,tenantId,source.id);
  assert.equal(current.version,2);
  assert.equal(current.document.content[0].inlines[0].text,"An unrelated draft edit.");
  assert.equal((await documents.history(source.id)).items.length,2);
});
