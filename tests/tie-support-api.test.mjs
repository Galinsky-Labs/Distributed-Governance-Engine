// DCE-010: tie rules and open-public support floors through the decision API.
import {before,after,beforeEach,test} from "node:test";
import assert from "node:assert/strict";
import {openWorld,id} from "./governance-fixture.mjs";

let w,tenantId,owner,doc;
before(async()=>{w=await openWorld();});
after(async()=>w?.db.close());
beforeEach(async()=>{await w.reset();({tenantId,owner}=w);doc=await w.document();});
const HOUR=3600000;
const call=async(path,init)=>{const r=await w.call(path,init);const t=await r.text();return {status:r.status,body:t?JSON.parse(t):null};};
const base=(p)=>`/api/workspaces/${tenantId}/documents/${doc.id}/proposals/${p.proposal.id}/decision`;
const open=(p,policySettings)=>call(base(p),{who:owner,method:"POST",body:{hours:1,commandId:id(),policySettings}});
const vote=(who,p,choice)=>call(base(p)+"/ballots",{who,method:"POST",body:{choice,expectedVersion:0,commandId:id()}});
const close=p=>call(base(p)+"/close",{who:owner,method:"POST",body:{}});
const cast=(who,p,choice,commandId=id())=>call(base(p)+"/casting-vote",{who,method:"POST",body:{choice,commandId}});
const atLeastHalf={basis:"decisive",comparison:"gte",numerator:"1",denominator:"2"};

async function tied(policy){
  const a=await w.member();
  const p=await w.propose(a,doc);
  const opened=await open(p,{quorum:{kind:"count",minimum:"2"},approval:atLeastHalf,...policy(a)});
  assert.equal(opened.status,200,JSON.stringify(opened.body));
  assert.equal((await vote(owner,p,"yes")).status,200);assert.equal((await vote(a,p,"no")).status,200);
  return {p,a,opened:opened.body};
}

test("without a tie rule an at-least-half policy passes a tie (unchanged behaviour); 'fails' makes the tie fail",async()=>{
  const plain=await tied(()=>({}));
  w.time+=HOUR+1;
  assert.equal((await close(plain.p)).body.certificate.outcome.status,"passed");
  doc=await w.document();
  const strict=await tied(()=>({tieRule:"fails"}));
  assert.match(strict.opened.rule.tieRule,/tie fails/);
  w.time+=HOUR+1;
  const {certificate}=(await close(strict.p)).body;
  assert.equal(certificate.outcome.status,"failed");
  assert.deepEqual(certificate.outcome.tie,{rule:"fails",outcome:"no",reason:"tie-fails"});
});

test("casting vote: only the named presiding member, only after voting ends, only on a tie, once",async()=>{
  const chair=await w.member("admin");
  const {p,a}=await tied(()=>({tieRule:"casting-vote",castingPrincipalId:chair.accountId}));
  assert.equal((await cast(chair,p,"yes")).body.error,"VOTE_STILL_OPEN");
  w.time+=HOUR+1;
  assert.equal((await cast(a,p,"yes")).status,403);
  const live=(await call(base(p),{who:chair})).body;
  assert.equal(live.castingPrincipal,true);assert.equal(live.outcome.tie.reason,"casting-vote-missing");
  const commandId=id();
  assert.equal((await cast(chair,p,"yes",commandId)).status,200);
  assert.equal((await cast(chair,p,"yes",commandId)).status,200,"idempotent replay");
  assert.equal((await cast(chair,p,"no")).body.error,"CASTING_VOTE_ALREADY_RECORDED");
  const {certificate}=(await close(p)).body;
  assert.equal(certificate.outcome.status,"passed");
  assert.equal(certificate.outcome.tie.reason,"casting-vote");
  assert.equal(certificate.outcome.overall.approval.tieBreak,"casting-vote");
  assert.equal((await cast(chair,p,"no")).body.error,"CASTING_VOTE_ALREADY_RECORDED");
});

