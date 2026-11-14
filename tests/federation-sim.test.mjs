// DCE-037 simulations: Earth authority, Mars mirror and voters over a
// deterministic virtual network with minutes-to-hours delay, partitions,
// loss, duplication and reordering. Each scenario asserts safety properties
// on the protocol objects themselves (signatures, receipts, log proofs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyInclusion, verifyCheckpoint, entryLeafHash } from "../src/transparency.mjs";
import { FEDERATION_SCHEMAS, verifySignedObject, receiptLogEntry, envelopeId, DELAY_CLASSES } from "../src/federation.mjs";
import {
  VirtualClock, Network, SimAuthority, SimMirror, SimVoter, seededRandom, seededSigner, seededHex, marsLightDelay, MINUTE, HOUR,
} from "./support/federation-sim.mjs";

const T0 = Date.UTC(2031, 0, 1);
const DOCUMENT = "6f1d2c3b-4a59-4687-9a0b-1c2d3e4f5a6b", TENANT = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", DECISION = "9b8a7c6d-5e4f-4321-8fed-cba987654321";
const CLOSES = T0 + 2 * HOUR, CUTOFF = CLOSES + DELAY_CLASSES.mars.graceMs;

async function world(seed, { voters = 20, rogue = false } = {}) {
  const random = seededRandom(seed), clock = new VirtualClock(T0), network = new Network(clock, random);
  const earth = network.add(new SimAuthority({ id: "earth.civic.test", signer: await seededSigner(random), clock, documentId: DOCUMENT, tenantId: TENANT }));
  const mars = network.add(new SimMirror({ id: "mars.civic.test", signer: await seededSigner(random), clock }));
  network.link(earth.id, mars.id, { delay: marsLightDelay(T0), jitterMs: 2 * MINUTE, duplicate: 0.2, loss: 0.05 });
  earth.pin(mars, 22 * MINUTE); mars.pin(earth, 22 * MINUTE);
  earth.replicas.push(mars.id);
  await earth.publish("Each settlement shall publish its water budget.");
  await earth.openDecision({ decisionId: DECISION, electorateSize: voters + 4, opensAt: T0, closesAt: CLOSES, delayClass: "mars" });
  const people = [];
  for (let i = 0; i < voters; i++) {
    const voter = network.add(new SimVoter({ id: "voter-" + i, signer: await seededSigner(random), clock, memberId: "member-" + i }));
    voter.binding = await earth.bind(voter.signer, voter.memberId);
    network.link(voter.id, mars.id, { delay: () => 50, jitterMs: 500, duplicate: 0.1 });
    network.link(voter.id, earth.id, { delay: marsLightDelay(T0), jitterMs: MINUTE, duplicate: 0.1 });
    people.push(voter);
  }
  let other = null;
  if (rogue) {
    other = network.add(new SimAuthority({ id: "rogue.civic.test", signer: await seededSigner(random), clock, documentId: DOCUMENT, tenantId: TENANT }));
    network.link(other.id, mars.id, { delay: () => 4 * MINUTE, jitterMs: 0 });
    other.pin(mars, 0); mars.pin(other, 0);
    other.replicas.push(mars.id);
    await other.publish("A competing text for the same document id.");
  }
  const end = T0 + 12 * HOUR;
  clock.every(10 * MINUTE, () => earth.down ? null : earth.checkpoint(), end);
  if (other) clock.every(10 * MINUTE, () => other.checkpoint(), end);
  clock.every(MINUTE, () => { earth.pump(); mars.pump(); other?.pump(); }, end);
  clock.every(10 * MINUTE, () => mars.auditRelays(), end);
  clock.every(10 * MINUTE, () => { for (const node of network.nodes.values()) if (node instanceof SimVoter) node.resubmit(); }, end);
  return { random, clock, network, earth, mars, rogue: other, people };
}
const descriptorOf = (w) => w.earth.descriptor;
const at = (w, time, fn) => w.clock.at(time, fn);
/** Every counted ballot: received by the cutoff, receipted once and proven in the latest signed checkpoint. */
async function assertSafety(w, { lostState = false } = {}) {
  const tally = w.earth.tally(), cp = w.earth.checkpoints.at(-1);
  assert.ok(await verifySignedObject(FEDERATION_SCHEMAS.decision, w.earth.descriptor, w.earth.signer.publicKey));
  // After an authority loses state it can decide an envelope again; that case is asserted to be detected instead.
  if (!lostState) for (const [, count] of w.earth.receiptsSigned) assert.equal(count, 1, "an envelope is decided exactly once despite duplicates");
  const members = new Set();
  for (const [, receipt] of tally) {
    assert.ok(Date.parse(receipt.body.receivedAt) <= Date.parse(w.earth.descriptor.body.cutoffAt), "no ballot after the cutoff is counted");
    const decided = w.earth.decided.get(receipt.body.envelopeId);
    assert.ok(!members.has(decided.memberId), "no member is counted twice");
    members.add(decided.memberId);
    const index = w.earth.leaves.findIndex((l) => l.eventDigest === receipt.body.eventDigest && l.kind === "federated-ballot");
    assert.ok(index >= 0 && index < cp.body.size, "receipt is in the signed log");
    assert.ok(verifyInclusion({ leaf: entryLeafHash(receiptLogEntry(receipt.body)), index, treeSize: cp.body.size, proof: await w.earth.log.inclusion(index, cp.body.size), root: cp.body.rootHash }));
    assert.ok(await verifySignedObject(FEDERATION_SCHEMAS.receipt, receipt, w.earth.signer.publicKey));
  }
  return tally;
}

