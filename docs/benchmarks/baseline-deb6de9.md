# Benchmark run `baseline-deb6de9`

Local measurement with the real engine stores against PostgreSQL. Not a production capacity claim.

## Command

```sh
DGE_TEST_DATABASE_URL=postgresql://postgres:…@127.0.0.1:5432/<admin>_test node scripts/benchmark.mjs --voters=2000 --concurrency=32 --pool=32 --bulk-electorate=2000 --bulk-decisions=2 --public-tenants=20 --documents-per-tenant=100 --proposals=200 --points=1000 --read-requests=20000 --decision-reads=10 --ledger-events=20000 --label=baseline-deb6de9
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
| First ballots, one hot decision (2000 voters) | 2,000 | 0 | 23.29 | 1347.19 | 1724.2 | 1851.98 |
| Ballot changes (expectedVersion 1) | 200 | 0 | 21.33 | 1389.82 | 2146.65 | 2198.17 |
| Participant decision reads after all ballots | 10 | 0 | 0.02 | 490724.19 | 546138.64 | 546138.64 |
| Public reads, mixed | 20,000 | 0 | 577.39 | 52.92 | 90.6 | 125.85 |
|   public directory | 3,334 | 0 | 96.23 | 50.54 | 82.98 | 118.84 |
|   public documentCurrent | 3,334 | 0 | 96.23 | 49.02 | 84.48 | 118.47 |
|   public documentEdition | 3,333 | 0 | 96.2 | 48.43 | 81.49 | 109.68 |
|   public history | 3,333 | 0 | 96.2 | 61.02 | 99.18 | 136.48 |
|   public proposals | 3,333 | 0 | 96.2 | 61.37 | 98.6 | 135.65 |
|   public points | 3,333 | 0 | 96.2 | 52.3 | 88.13 | 121.44 |
| Ledger inclusion proofs | 500 | 0 | 243.99 | 123.58 | 235.9 | 315.28 |

- Hot decision open (frozen electorate 2001): 179.56 ms; close + tally of 2000 ballots: 58,773.37 ms.
- Ballot storage: 6,000 ballot rows (2 decisions × 2,000 electors), 1.2 MiB including indexes; bulk load 63.49 ms.
- Opening a decision with a 2,000-member frozen electorate: median 117.99 ms.
- Real close + tally of one decision with 2,000 ballots while 6,000 rows are stored: 53,673.43 ms; reading another decision: 55,152.56 ms.
- Bulk method: Ballot rows are inserted with INSERT … SELECT into dge_decisions.ballots (real table, constraints, indexes, foreign keys); no per-ballot event/outbox rows are created for the bulk rows. Opening and closing use DecisionStore.open/close unchanged.
- Ledger: sequenced 25,412 pending events in 305,946.93 ms (83.06 entries/s); signed checkpoint over 25412 leaves in 8.76 ms.
- Public reads extrapolated: 49,886,496 reads/day (throughputPerSecond × 86,400 on this single host with no CDN; assumes the measured mix and sustained load, which was not run for 24 hours.).

## Limits of this measurement

- Single host; load generator and database compete for the same CPUs. No network latency, TLS, reverse proxy or CDN.
- Voter memberships and bulk ballot rows are inserted directly by the administrative connection; every cast, read, open and close goes through the real store with the unprivileged runtime role and row-level security.
- Short runs: no 24-hour soak, no failover, no overload/backpressure test, no autovacuum steady state.
- Started 2026-11-14T23:14:34.421Z, finished 2026-11-14T23:34:05.507Z.
