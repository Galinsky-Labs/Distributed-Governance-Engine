# Benchmark run `after-fixes-same-scale`

Local measurement with the real engine stores against PostgreSQL. Not a production capacity claim.

## Command

```sh
DGE_TEST_DATABASE_URL=postgresql://postgres:…@127.0.0.1:5432/<admin>_test node scripts/benchmark.mjs --voters=2000 --concurrency=32 --pool=32 --bulk-electorate=2000 --bulk-decisions=2 --public-tenants=20 --documents-per-tenant=100 --proposals=200 --points=1000 --read-requests=20000 --decision-reads=10 --ledger-events=20000 --label=after-fixes-same-scale
```

## Hardware and software

- CPU: Intel(R) Xeon(R) Processor @ 2.10GHz × 4 logical CPUs
- Memory: 15.7 GiB
- OS: Linux 6.18.44-fc-v470 x64
- Node.js v24.19.0; PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1) (fsync=on, max_connections=100, shared_buffers=16384 8kB, synchronous_commit=on, work_mem=4096 kB)
- PostgreSQL and the Node.js load generator share the same host; no network hop, no TLS, no HTTP socket.
- Runtime pool: 32 connections; client concurrency: 32

## Results

| Operation | Count | Errors | Ops/s | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|
| First ballots, one hot decision (2000 voters) | 2,000 | 0 | 744.24 | 41.65 | 62.34 | 72.39 |
| Ballot changes (expectedVersion 1) | 200 | 0 | 794.06 | 39.94 | 53.38 | 59.81 |
| Participant decision reads after all ballots | 10 | 0 | 386.24 | 23.56 | 25.47 | 25.47 |
| Public reads, mixed | 20,000 | 0 | 1056.48 | 29.58 | 45.27 | 53.72 |
|   public directory | 3,334 | 0 | 176.06 | 27.74 | 42.35 | 50.63 |
|   public documentCurrent | 3,334 | 0 | 176.06 | 26.33 | 38.32 | 47.38 |
|   public documentEdition | 3,333 | 0 | 176.01 | 25.97 | 38.17 | 45.84 |
|   public history | 3,333 | 0 | 176.01 | 32.74 | 47.32 | 57.18 |
|   public proposals | 3,333 | 0 | 176.01 | 33.06 | 47.16 | 55.34 |
|   public points | 3,333 | 0 | 176.01 | 32.76 | 49.57 | 55.65 |
| Ledger inclusion proofs | 500 | 0 | 235.69 | 129.71 | 199.19 | 306.89 |

- Hot decision open (frozen electorate 2001): 129.2 ms; close + tally of 2000 ballots: 62.81 ms.
- Ballot storage: 6,000 ballot rows (2 decisions × 2,000 electors), 1.2 MiB including indexes; bulk load 54.84 ms.
- Opening a decision with a 2,000-member frozen electorate: median 97.32 ms.
- Real close + tally of one decision with 2,000 ballots while 6,000 rows are stored: 58.59 ms; reading another decision: 8.95 ms.
- Bulk method: Ballot rows are inserted with INSERT … SELECT into dge_decisions.ballots (real table, constraints, indexes, foreign keys); no per-ballot event/outbox rows are created for the bulk rows. Opening and closing use DecisionStore.open/close unchanged.
- Ledger: sequenced 25,413 pending events in 24,733.38 ms (1027.48 entries/s); signed checkpoint over 25413 leaves in 5.19 ms.
- Public reads extrapolated: 91,279,872 reads/day (throughputPerSecond × 86,400 on this single host with no CDN; assumes the measured mix and sustained load, which was not run for 24 hours.).

## Limits of this measurement

- Single host; load generator and database compete for the same CPUs. No network latency, TLS, reverse proxy or CDN.
- Voter memberships and bulk ballot rows are inserted directly by the administrative connection; every cast, read, open and close goes through the real store with the unprivileged runtime role and row-level security.
- Short runs: no 24-hour soak, no failover, no overload/backpressure test, no autovacuum steady state.
- Started 2026-11-14T23:40:24.911Z, finished 2026-11-14T23:41:29.469Z.
