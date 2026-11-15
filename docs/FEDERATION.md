# Federation and delayed-network protocol (DCE-037)

Status: designed, implemented and locally tested on branch `feature/federation-scale`. Not deployed, not run between real
instances over a real network, not independently reviewed. Federation is optional; a single instance needs none of it.

Code: `src/federation.mjs` (pure, browser-safe protocol), `server/federation-store.mjs` (PostgreSQL persistence and the
worker), `server/federation-http.mjs` (routes and platform extension), `migrations/028-federation.sql` (schema
`dge_federation`). Tests: `tests/federation-store.test.mjs` (two real instances), `tests/federation-sim.test.mjs` with
`tests/support/federation-sim.mjs` (deterministic interplanetary simulation). Mounting: `docs/INTEGRATION-federation.md`.

## What this protocol does not claim

There is no global or instantaneous consensus anywhere. Each document has one authority instance that orders its
editions and ballots alone, in the order it receives them. Other instances mirror signed snapshots read-only and relay
envelopes; they never decide. A ballot is final when, and only when, the authority received it before the disclosed
cutoff and issued a signed receipt that its transparency log includes. A participant on another planet learns that
fact minutes to hours later; the cutoff rule exists so that this delay is disclosed in advance rather than hidden.

## Identity, peers and keys

- An instance is identified by its transparency log identity (`logId`, e.g. `civic.alpha.example`) and the Ed25519 log
  key that signs its checkpoints. The same key signs federation objects. `GET /api/federation/instance` publishes both.
- Peers are registered by a platform operator (`POST /api/federation/peers`, platform-admin session) with their
  instance id, exact HTTPS origin, public key and declared maximum one-way delay. There is no discovery and no
  trust-on-first-contact: an unregistered instance is ignored. A registered peer can be suspended.
- Key rotation: a rotation record names the next key and is signed by the currently pinned key (authorization) and by
  the next key (proof of possession). Peers follow it only if the pinned key signed it and its sequence is newer; old
  keys stay valid for signatures inside their validity window. A lost or compromised key needs an operator re-pin.
- Peer-to-peer requests (`POST /api/federation/inbox`) are authenticated only by an Ed25519 signature over method,
  path, timestamp, a random nonce and the SHA-256 of the body. The freshness window is the clock-skew allowance (5 min)
  plus that peer's declared one-way delay, because a request from a light-minutes-away peer is legitimately old on
  arrival. Nonces are single-use. Session cookies are never accepted on these endpoints.

## Authority and finality domain

A workspace owner/admin claims the document for this instance (`POST /api/workspaces/:t/documents/:d/federation`
with `replicas: [peer ids]`). The signed claim `{documentId, authority, visibility, claimedAt}` is logged
(`federated-authority`). A mirror binds a document to the first verified claim it accepts; any different instance
claiming the same document afterwards is rejected and recorded as `authority-conflict` evidence (with both claims). A
database trigger refuses to create a local document whose id is owned by a remote authority, so a mirror cannot start
accepting writes for it. Authority transfer is not implemented: it would need a handoff signed by the old authority and
an operator decision on every mirror.

## Delay classes and the disclosed cutoff

Before any ballot is cast, a manager federates an open decision
(`POST …/proposals/:p/decision/federation` with `delayClass`). The authority signs and logs (`federated-decision`,
finalization) a descriptor binding the decision's snapshot, proposal, policy and electorate digests, the electorate
size, `opensAt`, `closesAt`, the delay class and `cutoffAt = closesAt + graceMs`. Finality rules never change mid-vote:
federating is refused once a ballot exists or after `closesAt`.

| Class | Grace after `closesAt` | Declared max one-way delay |
|---|---|---|
| `terrestrial` | 5 min | 2 s |
| `cislunar` | 15 min | 2 s |
| `mars` | 3 h | 22 min |
| custom `{id, graceMs, maxOneWayDelayMs}` | ≤ 7 days, must cover the delay | operator-declared |

The grace is transit time, not a second voting window. Inside the grace the authority cannot tell an honest delayed
envelope from one signed after `closesAt` with an earlier client timestamp, so classes should be no longer than the
path needs, and running tallies should not be disclosed to remote participants before the cutoff. Closing a federated
decision before its cutoff is refused by the federation route (409 `FEDERATED_CUTOFF_PENDING`) and by a database
trigger on `dge_decisions.decisions`, whichever path issues the close.

## Participant keys and ballot envelopes

