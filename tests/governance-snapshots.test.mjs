import test from "node:test";
import assert from "node:assert/strict";
import { digest } from "../src/integrity.mjs";
import {
  createGovernanceSnapshot, validateGovernanceSnapshot,
  ballotForGovernanceSnapshot, evaluateGovernanceSnapshot,
} from "../src/governance-snapshots.mjs";
import { policy, electorate, proposal } from "./fixtures.mjs";
import { proposalDigest } from "../src/documents.mjs";

function original(overrides = {}) {
  return {
    id: "decision-1", tenantId: "tenant-1", documentId: "document-1",
    mode: "collaboration", proposalDigest: proposalDigest(proposal),
    policy: structuredClone(policy), electorate: structuredClone(electorate),
    createdAt: 900, ...overrides,
  };
}
const make = overrides => createGovernanceSnapshot(original(overrides));
test("policy and electorate are immutable, exact and digest-bound", () => {
  const input = original(), before = structuredClone(input);
  const snapshot = createGovernanceSnapshot(input);
  assert.equal(snapshot.policyDigest, digest("policy", policy));
  assert.equal(snapshot.electorateDigest, digest("electorate", electorate));
  assert.deepEqual(validateGovernanceSnapshot(structuredClone(snapshot)), snapshot);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.policy.quorum));
  assert.ok(Object.isFrozen(snapshot.electorate.members[0]));
  input.policy.minYes = "99";
  input.electorate.members[0].weight = "99";
  assert.notDeepEqual(input, before);
  assert.equal(snapshot.policy.minYes, "1");
  assert.equal(snapshot.electorate.members[0].weight, "1");
});
test("eligible votes remain bound to exact snapshot and cannot supply weight", () => {
  const snapshot = make(), yes = ballotForGovernanceSnapshot(snapshot, "alice", "yes", 1500);
  const no = ballotForGovernanceSnapshot(snapshot, "bob", "no", 1500);
  const abstain = ballotForGovernanceSnapshot(snapshot, "chris", "abstain", 1500);
  assert.equal(evaluateGovernanceSnapshot(snapshot, [yes, no, abstain], 2000).status, "failed");
  assert.throws(() => ballotForGovernanceSnapshot(snapshot, "intruder", "yes", 1500));
  assert.throws(() => ballotForGovernanceSnapshot(snapshot, "alice", "yes", 2000));
  assert.throws(() => evaluateGovernanceSnapshot(snapshot, [{...yes, weight: "1000"}], 2000));
  assert.throws(() => evaluateGovernanceSnapshot(snapshot, [yes, yes], 2000));
  assert.throws(() => evaluateGovernanceSnapshot(snapshot, [yes], 1400));
});
test("changed policy, electorate, or source cannot reuse stale bindings", () => {
  const snapshot = make();
  for (const patch of [
    {policy: {...snapshot.policy, minYes: "2"}},
    {electorate: {...snapshot.electorate, members: snapshot.electorate.members.slice(0,2)}},
    {proposalDigest: "0".repeat(64)},
    {mode: "public-input"},
  ]) assert.throws(() => validateGovernanceSnapshot({...snapshot, ...patch}), /modified/);
  assert.throws(() => validateGovernanceSnapshot({...snapshot, injected: true}));
});
test("public-input is always advisory, never a decision that adopts language", () => {
  const snapshot = make({mode: "public-input"});
  const votes = ["alice","bob","chris"].map(id => ballotForGovernanceSnapshot(snapshot,id,"yes",1500));
  const outcome = evaluateGovernanceSnapshot(snapshot,votes,2000);
  assert.equal(outcome.status,"advisory");
  assert.equal(outcome.canAdopt,false);
  assert.equal(outcome.approvalMet,null);
});
test("weighted corporate electorate preserves exact integer voting units", () => {
  const weights = [
    {principalId:"a", weight:"9007199254740993"},
    {principalId:"b", weight:"9007199254740992"},
  ];
  const snapshot = make({
    policy: {...policy,weighting:"shares",quorum:{kind:"fraction-weight",numerator:"1",denominator:"1"}},
    electorate: {id:"shareholders-1",kind:"frozen",members:weights},
  });
  const ballots = [
    ballotForGovernanceSnapshot(snapshot,"a","yes",1500),
    ballotForGovernanceSnapshot(snapshot,"b","no",1500),
  ];
  const outcome = evaluateGovernanceSnapshot(snapshot,ballots,2000);
  assert.equal(outcome.weights.eligible,"18014398509481985");
  assert.equal(outcome.status,"passed");
  assert.throws(() => make({electorate:{id:"bad",kind:"frozen",members:[{principalId:"a",weight:"2"}]}}));
});
