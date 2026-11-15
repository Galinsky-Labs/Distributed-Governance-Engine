// DCE-009: editing proposed wording creates a new proposal revision; prior
// ballots never carry over and the superseded proposal cannot be voted on.
import {before,after,beforeEach,test} from "node:test";
import assert from "node:assert/strict";
import {openWorld,id} from "./governance-fixture.mjs";

let w,doc,author;
before(async()=>{w=await openWorld();});
after(async()=>w?.db.close());
beforeEach(async()=>{await w.reset();doc=await w.document();author=await w.member();});
const revise=(who,prior,replacement,extra={})=>w.proposals.create(who,w.tenantId,doc.id,{baseVersion:1,selection:prior.proposal.selection,
  replacement,rationale:"Revised wording.",commandId:id(),disclosure:"publish-proposal-v1",revises:prior.proposal.id,...extra});

test("a revision links both ways, keeps the prior wording immutable and blocks votes on the superseded proposal",async()=>{
  const first=await w.propose(author,doc);
  const second=await revise(author,first,"twice yearly");
  assert.equal(second.revisionOf,first.proposal.id);
  const prior=await w.proposals.read(doc.id,first.proposal.id);
  assert.equal(prior.revisedBy,second.proposal.id);
  assert.equal(prior.proposal.replacement,first.proposal.replacement,"prior wording is unchanged");
  assert.notEqual(prior.digest,second.digest);
  await assert.rejects(w.decisions.open(w.owner,w.tenantId,doc.id,first.proposal.id,{hours:1,commandId:id()}),{code:"PROPOSAL_SUPERSEDED"});
  await assert.rejects(revise(author,first,"monthly"),{code:"PROPOSAL_ALREADY_REVISED"},"history is linear");
  const third=await revise(author,second,"monthly");
  assert.equal((await w.proposals.read(doc.id,second.proposal.id)).revisedBy,third.proposal.id);
  const opened=await w.decisions.open(w.owner,w.tenantId,doc.id,third.proposal.id,{hours:1,commandId:id()});
  assert.equal(opened.proposalDigest,third.digest,"the vote binds the newest wording");
});

test("only the author may revise, and not while the prior wording is under an open or provisional vote",async()=>{
  const first=await w.propose(author,doc);
  const other=await w.member();
  await assert.rejects(revise(other,first,"weekly"),{code:"ONLY_AUTHOR_MAY_REVISE"});
  await w.decisions.open(w.owner,w.tenantId,doc.id,first.proposal.id,{hours:1,commandId:id(),challengeWindowHours:1});
  await w.decisions.cast(w.owner,w.tenantId,doc.id,first.proposal.id,{choice:"yes",expectedVersion:0,commandId:id()});
  await assert.rejects(revise(author,first,"weekly"),{code:"VOTE_IN_PROGRESS"});
  w.time+=3600001;
  await w.decisions.close(w.owner,w.tenantId,doc.id,first.proposal.id);
  await assert.rejects(revise(author,first,"weekly"),{code:"VOTE_IN_PROGRESS"},"provisional finality still blocks");
});

test("ballots never transfer: a revision starts with no ballots and needs its own decision",async()=>{
  const first=await w.propose(author,doc);
  await w.decisions.open(w.owner,w.tenantId,doc.id,first.proposal.id,{hours:1,commandId:id()});
  await w.decisions.cast(w.owner,w.tenantId,doc.id,first.proposal.id,{choice:"yes",expectedVersion:0,commandId:id()});
  await w.decisions.cast(author,w.tenantId,doc.id,first.proposal.id,{choice:"no",expectedVersion:0,commandId:id()});
  w.time+=3600001;
  const {certificate}=await w.decisions.close(w.owner,w.tenantId,doc.id,first.proposal.id);
  assert.equal(certificate.outcome.status,"failed");
  const second=await revise(author,first,"quarterly and publicly");
  await assert.rejects(w.decisions.read(w.owner,w.tenantId,doc.id,second.proposal.id),{code:"DECISION_NOT_FOUND"});
  w.time=Date.now();
  const opened=await w.decisions.open(w.owner,w.tenantId,doc.id,second.proposal.id,{hours:1,commandId:id()});
  assert.equal(Number(opened.outcome.yes),0);
});