A member of the frozen electorate binds a device key for the decision (`POST …/decision/federation/keys`, session
auth). The authority signs a binding `{decisionId, descriptorDigest, voterKeyId, publicKey, generation, boundAt}` and
logs only a digest of it (`federated-key-binding`). A new binding supersedes the previous generation.

The device signs envelopes locally: `{authority, decisionId, descriptorDigest, voterKeyId, sequence, choice, castAt,
nonce}`; the envelope id is the SHA-256 of the signed bytes. Envelopes are submitted to `POST /api/federation/ballots`
on the authority or on any mirror; the envelope signature and the authority-signed binding are the authentication.

The authority's rule (`judgeEnvelope`), applied in receive order under the decision's shared lock and a per-voter lock:

1. Same envelope id already decided → return the original receipt (idempotent duplicate).
2. Received after `cutoffAt` → rejected `received-after-cutoff`.
3. Binding generation superseded → rejected. Client `castAt` outside `[opensAt, closesAt)` → rejected
   `cast-outside-window`; more than 2 min in the authority's future → rejected.
4. Same sequence already accepted for this key → rejected `sequence-equivocation`; a higher sequence already accepted →
   rejected `superseded-sequence`.
5. Otherwise accepted: the member's row in `dge_decisions.ballots` is upserted (so the ordinary close/tally path counts
   it once, by member), a decision event is written, and the receipt is logged.

Every decision, accepted or rejected, produces a receipt signed by the authority's log key:
`{authority, decisionId, envelopeId, voterKeyId, sequence, status, reason, receivedAt, cutoffAt, eventDigest}`.
`eventDigest = digest("federated-receipt-event-v1", {authority, decisionId, envelopeId, status})` is logged as
`federated-ballot` or `federated-rejection`, so a voter can find it in the log knowing only the envelope id.

Envelopes are signed, not encrypted: a relaying mirror sees the choice. Sealed ballots are not implemented.

## Signed portable snapshots and mirrors

