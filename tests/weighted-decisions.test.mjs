import {before,after,beforeEach,test} from "node:test";
import assert from "node:assert/strict";
import {openWorld,iso,id} from "./governance-fixture.mjs";
import {verifyWeightedDecisionReceipt} from "../src/weighted-governance.mjs";

let w,tenantId,owner,doc;
before(async()=>{w=await openWorld();});
after(async()=>w?.db.close());
beforeEach(async()=>{await w.reset();({tenantId,owner}=w);doc=await w.document();});

const HOUR=3600000;
const huge="9".repeat(70);
async function register(holdings){
  const roster=await w.electorates.createRoster(owner,tenantId,{kind:"unit-register",name:"Register",commandId:id()});
  for(const [who,classes] of holdings)for(const [cls,units] of Object.entries(classes))
    await w.electorates.recordEntry(owner,tenantId,roster.id,{principalId:who.accountId,units,class:cls,
      validFrom:iso(w.time-HOUR),expectedVersion:0,commandId:id()});
  w.time+=1000;
  return roster;
}
const open=(proposal,options={})=>w.decisions.open(owner,tenantId,doc.id,proposal.proposal.id,{hours:1,commandId:id(),...options});
const vote=(who,proposal,choice,extra={})=>w.decisions.cast(who,tenantId,doc.id,proposal.proposal.id,{choice,expectedVersion:0,commandId:id(),...extra});
const close=proposal=>w.decisions.close(owner,tenantId,doc.id,proposal.proposal.id);
const read=(who,proposal)=>w.decisions.read(who,tenantId,doc.id,proposal.proposal.id);
const classRule={class:"preferred-a",quorum:{numerator:"1",denominator:"2"},approval:{basis:"decisive",comparison:"gt",numerator:"1",denominator:"2"}};

test("unit-weighted roster decision: weight comes from the frozen snapshot and a class can veto the overall majority",async()=>{
  const [a,b]=[await w.member(),await w.member()];
  const roster=await register([[owner,{common:huge}],[a,{"preferred-a":"10"}],[b,{"preferred-a":"10",common:"1"}]]);
  const proposal=await w.propose(a,doc);
  const opened=await open(proposal,{electorate:{source:"roster",rosterId:roster.id,recordDate:iso(w.time-1)},weighting:"units",
    policySettings:{quorum:{kind:"fraction-weight",numerator:"1",denominator:"2"},classRequirements:[classRule]}});
  assert.equal(opened.schemaVersion,2);
  assert.equal(opened.eligibleWeight,(BigInt(huge)+21n).toString());
  assert.match(opened.rule.classes[0],/preferred-a/);
  // A record entered after opening changes nothing for this decision.
  const late=await w.member();
  await w.electorates.recordEntry(owner,tenantId,roster.id,{principalId:late.accountId,units:huge,class:"common",
    validFrom:iso(w.time-HOUR),expectedVersion:0,commandId:id()});
  await assert.rejects(vote(late,proposal,"yes"),{code:"NOT_IN_FROZEN_ELECTORATE"});
  const injected=await w.call(`/api/workspaces/${tenantId}/documents/${doc.id}/proposals/${proposal.proposal.id}/decision/ballots`,
    {who:a,method:"POST",body:{choice:"yes",expectedVersion:0,commandId:id(),weight:huge}});
  assert.equal(injected.status,400,"a client can never supply ballot weight");
  await vote(owner,proposal,"yes");await vote(a,proposal,"no");await vote(b,proposal,"no");
  w.time+=HOUR+1;
  const {certificate}=await close(proposal);
  assert.equal(certificate.outcome.overall.approval.met,true,"the huge common holding approves overall");
  assert.equal(certificate.outcome.classes[0].approval.met,false);
  assert.equal(certificate.outcome.status,"failed","overall approval never bypasses a required class approval");
  assert.equal(certificate.outcome.overall.yes,huge);
  assert.equal(certificate.application,"not-passed");
  assert.equal(certificate.finality,"final");
  assert.equal((await w.documents.read(owner,tenantId,doc.id)).version,1);
});

