import {before,after,beforeEach,test} from "node:test";
import assert from "node:assert/strict";
import {openWorld,id} from "./governance-fixture.mjs";
import {REMOVED_PLACEHOLDER} from "../server/moderation-store.mjs";

let w,tenantId,owner,doc,author,proposal,pointRecord;
before(async()=>{w=await openWorld();});
after(async()=>w?.db.close());
async function setup(options){
  await w.reset(options);({tenantId,owner}=w);doc=await w.document();
  author=await w.member();
  proposal=await w.propose(author,doc);
  pointRecord=await w.discussion.create(author,tenantId,doc.id,proposal.proposal.id,{position:"support",
    text:"Quarterly meetings improve oversight.",commandId:id(),disclosure:"publish-point-v1"});
}
beforeEach(()=>setup());
const outcome=promise=>promise.then(()=>"ok",error=>error.code);
const report=(who,targetKind,targetId,reasonCategory="spam",extra={})=>w.moderation.report(who,tenantId,{targetKind,targetId,reasonCategory,commandId:id(),...extra});
const act=(who,targetKind,targetId,action,reasonCategory,expectedVersion)=>w.moderation.act(who,tenantId,{targetKind,targetId,action,reasonCategory,expectedVersion,commandId:id()});

test("hide and restore are visible placeholders in public reads; ballots, scores and decisions are untouched",async()=>{
  const reporter=await w.member();
  await w.decisions.open(owner,tenantId,doc.id,proposal.proposal.id,{hours:1,commandId:id()});
  await w.decisions.cast(reporter,tenantId,doc.id,proposal.proposal.id,{choice:"yes",expectedVersion:0,commandId:id()});
  await w.discussion.vote(reporter,tenantId,doc.id,proposal.proposal.id,pointRecord.point.id,{value:1,expectedVoteVersion:0,commandId:id()});
  await report(reporter,"point",pointRecord.point.id,"harassment",{note:"<script>alert(1)</script> insulting"});
  await report(reporter,"proposal",proposal.proposal.id,"off-topic");
  const queue=await w.moderation.queue(owner,tenantId);
  assert.equal(queue.items.length,2);
  assert.ok(!JSON.stringify(queue).includes(reporter.accountId),"reporter identities never reach the queue");
  assert.equal(queue.items.find(i=>i.targetKind==="point").notes[0].note,"<script>alert(1)</script> insulting","notes are inert text for moderators");
  const hidden=await act(owner,"point",pointRecord.point.id,"hide","harassment",0);
  w.time+=1;
  await act(owner,"proposal",proposal.proposal.id,"hide","off-topic",0);
  w.time+=1;
  const points=await w.discussion.list(doc.id,proposal.proposal.id);
  assert.equal(points.items.length,1,"a hidden point is never silently deleted");
  assert.equal(points.items[0].point.text,REMOVED_PLACEHOLDER);
  assert.deepEqual(points.items[0].moderation,{state:"removed",placeholder:REMOVED_PLACEHOLDER,reasonCategory:"harassment"});
  assert.equal(points.items[0].up,1,"point scores survive moderation");
  const publicProposal=await w.proposals.read(doc.id,proposal.proposal.id);
  assert.equal(publicProposal.proposal.replacement,REMOVED_PLACEHOLDER);
  assert.equal(publicProposal.digest,proposal.digest);
  assert.equal(publicProposal.moderation.reasonCategory,"off-topic");
  const listed=await w.proposals.list(doc.id);
  assert.equal(listed.items[0].moderation.state,"removed");
  const publicText=JSON.stringify(points)+JSON.stringify(listed);
  assert.ok(!publicText.includes("Quarterly meetings improve oversight.")&&!publicText.includes("Test rationale."));
  assert.ok(!publicText.includes("<script>"),"report notes never reach public reads");
  const decision=await w.decisions.read(owner,tenantId,doc.id,proposal.proposal.id);
  assert.equal(decision.outcome.yes,"1","ballots are untouched by moderation");
  assert.equal(await outcome(act(owner,"point",pointRecord.point.id,"hide","spam",1)),"ALREADY_HIDDEN");
  assert.equal(await outcome(act(owner,"point",pointRecord.point.id,"restore","review-reversed",0)),"MODERATION_VERSION_CONFLICT");
  assert.equal(await outcome(act(owner,"point",pointRecord.point.id,"restore","spam",1)),"INVALID_MODERATION_ACTION");
  await act(owner,"point",pointRecord.point.id,"restore","review-reversed",hidden.version);
  assert.equal((await w.discussion.list(doc.id,proposal.proposal.id)).items[0].point.text,"Quarterly meetings improve oversight.");
  const log=await (await w.call(`/api/public/documents/${doc.id}/moderation`)).json();
  assert.deepEqual(log.items.map(i=>i.action),["hide","hide","restore"]);
  assert.ok(!JSON.stringify(log).includes(owner.accountId),"the public log never names moderators");
  const ledger=(await w.db.query("SELECT kind,finalization FROM dge_ledger.outbox WHERE kind='moderation-action'")).rows;
  assert.equal(ledger.length,3);assert.ok(ledger.every(e=>e.finalization===false));
  await assert.rejects(w.db.query("UPDATE dge_moderation.actions SET reason_category='spam'"),/append-only/);
  assert.equal((await w.db.query("SELECT count(*)::int n FROM dge_discussion.points")).rows[0].n,1);
});

