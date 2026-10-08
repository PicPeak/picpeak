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

Low-storage admission requires measurable byte/inode capacity and leaves the greater of absolute/percentage byte headroom plus absolute inode headroom. Local storage reserves room for staging plus promotion, with a second check on the actual destination mount immediately before promotion; S3 reserves local staging room. These public-ingress controls do not replace budgets for derived media, import paths, subprocesses, inbound mail or other writers.

## Authenticated admin and API uploads

Uploads by a signed-in admin (the admin UI, both multipart aliases, resumable uploads, PicTransfer deliverables) and through an API-v1 token come from the operator's own users. They are **not** rate-limited and **not** charged: there is no hourly, lifetime or per-gallery cap, they never count against a public allowance, and a public allowance never refuses them. Auth, permissions and ownership still apply, and so do the per-file settings. Admission only bounds what is in flight at once, so a full disk or a runaway client cannot take the server down:

| Bound | Default | Override key |
| --- | --- | --- |
| Free-disk headroom | 512 MiB or 5% of the volume, whichever is larger, and 1,024 free inodes | `headroomBytes`, `headroomPercent`, `headroomFiles` |
| Bytes all authenticated requests hold in staging together | the smaller of 50 GiB and 25% of the free space | `stagedBytes` |
| Files they hold in staging together | 50,000 | `stagedFiles` |
| Concurrent requests per uploading admin account | 16 | `accountRequests` |
| Concurrent requests per deployment | 64 | `requests` |
| Deadline for one request body (multipart request or one chunk) | 10 minutes | `requestTimeoutMs` |

A request that is alone is always admitted when the disk has room: one file up to `general_max_file_size_mb` / `general_max_video_size_mb` never fails on the staging bound. One multipart request may carry `general_max_upload_batch_size_mb` (95 MiB when unset) and never less than one maximum file plus 1 MiB of framing; set `requestBytes` to lower that. The admin UI sends larger single files through the resumable path.

A resumable upload is **one** request from init to completion, however many 10-MiB chunks or re-sent chunks it takes. Init reserves the declared file size, and local room for the chunks plus their merged copy. Video chunk zero is classified first (any ISO base media `ftyp` brand, a classic QuickTime `moov`/`mdat`/`wide`/`free` atom for `.mov`, RIFF AVI or WebM; still-image brands are refused); later indices can arrive out of order. Disk headroom is rechecked before each chunk, before the merge and before promotion.

Capacity refusals are transient and the admin UI waits and retries them: `UPLOAD_PENDING_LIMIT` and `UPLOAD_CONCURRENCY_LIMIT` (429), and `UPLOAD_TIMEOUT` / `UPLOAD_REQUEST_TIMEOUT` (408). `UPLOAD_STORAGE_LOW` (507) is not: free disk space first.

Authenticated requests are recorded in the same tables for this accounting only (`upload_kind = 'admin'`). Their rows are released when the upload completes or fails, and nothing remains charged afterwards, including for a photo whose processing later fails. They hold the same heartbeat lease as public requests: after a restart, the reaper releases a request or resumable session whose process died and removes its staging directory with its chunks. A resumable session that receives no chunk for 15 minutes (a closed tab) is released with its chunks; the client starts that file again.

Configure `ADMIN_UPLOAD_LIMITS_JSON` in the backend environment with the same positive-integer rules as the public profile; only the keys in the table and `requestBytes` are accepted, anything else fails closed. Compose forwards the variable. For example, to let authenticated uploads stage up to 200 GiB at once with 32 requests per account:

```dotenv
ADMIN_UPLOAD_LIMITS_JSON={"stagedBytes":214748364800,"accountRequests":32}
```

## Cleanup and capacity recovery

Staging directories are private and request-owned under `STORAGE_PATH/temp/public-uploads`. Writers settle before cleanup or reservation release.

A request in flight holds its reservation by a **heartbeat lease**: the process serving it refreshes the row every 30 seconds. A row whose heartbeat is older than five minutes belongs to a process that died mid-upload, whatever hostname or pid wrote it (a recreated container has a new hostname, a restarted one reuses its pid). The reaper runs at boot, every 30 seconds and before each public upload; it releases the reservation and removes the staging directory when it is under this process's staging root. An uncertain remote object stays charged in the ledger regardless.

Do not delete quota tables or reset counters on a live deployment: that permits old writers to bypass admission. Raise an allowance when legitimate workloads need more capacity. Ledger charges do not reset when files are removed; plan allowances accordingly. Back up the quota tables with the database. A migration rollback discards this protection and is a deliberate destructive operator action.

Clients receive localized batch/capacity/busy/rate/timeout guidance. Refusals use 413 (body or remaining allowance), 429 (quota/work/rate capacity), 507 (low local space), 404 (the gallery or request is gone) or 503 (unavailable admission accounting). Validation refusals (file type, file too large, too many files) keep their specific message; unexpected errors are reported generically. Existing authorization, type filtering, photo-cap and partial-success behavior remain intact.
