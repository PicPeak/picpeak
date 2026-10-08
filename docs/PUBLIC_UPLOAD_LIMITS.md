# Public upload admission limits

Gallery guest uploads and PicTransfer file-request uploads have authoritative server limits, including when Express is reached directly. Reverse-proxy body limits remain defense in depth. The raw multipart body (files, skipped parts, fields and framing) is metered while streaming; neither a missing Content-Length nor chunked encoding bypasses it.

These limits exist to stop abuse of the **public** (unauthenticated or guest) upload endpoints. They charge only what arrived through those endpoints. Photographer, admin, API and import uploads, archives and reference-mode originals never count, so an existing gallery with any number of photographer photos keeps its full guest allowance after an upgrade.

## What is charged

- Every public upload accepted from now on is recorded in a ledger before it is written. A ledger charge is a **lifetime** charge: it survives row deletion, hiding, guest erasure, ownership reassignment, token rotation and archival, because deletion can fail and a reusable public link must not regenerate unlimited storage.
- Public uploads that predate the ledger count while they exist: photos marked as guest uploads (`photos.uploaded_by = 'guest'`) toward their gallery, account and the deployment, and file-request uploads (`transfer_uploads`) toward their request, account and the deployment. Deleting one of these frees its share. Releases that did not mark guest uploads leave them uncounted.
- An ownerless gallery or request is charged to one shared legacy account bucket.

## Default allowances

| Scope | Lifetime bytes | Lifetime files | Pending bytes | Pending files | Concurrent requests | Bytes/hour |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Gallery | 50 GiB | 20,000 | 20 GiB | 5,000 | 16 | 20 GiB |
| Guest | 50 GiB | 20,000 | 20 GiB | 5,000 | 16 | 20 GiB |
| File request | 50 GiB | 20,000 | 20 GiB | 5,000 | 4 | 20 GiB |
| Account | 500 GiB | 200,000 | 50 GiB | 20,000 | 32 | 100 GiB |
| Deployment | unlimited | unlimited | 100 GiB | 50,000 | 64 | 200 GiB |

The deployment has no lifetime ceiling by default; it is bounded by the free-disk headroom check below. There is no per-hour request or file count: the guest gallery sends one file per request, so limits are expressed in files and bytes. The request rate per client network stays with the existing Express rate limiters.

A **guest** bucket is the guest's identity where the gallery has one, otherwise the client network (the same key the rate limiters use: an IPv4 address or an IPv6 /64). Guests behind one NAT without identities therefore share the guest row; raise `guest` if a venue network needs more.

**Pending** is work waiting for the photo processor. It is released when processing completes, when it fails terminally, or shortly after a pending photo is deleted; the lifetime charge stays in every case. A request is admitted while any pending room is left, so the caps can be overshot by one request per concurrent slot. File-request uploads are never media jobs.

## Per-request ceiling

One request may send at most `requestBytes` (default **95 MiB**), lowered by `general_max_upload_batch_size_mb` when that is smaller, but never less than one file of the configured maximum (`general_max_file_size_mb` for galleries, `transfer_max_upload_size_mb` for file requests) plus 1 MiB of multipart framing. A single allowed file therefore always fits. The file-request page receives this budget as `max_request_bytes` and splits a selection into several requests.

A request with a Content-Length reserves exactly that many bytes and is refused before its body is read when it exceeds the ceiling or the remaining allowance; a chunked request reserves the whole ceiling and is cut off mid-body at it. Each request reserves one file and one more per further file part as it arrives. Every body also has a five-minute deadline (`requestTimeoutMs`, at most one hour).

The hourly byte budget includes the raw body of failed or rejected requests. Active requests reserve their prospective ingress; completed requests charge the bytes actually received.

## Operator configuration

Set `PUBLIC_UPLOAD_LIMITS_JSON` in the backend process environment and restart/recreate it. It is an operator-only JSON object; settings-edit permissions cannot change these limits. Omitted keys retain the defaults. Unknown keys, zero, negative, fractional or unsafe values fail closed. Any positive integer is accepted, so a limit is lifted by setting it very high. Sizes are integer **bytes**, counts are positive integers, and `requestTimeoutMs` is milliseconds.

For example, to admit 200-MiB bodies and a 100-GiB gallery lifetime allowance:

```dotenv
PUBLIC_UPLOAD_LIMITS_JSON={"requestBytes":209715200,"gallery":{"bytes":107374182400}}
```

Available top-level scalars: `requestBytes`, `requestTimeoutMs`, `headroomBytes` (default 512 MiB), `headroomPercent` (default 5), `headroomFiles` (default 1,024 free inodes). Each of `gallery`, `guest`, `transfer`, `account`, `deployment` accepts `bytes`, `files`, `pendingBytes`, `pendingFiles`, `requests`, `hourBytes`. Larger bodies still need matching proxy limits.

Low-storage admission requires measurable byte/inode capacity and leaves the greater of absolute/percentage byte headroom plus absolute inode headroom. Local storage reserves room for staging plus promotion, with a second check on the actual destination mount immediately before promotion; S3 reserves local staging room. These public-ingress controls do not replace budgets for derived media, private/admin import paths, subprocesses, inbound mail or other writers.

## Cleanup and capacity recovery

Staging directories are private and request-owned under `STORAGE_PATH/temp/public-uploads`. Writers settle before cleanup or reservation release.

A request in flight holds its reservation by a **heartbeat lease**: the process serving it refreshes the row every 30 seconds. A row whose heartbeat is older than five minutes belongs to a process that died mid-upload, whatever hostname or pid wrote it (a recreated container has a new hostname, a restarted one reuses its pid). The reaper runs at boot, every 30 seconds and before each public upload; it releases the reservation and removes the staging directory when it is under this process's staging root. An uncertain remote object stays charged in the ledger regardless.

Do not delete quota tables or reset counters on a live deployment: that permits old writers to bypass admission. Raise an allowance when legitimate workloads need more capacity. Ledger charges do not reset when files are removed; plan allowances accordingly. Back up the quota tables with the database. A migration rollback discards this protection and is a deliberate destructive operator action.

Clients receive localized batch/capacity/busy/rate/timeout guidance. Refusals use 413 (body or remaining allowance), 429 (quota/work/rate capacity), 507 (low local space), 404 (the gallery or request is gone) or 503 (unavailable admission accounting). Validation refusals (file type, file too large, too many files) keep their specific message; unexpected errors are reported generically. Existing authorization, type filtering, photo-cap and partial-success behavior remain intact.
