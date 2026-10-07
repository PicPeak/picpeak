# Public upload admission limits

Gallery guest uploads and PicTransfer file-request uploads have authoritative server limits, including when Express is reached directly. Reverse-proxy body limits remain defense in depth. The raw multipart body (files, skipped parts, fields and framing) is metered while streaming; neither a missing Content-Length nor chunked encoding bypasses it. The default request ceiling is **95 MiB**. `general_max_upload_batch_size_mb` can lower it, but cannot raise the operator ceiling.

## Default allowances

These are finite **lifetime public-upload admission allowances**. Accepted originals remain charged after row deletion, hiding, guest erasure, ownership reassignment, token rotation or archival. They are intentionally not renewed by deleting catalogue entries: deletion can fail, and a reusable public capability must not regenerate unlimited storage or worker traffic. Current catalogue originals and archives without a ledger charge also count toward the gallery/account/deployment limits; reference-only external NAS originals are excluded. Historical objects with no catalogue metadata cannot be reconstructed from these counters. New public promotions are always recorded before the write, including unreferenced or uncertain objects.

| Scope | Original bytes | Files | Pending bytes | Pending files | Concurrent requests | Bytes/hour | Requests/hour |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Gallery | 5 GiB | 2,000 | 512 MiB | 100 | 2 | 1 GiB | 120 |
| Guest | 1 GiB | 500 | 256 MiB | 50 | 2 | 256 MiB | 120 |
| File request | 2 GiB | 500 | 256 MiB | 50 | 2 | 512 MiB | 120 |
| Account | 50 GiB | 20,000 | 1 GiB | 500 | 4 | 2 GiB | 600 |
| Deployment | 200 GiB | 100,000 | 2 GiB | 1,000 | 8 | 4 GiB | 1,200 |

The effective request ceiling/count is also reduced to available lifetime, pending and hourly capacity. Pending capacity is divided fairly between configured simultaneous requests, so one small request cannot reserve every pending slot. With defaults a guest request accepts at most 25 files, while the existing lower per-file, count and type settings still apply. Normal anonymous uploads remain supported in one shared anonymous bucket per gallery; ownerless legacy galleries/requests share a charged legacy account bucket. Guest identity creation cannot bypass the gallery, account or deployment allowance.

Pending gallery charges are released only after successful processing returns, not on age, failure or a janitor reset. Transfer files are never media jobs. Admission reserves the full bounded body before accepting it, then atomically replaces reservations with actual object/row charges. Failed settled writes are compensated; failed cleanup or uncertain remote writes remain charged. This prevents retries from turning database/storage outages into unbounded orphan growth.

The hourly byte budget includes the raw body of failed or rejected requests. Active requests reserve their prospective ingress; completed requests charge actual received bytes. An independent hourly request-count ceiling also charges empty/rejected requests, preventing the accounting ledger itself from growing without bound. Every body also has a five-minute deadline (operator overrides cannot exceed one hour).

## Operator configuration

Set `PUBLIC_UPLOAD_LIMITS_JSON` in the backend process environment and restart/recreate it. It is an operator-only JSON object; settings-edit permissions cannot disable these limits. Omitted keys retain the defaults. Unknown keys, zero, negative, fractional or unsafe values fail closed; there is no unlimited/disabled value. Sizes are integer **bytes**, counts are positive integers, and `requestTimeoutMs` is milliseconds.

For example, to admit 200-MiB bodies and a 10-GiB gallery lifetime allowance:

```dotenv
PUBLIC_UPLOAD_LIMITS_JSON={"requestBytes":209715200,"gallery":{"bytes":10737418240}}
```

Available top-level scalars: `requestBytes`, `requestTimeoutMs`, `headroomBytes` (default 512 MiB), `headroomPercent` (default 5), `headroomFiles` (default 1,024 free inodes). Each of `gallery`, `guest`, `transfer`, `account`, `deployment` accepts `bytes`, `files`, `pendingBytes`, `pendingFiles`, `requests`, `hourBytes`, `hourRequests`. Larger body settings still require sufficient guest/account/deployment pending and hourly capacity and matching proxy limits.

Low-storage admission requires measurable byte/inode capacity and leaves the greater of absolute/percentage byte headroom plus absolute inode headroom. Local storage reserves room for staging plus promotion, with a second check on the actual destination mount immediately before promotion; S3 reserves local staging room as well as durable byte/file quotas. These public-ingress controls do not replace budgets for derived media, private/admin import paths, subprocesses, inbound mail or other writers.

## Cleanup and capacity recovery

Staging directories are private and request-owned under `STORAGE_PATH/temp/public-uploads`. Writers settle before cleanup or reservation release. A subsequent upload cleans abandoned staging only after the recorded local Node producer is confirmed absent by the OS. Live, remote-host or ambiguous producers are never expired by a timer. Remote object uncertainty remains charged even after safe temporary cleanup.

Do not delete quota tables or reset counters on a live deployment: that permits old writers to bypass admission. Review retained failures with the operator, confirm all relevant producers and remote uploads are quiescent, and verify cleanup independently. Raise a finite allowance when legitimate workloads need more capacity. Accepted lifetime charges do not automatically reset when files are removed; plan gallery/account/deployment allowances accordingly. Back up the quota tables with the database. A migration rollback discards this protection and is a deliberate destructive operator action.

Clients receive localized batch/capacity/busy/rate/timeout guidance. Refusals use 413 (body/remaining allowance), 429 (quota/work/rate capacity), 507 (low local space), or 503 (unavailable admission accounting); existing authorization, type filtering, photo-cap and partial-success behavior remain intact.
