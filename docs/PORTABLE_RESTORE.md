# Portable restore on Linux

A `.picpeak` restore is a maintenance operation, not an online data merge. The
admin UI remains available for read-only progress, but application API requests,
storage serving, health readiness and background writers stay paused while the
database and managed files are replaced. Start it as an active Super Admin from
Settings → Backup. Save the progress page; its browser-session token grants only
progress access for that one attempt, not application or restore authority.

## Deployment requirements

Use Linux and build the native supervisor/addon (`cd backend && npm run
build:native`). This requires a C compiler and matching Node headers on native
installations; the backend and all-in-one Docker images build them automatically.
There is no unlimited or in-process fallback when supervision is unavailable.

All backend replicas must use the same Linux host/kernel, database, storage UID
and canonical persistent local `STORAGE_PATH` volume. Share the actual private
`.picpeak-maintenance` directory too. Ext-family, XFS, Btrfs, tmpfs, overlay,
ZFS and F2FS are recognized; a temporary filesystem is not a substitute for a
persistent production volume. Network filesystems, different hosts, missing
capacity information and ambiguous lease identities are refused. For host
identity across reboot, supply a stable, host-unique `MEDIA_PROCESS_HOST_ID` when
a persistent machine ID is unavailable. Never share that value between hosts.

Managed local files must be owned by the application UID and singly linked.
Redirected/symlinked parents, hardlinked destinations and separate-volume
promotion paths are refused before replacement.

Stop external database writers and do not run migrations during restore.
On PostgreSQL, cutover also holds exclusive locks on all target public tables
until transaction completion; database-backed progress polls can wait during
that interval, while the bundled maintenance UI remains served.

Do not delete or replace maintenance markers, leases, journals or runtime tables
to clear a fence. An expired timer, missing container PID or database disconnect
does not establish that a file writer or database transaction has stopped.

## Completion and recovery

The worker stages and verifies files before mutation. Database rows, the S3
generation index and the local promotion commit marker share one transaction.
Local replacements have private, durable undo data. Recovery waits for the
actual native writer and database transaction to be terminal, then either
verifies the committed version or restores the prior local version. Unknown or
changed evidence leaves `recovery_required` fenced; preserve the evidence and
diagnose the storage/database failure instead of clearing it manually.

After either a committed restore or verified rollback, restart **all backend
instances**, including background-only instances. The drained cohort cannot
resume; ordinary access opens only after the old runtime leases are proven free
and the new cohort completes startup. Old sessions are invalidated after an
identity-table replacement. Reference-mode external media still needs the
operator to configure the target external root.

S3 credentials/bucket/prefix must describe the target installation before
restoring. Incoming objects use opaque, per-attempt physical names; logical
activation follows the committed target-local index. Existing keys absent from
the archive are not purged. Private staged/obsolete S3 objects and local undo
journals are retained; this workflow does not provide automatic garbage
collection. Plan capacity for extraction, replacement and undo copies together.

## Finite resource limits

| Resource | Limit |
| --- | --- |
| Uploaded/copied archive | 5 GiB; one actual shared-volume ingress slot |
| ZIP entries including implied ancestor nodes | 100,000 |
| ZIP central-directory metadata / manifest | 16 MiB each |
| Expanded ZIP data | 32 GiB |
| NDJSON record / table | 1 MiB / 8 GiB and 10,000,000 rows |
| Database insert batch | 100 rows, 4 MiB, at most 900 bindings |
| Worker address space / JavaScript heap | 768 MiB / 384 MiB by default |
| Worker wall time / CPU time | 30 minutes / 600 seconds by default |
| Local reserve | 256 MiB and 1,024 free inodes; checked during writes |

`PICPEAK_IMPORT_MAX_ENTRIES`, `PICPEAK_IMPORT_MAX_EXPANDED_BYTES` and
`PICPEAK_IMPORT_MAX_MANIFEST_BYTES` can only tighten the fixed archive ceilings.
Set positive integers. `PICPEAK_IMPORT_WORKER_MEMORY_MIB` supports 256–4,096 MiB;
the heap is half that allowance, capped at 1,024 MiB.
`PICPEAK_IMPORT_WORKER_TIMEOUT_MS` may be raised to 7,200,000 milliseconds and
`PICPEAK_IMPORT_WORKER_CPU_SECONDS` to 7,200 seconds. A worker must still fit in
the shared native half-host/cgroup memory budget; larger settings cannot bypass
that budget. A resource refusal is not permission to remove supervision.

These variables belong in the backend process/container environment, not the
frontend's build-time `VITE_*` settings. Restart instances after changing them.
The SQLite-to-PostgreSQL migration CLI uses the same supervised offline restore;
stop ordinary backend instances first and retain its private, same-install S3
index sidecar when migrating an existing S3-backed installation.