test("rate budgets, duplicate reports and replayed commands",async()=>{
  await setup({moderation:{maxReportsPerHour:2,maxReportsPerDay:3}});
  const flooder=await w.member("viewer");
  const extra=[];
  for(let i=0;i<3;i++)extra.push(await w.discussion.create(author,tenantId,doc.id,proposal.proposal.id,{position:"oppose",
    text:"Extra point "+i,commandId:id(),disclosure:"publish-point-v1"}));
  const commandId=id();
  const first=await w.moderation.report(flooder,tenantId,{targetKind:"point",targetId:pointRecord.point.id,reasonCategory:"spam",commandId});
  assert.deepEqual(await w.moderation.report(flooder,tenantId,{targetKind:"point",targetId:pointRecord.point.id,reasonCategory:"spam",commandId}),first);
  assert.equal(await outcome(w.moderation.report(flooder,tenantId,{targetKind:"point",targetId:pointRecord.point.id,reasonCategory:"other",commandId})),"COMMAND_REUSED");
  assert.equal(await outcome(report(flooder,"point",pointRecord.point.id)),"ALREADY_REPORTED");
  await report(flooder,"point",extra[0].point.id);
  assert.equal(await outcome(report(flooder,"point",extra[1].point.id)),"REPORT_RATE_LIMITED");
  w.time+=3600001;
  await report(flooder,"point",extra[1].point.id);
  w.time+=3600001;
  assert.equal(await outcome(report(flooder,"point",extra[2].point.id)),"REPORT_RATE_LIMITED","daily budget");
  const response=await w.call(`/api/workspaces/${tenantId}/reports`,{who:flooder,method:"POST",
    body:{targetKind:"point",targetId:extra[2].point.id,reasonCategory:"spam",commandId:id()}});
  assert.equal(response.status,429);
  assert.equal(await outcome(report(flooder,"point",extra[2].point.id,"rumour")),"INVALID_REPORT");
});

