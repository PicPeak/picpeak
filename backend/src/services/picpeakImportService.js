'use strict';

// Receiving half of the GUI-only backup roundtrip: takes a ".picpeak" produced
// by picpeakExportService and restores it onto THIS instance.
//
// Restore semantics (agreed design): FULL OVERRIDE — every table is wiped and
// replaced by the backup's rows — EXCEPT the current logged-in admin account,
// which is preserved so the operator is never locked out. A backup admin whose
// email collides with the current account is overwritten with the current
// account's credentials (so the operator's known password keeps working).
//
// Same-engine (pg↔pg / sqlite↔sqlite) or the upgrade direction (sqlite → pg,
// #1041) — the reverse is refused. Forward-only (an older backup restores onto
// a newer instance; a newer backup is refused). The target's own schema is
// used as-is — we never replay the backup's DDL.

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const StreamZip = require('node-stream-zip');
const { assertZipEntriesWithin } = require('../utils/safePath');
const { db } = require('../database/db');
const knexConfig = require('../../knexfile');
const { getStoragePath } = require('../config/storage');
const { hasColumnCached } = require('../utils/schemaCache');
const { setSessionsValidAfter } = require('../utils/sessionCutoff');
const logger = require('../utils/logger');
const { PICPEAK_FORMAT_VERSION, EXCLUDED_TABLES, listDataTables } = require('./picpeakExportService');

const isPostgres = () => knexConfig.client === 'pg';

// Compare migrations by their numeric filename prefix (001_, 107_, 129_ …).
function migrationOrder(name) {
  const m = String(name || '').match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : -1;
}

async function readManifestFromZip(picpeakPath) {
  const zip = new StreamZip.async({ file: picpeakPath });
  try {
    return JSON.parse((await zip.entryData('manifest.json')).toString('utf8'));
  } finally {
    await zip.close();
  }
}

// Returns an array of human-readable blockers ([] = OK to restore).
async function validateManifest(manifest) {
  const errors = [];
  if (!manifest || manifest.kind !== 'picpeak-backup') {
    return ['This file is not a PicPeak backup (.picpeak).'];
  }
  if (Number(manifest.format) > PICPEAK_FORMAT_VERSION) {
    errors.push('This backup was created by a newer version of PicPeak. Update this instance first.');
  }
  const engine = isPostgres() ? 'pg' : 'sqlite';
  const backupEngine = manifest.database && manifest.database.engine;
  // Cross-engine restore is allowed in the UPGRADE direction only: a SQLite
  // archive onto a Postgres instance (#1041) — the official small-install →
  // full-stack migration path, same gate for the upload UI and
  // scripts/migrate-sqlite-to-postgres.js. The reverse stays refused: pg
  // archives carry ISO "T"/"Z" timestamps that SQLite would store as-is in
  // text columns (the #1028/#1029 drift class), and engine downgrades are
  // rarely intentional.
  if (backupEngine && backupEngine !== engine && !(backupEngine === 'sqlite' && engine === 'pg')) {
    errors.push(`Database engine mismatch: the backup is "${backupEngine}" but this instance is "${engine}". Cross-engine restore is only supported from a SQLite backup onto a PostgreSQL instance.`);
  }
  // Forward-only: the target schema must be at least as new as the backup's.
  let targetLatest = null;
  try {
    const applied = await db('knex_migrations').orderBy('id', 'desc').limit(1);
    targetLatest = applied[0] ? applied[0].name : null;
  } catch (_) {
    // No knex_migrations table (e.g. some test harnesses) — skip the check.
  }
  const backupLatest = manifest.database ? manifest.database.latest_migration : null;
  if (backupLatest && targetLatest && migrationOrder(backupLatest) > migrationOrder(targetLatest)) {
    errors.push('This backup is from a newer database schema than this instance. Update this instance to at least the backup version before restoring.');
  }
  return errors;
}

