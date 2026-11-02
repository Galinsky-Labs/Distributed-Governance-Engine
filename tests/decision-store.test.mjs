import {before,after,beforeEach,test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID,randomBytes} from "node:crypto";
import {PGlite} from "@electric-sql/pglite";
import {createIdentityStore,applyIdentityMigrations} from "../server/identity-store.mjs";
import {createLegalDocument} from "../src/legal-structure.mjs";
import {createDocumentStore} from "../server/document-store.mjs";
import {createProposalStore} from "../server/proposal-store.mjs";
import {createDecisionStore} from "../server/decision-store.mjs";
import {createDecisionRoutes} from "../server/decision-http.mjs";
import {createAccountHandler} from "../server/account-http.mjs";

const origin="https://quill.example";
let db,identity,documents,proposals,decisions,tenantId,owner,member,outsider,document,proposal,now,handler;
const transaction=fn=>db.transaction(async tx=>{
  await tx.exec("SET LOCAL ROLE dge_identity_runtime");
  return fn(tx);
});
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
  now=Date.now();
  decisions=createDecisionStore({identity,clock:()=>now});
  owner=await user();member=await user();outsider=await user();
  ({tenantId}=await identity.createTenant(owner));
  const invite=await identity.invite(owner,tenantId,member.accountId,"participant");
  await identity.acceptInvitation(member,tenantId,invite.invitationToken);
  document=structuredClone(createLegalDocument({id:randomUUID(),tenantId,title:"Decision test"}));
  document.content[0].inlines=[{kind:"text",text:"The agency shall report annually."}];
  await documents.create(owner,tenantId,{document,commandId:randomUUID(),disclosure:"publish-all-revisions-v1"});
  proposal=await proposals.create(member,tenantId,document.id,{
    baseVersion:1,selection:{blockId:document.content[0].id,start:24,end:32,quote:"annually"},
    replacement:"quarterly",rationale:"Timely reporting.",commandId:randomUUID(),disclosure:"publish-proposal-v1"
  });
  handler=createAccountHandler({store:identity,login:{},origin,
    extensions:[createDecisionRoutes({decisions})]});
});
const paths=()=>"/api/workspaces/"+tenantId+"/documents/"+document.id+
  "/proposals/"+proposal.proposal.id+"/decision";
const call=(path,{who=owner,method="GET",body}={})=>handler(new Request(origin+path,{
  method,headers:{
    cookie:"__Host-dge_session="+who.sessionToken,origin,"x-dge-csrf":who.csrfToken,
    ...(body?{"content-type":"application/json"}:{})
  },
  ...(body?{body:JSON.stringify(body)}:{})
}),{peerAddress:"127.0.0.1"});
const start=()=>decisions.open(owner,tenantId,document.id,proposal.proposal.id,{
  commandId:randomUUID(),hours:1
});
const cast=(who,choice,expectedVersion=0,commandId=randomUUID())=>
  decisions.cast(who,tenantId,document.id,proposal.proposal.id,{
    choice,expectedVersion,commandId
  });

