# Public participation scale and hot-document partitioning (DCE-034)

Status: locally measured on one host and partially implemented. The numbers below are local measurements with the
real stores against PostgreSQL 16 on the hardware stated in each report; they are not production capacity, cost or
availability claims. The staged targets in `docs/ARCHITECTURE.md` (100 editors per document, 10,000 active voters on a
hot bill, 1 million ballot records, 10 million public reads per day) remain targets to verify on real deployments.

Reports: `docs/benchmarks/` (`README.md` summarizes; JSON + Markdown per run). Benchmark: `scripts/benchmark.mjs`.

## Scaling defects found and fixed

All before/after figures come from `scripts/benchmark.mjs` at the same flags (`--voters=2000 --decision-reads=10
--bulk-electorate=2000 --bulk-decisions=2 --read-requests=20000 --ledger-events=20000`) on the same host: "before" is
commit `deb6de9` (`docs/benchmarks/baseline-deb6de9.*`), "after" is this branch
(`docs/benchmarks/after-fixes-same-scale.*`). The before run overlapped with other local test processes for part of its
duration, so small differences (public reads) are indicative; the large ones are algorithmic.

| Hot path | Defect | Fix | Before | After |
|---|---|---|---|---|
| Decision close / tally (`server/decision-store.mjs`) | `ballotForGovernanceSnapshot` re-validated (deep-copied, canonicalized and re-hashed) the whole frozen electorate for every ballot: O(electorate × ballots) | validate the snapshot once per digest and bind ballots against it with the same checks; then run the unchanged reference evaluator | close of 2,000 ballots: 58,773 ms (1,000 ballots: 12,267 ms) | 63 ms (1,000: 22 ms) |
| Decision read | every read loaded every ballot and re-ran the quadratic evaluation | open decisions report equal-weight running counts from one `GROUP BY` and the caller's own row; closed ones report the certificate's evaluator outcome | p50 490,724 ms per read (10 reads, 2,000 ballots, 32 concurrent) | p50 24 ms |
| Ballot casting | every tenant write held the tenant row `FOR UPDATE`, and every ballot held the decision row `FOR UPDATE` and re-validated the snapshot: a hot decision was fully serialized | opt-in `sharedTenantLock` for ballots (membership changes still lock exclusively and still exclude in-flight ballots); decision row `FOR SHARE` for ballots, `FOR UPDATE` for close; per-voter `pg_advisory_xact_lock` keeps one voter's replays and version races serialized; validated-snapshot cache | 23 ballots/s, p50 1,347 ms, p95 1,724 ms | 744 ballots/s, p50 42 ms, p95 62 ms |
| Ledger sequencing (`server/ledger.mjs`) | write-back compared `key::text = $n`, which cannot use the outbox primary keys: one sequential scan of the source table per sequenced entry; and the pending union sorted the whole backlog per batch | compare typed columns (`key = $n::uuid`); each source contributes at most one batch, ordered identically | 83 entries/s (25,412 pending) | 1,027 entries/s |
| Public edition/history/proposal reads | indexes all lead with `tenant_id`, public reads have none: full index scans across all tenants | migration 028: `versions(document_id,version)`, `proposals(document_id,id)`, `points(document_id,proposal_id,parent_id)`, `decisions(document_id,proposal_id)` | exact-edition lookup on a 500,000-row copy of `versions` (100,000 documents): 12.46 ms, full PK index scan | 0.05 ms, index scan (history page: 12.12 ms → 0.03 ms) |
| Ballot storage | `dge_decision_ballots_lookup (tenant_id,decision_id)` duplicated the primary-key prefix | dropped in migration 028 | (not separately measured) | one fewer index to maintain per ballot |

The `points` index is only chosen when a table holds points of many proposals; in the benchmark one proposal holds all
points, so the planner correctly keeps a sequential scan there.

Correctness is preserved: all pre-existing tests pass unchanged, including the concurrent duplicate-command and
version-conflict ballot tests and the membership-change fence; the reference evaluator is still the only tally used for
closure and the certificate.

## Authoritative finality stays serialized

- One decision row is the serialization point: ballots take it shared, closure takes it exclusively, so a close sees
  every committed ballot and no ballot commits after it. Federated decisions add a database trigger that refuses to
  close before the disclosed cutoff (`docs/FEDERATION.md`).