test("proxies: split allocations, direct precedence, attribution, revocation and no re-delegation",async()=>{
  const [p,x,y,z,q]=[await w.member(),await w.member(),await w.member(),await w.member(),await w.member()];
  const roster=await register([[p,{common:"100"}],[x,{common:"1"}],[y,{common:"1"}],[q,{common:"50"}]]);
  const grant=(from,to,allocation,scope={rosterId:roster.id})=>w.electorates.grantProxy(from,tenantId,{granteeId:to.accountId,allocation,commandId:id(),...scope});
  const gx=await grant(p,x,{common:"60"}),gy=await grant(p,y,{common:"40"}),gq=await grant(q,x,null);
  const proposal=await w.propose(x,doc);
  const opened=await open(proposal,{electorate:{source:"roster",rosterId:roster.id,recordDate:iso(w.time-1)},weighting:"units",
    policySettings:{quorum:{kind:"weight",minimum:"1"}}});
  // Decision-scoped grant on top of roster grants would over-allocate the frozen holding.
  const extra=await w.electorates.grantProxy(p,tenantId,{granteeId:z.accountId,decisionId:opened.id,allocation:{common:"1"},commandId:id()})
    .catch(error=>error);
  assert.equal(extra.code,"PROXY_OVER_ALLOCATION");
  const viaX=await vote(x,proposal,"yes",{onBehalfOf:gx.id});
  assert.equal(viaX.onBehalfOf,gx.id);
  await vote(y,proposal,"no",{onBehalfOf:gy.id});
  await vote(x,proposal,"yes",{onBehalfOf:gq.id});
  await assert.rejects(vote(z,proposal,"yes",{onBehalfOf:gx.id}),{code:"PROXY_GRANT_NOT_FOUND"},"a proxy power cannot be re-delegated");
  await assert.rejects(vote(y,proposal,"yes",{onBehalfOf:gx.id}),{code:"PROXY_GRANT_NOT_FOUND"});
  let live=await read(owner,proposal);
  assert.equal(live.outcome.yes,"110");assert.equal(live.outcome.no,"40");
  const xView=await read(x,proposal);
  assert.equal(xView.proxies.length,2);
  assert.ok(!JSON.stringify(xView.proxies).includes(p.accountId),"read model does not expose grantor identities");
  // q revokes before close: x's ballot for q no longer counts.
  await w.electorates.revokeProxy(q,tenantId,gq.id,{commandId:id()});
  await assert.rejects(vote(x,proposal,"no",{onBehalfOf:gq.id,expectedVersion:1}),{code:"PROXY_REVOKED"});
  // p votes directly: its full holding goes to its own choice.
  await vote(p,proposal,"abstain");
  live=await read(owner,proposal);
  assert.equal(live.outcome.abstain,"100");assert.equal(live.outcome.yes,"0");assert.equal(live.outcome.no,"0");
  w.time+=HOUR+1;
  const {certificate}=await close(proposal);
  assert.equal(certificate.outcome.proxies.supersededByDirect,2);
  assert.equal(certificate.outcome.proxies.revokedBeforeClose,1);
  assert.equal(certificate.outcome.overall.participatingWeight,"100");
  const rows=(await w.db.query("SELECT proxy_id,principal_id FROM dge_electorates.proxy_ballots WHERE grant_id=$1",[gx.id])).rows;
  assert.deepEqual(rows[0],{proxy_id:x.accountId,principal_id:p.accountId},"proxy ballots are attributed to proxy and principal");
});

