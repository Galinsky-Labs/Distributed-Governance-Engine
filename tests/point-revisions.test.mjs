// DCE-015: editable point history (revisions as new points), duplicate merges
// by owners/admins, and ratings that never transfer.
import {before,after,beforeEach,test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {openWorld} from "./governance-fixture.mjs";

let w,doc,author,proposalId,raters;
before(async()=>{w=await openWorld();});
after(async()=>w?.db.close());
beforeEach(async()=>{await w.reset();doc=await w.document();author=await w.member();proposalId=(await w.propose(author,doc)).proposal.id;raters=[await w.member(),await w.member()];});
const point=(who,text,extra={})=>w.discussion.create(who,w.tenantId,doc.id,proposalId,{position:"support",text,commandId:randomUUID(),disclosure:"publish-point-v1",...extra});
const rate=(who,pointId,value,expectedVoteVersion=0)=>w.discussion.vote(who,w.tenantId,doc.id,proposalId,pointId,{value,expectedVoteVersion,commandId:randomUUID()});
const ids=async()=>(await w.discussion.list(doc.id,proposalId,{sort:"new"})).items.map(i=>i.point.id);

test("an author revises a point: the listing shows only the current wording and the history keeps every version",async()=>{
  const first=await point(author,"Quarterly reports improve oversight.");
  await rate(raters[0],first.point.id,1);
  const second=await point(author,"Quarterly public reports improve oversight.",{revises:first.point.id});
  assert.deepEqual(await ids(),[second.point.id]);
  const history=await w.discussion.history(doc.id,proposalId,second.point.id);
  assert.deepEqual(history.items.map(i=>i.point.id),[first.point.id,second.point.id]);
  assert.equal(history.items[0].supersededBy.kind,"revision");
  assert.equal(history.items[0].up,1);assert.equal(history.items[1].up,0,"ratings never transfer");
  assert.equal(history.items[0].point.text,"Quarterly reports improve oversight.","old wording is immutable");
  await assert.rejects(rate(raters[1],first.point.id,1),{code:"POINT_SUPERSEDED"});
  await rate(raters[0],first.point.id,0,1);
  await assert.rejects(point(author,"Third try.",{revises:first.point.id}),{code:"POINT_ALREADY_SUPERSEDED"});
  await assert.rejects(point(raters[0],"Not mine.",{revises:second.point.id}),{code:"ONLY_AUTHOR_MAY_REVISE"});
  await assert.rejects(point(author,"Changed stance.",{revises:second.point.id,position:"oppose"}),{code:"REVISION_MUST_KEEP_STANCE"});
});

test("owners merge duplicates of the same stance; merged points leave the ranking but stay in history",async()=>{
  const a=await point(author,"Reports should be public.");
  const b=await point(raters[0],"Reports must be published.");
  const opposed=await w.discussion.create(raters[1],w.tenantId,doc.id,proposalId,{position:"oppose",text:"Costs too much.",commandId:randomUUID(),disclosure:"publish-point-v1"});
  const merge=(who,pointId,duplicateOf,commandId=randomUUID())=>w.discussion.mergeDuplicate(who,w.tenantId,doc.id,proposalId,pointId,{duplicateOf,commandId});
  await assert.rejects(merge(author,b.point.id,a.point.id),{code:"ACCESS_DENIED"});
  await assert.rejects(merge(w.owner,opposed.point.id,a.point.id),{code:"DUPLICATE_MUST_SHARE_STANCE"});
  assert.deepEqual(await merge(w.owner,b.point.id,a.point.id),{pointId:b.point.id,mergedInto:a.point.id});
  assert.deepEqual(await merge(w.owner,b.point.id,a.point.id),{pointId:b.point.id,mergedInto:a.point.id},"idempotent");
  await assert.rejects(merge(w.owner,a.point.id,b.point.id),{code:"MERGE_TARGET_SUPERSEDED"});
  assert.deepEqual((await ids()).sort(),[a.point.id,opposed.point.id].sort());
  const history=await w.discussion.history(doc.id,proposalId,b.point.id);
  assert.equal(history.items[0].supersededBy.kind,"duplicate");
  assert.equal(history.items[0].supersededBy.pointId,a.point.id);
});
