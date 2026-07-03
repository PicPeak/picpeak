---
title: Backup & Restore
description: How picpeak captures your install, where backups land, and how to recover from them — including full disaster recovery.
sidebar_position: 2
---

# Backup & Restore

picpeak's backup system captures your entire install — database, photos, CRM documents, gallery archives, and configuration — to a destination of your choice. Recovery happens through one of two paths depending on how badly things went wrong:

- **The install is alive** → use the **Restore wizard** in the admin UI to roll back to a chosen backup.
- **The install is gone** (host migration, `docker compose down -v`, drive replacement) → use the **install-from-backup** trigger file convention to rebuild in one boot, with no onboarding wizard and no temporary admin step.

This guide covers both.

## Table of contents

- [What gets backed up](#what-gets-backed-up)
- [Destinations](#destinations)
- [Inline DB dump](#inline-db-dump)
- [Custom backup paths](#custom-backup-paths)
- [The Coverage tab](#the-coverage-tab)
- [The Integrity tab](#the-integrity-tab)
- [Restoring on a live install](#restoring-on-a-live-install)
- [Disaster recovery (install from a backup)](#disaster-recovery-install-from-a-backup)
- [Backup History detail](#backup-history-detail)
- [Settings reference](#settings-reference)
- [Troubleshooting](#troubleshooting)

## What gets backed up

Every "Run Backup Now" (manual or scheduled) produces:

1. **A database dump** captured inline at the start of the run. Always included by default. picpeak refuses to ship a backup without a database dump unless the operator has explicitly opted out via the `backup_database_inline_dump` setting — see [Inline DB dump](#inline-db-dump) below.

2. **Files from a configurable list of paths**, declared in the `backup_paths` table:
   | Path | Default | Notes |
   | --- | --- | --- |
   | `events/active` | ✓ | Live gallery photo originals |
   | `events/archived` | gated by `backup_include_archived` | Long-term archive |
   | `thumbnails` | ✓ | Generated thumbnails |
   | `previews` | ✓ | Lightbox preview tier |
   | `heroes` | ✓ | Gallery hero images |
   | `uploads` | ✓ | Wet-signature contracts, imported invoices, etc. |
   | `business-docs` | ✓ | CRM PDFs, signature artefacts, imported historical invoices |

   Admins can add or remove rows from `backup_paths` to teach the walker about new feature directories — see [Custom backup paths](#custom-backup-paths).

3. **A manifest JSON** describing the run, written to `<destination>/manifests/backup-manifest-<id>.json`. The manifest carries the database dump path, the file inventory, checksums, and per-path counters.

## Destinations

picpeak supports three destination types, configured via **Backup → Configuration**:

- **Local** — files copied to a directory on the same host (default: `/backup` inside the container, which is typically a bind mount).
- **S3 / MinIO** — files uploaded via the S3 API. Supports custom endpoints (for MinIO, Backblaze B2, Wasabi, etc.).
- **rsync** — synchronised to a remote host over SSH.

Direct download from the admin UI is supported for local destinations; S3 backups can be retrieved via pre-signed URLs.

## Inline DB dump

Every "Run Backup Now" runs `pg_dump` (or `sqlite3 .backup`) inline before walking files. This guarantees the manifest's `database.backup_file` is always a fresh capture, never a stale reference to a previously-scheduled dump that may not exist.

If the inline dump fails (disk full, pg_dump crash, permission error), the run aborts and writes the error to `backup_runs.error_message`. The UI surfaces this as a failed run — no more silent files-only manifests.

**To opt out** (e.g. if you have a separately-orchestrated DB backup that you trust more):

```sql
INSERT INTO app_settings (setting_key, setting_value, setting_type, updated_at)
VALUES ('backup_database_inline_dump', 'false', 'backup', NOW())
ON CONFLICT (setting_key) DO UPDATE
  SET setting_value = 'false', updated_at = NOW();
```

With inline-dump opted out, picpeak's fail-loud guard still applies: a file backup with no recent DB dump on file (within 26 hours) will fail rather than ship a files-only manifest.

## Custom backup paths

To add a new directory to the backup walker (e.g. you've shipped a feature that drops artefacts under `storage/my-feature/`):

```sql
INSERT INTO backup_paths (path, include_in_default, display_order, description, created_at, updated_at)
VALUES ('my-feature', true, 100, 'My new feature artefacts', NOW(), NOW());
```

Next "Run Backup Now" picks it up — no restart, no migration. Set `include_in_default = false` to temporarily disable a path without dropping the row.

The `feature_flag` column gates a path behind an app_settings boolean (matches how `events/archived` is gated by `backup_include_archived`). Useful when a backup path corresponds to an optional feature.

## The Coverage tab

**Backup → Coverage** answers "what will the next backup actually include?" without having to run it:

- **Database** — inline-dump mode + last dump timestamp + staleness check
- **Configured paths** — one row per `backup_paths` entry with its current coverage status (`will-scan` / `skipped-by-toggle` / `skipped-by-feature-flag` / `missing-on-disk`)
- **Drift detection** — flags top-level directories under `STORAGE_PATH` that exist on disk but have NO matching `backup_paths` row. This is the canary for "a feature shipped without a matching backup row" — the most common cause of silent data loss in pre-2026-05 picpeak.

The Coverage tab auto-fetches on open. If everything is green, your next backup will capture what you'd expect.

## The Integrity tab

**Backup → Integrity** verifies that every `*_path` column on quotes / contracts / invoices / signatures actually resolves to a file on disk, AND that files with a stored `*_sha256` still hash to the same value. Read-only, on-demand. Useful for:

- Post-restore validation
- Detecting bit-rot
- Auditing legal-evidence artefacts before a tax review or dispute

## Restoring on a live install

Use this when picpeak is running and you want to roll back to a specific backup point — e.g. recovering accidentally-deleted records, reverting a bad migration, or testing a restore drill.

**Backup → Restore** walks you through:

1. **Source** — Local, S3, or rsync
2. **Choose Backup** — manifests discovered from disk (works after a fresh install where `backup_runs` is empty) or from the database history
3. **Restore Options** — Full / Database only / Files only / Selective + Force + Skip Pre-Restore
4. **Review** — surfaces validation warnings before you commit
5. **Restore Progress** — real-time stream of the actual steps

Failures during restore trigger an automatic rollback from the pre-restore safety snapshot. The destination ends up either as the restored state OR as the original pre-restore state — never as a half-clobbered mix.

### Restoring an older backup on a newer image

picpeak's restore path is forward-compatible: a backup taken on an older version restores cleanly onto a newer image without any manual schema work. After loading the dump, the restore service runs the same `npm run migrate:safe` script that `wait-for-db.sh` uses on every container boot. Any migrations that have been added between the backup's snapshot and the current image are applied inline, against the freshly-restored DB, before the restore is reported as complete.

Net effect: even if `bugfix/cool-new-feature` shipped a migration that adds a `widgets` table and your backup predates that branch, after restore your install has the `widgets` table (empty), the right indexes, and any seed rows the migration emits. No "you'll need to restart the container once" footnote.

The same applies to the install-from-backup trigger — migrations land inside the restore boundary, so the moment the server prints `Server running on port 3000`, the schema matches the running image. Log in and use the install immediately.

## Disaster recovery (install from a backup)

For full DR after `docker compose down -v`, host migration, drive replacement, or moving an install between hosts. picpeak detects a trigger file on first boot and runs the restore before the admin UI surfaces. You open the browser, log in with your original credentials, and the install is fully populated.

### Prerequisites

- Your install's backup files must already be present in the `/backup` mount. They survive `docker compose down -v` because `/backup` is a bind mount, not a Docker-managed volume.
- The image must include the install-from-backup feature (shipped 2026-05-31 on `beta`; available in `main` after the next stable release).
- The backup must contain a database dump. The wizard cannot reconstruct your CRM data, customers, quotes, invoices, or admin users from a files-only backup. Confirm by inspecting any `backup-manifest-*.json` and checking that `database.backup_file` is non-null.

### How the trigger works

On every container start, picpeak's boot sequence checks for a trigger file in the root of the `/backup` mount. If found AND the destination database is empty, the restore runs automatically. After a successful restore the trigger file is deleted so the next boot doesn't redo the work. On failure the trigger file is preserved — fix the input and restart the container to retry.

The trigger file is named **`RESTORE_ON_INSTALL`** (no extension) or **`RESTORE_ON_INSTALL.txt`** — either is accepted.

### Two trigger flavors

#### Auto-pick the newest backup

Create an empty trigger file:

```sh
touch /path/to/backup/RESTORE_ON_INSTALL
```

The boot hook will scan `/backup/manifests/` for files matching `backup-manifest-*.json` (or `.yaml`) and pick the one with the most recent modification time. Best for the common DR case where you simply want the latest snapshot.

#### Use a specific backup

Write the path of the manifest you want — either relative to the `/backup` mount root or an absolute path — into the trigger file:

```sh
# Relative path (recommended)
echo "manifests/backup-manifest-backup-20260530-190617-e9be97b3.json" \
  > /path/to/backup/RESTORE_ON_INSTALL

# Or absolute path inside the container
echo "/backup/manifests/backup-manifest-backup-20260530-190617-e9be97b3.json" \
  > /path/to/backup/RESTORE_ON_INSTALL
```

Use this when you need to restore an older backup (e.g. rolling back a data corruption that happened after the most recent backup ran).

### Full DR walkthrough

```sh
# 1. Snapshot the backup outside the compose directory (belt + suspenders).
#    This is a docker-compose-down-v-proof copy in case anything goes wrong.
SNAPSHOT=~/picpeak-snapshots/$(date +%Y%m%d-%H%M%S)
mkdir -p "$SNAPSHOT" && cp -av /path/to/picpeak/backup/. "$SNAPSHOT/"

# 2. Verify the backup is restorable. database.backup_file must be non-null.
LATEST=$(ls -t /path/to/picpeak/backup/manifests/*.json | head -1)
docker compose exec backend cat "/backup/manifests/$(basename $LATEST)" \
  | python3 -c "import json,sys; m=json.load(sys.stdin); \
      print('DB included:', bool(m.get('database',{}).get('backup_file')))"

# 3. Drop the trigger file. Two variants — pick one:

# (a) auto-pick newest
touch /path/to/picpeak/backup/RESTORE_ON_INSTALL

# (b) specific manifest
echo "manifests/backup-manifest-backup-20260530-190617-e9be97b3.json" \
  > /path/to/picpeak/backup/RESTORE_ON_INSTALL

# 4. Boot.
docker compose down -v
docker compose up -d
docker compose logs -f backend --tail=100
```

When the boot log shows `Install-from-backup: restore completed successfully` followed by `Server running on port 3000`, the install is ready. Open the admin UI and log in with your original (pre-disaster) credentials.

### Safety gates

Three layers prevent accidental data loss:

1. **The trigger file must exist.** No auto-magic — an admin explicitly drops the file to signal intent.

2. **The destination database must be empty.** If the database contains any events, the install-from-backup hook refuses to run. The fresh-install default admin (auto-created by migration 001) is treated as throwaway and replaced by the backup's admin row, so a single admin user does not block the restore.

3. **Failed restores roll back to the pre-restore state.** If anything fails after the DROP DATABASE step, picpeak's automatic rollback restores the destination from the pre-restore safety backup it took before starting.

#### Override for advanced cases

If you have a populated install you intentionally want to clobber (dev rebuilds, staging refresh, etc.):

```yaml
# In docker-compose.yml
backend:
  environment:
    - INSTALL_FROM_BACKUP_FORCE=true
```

Or via the CLI:

```sh
INSTALL_FROM_BACKUP_FORCE=true docker compose up -d backend
```

With this set, gate #2 is skipped and the restore proceeds even with existing data. Gates #1 (trigger file presence) and #3 (rollback on failure) still apply.

### Verifying DR success

After the boot log shows `Install-from-backup: restore completed successfully`:

```sh
# Trigger should be gone (deleted on successful restore)
ls /path/to/picpeak/backup/RESTORE_ON_INSTALL 2>/dev/null \
  || echo "Trigger cleaned up — restore succeeded."

# Inspect the restore_runs row
docker compose exec -T postgres psql -U picpeak -d picpeak_prod -c \
  "SELECT id, status, was_successful, was_rollback_attempted FROM restore_runs ORDER BY id DESC LIMIT 1;"

# Confirm data is back
docker compose exec -T postgres psql -U picpeak -d picpeak_prod -c "
  SELECT 'admin' AS t, COUNT(*) FROM admin_users
  UNION ALL SELECT 'events',       COUNT(*) FROM events
  UNION ALL SELECT 'invoices',     COUNT(*) FROM invoices
  UNION ALL SELECT 'app_settings', COUNT(*) FROM app_settings;"
```

Then open the admin login and use your **original** pre-disaster credentials.

## Backup History detail

Each row in **Backup → Backup History** expands to show:

- **Database** — whether the dump was included
- **Per-path file counts** — one row per `backup_paths` entry that contributed files, with count + total size. e.g.:
  ```
  events/active      142 (3.2 GB)
  business-docs       17 (4.5 MB)
  thumbnails         142 (12.4 MB)
  ```
- **Total files** + total bytes
- Error message if the run failed

This breakdown reflects Stage B's data-driven walker, so admins can see at a glance which paths contributed how much.

## Settings reference

Backup-related settings live in `app_settings` with `setting_type = 'backup'` or `setting_type = 'restore'`:

| Setting | Default | Notes |
| --- | --- | --- |
| `backup_enabled` | true | Master scheduler switch |
| `backup_destination_type` | `'local'` | `'local'`, `'s3'`, or `'rsync'` |
| `backup_destination_path` | `'/backup'` | Local destination |
| `backup_database_inline_dump` | true | Inline DB dump on every run |
| `backup_include_archived` | false | Gate `events/archived` |
| `backup_incremental` | true | Skip unchanged files (checksum-tracked) |
| `restore_allow_force` | true | Permit Force Restore via the wizard |
| `restore_require_pre_backup` | true | Take a pre-restore safety snapshot |
| `restore_verify_checksums` | true | Verify file checksums after restore |
| `restore_email_on_completion` | true | Notify admin when restore finishes |
| `restore_retention_days` | 30 | How long pre-restore snapshots survive |

Most settings are exposed in the **Backup → Configuration** tab. Less common ones can be set via SQL.

## Troubleshooting

### "Run Backup Now" fails with `No database backup available`

The inline DB dump was disabled AND no recent scheduled dump exists. Either re-enable inline dumps (set `backup_database_inline_dump = 'true'`) or configure a scheduled DB dump that completes within the staleness window (default 26h).

### Backup History row says "completed" but shows 0 files

This is the legacy of a pre-2026-05 install where the walker was hard-coded and missed paths. After upgrading, the new walker captures everything per `backup_paths`. The 0-file row is historical — new backups will count correctly.

### Restore wizard shows "No backups found"

The wizard's disk discovery looks in `backup_destination_path` + its `manifests/` subdirectory. If you moved manifests elsewhere or your bind mount points at a different host directory than expected, the discovery won't find them. Check `backup_destination_path` in the Configuration tab matches reality.

### Restore completes but login fails

Caused by the pre-2026-05 dead-pool bug — fixed in the current image. If you're on a stale image and still see this, restart the backend container once:

```sh
docker compose restart backend
```

Then try logging in again.

### Install-from-backup: boot log shows no `Install-from-backup:` lines

Check that the trigger file is actually visible from inside the container:

```sh
docker compose exec backend ls -la /backup/RESTORE_ON_INSTALL
docker compose exec backend cat /backup/RESTORE_ON_INSTALL
```

If `ls` reports the file but the hook didn't run, the most likely cause is that the trigger pointed at a manifest that doesn't exist. The hook silently returns when the manifest path can't be resolved. Verify the path inside the file matches an actual manifest:

```sh
docker compose exec backend ls -la /backup/manifests/
```

### Install-from-backup: restore fails and leaves the trigger file in place

This is the intentional behavior — fix the input, then restart the container to retry. The boot log will surface the underlying error (e.g. corrupt manifest, missing database dump file, validator warnings without the force override).

Common failure modes:

- **Backup is files-only** (`database.backup_file = null` in the manifest). Pick a different backup or proceed with caution via the admin wizard, knowing you will restore files only.
- **Manifest path mismatch.** The path in the trigger file points at a manifest that doesn't exist. Either fix the path or use the empty-file auto-pick variant.
- **Existing data** without the force override. Either start from a truly empty install (`docker compose down -v`) or set `INSTALL_FROM_BACKUP_FORCE=true`.

### How do I disable install-from-backup entirely?

Don't create a `RESTORE_ON_INSTALL` file. Without the trigger, the hook is a no-op on every boot. There is no separate "off switch" because the feature is opt-in by design.

## See also

- [Deployment](/deployment) — Docker, environment variables, volumes
- [Admin Settings](/guides/admin-settings) — Configuration tab walkthrough