test("Earth–Mars voting through a mirror survives 3–22 minute light delay, a conjunction blackout, loss, duplicates and reordering", async () => {
  const run = async (seed) => {
    const w = await world(seed, { voters: 24 });
    // A 90-minute blackout spans the close: envelopes wait in the mirror's durable queue.
    w.network.partition(w.earth.id, w.mars.id, T0 + 75 * MINUTE, T0 + 165 * MINUTE);
    const descriptor = descriptorOf(w), voters = w.people;
    for (const [i, voter] of voters.entries()) {
      const castAt = i < 3 ? CLOSES - MINUTE : T0 + Math.floor(w.random() * 110) * MINUTE;
      at(w, castAt, () => voter.cast({ descriptor, binding: voter.binding, choice: ["yes", "no", "abstain"][i % 3], via: w.mars.id, nonce: seededHex(w.random, 16) }));
    }
    // Five voters change their vote (sequence 2); the highest accepted sequence is the one counted.
    for (const voter of voters.slice(3, 8))
      at(w, T0 + 115 * MINUTE, () => voter.cast({ descriptor, binding: voter.binding, choice: "yes", sequence: 2, via: w.mars.id, nonce: seededHex(w.random, 16) }));
    // An honest client after closesAt: its own timestamp is outside the window.
    at(w, CLOSES + 5 * MINUTE, () => voters[8].cast({ descriptor, binding: voters[8].binding, choice: "no", sequence: 2, via: w.mars.id, nonce: seededHex(w.random, 16) }));
    // A direct submission sent just before closing but cut off past the cutoff by an outage on its path.
    const late = w.network.add(new SimVoter({ id: "voter-late", signer: await seededSigner(w.random), clock: w.clock, memberId: "member-late" }));
    late.binding = await w.earth.bind(late.signer, late.memberId);
    w.network.link(late.id, w.earth.id, { delay: marsLightDelay(T0), jitterMs: 0 });
    w.network.partition(late.id, w.earth.id, CLOSES - 10 * MINUTE, CUTOFF + 10 * MINUTE);
    let lateEnvelope;
    at(w, CLOSES - 2 * MINUTE, async () => { lateEnvelope = await late.cast({ descriptor, binding: late.binding, choice: "yes", via: w.earth.id, nonce: seededHex(w.random, 16) }); });
    // Voters poll the mirror for their receipts.
    w.clock.every(15 * MINUTE, () => { for (const v of voters) for (const s of v.sent) w.network.send(v.id, w.mars.id, { kind: "status-query", envelopeId: envelopeId(s.envelope) }); }, T0 + 12 * HOUR);
    await w.clock.runUntil(T0 + 12 * HOUR);
    return { w, late, lateEnvelope };
  };
  const { w, late, lateEnvelope } = await run(7);
  assert.ok(w.network.stats.dropped > 0 && w.network.stats.duplicated > 0 && w.network.stats.reordered > 0, "faults were injected");
  const tally = await assertSafety(w);
  // Liveness under the declared grace: every voter who cast in the window is counted, revisions win.
  assert.equal(tally.size, 24);
  for (const voter of w.people.slice(3, 8)) {
    const counted = tally.get(voter.signer.keyId);
    assert.equal(counted.body.sequence, 2);
    assert.equal(w.earth.decided.get(counted.body.envelopeId).choice, "yes");
  }
  const blackout = [...tally.values()].filter((r) => Date.parse(r.body.receivedAt) > CLOSES);
  assert.ok(blackout.length >= 3, "ballots cast before closing were received during the grace period");
  const outside = [...w.earth.decided.values()].find((d) => d.voterKeyId === w.people[8].signer.keyId && d.sequence === 2);
  assert.equal(outside.receipt.body.reason, "cast-outside-window");
  const lateReceipt = late.receipts.get(envelopeId(lateEnvelope));
  assert.deepEqual([lateReceipt.body.status, lateReceipt.body.reason], ["rejected", "received-after-cutoff"]);
  assert.ok(await verifySignedObject(FEDERATION_SCHEMAS.receipt, lateReceipt, w.earth.signer.publicKey), "the late voter holds a verifiable signed rejection");
  assert.ok(w.earth.leaves.some((l) => l.kind === "federated-rejection" && l.eventDigest === lateReceipt.body.eventDigest), "the rejection is logged");
  assert.ok(!tally.has(late.signer.keyId));
  // Mirrors converge to the authority's checkpoints and hold every receipt they relayed.
  const latest = w.earth.checkpoints.at(-1), seen = w.mars.history.get(w.earth.id).at(-1);
  assert.deepEqual([seen.size, seen.rootHash], [latest.body.size, latest.body.rootHash]);
  assert.equal(w.mars.documents.get(DOCUMENT).body.authority, w.earth.id);
  for (const relay of w.mars.relays.values()) assert.ok(relay.receipt && relay.audit === "included");
  for (const voter of w.people) for (const s of voter.sent) assert.ok(voter.receipts.has(envelopeId(s.envelope)), "voter obtained a receipt through the mirror");
  assert.deepEqual(w.mars.evidence, []);
  // Determinism: the same seed reproduces the same run.
  const again = (await run(7)).w;
  assert.deepEqual(again.network.stats, w.network.stats);
  assert.equal(again.earth.checkpoints.at(-1).body.rootHash, latest.body.rootHash);
});

