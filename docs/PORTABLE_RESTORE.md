# Portable restore (.picpeak import)

A `.picpeak` restore replaces the database and the managed files of an
instance. It is a maintenance operation: while it runs, the instance answers
ordinary requests with 503, the admin interface shows the restore progress and
`/health` answers `200` with `"maintenance": "restoring"`, so a health-based
restarter leaves it alone. Start it as an active Super Admin from Settings →
Backup.

## An optional feature

Coordinated restore needs four things from the host:

- Linux (the Docker images qualify),
- the compiled kernel-lease addon and process guard (`cd backend && npm run
  build:native`; the Docker images build them),
- the guard able to supervise a process (ptrace allowed for the container;
  Docker's default profile allows it),
- `STORAGE_PATH` on a local filesystem (ext4, XFS, Btrfs, ZFS, F2FS, tmpfs or
  overlay; not NFS or CIFS).

Where one of them is missing the application starts and runs exactly as it
does without this feature. One startup log line names the missing piece, the
import in the admin interface is shown as unavailable with the same reason, and
the import route answers 503. Nothing else changes: no table is read, no
directory is created, no request is slowed down.

On a host that qualifies, an instance that never runs a portable restore also
does nothing for it at boot: no control row, no lease, no workspace. The only
standing cost is an in-memory flag checked per request and one small file
lookup every two seconds (`<STORAGE_PATH>/.picpeak-maintenance/fence.json`,
absent until the first restore).

## What happens during a restore

1. **Validation, with the instance fully up.** The upload request itself reads
   the manifest (bounded), checks that it is a PicPeak backup this version and
   database engine can take, that its schema is not newer than this instance,
   counts entries and bytes against the limits below, checks free space on the
   storage volume and, on PostgreSQL, that the database role may suspend
   foreign keys and replace every table. A refused archive gets a specific
   error and the instance is never fenced.
2. **Fence and drain.** New requests get 503, background services stop and
   running requests may finish. After `PICPEAK_RESTORE_DRAIN_GRACE_MS`
   (default 60 000) the remaining connections are closed, as on shutdown. If
   work still does not end, the restore is aborted and the instance reopens.
3. **Stage.** A supervised worker extracts the archive into the private
   workspace, verifies every entry's size and CRC, every table's checksum and
   every catalogued file's SHA-256, and copies the files next to their
   destinations together with undo copies. All hashing happens here.
4. **Cutover.** One database transaction replaces the rows and, holding the
   table locks, renames the staged files into place. Nothing is hashed under
   the lock.
5. **Verify.** After the commit the worker checks the promoted files again.

If anything fails before the commit, the worker restores every file from its
undo copy, the database transaction rolls back, and **the instance reopens by
itself**: services restart in the same process, no restart is needed, and the
progress view shows the reason. After a **committed** restore every backend
process must be restarted once, because its in-memory caches describe the
replaced database; the admin interface says so. Old sessions are invalidated.

## Crash, reboot, stuck fence

A process that starts while a restore is unfinished serves only the
maintenance page, recovers the restore (rolling it back unless its commit is in
the database) and then starts normally. This also holds after a host reboot or
a recreated container: a registration whose kernel lease cannot be checked any
more counts as dead once its heartbeat is 90 seconds old, and dead
registrations are deleted.

Should an instance nevertheless stay in maintenance (the storage volume was
moved, the host no longer qualifies, recovery keeps failing), clear the fence
by hand:

```bash
# stop the backend first
node scripts/clear-portable-restore-fence.js            # shows the state
node scripts/clear-portable-restore-fence.js --confirm  # clears it
# docker compose run --rm backend node scripts/clear-portable-restore-fence.js --confirm
```

The script refuses while a backend process still holds the fence (`--force`
overrides). If the interrupted restore had not committed, its files are rolled
back and the instance is what it was before; if it had, the restored data
stays. The action is written to the log and to the activity log
(`portable_restore_fence_cleared`). Start the backend afterwards.

## Several backend processes

All processes must share the same host, database and `STORAGE_PATH` volume.
Another process notices a restore through the fence marker in storage within
a few seconds, stops its services, drains and acknowledges before the worker
starts. A process that does not share the storage volume cannot be fenced;
stop it before restoring. Stop external database writers and do not run
migrations during a restore.

## Workspace and cleanup

Everything a restore writes lives in `<STORAGE_PATH>/.picpeak-maintenance`,
which file backups and rsync runs skip. Plan free space for the archive, its
extracted copy and the staged copy of its files (about the archive plus twice
its expanded size).

- After a rollback or an aborted restore the whole attempt is removed.
- After a commit the uploaded archive, the extracted copy and the staged files
  are removed at once. The undo copies of the files that were replaced are kept
  for 24 hours and removed at the next start after that.
- Leftovers of interrupted uploads and earlier attempts are removed at start.

## S3 storage

S3 credentials, bucket and prefix must describe the target installation before
restoring. Restored objects are written under per-restore generation keys and
activated through an index in the target database; objects absent from the
archive are kept. The index is bound to endpoint, region, bucket and prefix. A
re-spelled endpoint (scheme, letter case, default port, trailing slash, AWS's
own endpoint) is the same store. If the configuration really names another
store, storage continues **read-only** and logs the reason instead of failing
to start: set the previous `STORAGE_S3_*` values again, or, after deliberately
moving to a new bucket whose objects are at their plain keys, remove the index
(`DELETE FROM storage_s3_generation_index`) and restart. Staged objects of a
failed restore are not collected automatically. Local storage does not use the
index at all.

## Limits

An instance can import what it can export. The defaults are those of earlier
releases; every value can be raised or lowered in the backend environment.

| Resource | Default | Variable |
| --- | --- | --- |
| Uploaded archive | 5 GiB | fixed |
| Entries | 2,000,000 | `PICPEAK_IMPORT_MAX_ENTRIES` |
| Expanded size | 1 TiB | `PICPEAK_IMPORT_MAX_EXPANDED_BYTES` |
| Manifest | 256 MiB | `PICPEAK_IMPORT_MAX_MANIFEST_BYTES` |
| One table row | 64 MiB | `PICPEAK_IMPORT_MAX_ROW_BYTES` |
| One file | the size the manifest records; for a file the manifest does not describe, the largest upload the instance allows (at least 5,000 MiB) | upload size settings |
| One table | 8 GiB, 10,000,000 rows | fixed |
| Free space reserve | 256 MiB, 1,024 inodes | fixed |

An export that exceeds an importer's defaults logs a warning naming the
variable to raise on the importing instance.

The worker's budgets follow the archive: memory 768 MiB plus 2 MiB per 1,000
entries (at most 8 GiB), wall time 30 minutes plus one second per 4 MiB of
expanded data and 20 ms per entry (at most seven days), no CPU-time limit.
`PICPEAK_IMPORT_WORKER_MEMORY_MIB` (256–65,536),
`PICPEAK_IMPORT_WORKER_TIMEOUT_MS` and `PICPEAK_IMPORT_WORKER_CPU_SECONDS`
override them. These variables belong in the backend environment, not in the
frontend's build-time `VITE_*` settings.

## SQLite to PostgreSQL migration

`scripts/migrate-sqlite-to-postgres.js` uses the same supervised restore and
therefore needs a host that qualifies (see above). Stop the backend first; a
backend that is still running makes the migration stop without changing
anything.
