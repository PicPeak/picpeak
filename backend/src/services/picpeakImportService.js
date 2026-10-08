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
const path = require('path');
const { TextDecoder } = require('util');
const boundedArchive = require('./portableImportArchive');
const { STORED_PATH_COLUMNS, relocateStoredPath } = require('../utils/storedPath');
const { db } = require('../database/db');
const knexConfig = require('../../knexfile');
const { hasColumnCached } = require('../utils/schemaCache');
const logger = require('../utils/logger');
const { PICPEAK_FORMAT_VERSION } = require('./picpeakExportService');
const { normaliseSqliteEmailQueue } = require('../utils/queueTimestamps');
const { canonicaliseSqliteExpiresAt } = require('../utils/expiresAtText');
const { rowBatches } = require('./portableImportRows');
const {
  dedupeExternalPhotos,
  createExternalRelpathIndex,
  dropExternalRelpathIndex,
} = require('./externalPhotoDedupe');

const isPostgres = () => knexConfig.client === 'pg';

// Compare migrations by their numeric filename prefix (001_, 107_, 129_ …).
function migrationOrder(name) {
  const m = String(name || '').match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : -1;
}

function archiveLimitError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

// The exporter writes exactly these storage subtrees under files/
// (picpeakExportService: DOC_DIRS, PHOTO_DIRS, and legacy documents, which
// isPlaceablePath keeps under the DOC_DIRS). Everything else in an archive
// was not produced by PicPeak and is refused before any live state changes:
// the import copies files/ into STORAGE_PATH as-is, and some of that tree is
// served publicly (fonts/, uploads/logos, uploads/favicons).
const IMPORT_FILE_ROOTS = ['business-docs', 'uploads', 'transfers', 'events/active', 'events/archived',
  'thumbnails', 'previews', 'heroes', 'videos', 'watermarks'];
// The storage subtrees (inside the roots above) that the app serves as
// static web content, without authentication:
//   uploads/logos     backend/server.js `app.use('/uploads/logos', secureStatic(...))`
//   uploads/favicons  backend/server.js `app.use('/uploads/favicons', secureStatic(...))`,
//                     and the /favicon.ico handler, which streams from both
// frontend/nginx.conf proxies `location ^~ /uploads` to those mounts and
// serves no storage path itself. fonts/ is served too but is not an import
// root; /photos and /thumbnails are no longer mounted. Everything else under
// the roots — transfer attachments (uploads/transfers/<id>/...), signed
// contracts, business documents, event media — is handed out by authorised
// routes as an attachment under its stored name, never as a page.
const IMPORT_PUBLICLY_SERVED_PREFIXES = ['uploads/logos', 'uploads/favicons'];
// Active web content must never land in a served subtree through an archive.
// SVG is deliberately not here: it is a supported logo format and
// secureStatic serves it under a script-blocking CSP. Outside the served
// subtrees the extension is just a name: a client may well have uploaded
// `payload.js` or `page.html` to a transfer, and a genuine export carries it.
const IMPORT_FORBIDDEN_EXTENSIONS = new Set(['.html', '.htm', '.xhtml', '.xht', '.shtml', '.js', '.mjs', '.cjs']);

/**
 * Why a storage-relative file path from an archive's files/ tree may not be
 * restored, or null when it may. `rel` is POSIX, without the files/ prefix.
 */
function importFilePathProblem(rel) {
  const parts = rel.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) return 'malformed path';
  const root = IMPORT_FILE_ROOTS.find((r) => rel === r || rel.startsWith(`${r}/`));
  if (!root || rel === root) return `not under an exported storage folder (${IMPORT_FILE_ROOTS.join(', ')})`;
  // Compared case-insensitively: a case-insensitive filesystem would land
  // `uploads/Logos/x.html` in the served directory all the same.
  const lower = rel.toLowerCase();
  const served = IMPORT_PUBLICLY_SERVED_PREFIXES.some((prefix) => lower.startsWith(`${prefix}/`));
  if (served && IMPORT_FORBIDDEN_EXTENSIONS.has(path.posix.extname(lower))) return 'active web content';
  return null;
}