test("two instances claiming one document: the mirror serves one authority and records the conflict", async () => {
  for (const rogueFirst of [false, true]) {
    const w = await world(11, { voters: 2, rogue: true });
    if (rogueFirst) w.network.partition(w.earth.id, w.mars.id, T0, T0 + 2 * HOUR); else w.network.partition(w.rogue.id, w.mars.id, T0, T0 + 2 * HOUR);
    await w.clock.runUntil(T0 + 6 * HOUR);
    const winner = rogueFirst ? w.rogue.id : w.earth.id, loser = rogueFirst ? w.earth.id : w.rogue.id;
    assert.equal(w.mars.documents.get(DOCUMENT).body.authority, winner, "the first verified claim is binding");
    assert.ok(w.mars.evidence.some((e) => e.kind === "authority-conflict" && e.peer === loser && e.documentId === DOCUMENT));
    assert.ok(!w.mars.evidence.some((e) => e.kind === "authority-conflict" && e.peer === winner));
    // A relayed ballot for the losing authority's decision is not accepted by the mirror.
    const voter = w.people[0];
    const losingDescriptor = (rogueFirst ? w.earth : w.rogue).descriptor ?? w.earth.descriptor;
    if (rogueFirst) {
      await voter.cast({ descriptor: losingDescriptor, binding: voter.binding, choice: "yes", via: w.mars.id, nonce: seededHex(w.random, 16) });
      await w.clock.runUntil(T0 + 6 * HOUR + MINUTE);
      assert.equal(w.mars.relays.size, 0, "the mirror does not relay ballots for a document it attributes to another authority");
    }
  }
});

test("a mirror that withholds receipts is caught by voters who fetch the authority's signed receipt over another path", async () => {
  const w = await world(23, { voters: 6 });
  w.mars.censorReceipts = true;
  const descriptor = descriptorOf(w);
  for (const [i, voter] of w.people.entries())
    at(w, T0 + (10 + i) * MINUTE, () => voter.cast({ descriptor, binding: voter.binding, choice: "yes", via: w.mars.id, nonce: seededHex(w.random, 16) }));
  w.clock.every(15 * MINUTE, () => { for (const v of w.people) for (const s of v.sent) w.network.send(v.id, w.mars.id, { kind: "status-query", envelopeId: envelopeId(s.envelope) }); }, T0 + 4 * HOUR);
  // After an hour with no receipt from the mirror, each voter asks the authority directly.
  at(w, T0 + 90 * MINUTE, () => { for (const v of w.people) for (const s of v.sent) w.network.send(v.id, w.earth.id, { kind: "receipt-query", envelopeId: envelopeId(s.envelope) }); });
  await w.clock.runUntil(T0 + 4 * HOUR);
  const deliveryBound = 2 * 22 * MINUTE + 30 * MINUTE; // one-way Mars delay ×2 plus queue retry allowance
  for (const voter of w.people) {
    const found = voter.checkCensorship(deliveryBound);
    assert.equal(found.length, 1, voter.id + " detects the withheld receipt");
    assert.ok(await verifySignedObject(FEDERATION_SCHEMAS.relayStatus, found[0].statement, w.mars.signer.publicKey), "the mirror's denial is signed evidence");
    assert.equal(found[0].receipt.body.status, "accepted");
  }
  const tally = await assertSafety(w);
  assert.equal(tally.size, 6, "censoring receipts does not stop the ballots from counting");
  // An honest mirror, same schedule: nothing is flagged.
  const honest = await world(23, { voters: 6 });
  for (const [i, voter] of honest.people.entries())
    at(honest, T0 + (10 + i) * MINUTE, () => voter.cast({ descriptor: descriptorOf(honest), binding: voter.binding, choice: "yes", via: honest.mars.id, nonce: seededHex(honest.random, 16) }));
  honest.clock.every(15 * MINUTE, () => { for (const v of honest.people) for (const s of v.sent) honest.network.send(v.id, honest.mars.id, { kind: "status-query", envelopeId: envelopeId(s.envelope) }); }, T0 + 4 * HOUR);
  await honest.clock.runUntil(T0 + 4 * HOUR);
  for (const voter of honest.people) assert.deepEqual(voter.checkCensorship(deliveryBound), []);
});