test("frozen member electorate, durable votes and replay-safe receipts survive concurrent writes",async()=>{
  const commandId=randomUUID(),parameters={hours:1,commandId};
  const first=await decisions.open(owner,tenantId,document.id,proposal.proposal.id,parameters);
  assert.equal(first.eligibleCount,2);
  assert.equal(first.state,"open");
  assert.equal(first.outcome.canAdopt,false);
  assert.deepEqual(await decisions.open(owner,tenantId,document.id,proposal.proposal.id,parameters),first);
  await assert.rejects(start(),{code:"DECISION_ALREADY_EXISTS"});
  await assert.rejects(decisions.open(member,tenantId,document.id,proposal.proposal.id,parameters));
  await assert.rejects(cast(outsider,"yes"));
  const once=randomUUID();
  const [one,two]=await Promise.all([cast(member,"yes",0,once),cast(member,"yes",0,once)]);
  assert.deepEqual(one,two);
  assert.equal(one.version,1);
  assert.match(one.receiptDigest,/^[a-f0-9]{64}$/);
  const competing=await Promise.allSettled([cast(member,"no",1),cast(member,"abstain",1)]);
  assert.equal(competing.filter(x=>x.status==="fulfilled").length,1);
  assert.equal(competing.find(x=>x.status==="rejected").reason.code,"BALLOT_VERSION_CONFLICT");
  const read=await decisions.read(member,tenantId,document.id,proposal.proposal.id);
  assert.equal(read.mine.version,2);
  assert.equal(read.outcome.participating,1);
  assert.equal(read.anchorStatus,"pending");
  assert.ok(!JSON.stringify(read).includes(owner.accountId));
  assert.ok(!JSON.stringify(read).includes(member.accountId));
  await assert.rejects(decisions.close(owner,tenantId,document.id,proposal.proposal.id),{code:"VOTE_STILL_OPEN"});
  await identity.changeMember(owner,tenantId,member.accountId,"viewer");
  await assert.rejects(cast(member,"yes",2));
  now+=3600001;
  const closed=await decisions.close(owner,tenantId,document.id,proposal.proposal.id);
  assert.equal(closed.certificate.executed,false);
  assert.equal(closed.certificate.canAdopt,false);
  assert.match(closed.certificateDigest,/^[a-f0-9]{64}$/);
  assert.deepEqual(await decisions.close(owner,tenantId,document.id,proposal.proposal.id),closed);
  await assert.rejects(cast(owner,"yes"),{code:"VOTE_CLOSED"});
  const loaded=await decisions.read(owner,tenantId,document.id,proposal.proposal.id);
  assert.equal(loaded.state,"closed");
  assert.equal(loaded.outcome.executed,false);
  assert.equal(loaded.certificateDigest,closed.certificateDigest);
  assert.deepEqual((await documents.read(owner,tenantId,document.id)).document,document);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM dge_decisions.decisions")).rows[0].n,1);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM dge_decisions.ballots")).rows[0].n,1);
  await transaction(async tx=>{
    assert.equal((await tx.query("SELECT * FROM dge_decisions.ballots")).rows.length,0,
      "Unscoped runtime role must see no private ballot records");
  });
});

test("tenant and CSRF fences protect decision API; results never publish the electorate roster",async()=>{
  let response=await call(paths());
  assert.equal(response.status,404);
  response=await call(paths(),{method:"POST",body:{hours:1,commandId:randomUUID()}});
  assert.equal(response.status,200);
  const publicResult=await response.json();
  assert.equal(publicResult.eligibleCount,2);
  assert.ok(!JSON.stringify(publicResult).includes(member.accountId));
  response=await call(paths()+"/ballots",{who:member,method:"POST",body:{choice:"yes",expectedVersion:0,commandId:randomUUID()}});
  assert.equal(response.status,200);
  response=await call(paths()+"/ballots",{who:outsider,method:"POST",body:{choice:"yes",expectedVersion:0,commandId:randomUUID()}});
  assert.equal(response.status,403);
  const denied=await handler(new Request(origin+paths()+"/ballots",{method:"POST",headers:{
    cookie:"__Host-dge_session="+owner.sessionToken,origin,"content-type":"application/json"
  },body:JSON.stringify({choice:"yes",expectedVersion:0,commandId:randomUUID()})}),{peerAddress:"127.0.0.1"});
  assert.equal(denied.status,403);
  const responseWithInvalidBody=await call(paths()+"/ballots",{method:"POST",body:{
    choice:"yes",expectedVersion:0,commandId:randomUUID(),principalId:outsider.accountId
  }});
  assert.equal(responseWithInvalidBody.status,400);
  const mine=await call(paths(),{who:member});
  assert.equal(mine.status,200);
  assert.equal((await mine.json()).mine.choice,"yes");
});

test("out-of-window ballots and stale source versions cannot authorize edits",async()=>{
  const first=await start();
  now+=3600001;
  await assert.rejects(cast(member,"yes"),{code:"VOTE_WINDOW_CLOSED"});
  const final=await decisions.close(owner,tenantId,document.id,proposal.proposal.id);
  assert.equal(final.certificate.outcome.status,"failed");
  assert.equal(first.outcome.executed,false);
  assert.equal(final.certificate.canAdopt,false);
  const second=structuredClone(document);
  second.content[0].inlines=[{kind:"text",text:"Another version of the reporting rule."}];
  await documents.save(owner,tenantId,document.id,{document:second,expectedVersion:1,commandId:randomUUID()});
  const result=await decisions.read(owner,tenantId,document.id,proposal.proposal.id);
  assert.equal(result.state,"closed");
  assert.equal(result.outcome.executed,false);
});