- Each document has a single authoritative edition sequence (`documents.version` under the row lock), unchanged.
- The transparency log has one sequencer (`dge_ledger.head FOR UPDATE`); it is a background worker, never on the
  request path.

## Partitioning strategy for ballots and claims

Ballots, ballot events, points, point votes and outbox rows are always addressed by `(tenant_id, document_id or
decision_id, …)`, and no request reads across decisions. That makes them partitionable without changing the access
pattern:

1. Now (implemented): per-decision concurrency (shared locks, per-voter advisory locks), indexes that start with the
   document or decision, and one aggregate per read instead of whole-roster loads.
2. Next (planned, not implemented): PostgreSQL declarative partitioning `PARTITION BY HASH (tenant_id, decision_id)` for
   `dge_decisions.ballots` and `events`, and `PARTITION BY HASH (tenant_id, document_id)` for `dge_discussion.points`,
   `votes` and `vote_events`. The primary keys already contain the partition keys. Migration plan: expand (create the
   partitioned table and a trigger that dual-writes), backfill in batches, verify counts and digests per decision,
   switch reads, contract. Closed decisions' partitions can move to cheaper storage.
3. Later: a hot decision is a natural single-writer shard. Federation already models one authority per document; a
   regional voting shard is an instance that is the authority for that document, with mirrors for reads.

## Edge caching of immutable public editions

Implemented in a new file (`server/public-edition-cache-http.mjs`, mounted as a platform extension, see
`docs/INTEGRATION-federation.md`): `GET /api/public/documents/:id?version=N` returns the same body as the document
route with `Cache-Control: public, max-age=31536000, immutable` and `ETag: "<edition digest>"`, and answers
`If-None-Match` with 304. Editions are append-only and digest-bound, so the cache can never serve a different text
under the same URL. Everything that changes stays `no-store`: unversioned current reads, history, directory,
proposals, points, decisions and ledger checkpoints. A missing edition (404) is not cached. `anchorStatus` in the
edition body is a constant placeholder; anchor state must be read from the ledger endpoints, not the cached edition.
If moderation or legal takedown of a published edition is ever added (migration 022 is a reserved slot), CDN purge by
surrogate key must ship with it, because `immutable` forbids revalidation.

Recommended CDN rules (not deployed): cache only `GET` with a `version` query, key on the full URL, ignore cookies,
never cache responses carrying `Set-Cookie`. Offline verification packages are also per-version and could take the
same policy after review.

## Bounded rooms

There is no all-participants WebSocket room. Real-time rooms exist only for editing drafts, per document version:
`attachPublicCollaborationHub` defaults to 32 rooms and 12 clients per room (configurable up to 100 each), admits only
authenticated workspace editors of a draft and closes the room when the version changes; the private hub has the same
bounds. Readers, voters and discussion participants use request/response reads with cursor pagination
(directory 30, proposals 20, points 10 per page, all capped at 100), so public traffic never fans out through a socket.

## Asynchronous projections

- Ledger sequencing, checkpoints and anchoring run in the ledger worker from transactional outboxes.
- Federation export, delivery, inbox application and receipt audits run in the federation worker.
- Decision reads use a projection (running counts or the certificate outcome) instead of re-evaluating; closure is
  the only place the full evaluation runs.
- Planned: per-decision tally rows maintained from ballot events for very large electorates, and a materialized public
  directory, both rebuilt from the authoritative tables and verified by digest.

## Remaining limits

- A frozen electorate is capped at 100,000 members (engine invariant). Opening a decision with 100,000 members builds
  and hashes a multi-megabyte snapshot with the pure-JavaScript SHA-256: median 4.2 s locally. Closing one with 99,999
  ballots while 1,009,990 ballot rows are stored takes 1.8 s; reading an open hot decision costs one aggregate over its
  ballots (p50 231 ms at 10,000 ballots under 32 concurrent readers) until per-decision tally rows exist.
- Every ballot still writes one ballot row, one event, one outbox row and later one ledger entry; ledger sequencing
  (about 1,000 entries/s locally) bounds sustained ballot throughput per instance unless sequencing is batched further.
- Measurements are single-host, no network, TLS, proxy or CDN; no 24-hour soak, overload, failover or autovacuum
  steady-state test; the load generator shares the CPUs with PostgreSQL.