test("an authority restored from an old backup is caught: split view, conflicting receipts and omission", async () => {
  const w = await world(31, { voters: 10 });
  const descriptor = descriptorOf(w);
  const cast = (voter, minute, via) => at(w, T0 + minute * MINUTE, () => voter.cast({ descriptor, binding: voter.binding, choice: "yes", via, nonce: seededHex(w.random, 16) }));
  w.people.slice(0, 4).forEach((v, i) => cast(v, 5 + i, w.mars.id));
  let backup;
  at(w, T0 + 50 * MINUTE, () => { backup = w.earth.backup(); });
  w.people.slice(4, 7).forEach((v, i) => cast(v, 55 + i, w.mars.id));
  cast(w.people[7], 56, w.earth.id); // direct: only the voter holds this receipt
  at(w, T0 + 100 * MINUTE, () => { w.earth.down = true; });
  at(w, T0 + 110 * MINUTE, async () => { await w.earth.restore(backup); w.earth.down = false; });
  w.people.slice(8, 10).forEach((v, i) => cast(v, 112 + i, w.mars.id));
  at(w, T0 + 5 * HOUR, () => w.people[7].audit(w.earth.id, envelopeId(w.people[7].sent[0].envelope)));
  await w.clock.runUntil(T0 + 8 * HOUR);
  const kinds = new Set(w.mars.evidence.map((e) => e.kind));
  assert.ok(kinds.has("split-view"), "the mirror detects that the authority's new history is inconsistent with checkpoints it verified");
  const split = w.mars.evidence.find((e) => e.kind === "split-view");
  assert.ok(await verifyCheckpoint(split.checkpoint, w.earth.signer.publicKey), "evidence carries the authority's own signed checkpoint");
  assert.ok(kinds.has("conflicting-receipts"), "re-decided envelopes produced a second, different signed receipt");
  assert.equal(w.people[7].audits.get(envelopeId(w.people[7].sent[0].envelope)), "omitted", "the direct voter proves its receipted ballot vanished from the log");
  const seen = w.mars.history.get(w.earth.id);
  assert.ok(seen.at(-1).size <= w.earth.checkpoints.at(-1).body.size && seen.at(-1).rootHash !== w.earth.checkpoints.at(-1).body.rootHash,
    "the mirror refuses to follow the forked history");
  await assertSafety(w, { lostState: true });
  const redecided = [...w.earth.receiptsSigned].filter(([, n]) => n > 1).map(([id]) => id);
  assert.ok(redecided.length > 0);
  for (const id of redecided) assert.ok(w.mars.evidence.some((e) => e.kind === "conflicting-receipts" && e.envelopeId === id), "every second decision of an envelope is caught");
});

test("a mirror that loses all state rebuilds from the authority's retained queue, chained by consistency proofs", async () => {
  const w = await world(43, { voters: 4 });
  const descriptor = descriptorOf(w);
  w.people.forEach((v, i) => at(w, T0 + (5 + 20 * i) * MINUTE, () => v.cast({ descriptor, binding: v.binding, choice: "no", via: w.mars.id, nonce: seededHex(w.random, 16) })));
  at(w, T0 + 70 * MINUTE, () => { w.mars.wipe(); w.mars.pin(w.earth, 22 * MINUTE); });
  await w.clock.runUntil(T0 + 9 * HOUR);
  const latest = w.earth.checkpoints.at(-1), rebuilt = w.mars.history.get(w.earth.id);
  assert.deepEqual([rebuilt.at(-1).size, rebuilt.at(-1).rootHash], [latest.body.size, latest.body.rootHash]);
  assert.ok(rebuilt.length > 3, "the rebuilt view replays the checkpoint chain, not just the newest checkpoint");
  assert.equal(w.mars.documents.get(DOCUMENT).body.authority, w.earth.id);
  assert.deepEqual(w.mars.evidence, []);
  const tally = await assertSafety(w);
  assert.equal(tally.size, 4, "ballots relayed before and after the mirror's loss are all counted once");
});