test("equal-person decisions refuse split proxies and the cast path re-checks over-allocation",async()=>{
  const [p,x,y]=[await w.member(),await w.member(),await w.member()];
  const roster=await register([[p,{common:"10"}],[x,{common:"1"}]]);
  const split=await w.electorates.grantProxy(p,tenantId,{granteeId:x.accountId,rosterId:roster.id,allocation:{common:"5"},commandId:id()});
  const proposal=await w.propose(x,doc);
  const opened=await open(proposal,{electorate:{source:"roster",rosterId:roster.id,recordDate:iso(w.time-1)}});
  await assert.rejects(vote(x,proposal,"yes",{onBehalfOf:split.id}),{code:"PROXY_SPLIT_NOT_ALLOWED"});
  await w.electorates.revokeProxy(p,tenantId,split.id,{commandId:id()});
  // A decision grant and a later roster grant each pass their own scope
  // check; together they would double count, so casting refuses both.
  const forDecision=await w.electorates.grantProxy(p,tenantId,{granteeId:x.accountId,decisionId:opened.id,commandId:id()});
  const forRoster=await w.electorates.grantProxy(p,tenantId,{granteeId:y.accountId,rosterId:roster.id,commandId:id()});
  await assert.rejects(vote(x,proposal,"yes",{onBehalfOf:forDecision.id}),{code:"PROXY_OVER_ALLOCATION"});
  await assert.rejects(vote(y,proposal,"yes",{onBehalfOf:forRoster.id}),{code:"PROXY_OVER_ALLOCATION"});
  await w.electorates.revokeProxy(p,tenantId,forRoster.id,{commandId:id()});
  assert.equal((await vote(x,proposal,"yes",{onBehalfOf:forDecision.id})).version,1);
  assert.equal((await read(owner,proposal)).outcome.yes,"1","an equal-person proxy carries exactly one vote");
});

test("challenge window: provisional, held, dismissed, then final with a single application",async()=>{
  const a=await w.member();
  const proposal=await w.propose(a,doc);
  await open(proposal,{challengeWindowHours:24});
  await vote(owner,proposal,"yes");await vote(a,proposal,"yes");
  w.time+=HOUR+1;
  const provisional=await close(proposal);
  assert.equal(provisional.certificate.finality,"provisional");
  assert.equal(provisional.certificate.application,"pending-finality");
  assert.equal((await w.documents.read(owner,tenantId,doc.id)).version,1,"nothing applies while provisional");
  await assert.rejects(w.decisions.finalize(owner,tenantId,doc.id,proposal.proposal.id),{code:"CHALLENGE_WINDOW_OPEN"});
  const outsider=await w.user();
  await assert.rejects(w.decisions.challenge(outsider,tenantId,doc.id,proposal.proposal.id,{reasonCategory:"procedure",statement:"x",commandId:id()}));
  const viewer=await w.member("viewer");
  await assert.rejects(w.decisions.challenge(viewer,tenantId,doc.id,proposal.proposal.id,{reasonCategory:"procedure",statement:"x",commandId:id()}),
    {code:"NOT_IN_FROZEN_ELECTORATE"});
  await assert.rejects(w.decisions.challenge(a,tenantId,doc.id,proposal.proposal.id,{reasonCategory:"rumour",statement:"x",commandId:id()}),{code:"INVALID_CHALLENGE"});
  await assert.rejects(w.decisions.challenge(a,tenantId,doc.id,proposal.proposal.id,{reasonCategory:"other",statement:"x".repeat(2001),commandId:id()}),{code:"INVALID_CHALLENGE"});
  const commandId=id();
  const filed=await w.decisions.challenge(a,tenantId,doc.id,proposal.proposal.id,{reasonCategory:"ballot-irregularity",statement:"Please verify the count.",commandId});
  assert.deepEqual(await w.decisions.challenge(a,tenantId,doc.id,proposal.proposal.id,{reasonCategory:"ballot-irregularity",statement:"Please verify the count.",commandId}),filed);
  assert.equal((await read(owner,proposal)).finality,"held");
  await assert.rejects(w.decisions.finalize(owner,tenantId,doc.id,proposal.proposal.id),{code:"CHALLENGE_PENDING"});
  await assert.rejects(w.decisions.resolveChallenge(a,tenantId,doc.id,proposal.proposal.id,filed.id,{resolution:"dismiss",commandId:id()}));
  const listed=await w.decisions.listChallenges(viewer,tenantId,doc.id,proposal.proposal.id);
  assert.equal(listed.items[0].statement,undefined,"other members see category and status, not the statement");
  const dismissed=await w.decisions.resolveChallenge(owner,tenantId,doc.id,proposal.proposal.id,filed.id,{resolution:"dismiss",commandId:id()});
  assert.equal(dismissed.finality,"provisional","window still open after dismissal");
  w.time+=24*HOUR;
  await assert.rejects(w.decisions.challenge(a,tenantId,doc.id,proposal.proposal.id,{reasonCategory:"other",statement:"late",commandId:id()}),{code:"CHALLENGE_WINDOW_CLOSED"});
  const results=await Promise.all([1,2,3].map(()=>w.decisions.finalize(owner,tenantId,doc.id,proposal.proposal.id)));
  assert.equal(new Set(results.map(r=>r.certificateDigest)).size,1);
  const final=results[0].certificate;
  assert.equal(final.finality,"final");
  assert.equal(final.application,"applied-to-public-draft");
  assert.equal(final.challenge.outcome,"dismissed");
  assert.equal(final.challenge.filed,1);
  assert.equal(final.previousCertificateDigest,provisional.certificateDigest);
  assert.equal((await w.documents.read(owner,tenantId,doc.id)).version,2);
  assert.equal((await w.documents.history(doc.id)).items.length,2,"finalization applies exactly once");
  const ledger=(await w.db.query("SELECT kind,finalization FROM dge_ledger.outbox ORDER BY created_at,kind")).rows;
  assert.deepEqual(ledger.filter(e=>e.kind==="decision-certificate"),[{kind:"decision-certificate",finalization:true}]);
  assert.equal(ledger.filter(e=>e.kind==="decision-provisional").length,1);
  assert.equal(ledger.filter(e=>e.kind==="decision-challenge-resolution").length,1);
  await assert.rejects(w.db.transaction(async tx=>{
    await tx.exec("SET LOCAL ROLE dge_identity_runtime");
    await tx.query("SELECT set_config('dge.tenant_id',$1,true)",[tenantId]);
    await tx.query("UPDATE dge_decisions.decisions SET certificate_digest=$1",["0".repeat(64)]);
  }),/immutable/,"the request role can never rewrite a final certificate");
  const receipt=await w.decisions.publicReceipt(doc.id,proposal.proposal.id);
  assert.equal(receipt.schemaVersion,2);
  assert.equal(verifyWeightedDecisionReceipt(receipt,{documentId:doc.id}).checksumValid,true);
  const text=JSON.stringify(receipt);
  for(const who of [owner,a])assert.ok(!text.includes(who.accountId),"public receipts never name voters");
  assert.ok(!text.includes("Please verify the count."),"challenge statements stay private");
});

