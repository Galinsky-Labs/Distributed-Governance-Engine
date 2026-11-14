# Benchmark run `local-10k-voters-1m-ballots`

Local measurement with the real engine stores against PostgreSQL. Not a production capacity claim.

## Command

```sh
DGE_TEST_DATABASE_URL=postgresql://postgres:…@127.0.0.1:5432/<admin>_test node scripts/benchmark.mjs --voters=10000 --concurrency=32 --pool=32 --bulk-electorate=99999 --bulk-decisions=10 --public-tenants=20 --documents-per-tenant=100 --proposals=200 --points=1000 --read-requests=20000 --decision-reads=200 --ledger-events=50000 --label=local-10k-voters-1m-ballots
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
| First ballots, one hot decision (10000 voters) | 10,000 | 0 | 768.99 | 39.76 | 62.21 | 76.97 |
| Ballot changes (expectedVersion 1) | 200 | 0 | 998.61 | 31.65 | 41.6 | 44.07 |
| Participant decision reads after all ballots | 200 | 0 | 132.94 | 231.18 | 362.83 | 415.79 |
| Public reads, mixed | 20,000 | 0 | 861.62 | 35.88 | 57.02 | 68.77 |
|   public directory | 3,334 | 0 | 143.6 | 34.01 | 53.84 | 63.97 |
|   public documentCurrent | 3,334 | 0 | 143.6 | 31.99 | 49.65 | 61.24 |
|   public documentEdition | 3,333 | 0 | 143.56 | 31.33 | 48.79 | 60.53 |
|   public history | 3,333 | 0 | 143.56 | 40.1 | 59.67 | 71.08 |
|   public proposals | 3,333 | 0 | 143.56 | 40.43 | 61.14 | 73.02 |
|   public points | 3,333 | 0 | 143.56 | 38.99 | 61.02 | 72.31 |
| Ledger inclusion proofs | 500 | 0 | 303.21 | 99.48 | 167.78 | 203.44 |

- Hot decision open (frozen electorate 10001): 510.4 ms; close + tally of 10000 ballots: 203.12 ms.
- Ballot storage: 1,009,990 ballot rows (10 decisions × 99,999 electors), 181.0 MiB including indexes; bulk load 14,302.06 ms.
- Opening a decision with a 99,999-member frozen electorate: median 4,203.47 ms.
- Real close + tally of one decision with 99,999 ballots while 1,009,990 rows are stored: 1,772.63 ms; reading another decision: 107.02 ms.
- Bulk method: Ballot rows are inserted with INSERT … SELECT into dge_decisions.ballots (real table, constraints, indexes, foreign keys); no per-ballot event/outbox rows are created for the bulk rows. Opening and closing use DecisionStore.open/close unchanged.
- Ledger: sequenced 63,429 pending events in 69,367.58 ms (914.39 entries/s); signed checkpoint over 63429 leaves in 7.21 ms.
- Public reads extrapolated: 74,443,968 reads/day (throughputPerSecond × 86,400 on this single host with no CDN; assumes the measured mix and sustained load, which was not run for 24 hours.).

## Limits of this measurement

- Single host; load generator and database compete for the same CPUs. No network latency, TLS, reverse proxy or CDN.
- Voter memberships and bulk ballot rows are inserted directly by the administrative connection; every cast, read, open and close goes through the real store with the unprivileged runtime role and row-level security.
- Short runs: no 24-hour soak, no failover, no overload/backpressure test, no autovacuum steady state.
- Started 2026-11-14T23:44:18.812Z, finished 2026-11-14T23:47:32.270Z.