/** Refuse an archive whose files/ entries the exporter could not have written. */
function assertFilesEntriesAllowed(entries) {
  for (const entry of entries || []) {
    if (!entry || !entry.name || entry.isDirectory) continue;
    const name = String(entry.name).replace(/\\/g, '/');
    if (!name.startsWith('files/')) continue;
    const problem = importFilePathProblem(name.slice('files/'.length));
    if (problem) {
      const err = archiveLimitError(`Archive contains a file PicPeak would not have exported (${problem}): ${name}`, 400);
      err.code = 'UNSUPPORTED_ARCHIVE_FILE';
      throw err;
    }
  }
}

// Compatibility exports share the exact bounded archive boundary used by the
// supervised worker. Preview enumeration is also bounded before entry storage.
function assertArchiveWithinLimits(entries, extractDir, options = {}) {
  return boundedArchive.assertArchiveWithinLimits(entries, extractDir,
    { ...options, validateFileKey: importFilePathProblem });
}
function extractWithinLimits(zip, entries, extractDir, options = {}) {
  return boundedArchive.extractWithinLimits(zip, entries, extractDir,
    { ...options, validateFileKey: importFilePathProblem });
}
async function readManifestFromZip(picpeakPath) {
  const zip = await boundedArchive.openBoundedArchive(picpeakPath, { validateFileKey: importFilePathProblem });
  try {
    const tooLarge = () => archiveLimitError('The backup manifest is too large to be a PicPeak manifest.', 400);
    const bytes = await boundedArchive.readEntryWithin(zip, 'manifest.json', boundedArchive.HARD_LIMITS.manifestBytes, tooLarge);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { await zip.close(); }
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
async function captureOperatorRole(roleId, executor = db) {
  if (!roleId) return null;
  const role = await executor('roles').where({ id: roleId }).first();
  if (!role) return null;
  const permissions = await executor('role_permissions')
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
async function resyncSequences(tables, { executor = db, strict = false } = {}) {
  if (!isPostgres()) return;
  for (const table of tables) {
    try {
      if (!(await executor.schema.hasColumn(table, 'id'))) continue;
      const res = await executor.raw('SELECT pg_get_serial_sequence(?, ?) AS seq', [table, 'id']);
      const seq = res && res.rows && res.rows[0] && res.rows[0].seq;
      if (!seq) continue; // `id` isn't a serial/identity column
      await executor.raw(
        'SELECT setval(?, (SELECT COALESCE(MAX(id), 1) FROM ??), (SELECT MAX(id) IS NOT NULL FROM ??))',
        [seq, table, table]
      );
    } catch (err) {
      if (strict) throw err;
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
  // Whether SSO may link to this row by email (migration 227) — auth state,
  // so a backup must not set it for the operator either.
  'email_link_eligible',
];

// The json/jsonb columns of a table (Postgres only). The pg driver returns
// jsonb as parsed JS values, so on re-insert they must be serialised back to
// valid JSON text — otherwise a scalar like the string "PicPeak" is sent
// unquoted and pg rejects it ("invalid input syntax for type json").
async function jsonColumnsFor(trx, table) {
  if (!isPostgres()) return new Set();
  const res = await trx.raw(
    'SELECT column_name FROM information_schema.columns WHERE table_schema = \'public\' AND table_name = ? AND data_type IN (\'json\', \'jsonb\')',
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

// Columns that name a file by a key relative to a root this install joins it
// onto: the storage root for archives, photos and their derived files, the
// external media root for referenced photos. Readers contain most of them
// (photoResolver, the storage backends), but archive_path and watermark_path
// are joined raw in places, and the rows arrive here straight from the
// archive's ndjson, so a crafted .picpeak could plant `../` values that reach
// files outside storage. No legitimate row carries a `..` segment in any of
// these columns, so the whole import is refused rather than the row skipped:
// a backup that was tampered with is not one to restore in part.
const CONTAINED_PATH_COLUMNS = {
  events: ['archive_path'],
  photos: ['path', 'thumbnail_path', 'watermark_path', 'external_relpath'],
};

function assertContainedPaths(table, rows) {
  const columns = CONTAINED_PATH_COLUMNS[table];
  if (!columns) return;
  for (const row of rows) {
    for (const column of columns) {
      const value = row[column];
      if (typeof value !== 'string' || !value) continue;
      if (value.split(/[\\/]+/).includes('..')) {
        throw archiveLimitError(
          `The backup's ${table}.${column} contains a path that climbs out of its directory (${JSON.stringify(value)}); the archive is refused.`,
          400,
        );
      }
    }
  }
}

// Stored file paths (storedPath.js). A source install recorded generated PDFs,
// signature images and uploads as absolute paths under ITS storage root; the
// files land under this install's root (restoreFiles), so each path is
// rewritten to the storage-relative form, which resolves here whatever the
// two roots are called. When a path has more than one candidate suffix, the
// one the archive actually carries under files/ wins. Values that are already
// relative, or name nothing under a storage folder, are left as they are.
function relocateStoredPaths(table, rows, filesDir) {
  const columns = STORED_PATH_COLUMNS.filter((c) => c.table === table).map((c) => c.column);
  if (!columns.length) return rows;
  const inArchive = (rel) => fs.existsSync(path.join(filesDir, ...rel.split('/')));
  return rows.map((row) => {
    const out = { ...row };
    for (const col of columns) {
      if (typeof out[col] === 'string') out[col] = relocateStoredPath(out[col], inArchive);
    }
    return out;
  });
}

// Tables a migration seeds with mandatory system/lookup rows ONLY at table-
// creation time (inside its `hasTable` guard, or — product_usage_state — a
// one-time row-existence check that behaves the same way once the migration
// has run), with no runtime re-seed path anywhere else in the app. Unlike
// genuine user-data tables, clearing these to empty on a restore whose
// archive predates the seeding migration is wrong: the row(s) are gone for
// good (migrations never re-run once applied) and either crash a live
// endpoint (product_usage_state) or silently break a feature with no
// recovery UI (accounting chart of accounts/VAT codes/categories, CRM
// payment-term templates, the contract block library). Verified by reading
// each migration + its consuming service; other seed-in-guard tables such as
// `business_profile`, `roles`/`permissions`, `backup_paths` and the various
// email templates already self-heal at runtime (see businessProfileService
// .getProfile(), _permissionsBoot.js, _backupPathsBoot.js, etc.) and are
// deliberately NOT listed here.
//
// Guarded contract (seedOnlyTablesContract.test.js): after running every core
// migration on a fresh DB, the set of exported tables that hold rows must
// equal SEED_ONLY_TABLES plus that test's commented exemption list. A new
// migration that seeds rows therefore fails the test until its table is
// classified: add it HERE when an archive can predate the table and nothing
// reseeds it at runtime; add it to the test's exemption list (with the reason)
// otherwise. Never list a table that holds user data: a listed table the
// archive lacks keeps its LOCAL rows across the restore, which is the #1586
// leak shape this clear exists to close.
const SEED_ONLY_TABLES = new Set([
  'public_upload_lock',          // 266 — id=1 serialization singleton, no user data; old archives must not erase it
  'product_usage_state',        // migrations/core/201_product_usage.js — id=1 singleton; UsageService.status() dereferences it unguarded
  'ledger_accounts',             // migrations/core/129_create_ledger_accounts_and_vat_codes.js — Swiss/LI chart of accounts
  'vat_codes',                   // migrations/core/129_create_ledger_accounts_and_vat_codes.js — MWST codes, FK to ledger_accounts
  'expense_categories',          // migrations/core/124_create_inbound_documents_and_expenses.js — default expense category labels
  'payment_term_templates',      // migrations/core/107_crm_consolidated.js — legacy system payment-term templates
  'payment_net_days_templates',  // migrations/core/107_crm_consolidated.js — split net-days templates
  'payment_timing_templates',    // migrations/core/107_crm_consolidated.js — split timing templates
  'contract_blocks',             // migrations/core/107_crm_consolidated.js (orig. 130) — system contract clause library
]);

// Whole-DB replace in one transaction with FK enforcement suspended (pg:
// session_replication_role=replica on the trx connection, reset before commit;
// sqlite: defer_foreign_keys so checks run at commit). knex_migrations is never
// in the data set, so the target's schema/migration state is left intact.
async function replaceAllTables(tables, dataDir, currentAdmin, roleSnapshot, { crossEngine = false, allTables, executor } = {}) {
  await require('./portableRestoreWorker').assertWorkerAuthority(executor);
  const replace = async trx => {
    if (isPostgres()) {
      try {
        await trx.raw('SET session_replication_role = \'replica\'');
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

    // Suspending FK enforcement does not suspend UNIQUE indexes on either
    // engine (#1162). A backup taken before migration 186 carries the
    // duplicate photo rows that migration exists to remove, so batchInsert
    // below would hit photos_event_external_relpath_uniq and roll the whole
    // restore back — after every table had already been emptied. Drop it for
    // the load and rebuild it once the rows are deduped, which is the same
    // repair the migration performs.
    let hadRelpathIndex = false;
    if (await trx.schema.hasColumn('photos', 'external_relpath')) {
      hadRelpathIndex = true;
      await dropExternalRelpathIndex(trx);
    }

    // Clear every table the CURRENT schema exports (`allTables`), not just
    // the tables this archive's manifest lists (`tables`, a subset of it).
    // An archive made before a table existed carries no rows for it, so
    // clearing only `tables` would leave that table's LOCAL rows in place —
    // attached to whatever restored row happens to reuse the same id (#1586:
    // an archive predating customer_groups left local group memberships
    // pointing at the wrong restored customers after the restore). For a
    // feature absent from the archive, empty is the correct restored state.
    //
    // This subsumes the one-off fix this used to be (clearing
    // accounting_change_history when the archive predated it): `allTables`
    // already includes that table whenever this instance has it, which is
    // the same condition that fix checked for explicitly.
    //
    // Exception: a SEED_ONLY_TABLES table whose rows the archive does NOT
    // carry (the archive predates the migration that seeds it) is skipped
    // here rather than cleared — see SEED_ONLY_TABLES above. When the
    // archive DOES carry the table (it's in `tables`), clear it as normal:
    // the reinsert loop below replaces it with the archive's rows, and
    // skipping the clear would leave stale local rows colliding with the
    // reinserted ones on unique constraints (e.g. ledger_accounts.number).
    const manifestTableSet = new Set(tables);
    const tablesToClear = new Set(allTables || tables);
    // Download limit grants (issue 1560) too: an archive made before they
    // existed would leave local grants on restored photos whose ids happen
    // to match, using up those galleries' quotas.
    if (await trx.schema.hasTable('event_download_grants')) tablesToClear.add('event_download_grants');
    for (const table of tablesToClear) {
      if (SEED_ONLY_TABLES.has(table) && !manifestTableSet.has(table)) continue;
      await trx(table).del();
    }

    // Face data (#1074) is excluded from the archive, which also excludes it
    // from `tables` — so the LOCAL rows would survive a whole-DB replace.
    // FK enforcement is deliberately suspended during import, so those
    // orphans can end up attached to reused photo/event ids from the incoming
    // archive: one instance's biometric data silently adopted by another's
    // galleries. Purge them explicitly.
    for (const faceTable of ['photo_faces', 'event_people', 'event_people_merge_dismissals']) {
      try {
        await trx(faceTable).del();
      } catch (err) {
        // Absent on targets that predate migration 177 — nothing to purge.
      }
    }

    for (const table of tables) {
      const jsonCols = await jsonColumnsFor(trx, table);
      const types = crossEngine ? await typedColumnsFor(trx, table) : null;
      for await (const rows of rowBatches(path.join(dataDir, `${table}.ndjson`), { allowMissing: true })) {
        let prepared = rows;
        if (crossEngine) prepared = coerceForTargetEngine(prepared, types);
        // SQLite JSON is already serialized; PG JSON values need serialization.
        prepared = serialiseJsonColumns(prepared, crossEngine ? new Set() : jsonCols);
        prepared = relocateStoredPaths(table, prepared, path.join(path.dirname(dataDir), 'files'));
        assertContainedPaths(table, prepared);
        await trx.batchInsert(table, prepared, prepared.length);
      }
      // Archived queue rows come back as they were, text timestamps included,
      // and migration 256 will not run again on this target (issue 1670).
      if (table === 'email_queue') await normaliseSqliteEmailQueue(trx);
      // Likewise events.expires_at text that julianday() cannot read, which
      // migration 263 rewrote once on this target (issue 1733).
      if (table === 'events') await canonicaliseSqliteExpiresAt(trx);
    }

    // Restore the constraint the load ran without. Deduping first because the
    // incoming rows may be exactly the duplicates migration 186 removes; the
    // index creation then also proves the repair worked, inside the same
    // transaction that would otherwise leave the target unprotected.
    if (hadRelpathIndex) {
      const removed = await dedupeExternalPhotos(trx);
      if (removed) {
        logger.info(`picpeakImport: removed ${removed} duplicate external photo row(s) from the archive (#1162)`);
      }
      await createExternalRelpathIndex(trx);
    }

    const operatorId = await reinjectCurrentAdmin(trx, currentAdmin);
    if (operatorId && roleSnapshot) {
      await preserveOperatorRole(trx, operatorId, roleSnapshot);
    }

    // Reset the pg session flag BEFORE the connection returns to the pool.
    if (isPostgres()) await trx.raw('SET session_replication_role = \'origin\'');
  };
  if (executor) {
    if (!executor.isTransaction) throw new Error('Portable replacement requires the held restore transaction');
    await replace(executor);
  } else await db.transaction(replace);
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
async function importFromPicpeak({ picpeakPath, currentAdminId, migrationStorageIndexPath }) {
  // All mutable entry points, including the stopped-server engine CLI, use the
  // same persistent fence and actual resource-limited Linux worker.
  const options = migrationStorageIndexPath === undefined ? {} : { migrationStorageIndexPath };
  return require('./portableRestoreCoordinator').restoreOffline({
    archivePath: picpeakPath, currentAdminId, options,
  });
}

async function importInMaintenanceWorker() {
  return require('./portableImportMaintenance').importInMaintenanceWorker();
}

async function recoverInMaintenanceWorker() {
  return require('./portableImportMaintenance').recoverInMaintenanceWorker();
}

module.exports = {
  importInMaintenanceWorker,
  recoverInMaintenanceWorker,
  replaceAllTables,
  detectExternalMedia,
  jsonColumnsFor,
  serialiseJsonColumns,
  assertContainedPaths,
  assertFilesEntriesAllowed,
  importFilePathProblem,
  importFromPicpeak,
  readManifestFromZip,
  validateManifest,
  assertArchiveWithinLimits,
  extractWithinLimits,
  // exported for testing — the cross-engine coercion (#1038)
  epochToIso,
  coerceForTargetEngine,
  typedColumnsFor,
  relocateStoredPaths,
  reinjectCurrentAdmin,
  captureOperatorRole,
  preserveOperatorRole,
  resyncSequences,
  SEED_ONLY_TABLES,
};