test("casting-vote rule without a recorded casting vote fails closed; non-ties refuse casting votes",async()=>{
  const chair=await w.member("admin");
  const missing=await tied(()=>({tieRule:"casting-vote",castingPrincipalId:chair.accountId}));
  w.time+=HOUR+1;
  const {certificate}=(await close(missing.p)).body;
  assert.equal(certificate.outcome.status,"failed");assert.equal(certificate.outcome.tie.reason,"casting-vote-missing");
  doc=await w.document();
  const a=await w.member();const p=await w.propose(a,doc);
  await open(p,{tieRule:"casting-vote",castingPrincipalId:chair.accountId});
  await vote(owner,p,"yes");await vote(a,p,"yes");
  w.time+=HOUR+1;
  assert.equal((await cast(chair,p,"no")).body.error,"NOT_A_TIE");
});

test("tie-rule validation: casting principal must be a member, rules stay in their mode",async()=>{
  const a=await w.member();const p=await w.propose(a,doc);
  const outsider=await w.user();
  assert.equal((await open(p,{tieRule:"casting-vote",castingPrincipalId:outsider.accountId})).body.error,"CASTING_PRINCIPAL_NOT_A_MEMBER");
  assert.equal((await open(p,{tieRule:"casting-vote"})).body.error,"INVALID_VOTE_POLICY");
  assert.equal((await open(p,{tieRule:"fails",castingPrincipalId:a.accountId})).body.error,"INVALID_VOTE_POLICY");
  assert.equal((await open(p,{tieRule:"coin-toss"})).body.error,"INVALID_VOTE_POLICY");
  assert.equal((await open(p,{supportFloor:{minimumParticipants:"2",supportNumerator:"1",supportDenominator:"2"}})).body.error,"SUPPORT_FLOOR_REQUIRES_PUBLIC_INPUT");
});

test("open-public support floor: published in the frozen snapshot, advisory result, never adoption",async()=>{
  const frozen=await w.documents.freezeForInput(owner,tenantId,doc.id,{commandId:id(),expectedVersion:1});
  doc=frozen.document;
  const [a,b]=[await w.member(),await w.member()];
  const p=await w.propose(a,doc,"p-public",{baseVersion:2});
  const floor={minimumParticipants:"3",supportNumerator:"2",supportDenominator:"3"};
  assert.equal((await open(p,{tieRule:"fails"})).body.error,"TIE_RULE_REQUIRES_COLLABORATION");
  const opened=await open(p,{supportFloor:floor});
  assert.equal(opened.status,200,JSON.stringify(opened.body));
  assert.match(opened.body.rule.supportFloor,/at least 3 participants/);
  await vote(owner,p,"yes");await vote(a,p,"yes");
  let live=(await call(base(p),{who:owner})).body;
  assert.equal(live.outcome.supportFloor.status,"insufficient-participation");
  await vote(b,p,"no");
  w.time+=HOUR+1;
  const {certificate}=(await close(p)).body;
  assert.equal(certificate.outcome.status,"advisory");
  assert.equal(certificate.outcome.supportFloor.status,"support-floor-met");
  assert.equal(certificate.outcome.supportFloor.advisory,true);
  assert.equal(certificate.canAdopt,false);assert.equal(certificate.appliedVersion,null);
  assert.equal((await w.documents.read(owner,tenantId,doc.id)).version,2);
});

test("published local deadlines resolve to one exact closing instant; DST gaps and overlaps are refused",async()=>{
  const a=await w.member();const p=await w.propose(a,doc);
  const local=new Date(w.time+3*86400000),date=local.toISOString().slice(0,10);
  const openAt=deadline=>call(base(p),{who:owner,method:"POST",body:{commandId:id(),deadline}});
  assert.equal((await openAt({date:"2026-03-08",time:"02:30",timeZone:"America/New_York"})).body.error,"INVALID_DEADLINE");
  assert.equal((await openAt({date,time:"17:00",timeZone:"Mars/Base"})).body.error,"INVALID_DEADLINE");
  assert.equal((await call(base(p),{who:owner,method:"POST",body:{commandId:id(),hours:2,deadline:{date,time:"17:00",timeZone:"UTC"}}})).body.error,"INVALID_VOTE_WINDOW");
  const opened=await openAt({date,time:"17:00",timeZone:"Asia/Kolkata"});
  assert.equal(opened.status,200,JSON.stringify(opened.body));
  assert.equal(opened.body.closesAt,date+"T11:30:00.000Z");
});
