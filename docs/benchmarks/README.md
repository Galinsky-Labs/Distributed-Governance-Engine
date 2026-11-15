# Local workload benchmarks (DCE-034)

Local measurements of the real engine stores against PostgreSQL. They are evidence for the defects fixed on this
branch and a reproducible starting point; they are not production capacity, latency or cost claims.

## Hardware and software (all runs)

Intel Xeon @ 2.10 GHz, 4 logical CPUs, 15.7 GiB RAM, Linux 6.18 x64; Node.js 24.19.0; PostgreSQL 16.15 with default
settings (`shared_buffers` 128 MB, `work_mem` 4 MB, `fsync` and `synchronous_commit` on). The database and the load
generator share the host; there is no network hop, TLS, HTTP socket, reverse proxy or CDN. Runtime pool 32 connections,
client concurrency 32, unprivileged runtime role with row-level security.

## Reproduce

```sh
export PATH=/opt/node24/bin:$PATH
export DGE_TEST_DATABASE_URL=postgresql://postgres:<password>@127.0.0.1:5432/<admin_db>_test   # loopback, *_test only
node --max-old-space-size=8192 scripts/benchmark.mjs --voters=10000 --read-requests=20000 --ledger-events=50000 \
  --label=local-10k-voters-1m-ballots
```

The URL is used only as an administrative connection. Each run creates `dge_bench_<random>_test` and a login role in
`dge_identity_runtime`, applies all migrations, and drops both afterwards (`--keep` keeps them). Every option is
listed with its default in `scripts/benchmark.mjs`; each report repeats the exact flags. `--voters` and
`--bulk-electorate` are capped at 99,999 because a frozen electorate is capped at 100,000 members.

The before run used the same script copied into an export of commit `deb6de9` (`git archive deb6de9`, plus the
`node_modules` symlink), so it measures the old stores with the new harness.

## Runs

| Report | Code | Scale |
|---|---|---|
| `baseline-deb6de9` | before this branch | 2,000 voters; 2 × 2,000-member decisions; 20,000 public reads; 25,412 ledger events |
| `after-fixes-same-scale` | this branch | identical flags |
| `local-10k-voters-1m-ballots` | this branch | 10,000 voters on one hot decision; 1,009,990 ballot rows (10 × 99,999 bulk + hot decision); 20,000 public reads over 2,000 seeded documents; 63,429 ledger events |

## Results

| Measure | Before (2k) | After (2k) | After (10k voters, 1M ballots) |
|---|---:|---:|---:|
| First ballots on one hot decision | 23 /s, p50 1,347 ms, p95 1,724 ms | 744 /s, p50 42 ms, p95 62 ms | 769 /s, p50 40 ms, p95 62 ms, 0 errors |
| Ballot changes (version 1 → 2) | 21 /s, p50 1,390 ms | 794 /s, p50 40 ms | 999 /s, p50 32 ms |
| Participant read of the hot decision after all ballots | p50 490,724 ms | p50 24 ms | p50 231 ms, p95 363 ms (133 /s) |
| Open decision (frozen electorate) | 180 ms (2,001) | 129 ms (2,001) | 510 ms (10,001); median 4,203 ms (100,000) |
| Close + tally (hot decision) | 58,773 ms (2,000 ballots) | 63 ms | 203 ms (10,000 ballots) |
| Close + tally with all rows stored | 53,673 ms (2,000 of 6,000) | 59 ms | 1,773 ms (99,999 of 1,009,990) |
| Ballot table incl. indexes | 1.2 MiB (6,000 rows) | 1.2 MiB | 181 MiB (1,009,990 rows) |
| Ledger sequencing | 83 entries/s | 1,027 entries/s | 914 entries/s (63,429 entries in 69 s) |
| Public reads, mixed (directory, editions, history, proposals, points) | 577 /s, p50 53 ms, p95 91 ms | 1,056 /s, p50 30 ms, p95 45 ms | 862 /s, p50 36 ms, p95 57 ms |
| Public reads per day, extrapolated | 49.9 M | 91.3 M | 74.4 M |

Notes:

- "Reads per day" is the measured requests per second × 86,400 for this mix on this host with no cache in front. It is
  an arithmetic extrapolation, not a 24-hour test. The 10 M reads/day target would need about 116 reads/s sustained;
  the measured local throughput is above that, but real deployments add network, TLS, proxies and competing writes.
- Participant reads of an open hot decision scale with its ballot count (one `GROUP BY` per read): 24 ms at 2,000
  ballots, 231 ms p50 at 10,000 under 32 concurrent readers. A maintained per-decision tally would make them constant.
- The before run overlapped with other local test processes for part of its duration; the algorithmic changes are
  orders of magnitude, but the public-read difference between the 2k runs should be read as indicative. The 2k runs
  sample ledger proofs through a 4-connection administrative pool; the 10k run pre-samples them, so proof latencies are
  not comparable across runs and are omitted here.
- Index effect measured separately with `EXPLAIN ANALYZE` on a 500,000-row copy of `dge_documents.versions`
  (100,000 documents, same columns and indexes): exact-edition lookup 12.46 ms → 0.05 ms, history page 12.12 ms →
  0.03 ms after adding `(document_id, version)`.
- Bulk ballots are inserted directly (`INSERT … SELECT`) into the real `dge_decisions.ballots` table without per-ballot
  events or outbox rows; the hot decision's 10,000 ballots and 200 changes go through `DecisionStore.cast` with real
  sessions. Memberships for benchmark voters are granted directly rather than through invitations.
- Not measured: 100 concurrent draft editors per document (the collaboration hubs cap rooms at 12 clients by default),
  overload/backpressure, queue lag under failure, failover, autovacuum steady state, 24-hour soak.
