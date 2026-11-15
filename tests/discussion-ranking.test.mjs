// DCE-016: confidence ranking with explained sorts, and the anti-ring bound on
// one account's ratings of a single author's points.
import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {openWorld} from "./governance-fixture.mjs";
import {createDiscussionStore,RANKING_EXPLANATIONS} from "../server/discussion-store.mjs";

let w;
before(async()=>{w=await openWorld();await w.reset();});
after(async()=>w?.db.close());
const point=(store,who,doc,proposalId,text,position="support")=>store.create(who,w.tenantId,doc.id,proposalId,{position,text,commandId:randomUUID(),disclosure:"publish-point-v1"});
const rate=(store,who,doc,proposalId,pointId,value,expectedVoteVersion=0)=>store.vote(who,w.tenantId,doc.id,proposalId,pointId,{value,expectedVoteVersion,commandId:randomUUID()});

test("confidence ranking orders by the Wilson lower bound, explains itself and pages stably",async()=>{
  const store=w.discussion,doc=await w.document(),author=await w.member();
  const {proposal}=await w.propose(author,doc);
  const raters=[];for(let i=0;i<6;i++)raters.push(await w.member());
  const few=await point(store,author,doc,proposal.id,"One enthusiastic rating.");
  const many=await point(store,author,doc,proposal.id,"Five of six raters agree.");
  const split=await point(store,author,doc,proposal.id,"Opinion is evenly split.");
  await rate(store,raters[0],doc,proposal.id,few.point.id,1);
  for(let i=0;i<6;i++)await rate(store,raters[i],doc,proposal.id,many.point.id,i<5?1:-1);
  for(let i=0;i<4;i++)await rate(store,raters[i],doc,proposal.id,split.point.id,i<2?1:-1);
  const top=await store.list(doc.id,proposal.id,{sort:"top"});
  assert.equal(top.items[0].point.id,many.point.id);
  assert.equal(top.ranking,RANKING_EXPLANATIONS.top);
  const confidence=await store.list(doc.id,proposal.id,{sort:"confidence"});
  assert.deepEqual(confidence.items.map(i=>i.point.id),[many.point.id,few.point.id,split.point.id]);
  assert.match(confidence.ranking,/Wilson/);
  assert.match(confidence.ranking,/never change any decision ballot/);
  const [a,b,c]=confidence.items.map(i=>i.confidence);
  assert.ok(a>b&&b>c&&c>=0&&a<1,"bounded, explained scores: "+[a,b,c]);
  assert.ok(Math.abs(a-0.4365)<0.001,"5 of 6 → Wilson lower bound ≈ 0.4365, got "+a);
  for(const item of confidence.items)assert.equal(typeof item.up,"number");
  const first=await store.list(doc.id,proposal.id,{sort:"confidence",limit:1});
  const second=await store.list(doc.id,proposal.id,{sort:"confidence",limit:1,after:first.nextCursor});
  assert.equal(second.items[0].point.id,few.point.id);
  await assert.rejects(store.list(doc.id,proposal.id,{sort:"top",after:first.nextCursor}),{code:"INVALID_POINT_CURSOR"});
});

test("anti-ring bound: one account's active ratings on a single author's points are capped; withdrawal always works",async()=>{
  const store=createDiscussionStore({identity:w.identity,transaction:w.transaction,clock:()=>w.time,maxVotesPerAuthor:2});
  const doc=await w.document(),author=await w.member(),other=await w.member(),ring=await w.member();
  const {proposal}=await w.propose(author,doc);
  const mine=[];for(let i=0;i<3;i++)mine.push(await point(store,author,doc,proposal.id,"Author point "+i));
  const theirs=await point(store,other,doc,proposal.id,"Another author");
  await rate(store,ring,doc,proposal.id,mine[0].point.id,1);
  await rate(store,ring,doc,proposal.id,mine[1].point.id,-1);
  await assert.rejects(rate(store,ring,doc,proposal.id,mine[2].point.id,1),{code:"AUTHOR_RATING_LIMIT_REACHED"});
  await rate(store,ring,doc,proposal.id,theirs.point.id,1);
  await rate(store,ring,doc,proposal.id,mine[0].point.id,0,1);
  await rate(store,ring,doc,proposal.id,mine[2].point.id,1);
  // Changing an existing rating is not a new rating and is never blocked by the bound.
  await rate(store,ring,doc,proposal.id,mine[1].point.id,1,1);
});