test("an upheld challenge voids the decision forever; a fresh decision needs a new snapshot",async()=>{
  const a=await w.member(),b=await w.member();
  const proposal=await w.propose(a,doc);
  const first=await open(proposal,{challengeWindowHours:1});
  await vote(owner,proposal,"yes");await vote(a,proposal,"yes");
  w.time+=HOUR+1;
  await close(proposal);
  const one=await w.decisions.challenge(a,tenantId,doc.id,proposal.proposal.id,{reasonCategory:"eligibility",statement:"An ineligible voter took part.",commandId:id()});
  const two=await w.decisions.challenge(b,tenantId,doc.id,proposal.proposal.id,{reasonCategory:"procedure",statement:"Notice was short.",commandId:id()});
  const upheld=await w.decisions.resolveChallenge(owner,tenantId,doc.id,proposal.proposal.id,one.id,{resolution:"uphold",note:"Confirmed.",commandId:id()});
  assert.equal(upheld.finality,"void");
  await assert.rejects(w.decisions.resolveChallenge(owner,tenantId,doc.id,proposal.proposal.id,two.id,{resolution:"dismiss",commandId:id()}),{code:"CHALLENGE_ALREADY_RESOLVED"});
  w.time+=2*HOUR;
  await assert.rejects(w.decisions.finalize(owner,tenantId,doc.id,proposal.proposal.id),{code:"DECISION_VOID"});
  await assert.rejects(vote(b,proposal,"yes"),{code:"VOTE_CLOSED"});
  assert.equal((await w.documents.read(owner,tenantId,doc.id)).version,1,"a void decision never applies");
  await assert.rejects(w.db.query("UPDATE dge_decisions.decisions SET finality='provisional'"),/immutable/);
  await assert.rejects(w.db.query("UPDATE dge_decisions.decisions SET state='open'"),/reopen/);
  const receiptBefore=await w.decisions.publicReceipt(doc.id,proposal.proposal.id);
  assert.equal(receiptBefore.certificate.finality,"void");
  // A new member joins; only a new decision with a new snapshot can include them.
  const c=await w.member();
  const second=await open(proposal);
  assert.notEqual(second.id,first.id);
  assert.notEqual(second.snapshotDigest,first.snapshotDigest);
  assert.equal(second.eligibleCount,first.eligibleCount+1);
  await vote(c,proposal,"yes");
  assert.equal((await read(owner,proposal)).id,second.id);
});