function parseNdjson(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

// Re-insert the operator's account inside the restore transaction so they keep
// working credentials after the wipe.
//
// The operator's login + credentials + MFA must be restored, not just the
// password. A crafted backup can carry a row with the operator's email whose
// two_factor_* fields are attacker-chosen — leaving those in place would let
// the backup strip or hijack the operator's MFA, or (cross-instance) pin a TOTP
// secret encrypted with the source instance's key the operator can never
// satisfy. These columns are scalar/text (recovery codes are a JSON string in a
// TEXT column), so writing them needs no special json handling. Relationship/
// audit FKs (role_id, created_by) are deliberately NOT forced from the snapshot
// — see the update branch below.
//
// admin_users has UNIQUE constraints on BOTH email and username, and a restored
// backup can collide with the operator on either — possibly on two DIFFERENT
// rows (one shares the email, another shares the default `admin` username). We
// reconcile WITHOUT deleting any restored row: deleting would fire ON DELETE
// actions (SQLite) or dangle references such as events.created_by (Postgres,
// where replica mode suppresses cascades). Instead:
//   - if a row already has the operator's email, overwrite it in place (its id
//     is preserved, so every FK pointing at the operator stays valid);
//   - if a DIFFERENT row holds the operator's username, rename that row (id
//     preserved, its own FKs stay valid) to free the username;
//   - only when no row has the operator's email do we insert a fresh row.
async function reinjectCurrentAdmin(trx, currentAdmin) {
  if (!currentAdmin) return null;

  const emailMatch = await trx('admin_users')
    .whereRaw('lower(email) = lower(?)', [currentAdmin.email])
    .first();

  // Free the operator's username if a different row holds it (rename, not delete).
  const usernameHolder = await trx('admin_users')
    .whereRaw('lower(username) = lower(?)', [currentAdmin.username])
    .first();
  if (usernameHolder && (!emailMatch || usernameHolder.id !== emailMatch.id)) {
    await trx('admin_users')
      .where({ id: usernameHolder.id })
      .update({ username: `${usernameHolder.username}__restored_${usernameHolder.id}` });
  }

  if (emailMatch) {
    // Update in place — keeps emailMatch.id so restored FKs to the operator
    // hold. Write only the AUTH-critical columns (login identity + credentials
    // + MFA), never the relationship/audit FKs (role_id → roles, created_by →
    // admin_users). Forcing the operator's pre-restore role_id/created_by here
    // could reference rows absent from a cross-instance backup and dangle the
    // FK (SQLite rolls back at commit); the row already carries the backup's
    // own valid values for those. This still closes the MFA-hijack gap — a
    // crafted backup can't strip or replace the operator's second factor.
    const authUpdate = {};
    for (const field of PRESERVED_AUTH_FIELDS) {
      if (field in currentAdmin) authUpdate[field] = currentAdmin[field];
    }
    await trx('admin_users').where({ id: emailMatch.id }).update(authUpdate);
    return emailMatch.id;
  } else {
    // The operator's email isn't in the backup, so nothing restored references
    // their id — a fresh row can't dangle a reference TO the operator. Null the
    // self-referential created_by (its target admin may be absent from this
    // backup; ON DELETE SET NULL makes null the correct "unknown inviter"
    // value) so the insert itself can't dangle. Use an explicit max(id)+1
    // rather than the identity sequence, which batchInsert left unadvanced on
    // Postgres (a sequence-based insert could collide with a restored id).
    const snapshot = { ...currentAdmin };
    delete snapshot.id;
    if ('created_by' in snapshot) snapshot.created_by = null;
    const maxRow = await trx('admin_users').max({ m: 'id' }).first();
    snapshot.id = (Number(maxRow && maxRow.m) || 0) + 1;
    await trx('admin_users').insert(snapshot);
    return snapshot.id;
  }
}

// Capture the operator's role and its granted permission NAMES before the wipe,
// so preserveOperatorRole() can re-establish the operator's authorization after
// the RBAC tables are replaced. Permission NAMES (not ids) are captured because
// the restored permissions table reassigns ids. Returns null if the operator
// has no role.
async function captureOperatorRole(roleId) {
  if (!roleId) return null;
  const role = await db('roles').where({ id: roleId }).first();
  if (!role) return null;
  const permissions = await db('role_permissions')
    .join('permissions', 'permissions.id', 'role_permissions.permission_id')
    .where('role_permissions.role_id', roleId)
    .pluck('permissions.name');
  return { role, permissions };
}

// Restore the operator's authorization after roles/role_permissions are
// replaced. A restore rewrites the RBAC tables, so the operator's pre-restore
// role_id may now name a different (or missing) role — a crafted backup could
// silently downgrade them, and reinjectCurrentAdmin deliberately does NOT copy
// role_id (it could dangle). Here we resolve the role by NAME against the
// restored data: if a role with the operator's role name exists we trust it
// (it's the backup the operator chose to restore); otherwise we re-create the
// role from the captured snapshot and re-grant the captured permissions that
// still exist, so the operator can never be locked out of their own instance.
async function preserveOperatorRole(trx, operatorId, snapshot) {
  if (!operatorId || !snapshot || !snapshot.role) return;
  const { role, permissions } = snapshot;

  let target = await trx('roles').whereRaw('lower(name) = lower(?)', [role.name]).first();
  if (!target) {
    const roleRow = { ...role };
    delete roleRow.id;
    const maxRole = await trx('roles').max({ m: 'id' }).first();
    const newRoleId = (Number(maxRole && maxRole.m) || 0) + 1; // sequence resynced post-commit
    roleRow.id = newRoleId;
    await trx('roles').insert(roleRow);
    if (permissions && permissions.length) {
      const perms = await trx('permissions').whereIn('name', permissions).select('id');
      if (perms.length) {
        await trx('role_permissions').insert(
          perms.map((p) => ({ role_id: newRoleId, permission_id: p.id }))
        );
      }
    }
    target = { id: newRoleId };
  }
  await trx('admin_users').where({ id: operatorId }).update({ role_id: target.id });
}

// Fast-forward each restored table's Postgres identity sequence to its current
// max(id). batchInsert writes explicit ids without advancing the sequence, so
// the next natural insert into any restored table (a new event, an accepted
// invitation, etc.) would otherwise collide on the primary key. Runs AFTER the
// restore transaction commits (setval is non-transactional and would survive a
// rollback) and guards every table with a column-existence check —
// pg_get_serial_sequence RAISES on a table lacking an `id` column (e.g. the
// composite-key role_permissions), so an unguarded call would abort here.
// No-op on SQLite, whose AUTOINCREMENT tracks the high-water mark itself.
async function resyncSequences(tables) {
  if (!isPostgres()) return;
  for (const table of tables) {
    try {
      if (!(await db.schema.hasColumn(table, 'id'))) continue;
      const res = await db.raw('SELECT pg_get_serial_sequence(?, ?) AS seq', [table, 'id']);
      const seq = res && res.rows && res.rows[0] && res.rows[0].seq;
      if (!seq) continue; // `id` isn't a serial/identity column
      await db.raw(
        'SELECT setval(?, (SELECT COALESCE(MAX(id), 1) FROM ??), (SELECT MAX(id) IS NOT NULL FROM ??))',
        [seq, table, table]
      );
    } catch (err) {
      logger.warn(`[picpeak-import] could not resync sequence for ${table}: ${err.message}`);
    }
  }
}

// AUTH-critical admin_users columns preserved when overwriting a restored row
// that shares the operator's email. Deliberately excludes relationship/audit
// FKs (role_id, created_by) — see reinjectCurrentAdmin for why.
const PRESERVED_AUTH_FIELDS = [
  'username', 'email', 'password_hash', 'is_active', 'must_change_password',
  'two_factor_enabled', 'two_factor_secret', 'two_factor_recovery_codes', 'two_factor_enrolled_at',
];

// The json/jsonb columns of a table (Postgres only). The pg driver returns
// jsonb as parsed JS values, so on re-insert they must be serialised back to
// valid JSON text — otherwise a scalar like the string "PicPeak" is sent
// unquoted and pg rejects it ("invalid input syntax for type json").
async function jsonColumnsFor(trx, table) {
  if (!isPostgres()) return new Set();
  const res = await trx.raw(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ? AND data_type IN ('json', 'jsonb')",
    [table]
  );
  return new Set(res.rows.map((r) => r.column_name));
}

function serialiseJsonColumns(rows, jsonCols) {
  if (!jsonCols.size) return rows;
  return rows.map((row) => {
    const out = { ...row };
    for (const col of jsonCols) {
      if (out[col] !== undefined && out[col] !== null) out[col] = JSON.stringify(out[col]);
    }
    return out;
  });
}

// Cross-engine loads only (#1038): SQLite has no real date or boolean types, so
// its rows carry epoch numbers where Postgres wants a timestamp and 0/1 where
// Postgres wants a boolean. Both are rejected outright by pg
// ("date/time field value out of range: 1786548038763"). Coerce per column,
// driven by the TARGET schema so nothing is guessed from the value alone.
// Same-engine restores never call this and are byte-for-byte unchanged.
async function typedColumnsFor(trx, table) {
  const info = await trx(table).columnInfo();
  const timestamps = [];
  const booleans = [];
  for (const [name, meta] of Object.entries(info)) {
    const type = String(meta.type || '').toLowerCase();
    if (type.includes('timestamp') || type === 'date' || type === 'datetime') timestamps.push(name);
    else if (type === 'boolean' || type === 'bool') booleans.push(name);
  }
  return { timestamps, booleans };
}

// SQLite writes Date objects as epoch MILLISECONDS in production, but some rows
// (and older installs) carry epoch seconds. 1e11 sits far past any plausible
// seconds value and far below any plausible ms value, so it separates them
// cleanly for every date this application will ever see.
function epochToIso(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  const ms = Math.abs(n) < 1e11 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

function coerceForTargetEngine(rows, { timestamps, booleans }) {
  if (!timestamps.length && !booleans.length) return rows;
  return rows.map((row) => {
    const out = { ...row };
    for (const col of timestamps) {
      const v = out[col];
      if (v === null || v === undefined || v === '') continue;
      if (typeof v === 'number' || (typeof v === 'string' && /^-?\d+$/.test(v))) {
        out[col] = epochToIso(v);
      }
    }
    for (const col of booleans) {
      const v = out[col];
      if (v === null || v === undefined) continue;
      if (typeof v === 'number') out[col] = v !== 0;
      else if (typeof v === 'string') out[col] = !['0', 'false', ''].includes(v.toLowerCase());
    }
    return out;
  });
}

// Whole-DB replace in one transaction with FK enforcement suspended (pg:
// session_replication_role=replica on the trx connection, reset before commit;
// sqlite: defer_foreign_keys so checks run at commit). knex_migrations is never
// in the data set, so the target's schema/migration state is left intact.
async function replaceAllTables(tables, dataDir, currentAdmin, roleSnapshot, { crossEngine = false } = {}) {
  await db.transaction(async (trx) => {
    if (isPostgres()) {
      try {
        await trx.raw("SET session_replication_role = 'replica'");
      } catch (_) {
        // session_replication_role requires a Postgres SUPERUSER. The bundled
        // postgres image's role is one; managed Postgres (RDS / Cloud SQL / …)
        // app users usually are not. Fail fast with a clear message BEFORE any
        // rows are deleted — the transaction rolls back, so nothing is wiped.
        const err = new Error(
          'Restore needs a PostgreSQL superuser to suspend foreign-key checks during the full replace, but this instance’s database user is not a superuser (common on managed Postgres such as RDS or Cloud SQL). Restore onto the bundled Postgres, or grant the role superuser for the restore.'
        );
        err.statusCode = 400;
        throw err;
      }
    } else {
      await trx.raw('PRAGMA defer_foreign_keys = ON');
    }

    for (const table of tables) {
      await trx(table).del();
    }

    // Face data (#1074) is excluded from the archive, which also excludes it
    // from `tables` — so the LOCAL rows would survive a whole-DB replace.
    // FK enforcement is deliberately suspended during import, so those
    // orphans can end up attached to reused photo/event ids from the incoming
    // archive: one instance's biometric data silently adopted by another's
    // galleries. Purge them explicitly.
    for (const faceTable of ['photo_faces', 'event_people']) {
      try {
        await trx(faceTable).del();
      } catch (err) {
        // Absent on targets that predate migration 177 — nothing to purge.
      }
    }

    for (const table of tables) {
      const rows = parseNdjson(path.join(dataDir, `${table}.ndjson`));
      if (!rows.length) continue;
      const jsonCols = await jsonColumnsFor(trx, table);
      let prepared = rows;
      let toSerialise = jsonCols;
      if (crossEngine) {
        prepared = coerceForTargetEngine(prepared, await typedColumnsFor(trx, table));
        // A sqlite-sourced archive already carries JSON columns as valid JSON
        // TEXT, which is exactly what pg wants. Serialising again would store
        // `{"a":1}` as the scalar string "{\"a\":1}" and would turn the JSON
        // literal `null` into SQL NULL.
        toSerialise = new Set();
      }
      prepared = serialiseJsonColumns(prepared, toSerialise);
      await trx.batchInsert(table, prepared, 100);
    }

    const operatorId = await reinjectCurrentAdmin(trx, currentAdmin);
    if (operatorId && roleSnapshot) {
      await preserveOperatorRole(trx, operatorId, roleSnapshot);
    }

    // Reset the pg session flag BEFORE the connection returns to the pool.
    if (isPostgres()) await trx.raw("SET session_replication_role = 'origin'");
  });
}

// Copy the archive's files/ tree into storage, overwriting existing files.
async function restoreFiles(stagingDir) {
  const src = path.join(stagingDir, 'files');
  if (!fs.existsSync(src)) return 0;
  const storageRoot = getStoragePath();
  let count = 0;
  async function walk(rel) {
    const abs = path.join(src, rel);
    for (const entry of await fsp.readdir(abs, { withFileTypes: true })) {
      const childRel = path.join(rel, entry.name);
      if (entry.isDirectory()) {
        await walk(childRel);
      } else if (entry.isFile()) {
        const dest = path.join(storageRoot, childRel);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.copyFile(path.join(src, childRel), dest);
        count += 1;
      }
    }
  }
  await walk('');
  return count;
}

// Does the restored data reference an external-media library? If so the caller
// shows a banner telling the admin to (re)configure the external-media mount on
// this instance — those files are NOT in the backup by design.
async function detectExternalMedia() {
  try {
    if (await hasColumnCached('events', 'external_path')) {
      const row = await db('events').whereNotNull('external_path').first();
      if (row) return true;
    }
    if (await hasColumnCached('photos', 'external_relpath')) {
      const row = await db('photos').whereNotNull('external_relpath').first();
      if (row) return true;
    }
  } catch (_) {
    // Best-effort — a detection miss is not worth failing the restore.
  }
  return false;
}

/**
 * Restore a .picpeak onto this instance.
 * @param {Object} opts
 * @param {string} opts.picpeakPath  path to the uploaded/staged .picpeak
 * @param {number} [opts.currentAdminId]  admin to preserve across the wipe
 * @returns {Promise<{restored:boolean, tables:number, filesRestored:number, usesExternalMedia:boolean, crossEngine:boolean, manifest:object}>}
 */
async function importFromPicpeak({ picpeakPath, currentAdminId }) {
  const manifest = await readManifestFromZip(picpeakPath);
  const blockers = await validateManifest(manifest);
  if (blockers.length) {
    const err = new Error(blockers[0]);
    err.statusCode = 400;
    err.validation = blockers;
    throw err;
  }

  // Archives predating the manifest engine field get the target's engine —
  // i.e. the exact same-engine behavior. After validateManifest, a mismatch
  // can only be sqlite → pg.
  const targetEngine = isPostgres() ? 'pg' : 'sqlite';
  const sourceEngine = (manifest.database && manifest.database.engine) || targetEngine;
  const crossEngine = sourceEngine !== targetEngine;
  if (crossEngine) {
    logger.info(`[picpeak-import] cross-engine restore: ${sourceEngine} backup onto ${targetEngine} instance`);
  }

  const currentAdmin = currentAdminId
    ? await db('admin_users').where({ id: currentAdminId }).first()
    : null;
  // Capture the operator's role + granted permission names BEFORE the wipe so
  // their authorization can be re-established after the RBAC tables are replaced.
  const roleSnapshot = currentAdmin ? await captureOperatorRole(currentAdmin.role_id) : null;

  const staging = await fsp.mkdtemp(path.join(os.tmpdir(), 'picpeak-import-'));
  try {
    const zip = new StreamZip.async({ file: picpeakPath });
    try {
      // Reject ZIP-slip entries before extracting — a crafted .picpeak could
      // otherwise write outside the staging dir via `../` entry names
      // (same class as GHSA-jfhw-fj23-fx6x).
      assertZipEntriesWithin(Object.values(await zip.entries()), staging);
      await zip.extract(null, staging);
    } finally {
      await zip.close();
    }

    const dataDir = path.join(staging, 'data');
    // Only touch tables that (a) the uploaded manifest lists AND (b) actually
    // exist as real tables in THIS database. listDataTables() already excludes
    // knex_migrations/_lock (EXCLUDED_TABLES), so a crafted or corrupted
    // .picpeak can never make the restore delete the migration bookkeeping — or
    // any table that isn't a genuine data table here.
    const dbTables = new Set(await listDataTables());
    const manifestTables = Object.keys(manifest.tables || {});
    const tables = manifestTables.filter((tbl) => dbTables.has(tbl) && !EXCLUDED_TABLES.has(tbl));
    const skipped = manifestTables.filter((tbl) => !tables.includes(tbl));
    if (skipped.length) {
      logger.warn(`[picpeak-import] ignoring ${skipped.length} backup table(s) not present in this DB (or protected): ${skipped.join(', ')}`);
    }

    await replaceAllTables(tables, dataDir, currentAdmin, roleSnapshot, { crossEngine });

    // Post-commit fixups (must NOT run inside the restore transaction):
    //  - resync Postgres identity sequences left behind by the explicit-id
    //    batchInsert, so the next natural insert doesn't collide;
    //  - stamp a global session cutoff so every JWT issued before this restore
    //    (admin, customer, gallery) stops authenticating — ids may have shifted.
    await resyncSequences(tables);
    await setSessionsValidAfter(Math.floor(Date.now() / 1000));


    const filesRestored = await restoreFiles(staging);

    // Face data (#1074): queue ONLY once the files are on disk. The archive
    // carries no face rows and the export blanked photos.face_status, but the
    // event toggles come across enabled, so the "enable" transition that
    // normally triggers a backfill never happens here.
    //
    // Ordering matters: the worker is live during a restore. Queued before
    // restoreFiles, it races the copy and either scans the PREVIOUS
    // instance's files or marks photos failed for originals that are not
    // there yet — and nothing re-queues them afterwards.
    try {
      const requeued = await db('photos')
        .whereIn('event_id', db('events').select('id').where('face_recognition_enabled', true))
        .update({
          face_status: 'pending', face_count: null, face_started_at: null, face_error: null,
        });
      if (requeued > 0) {
        logger.info(`picpeakImport: queued ${requeued} photo(s) for face detection after import`);
      }
    } catch (err) {
      logger.debug?.(`picpeakImport: face requeue skipped: ${err.message}`);
    }
    const usesExternalMedia = await detectExternalMedia();

    logger.info(
      `[picpeak-import] restored ${tables.length} tables, ${filesRestored} files (externalMedia=${usesExternalMedia}, crossEngine=${crossEngine})`
    );
    return { restored: true, tables: tables.length, filesRestored, usesExternalMedia, crossEngine, manifest };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  importFromPicpeak,
  readManifestFromZip,
  validateManifest,
  // exported for testing — the cross-engine coercion (#1038)
  epochToIso,
  coerceForTargetEngine,
  typedColumnsFor,
  reinjectCurrentAdmin,
  captureOperatorRole,
  preserveOperatorRole,
  resyncSequences,
};
