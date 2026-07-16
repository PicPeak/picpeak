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
// Same-engine only (pg↔pg / sqlite↔sqlite) and forward-only (an older backup
// restores onto a newer instance; a newer backup is refused). The target's own
// schema is used as-is — we never replay the backup's DDL.

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
  if (manifest.database && manifest.database.engine && manifest.database.engine !== engine) {
    errors.push(`Database engine mismatch: the backup is "${manifest.database.engine}" but this instance is "${engine}". Restore is only supported between matching engines.`);
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
  if (!currentAdmin) return;

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

// Whole-DB replace in one transaction with FK enforcement suspended (pg:
// session_replication_role=replica on the trx connection, reset before commit;
// sqlite: defer_foreign_keys so checks run at commit). knex_migrations is never
// in the data set, so the target's schema/migration state is left intact.
async function replaceAllTables(tables, dataDir, currentAdmin) {
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
    for (const table of tables) {
      const rows = parseNdjson(path.join(dataDir, `${table}.ndjson`));
      if (!rows.length) continue;
      const jsonCols = await jsonColumnsFor(trx, table);
      await trx.batchInsert(table, serialiseJsonColumns(rows, jsonCols), 100);
    }

    await reinjectCurrentAdmin(trx, currentAdmin);

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
 * @returns {Promise<{restored:boolean, tables:number, filesRestored:number, usesExternalMedia:boolean, manifest:object}>}
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

  const currentAdmin = currentAdminId
    ? await db('admin_users').where({ id: currentAdminId }).first()
    : null;

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

    await replaceAllTables(tables, dataDir, currentAdmin);
    const filesRestored = await restoreFiles(staging);
    const usesExternalMedia = await detectExternalMedia();

    logger.info(
      `[picpeak-import] restored ${tables.length} tables, ${filesRestored} files (externalMedia=${usesExternalMedia})`
    );
    return { restored: true, tables: tables.length, filesRestored, usesExternalMedia, manifest };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  importFromPicpeak,
  readManifestFromZip,
  validateManifest,
  reinjectCurrentAdmin,
};
