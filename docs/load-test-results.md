# Isolated single-node load test (mock backend)

Generated 2026-11-21T03:38:10.464Z by `scripts/load-test.ts` against server 0.3.0. **This is single-node mock evidence on a developer machine, not a production capacity claim.** See [scale-design.md](scale-design.md) for the production design.

- Machine: Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz, 32 logical cores, 127.9 GiB RAM, win32 10.0.26300, Node v24.22.2. Load client and server ran on the same machine.
- Dataset (isolated throwaway SQLite database, never the shared demo): 100004 patients in 66525 families with one patient-app token each, 50 load doctors, 39827 earlier visits with 79654 signed handwritten documents and 119481 deliveries, 278837 feed events. Database 908 MiB; seeding took 136.5 s and server start 3.8 s.
- Limits: Production mobile limits were active (no --relaxed-limits): 600 requests/minute per token. The load client and server shared one machine.
- Integrity: 250 bundles completed 250 visits and created 750 documents (expected 750); replays created no duplicates.

| Scenario | Requests | Concurrency | Requests/s | p50 ms | p95 ms | p99 ms | HTTP statuses |
|---|---:|---:|---:|---:|---:|---:|---|
| Patient notifications, first poll (200) | 5000 | 50 | 386.4 | 124.6 | 161.9 | 197.6 | 200: 5000 |
| Patient notifications, background re-poll (304) | 20000 | 100 | 1617.2 | 58.5 | 86.6 | 102.4 | 304: 20000 |
| Patient profile feed page (limit 100) | 5000 | 50 | 711.1 | 60.6 | 120.6 | 163.4 | 200: 5000 |
| Patient profile record (signed URLs) | 5000 | 50 | 298.2 | 162.2 | 251 | 325 | 200: 5000 |
| Patient blob read (bearer, page PNG or PDF) | 3000 | 50 | 409.9 | 124.5 | 180.9 | 310.3 | 200: 3000 |
| Doctor queue (35 entries, returning flags) | 1000 | 20 | 114.9 | 168.2 | 213.8 | 284.9 | 200: 1000 |
| Doctor visit completion, 50 doctors at once (3 documents each) | 50 | 50 | 49.6 | 572.5 | 985.9 | 1000.6 | 201: 50 |
| Doctor visit completion, remaining 200 bundles with patient polling in parallel | 200 | 50 | 41.3 | 1198.4 | 1302.1 | 1360.4 | 201: 200 |
| Patient 304 re-polls during the completion burst | 10000 | 100 | 528.8 | 161.3 | 291.6 | 1263.2 | 200: 23, 304: 9977 |
| Completion replay with the same Idempotency-Key | 250 | 50 | 1294.2 | 34.7 | 49.3 | 52.1 | 201: 250 |

Reading the numbers: background polling is dominated by the 304 path, which re-runs the authorization and feed query but sends no body. Blob reads come from SQLite in this mock; production serves immutable blobs from object storage through a CDN. Completion latency includes the atomic write of documents, deliveries, events and the idempotency record in one SQLite transaction.