Authorities queue, per replica peer, a snapshot bundle signed with the log key:
`{authority, documentId, sequence, issuedAt, claim, edition, decisions, checkpoint, evidence}`. `edition` is the full
public edition (document, digest, previous digest, version, time, restoration) or, for private documents, only a
ciphertext reference `{version, ciphertextDigest, ciphertextUri, byteLength}`; plaintext of private documents never
leaves the authority. `decisions` carries each signed descriptor (which commits to the electorate by digest and size,
never by roster), the frozen voting policy (checked against the descriptor's policy digest and validated) and the
certificate digest once closed. `evidence` holds RFC 6962 inclusion proofs of the edition event against `checkpoint`.

A mirror verifies the bundle signature with the pinned key, the claim against the claim it already holds, the
checkpoint signature, that the checkpoint is one it already verified (otherwise the bundle waits), the edition digest
and its inclusion proof, and every descriptor signature. Accepted bundles are served by
`GET /api/federation/documents/:id` as `{authority, servedBy, readOnly: true, verifiedAt, bundle}`.

## Checkpoints, split views and omission

Checkpoints travel on a dedicated ordered channel per authority (`LOG_CHANNEL`), each with an RFC 6962 consistency
proof from the previous checkpoint sent to that peer. A mirror records a checkpoint only if it is consistent with the
newest one it verified; if the proof starts elsewhere it sends a `sync-request` and the authority answers with a proof
from the mirror's size. A checkpoint of a known size with a different root, or a proof that fails, is recorded as
`split-view` evidence containing both signed checkpoints, and the mirror keeps its old view.

A receipt is a promise to log within the maximum merge delay (default 1 h on servers, 10 min in simulations). A mirror
audits each receipt it relayed against the authority's public proof endpoint once a checkpoint newer than
`receivedAt + maxMergeDelay` exists: included, or `omission` evidence. A conflicting second signed receipt for the same
envelope is `conflicting-receipts` evidence. A message that reuses a channel sequence with different content is
`sender-equivocation` evidence; if it is a checkpoint or receipt its content is still checked, since it can prove a
fork. Evidence is public at `GET /api/federation/evidence` and append-only.

Mirrors sign their relay status statements (`receipt-available` / `awaiting-authority`). A voter who obtains the
authority's receipt over another path and holds a mirror statement still denying it later than the path's declared
delivery bound has signed proof of receipt censorship (`receiptWithheld`). Inside the bound, a missing receipt is
indistinguishable from delay, so detection never fires early.

## Store-and-forward queues

Every inter-instance message is signed by the sender: `{from, to, documentId, sequence, type, payload, createdAt}`;
its id is the SHA-256 of the signed bytes, so retries are idempotent. Types: `checkpoint`, `sync-request`, `snapshot`,
`ballot`, `receipt`. Ordering is per (sender, document) channel: messages apply strictly in sequence; later ones are
stored and wait for the gap (up to 1,000 ahead); duplicates are acknowledged and dropped. The sender keeps every
message in `dge_federation.outbox` and retries unacknowledged ones with exponential backoff (2 s doubling, capped at
6 h, jitter derived from the message id). The inbox reply reports, per channel, the highest contiguous sequence stored;
a recipient restored from backup reports a lower one and the sender resends everything after it, in order. A mirror
that loses all state is rebuilt the same way, replaying the checkpoint chain with its consistency proofs.

## Simulation results (tests/federation-sim.test.mjs)

Deterministic: virtual clock, seeded PRNG, seeded Ed25519 keys; the same seed reproduces the same run (asserted).
Network faults: Earth–Mars one-way light delay varying 3–22 min, up to 2 min jitter (reordering), 5 % loss, 20 %
duplication on the interplanetary link, partitions.

| Scenario | Faults | Asserted |
|---|---|---|
| Voting through a Mars mirror | 90-minute blackout spanning `closesAt`, loss, duplicates, reordering; vote revisions; a client voting after `closesAt`; a direct envelope cut off past the cutoff | every envelope decided exactly once; nothing received after the cutoff counted; each member counted once with the highest sequence; every counted receipt proven in the latest signed checkpoint; all 24 in-window voters counted (≥ 3 received during the grace); late and out-of-window envelopes get signed, logged rejections; mirror converges to the authority's latest checkpoint and audits every relayed receipt as included; no evidence |
| Conflicting authorities | either claimant reaches the mirror first | the first verified claim is served; the other is `authority-conflict` evidence; ballots for the losing claimant's decision are not relayed |
| Receipt censorship | mirror withholds receipts | each voter proves withholding with the mirror's signed statement and the authority's receipt fetched directly; ballots still count; an honest mirror on the same schedule triggers nothing |
| Authority disaster | restore from a 50-minute-old backup, then continue | mirror records `split-view` with the authority's signed checkpoint and refuses the fork; every envelope decided twice is caught as `conflicting-receipts`; a directly-submitting voter proves `omitted` |
| Mirror disaster | mirror loses all state mid-vote | rebuilt from the authority's retained queue through the chained checkpoints; converges with no evidence; all ballots counted once |

## Data disclosed to peers and the public

| Object | Who receives it | Contents |
|---|---|---|
| Snapshot of a public document | registered mirrors, then anyone reading the mirror | the public edition (already public), signed descriptors, frozen policy, digests, checkpoint, inclusion proofs |
| Snapshot of a private document | registered mirrors only (the public `GET /api/federation/documents/:id` answers 404 for it on every instance) | version, ciphertext digest, size and a URL on the authority (which contains the tenant id); no plaintext, no key material |
| Descriptor | public | decision, document and digests; electorate size; window; delay class; cutoff. No member identities |
| Key binding | the participant; its digest in the public log | voter key id and public key for one decision (pseudonymous; the authority keeps the member mapping in `key_bindings`) |
| Envelope | the authority and any relaying mirror | voter key id and the choice in the clear (signed, not encrypted) |
| Receipt | the voter, relaying mirror; its event digest in the public log | envelope id, voter key id, sequence, status, reason, times |
| Evidence | public | signed objects that prove misbehaviour (checkpoints, claims, receipts) |

`security/data-inventory.json` has not been updated for these records in this branch (only new files could be added
besides the migration list); that must happen before deployment.

## Limitations

- Simulated and two-instance in-process tests only; no real interplanetary transport, DTN bundle layer or relay
  satellites. HTTPS needs round trips that are impractical at light-minute distances: across such links the same
  signed messages must be carried by a store-and-forward bundle relay, which is not part of this repository.
- First-claim-wins is a liveness and safety trade-off: a registered peer that squats a document id first is served
  until operators intervene; the conflict is always recorded.
- Envelopes are signed, not encrypted; relays see choices. Receipt censorship is detected only by voters who use an
  independent path. The authority itself can delay receipts within the merge delay without detection.
- After an authority loses data it can decide an envelope twice; this is detected (conflicting receipts, split view,
  omission) but not prevented, and recovery is an operator process.
- The server worker audits only receipts it relayed; it does not gossip checkpoints between mirrors, so a split view
  shown consistently to one mirror only is detectable only by comparing mirrors' evidence or witnesses.
- Messages and decided envelopes are retained indefinitely; no compaction or retention policy yet.
- Weighting is equal (one member, one ballot) as in the existing decision store.