test("appeals: only the author appeals, an independent manager decides, and restoration is audited",async()=>{
  const admin=await w.member("admin"),reporter=await w.member();
  await report(reporter,"point",pointRecord.point.id,"spam");
  const hidden=await act(owner,"point",pointRecord.point.id,"hide","spam",0);
  const notices=await w.moderation.mine(author,tenantId);
  assert.equal(notices.items[0].reasonCategory,"spam");assert.equal(notices.items[0].appeal,null);
  assert.equal(await outcome(w.moderation.appeal(reporter,tenantId,{actionId:hidden.actionId,statement:"Not mine.",commandId:id()})),"ONLY_AUTHOR_MAY_APPEAL");
  const appeal=await w.moderation.appeal(author,tenantId,{actionId:hidden.actionId,statement:"This is on-topic evidence.",commandId:id()});
  assert.equal(await outcome(w.moderation.appeal(author,tenantId,{actionId:hidden.actionId,statement:"Again.",commandId:id()})),"APPEAL_EXISTS");
  assert.equal((await w.moderation.queue(owner,tenantId)).appeals.length,1);
  assert.equal(await outcome(w.moderation.resolveAppeal(owner,tenantId,appeal.id,{decision:"grant",commandId:id()})),"APPEAL_REVIEWER_CONFLICT");
  assert.equal(await outcome(w.moderation.resolveAppeal(reporter,tenantId,appeal.id,{decision:"grant",commandId:id()})),"ACCESS_DENIED");
  const granted=await w.moderation.resolveAppeal(admin,tenantId,appeal.id,{decision:"grant",note:"Restored on review.",commandId:id()});
  assert.equal(granted.status,"granted");
  assert.deepEqual(await w.moderation.resolveAppeal(admin,tenantId,appeal.id,{decision:"grant",commandId:id()}).then(r=>r.status),"granted");
  assert.equal(await outcome(w.moderation.resolveAppeal(admin,tenantId,appeal.id,{decision:"deny",commandId:id()})),"APPEAL_ALREADY_RESOLVED");
  assert.equal((await w.discussion.list(doc.id,proposal.proposal.id)).items[0].point.text,"Quarterly meetings improve oversight.");
  const log=(await w.moderation.publicLog(doc.id)).items;
  assert.deepEqual(log.map(i=>[i.action,i.reasonCategory]),[["hide","spam"],["restore","appeal-granted"]]);
  const kinds=(await w.db.query("SELECT kind FROM dge_moderation.events ORDER BY occurred_at,kind")).rows.map(r=>r.kind).sort();
  assert.deepEqual(kinds,["appeal-granted","appealed","hidden","reported","restored"]);
  // A denied appeal keeps the item hidden.
  const again=await act(admin,"point",pointRecord.point.id,"hide","spam",2);
  const second=await w.moderation.appeal(author,tenantId,{actionId:again.actionId,statement:"Please reconsider.",commandId:id()});
  await w.moderation.resolveAppeal(owner,tenantId,second.id,{decision:"deny",commandId:id()});
  assert.equal((await w.discussion.list(doc.id,proposal.proposal.id)).items[0].point.text,REMOVED_PLACEHOLDER);
  assert.equal((await w.moderation.mine(author,tenantId)).items[0].appeal.status,"denied");
});

test("coordinated flagging is surfaced to moderators and never acts on its own",async()=>{
  const fresh=[await w.member(),await w.member(),await w.member()];
  for(const who of fresh)await report(who,"proposal",proposal.proposal.id,"spam");
  let item=(await w.moderation.queue(owner,tenantId)).items[0];
  assert.equal(item.coordinatedFlagging.flagged,true);
  assert.equal(item.coordinatedFlagging.recentAccountReports,3);
  assert.equal(item.coordinatedFlagging.automaticAction,false);
  assert.equal(item.hidden,false,"no automatic hiding");
  assert.equal((await w.proposals.read(doc.id,proposal.proposal.id)).moderation,undefined);
  // The same volume from long-standing members is not a coordination signal.
  await setup();
  const veterans=[await w.member(),await w.member(),await w.member()];
  await w.db.query("UPDATE dge_identity.events SET occurred_at=occurred_at-interval '60 days' WHERE kind='joined'");
  for(const who of veterans)await report(who,"proposal",proposal.proposal.id,"spam");
  item=(await w.moderation.queue(owner,tenantId)).items[0];
  assert.equal(item.coordinatedFlagging.flagged,false);
  assert.equal(item.openReports,3);
});

test("moderator privilege escalation and cross-tenant canaries",async()=>{
  const editor=await w.member("editor"),participant=await w.member();
  for(const who of [editor,participant,author]){
    assert.equal(await outcome(w.moderation.queue(who,tenantId)),"ACCESS_DENIED");
    assert.equal(await outcome(act(who,"point",pointRecord.point.id,"hide","spam",0)),"ACCESS_DENIED");
  }
  const forged=await w.call(`/api/workspaces/${tenantId}/moderation/actions`,{who:participant,method:"POST",
    body:{targetKind:"point",targetId:pointRecord.point.id,action:"hide",reasonCategory:"spam",expectedVersion:0,commandId:id()}});
  assert.equal(forged.status,403);
  const outsider=await w.user();
  const {tenantId:other}=await w.identity.createTenant(outsider);
  assert.equal(await outcome(w.moderation.report(outsider,other,{targetKind:"point",targetId:pointRecord.point.id,reasonCategory:"spam",commandId:id()})),
    "MODERATION_TARGET_NOT_FOUND");
  assert.equal(await outcome(w.moderation.report(outsider,tenantId,{targetKind:"point",targetId:pointRecord.point.id,reasonCategory:"spam",commandId:id()})),"ACCESS_DENIED");
  await w.transaction(async tx=>{
    for(const table of ["reports","actions","appeals","events"])
      assert.equal((await tx.query(`SELECT * FROM dge_moderation.${table}`)).rows.length,0);
  });
});