test("no challenge window: closing is immediately final and logged with finalization=true",async()=>{
  const a=await w.member();
  const proposal=await w.propose(a,doc);
  await open(proposal,{weighting:"equal"});
  await vote(owner,proposal,"yes");await vote(a,proposal,"yes");
  w.time+=HOUR+1;
  const [x,y]=await Promise.all([close(proposal),close(proposal)]);
  assert.deepEqual(x,y,"two concurrent closers return one certificate");
  assert.equal(x.certificate.finality,"final");
  assert.equal(x.certificate.application,"applied-to-public-draft");
  assert.equal((await w.documents.read(owner,tenantId,doc.id)).document.content[1].children[0].inlines[0].text,"Meetings occur quarterly and openly.");
  const events=(await w.db.query("SELECT finalization FROM dge_ledger.outbox WHERE kind='decision-certificate'")).rows;
  assert.deepEqual(events,[{finalization:true}]);
  assert.equal((await w.db.query("SELECT count(*)::int n FROM dge_electorates.certificates")).rows[0].n,1);
});

test("atomic bundles apply every proposal in one revision or none; overlaps conflict without partial writes",async()=>{
  const a=await w.member();
  const p1=await w.propose(a,doc,"p-public"),p2=await w.propose(a,doc,"p-board"),p3=await w.propose(a,doc,"p-board",{quote:"five seats",replacement:"nine seats"});
  await assert.rejects(open(p1,{bundle:[p2.proposal.id,p1.proposal.id]}),{code:"INVALID_BUNDLE"});
  const bundled=await open(p1,{bundle:[p1.proposal.id,p2.proposal.id]});
  assert.equal(bundled.bundle.length,2);
  await assert.rejects(open(p2),{code:"DECISION_ALREADY_EXISTS"},"a bundled proposal cannot be decided twice");
  await vote(owner,p1,"yes");await vote(a,p1,"yes");
  w.time+=HOUR+1;
  const {certificate}=await close(p1);
  assert.equal(certificate.application,"applied-to-public-draft");
  const current=await w.documents.read(owner,tenantId,doc.id);
  assert.equal(current.version,2,"one revision for the whole bundle");
  assert.equal(current.document.content[1].children[0].inlines[0].text,"Meetings occur quarterly and openly.");
  assert.equal(current.document.content[2].children[0].inlines[0].text,"The board has seven seats and meets monthly.");
  // p3 overlaps p2 and was proposed on version 1: its base is stale now.
  await assert.rejects(open(p3),{code:"STALE_SOURCE_VERSION"});
  // On version 2, two overlapping proposals in one bundle conflict as a whole.
  const fresh=current.document;
  const q1=await w.propose(a,fresh,"p-board",{quote:"seven seats",replacement:"eight seats",baseVersion:2});
  const q2=await w.propose(a,fresh,"p-board",{quote:"seven",replacement:"six",baseVersion:2});
  await open(q1,{bundle:[q1.proposal.id,q2.proposal.id]});
  await vote(owner,q1,"yes");await vote(a,q1,"yes");
  w.time+=HOUR+1;
  const conflicted=(await close(q1)).certificate;
  assert.equal(conflicted.outcome.status,"passed");
  assert.equal(conflicted.application,"conflicted");
  assert.equal((await w.documents.read(owner,tenantId,doc.id)).version,2,"nothing from a conflicting bundle applies");
});

test("overlapping passed proposals serialize: the second fails its exact-base check and is recorded",async()=>{
  const a=await w.member();
  const p1=await w.propose(a,doc,"p-public"),p2=await w.propose(a,doc,"p-public",{quote:"openly",replacement:"publicly"});
  await open(p1);await open(p2);
  for(const p of [p1,p2]){await vote(owner,p,"yes");await vote(a,p,"yes");}
  w.time+=HOUR+1;
  const first=await close(p1),second=await close(p2);
  assert.equal(first.certificate.application,"applied-to-public-draft");
  assert.equal(second.certificate.outcome.status,"passed");
  assert.equal(second.certificate.application,"stale-source");
  assert.equal(second.certificate.sourceIsCurrent,false);
  assert.equal((await w.documents.read(owner,tenantId,doc.id)).version,2);
});

test("double submits, replays and crashes around commit never add weight",async()=>{
  const a=await w.member();
  const proposal=await w.propose(a,doc);
  await open(proposal,{weighting:"equal"});
  const commandId=id();
  const results=await Promise.allSettled([1,2,3,4].map(()=>vote(a,proposal,"yes",{commandId})));
  assert.ok(results.every(r=>r.status==="fulfilled"));
  assert.equal(new Set(results.map(r=>r.value.receiptDigest)).size,1);
  await assert.rejects(vote(a,proposal,"no",{commandId}),{code:"COMMAND_REUSED"});
  // Crash before commit: nothing persists and the retry succeeds once.
  w.crashBeforeCommit=true;
  const retryId=id();
  await assert.rejects(vote(owner,proposal,"no",{commandId:retryId}),/simulated crash/);
  assert.equal((await w.db.query("SELECT count(*)::int n FROM dge_decisions.ballots WHERE account_id=$1",[owner.accountId])).rows[0].n,0);
  const committed=await vote(owner,proposal,"no",{commandId:retryId});
  // Crash after commit: the client lost the acknowledgment and retries.
  assert.deepEqual(await vote(owner,proposal,"no",{commandId:retryId}),committed);
  const live=await read(owner,proposal);
  assert.equal(live.outcome.yes,"1");assert.equal(live.outcome.no,"1");
  assert.equal((await w.db.query("SELECT count(*)::int n FROM dge_decisions.ballots")).rows[0].n,2);
});

test("cross-tenant canaries: rosters, proxies and challenges never cross workspaces",async()=>{
  const intruder=await w.user();
  const {tenantId:otherTenant}=await w.identity.createTenant(intruder);
  const roster=await register([[owner,{common:"5"}]]);
  const proposal=await w.propose(owner,doc);
  const otherDoc=await w.document(otherTenant,intruder);
  const otherProposal=await w.propose(intruder,otherDoc);
  await assert.rejects(w.decisions.open(intruder,otherTenant,otherDoc.id,otherProposal.proposal.id,{hours:1,commandId:id(),
    electorate:{source:"roster",rosterId:roster.id,recordDate:iso(w.time-1)}}),{code:"ROSTER_NOT_FOUND"});
  await open(proposal,{electorate:{source:"roster",rosterId:roster.id,recordDate:iso(w.time-1)},weighting:"units"});
  await assert.rejects(w.decisions.read(intruder,tenantId,doc.id,proposal.proposal.id));
  await assert.rejects(w.decisions.read(intruder,otherTenant,doc.id,proposal.proposal.id),{code:"DECISION_NOT_FOUND"});
  await assert.rejects(w.electorates.grantProxy(intruder,otherTenant,{granteeId:owner.accountId,rosterId:roster.id,commandId:id()}),
    {code:"PROXY_GRANTEE_NOT_ELIGIBLE"});
  await w.transaction(async tx=>{
    for(const table of ["proxy_grants","bundle_members","certificates","challenges"])
      assert.equal((await tx.query(`SELECT * FROM dge_electorates.${table}`)).rows.length,0);
  });
});
