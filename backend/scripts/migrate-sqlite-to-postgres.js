#!/usr/bin/env node
'use strict';

/**
 * Move an install's data from SQLite to PostgreSQL (#1038).
 *
 *   node scripts/migrate-sqlite-to-postgres.js [--force] [--keep-archive]
 *
 * For installs that have been unknowingly running on SQLite: the image used to
 * leave NODE_ENV unset, so knexfile.js fell back to its development block and
 * ignored DB_HOST/DB_USER/DB_PASSWORD. Their galleries live in the SQLite file
 * while the Postgres database they provisioned sits empty.
 *
 * This deliberately reuses the .picpeak export/import services rather than
 * hand-rolling a cross-engine copy — they already solve the parts that are easy
 * to get wrong: foreign-key suspension during the load, JSON column handling
 * per engine, and (critically) resyncing Postgres serial sequences after rows
 * are inserted with explicit ids.
 *
 * Both services bind to the global `db` at require time, so each half runs in
 * its own child process with DATABASE_CLIENT pinned — this script re-invokes
 * itself with --phase for that.
 *
 * Photos and other files on disk are NOT touched: only database rows move. The
 * SQLite file is left exactly as it was, so the migration is reversible by
 * unsetting DATABASE_CLIENT again.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BACKEND_ROOT = path.resolve(__dirname, '..');

// Same configuration sources the running backend uses. Without these, invoking
// this CLI directly (or via `docker exec`, which does not inherit the exports
// wait-for-db.sh performs) would fail the pre-flight checks below even though
// the child phases would happily read backend/.env through knexfile.
require('dotenv').config({ path: path.join(BACKEND_ROOT, '.env') });
for (const [varName, file] of [['DB_PASSWORD', 'db_password'], ['JWT_SECRET', 'jwt_secret']]) {
  const secretFile = `/run/secrets/${file}`;
  if (!process.env[varName] && fs.existsSync(secretFile)) {
    try {
      process.env[varName] = fs.readFileSync(secretFile, 'utf8').trim();
    } catch (_) { /* unreadable secret — the checks below report it */ }
  }
}

function parseArgs(argv) {
  return {
    force: argv.includes('--force'),
    keepArchive: argv.includes('--keep-archive'),
    phase: (argv.find((a) => a.startsWith('--phase=')) || '').split('=')[1] || null,
    archive: (argv.find((a) => a.startsWith('--archive=')) || '').split('=')[1] || null,
    resultFile: (argv.find((a) => a.startsWith('--result-file=')) || '').split('=')[1] || null,
    ignoreBootstrapAdmins: argv.includes('--ignore-bootstrap-admins'),
  };
}

// Resolve the Postgres target ONCE, with production defaults, and hand the same
// explicit values to every child. Otherwise the block knexfile happens to pick
// decides the database name, and the migration can land somewhere the running
// application will never open (#1038 review).
function normalisedPgEnv() {
  const { pgConnectionFromEnv } = require('../src/utils/databaseEngine');
  const c = pgConnectionFromEnv();
  return {
    DB_HOST: String(c.host),
    DB_PORT: String(c.port),
    DB_USER: String(c.user),
    DB_NAME: String(c.database),
  };
}

function runPhase(phase, client, extraArgs = []) {
  // The child's stdout is NOT a private channel: winston logs to the console
  // outside production and whenever LOG_TO_CONSOLE=true, so the payload comes
  // back through a file instead.
  const resultFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), `picpeak-phase-${phase}-`)), 'result',
  );
  try {
    const res = spawnSync(
      process.execPath,
      [__filename, `--phase=${phase}`, `--result-file=${resultFile}`, ...extraArgs],
      {
        cwd: BACKEND_ROOT,
        env: {
          ...process.env,
          ...normalisedPgEnv(),
          DATABASE_CLIENT: client,
          // Production semantics for the child regardless of how the CLI was
          // invoked: the development block ignores DB_SSL, so a managed Postgres
          // that requires TLS could not be migrated into at all.
          NODE_ENV: 'production',
        },
        stdio: ['ignore', 'inherit', 'inherit'],
        encoding: 'utf8',
      },
    );
    if (res.status !== 0) {
      throw new Error(`${phase} phase failed (exit ${res.status})`);
    }
    return fs.existsSync(resultFile) ? fs.readFileSync(resultFile, 'utf8').trim() : '';
  } finally {
    fs.rmSync(path.dirname(resultFile), { recursive: true, force: true });
  }
}

// ── phases (each runs in its own process, with DATABASE_CLIENT pinned) ────────

async function phaseExport() {
  const { createPicpeak } = require('../src/services/picpeakExportService');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-sqlite-migration-'));
  // Rows only. This moves an install between engines on the SAME machine, so
  // every file is already where it belongs; hauling business docs through /tmp
  // would just risk filling the temp disk.
  try {
    const { filePath } = await createPicpeak({ includePhotos: false, includeFiles: false, outDir });
    return filePath;
  } catch (err) {
    // createPicpeak leaves a caller-supplied outDir alone on failure, and a
    // partial archive still contains password hashes and credentials.
    fs.rmSync(outDir, { recursive: true, force: true });
    throw err;
  }
}

// Tables that are EMPTY on a freshly migrated schema, so any row in them means
// a human has used this install. Used to protect the target from being wiped
// and to decide whether the source is worth migrating (#1038 review). Tables
// missing on a given branch are skipped.
const USER_DATA_TABLES = [
  'events', 'photos', 'photo_feedback', 'admin_users', 'customer_accounts',
  'quotes', 'invoices', 'projects', 'expenses', 'inbound_documents',
];

async function tablesWithData(db, tables, { ignoreBootstrapAdmins = false } = {}) {
  const { adminsIndicateUse } = require('../src/utils/databaseEngine');
  const found = {};
  for (const table of tables) {
    if (!(await db.schema.hasTable(table))) continue;
    if (table === 'admin_users' && ignoreBootstrapAdmins) {
      // Match probePgData: one never-used seeded admin is not "user data", or
      // the migration would demand --force against an empty target.
      const cols = ['must_change_password'];
      if (await db.schema.hasColumn('admin_users', 'last_login')) cols.push('last_login');
      const rows = await db('admin_users').select(cols);
      if (adminsIndicateUse(rows)) found[table] = rows.length;
      continue;
    }
    const row = await db(table).count('* as count').first();
    const count = Number(row?.count || 0);
    if (count > 0) found[table] = count;
  }
  return found;
}

async function phaseUserData(ignoreBootstrapAdmins) {
  const { db } = require('../src/database/db');
  return JSON.stringify(await tablesWithData(db, USER_DATA_TABLES, { ignoreBootstrapAdmins }));
}

// Fingerprint EVERY table the export carries, not a hand-picked few: writes to
// an unlisted table were invisible, and count+maxId alone misses in-place
// UPDATEs (an event edit, a password change). max(updated_at) covers those
// wherever the column exists. Still not a substitute for stopping the backend —
// a table with neither `id` nor `updated_at` can be edited unnoticed — which is
// why the script says so up front.
async function phaseFingerprint() {
  const { db } = require('../src/database/db');
  const { listDataTables } = require('../src/services/picpeakExportService');
  const out = {};
  for (const table of await listDataTables()) {
    const entry = {};
    try {
      entry.count = Number((await db(table).count('* as count').first())?.count || 0);
    } catch (_) {
      continue; // table vanished mid-run; the export would fail on it anyway
    }
    for (const [key, col] of [['maxId', 'id'], ['maxUpdated', 'updated_at']]) {
      try {
        const row = await db(table).max(`${col} as v`).first();
        if (row && row.v !== null && row.v !== undefined) entry[key] = String(row.v);
      } catch (_) { /* column doesn't exist on this table */ }
    }
    out[table] = entry;
  }
  return JSON.stringify(out);
}

async function phaseMigrateSchema() {
  // runMigrations() exits the process itself (0 on success, 1 on failure), so the
  // child's exit code is the result — nothing to return.
  const { runMigrations } = require('../migrations/run-migrations-safe');
  await runMigrations();
}

async function phaseImport(archivePath) {
  const { importFromPicpeak } = require('../src/services/picpeakImportService');
  // No currentAdminId: this is a CLI, there is no operator session to preserve.
  // The SQLite install's own admin accounts come across with everything else.
  // allowEngineSwitch: moving between engines is the whole point here. The
  // upload/restore UI keeps refusing it.
  const summary = await importFromPicpeak({ picpeakPath: archivePath, allowEngineSwitch: true });
  return JSON.stringify(summary || {});
}

function summariseUserData(found) {
  return Object.entries(found).map(([t, n]) => `${t}=${n}`).join(', ');
}

function describeDrift(before, after) {
  const drifted = [];
  for (const table of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[table] || {};
    const b = after[table] || {};
    if (a.count !== b.count) {
      drifted.push(`${table}: ${a.count ?? 0} rows → ${b.count ?? 0}`);
    } else if (a.maxId !== b.maxId || a.maxUpdated !== b.maxUpdated) {
      drifted.push(`${table}: rows edited in place (max id ${a.maxId ?? '-'} → ${b.maxId ?? '-'}, `
        + `last update ${a.maxUpdated ?? '-'} → ${b.maxUpdated ?? '-'})`);
    }
  }
  return drifted;
}

// Set once the export exists; every failure path clears it (the archive holds
// plaintext secrets, so leaving it behind on error is not acceptable).
let archiveToClean = null;

function cleanupArchive() {
  if (!archiveToClean) return;
  try {
    fs.rmSync(path.dirname(archiveToClean), { recursive: true, force: true });
  } catch (err) {
    console.error(`  WARNING: could not remove ${archiveToClean} (${err.message}) — it contains`
      + ' plaintext secrets, delete it by hand.');
  }
  archiveToClean = null;
}

// ── orchestration ────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Child phase. The knex pool holds the event loop open, so finish by flushing
  // stdout and exiting explicitly — otherwise the parent's spawnSync waits on a
  // process that will never end by itself.
  if (args.phase) {
    const payload = args.phase === 'export' ? await phaseExport()
      : args.phase === 'fingerprint' ? await phaseFingerprint()
        : args.phase === 'user-data' ? await phaseUserData(args.ignoreBootstrapAdmins)
          : args.phase === 'import' ? await phaseImport(args.archive)
            : await phaseMigrateSchema();
    if (args.resultFile) fs.writeFileSync(args.resultFile, String(payload ?? ''));
    // The knex pool holds the event loop open; exit explicitly or the parent's
    // spawnSync waits on a process that will never end by itself.
    process.exit(0);
  }

  const { resolveSqlitePath } = require('../src/utils/databaseEngine');
  const sqlitePath = resolveSqlitePath();

  console.log('PicPeak — SQLite → PostgreSQL migration\n');

  if (!fs.existsSync(sqlitePath)) {
    console.error(`No SQLite database at ${sqlitePath}. Nothing to migrate.`);
    process.exit(1);
  }

  if (process.env.DATABASE_CLIENT && process.env.DATABASE_CLIENT !== 'pg') {
    console.error(
      `This deployment pins DATABASE_CLIENT=${process.env.DATABASE_CLIENT}.\n`
      + 'After the migration the application must run on PostgreSQL — the SQLite file is\n'
      + 'renamed out of the way, so a restart with this setting would create a NEW, empty\n'
      + 'SQLite database and serve that instead of your data.\n\n'
      + 'Set DATABASE_CLIENT=pg (or remove it) in your deployment, then run this again.'
    );
    process.exit(1);
  }

  // Not a refusal: an unset NODE_ENV is exactly the state the affected installs
  // are in, and refusing would block the people this script is for. The success
  // marker makes the boot resolve to Postgres regardless; this just tells the
  // operator to make it explicit.
  if (!process.env.DATABASE_CLIENT && require('../knexfile').client !== 'pg') {
    console.log(
      'Note: this environment resolves to SQLite (NODE_ENV is not "production" and\n'
      + 'DATABASE_CLIENT is unset). The migration will still complete and the marker it\n'
      + 'writes makes the app use PostgreSQL afterwards, but set NODE_ENV=production (or\n'
      + 'DATABASE_CLIENT=pg) so the configuration says what is actually happening.\n'
    );
  }

  if (!process.env.DB_HOST && !process.env.DB_PASSWORD) {
    console.error(
      'No PostgreSQL settings found (DB_HOST / DB_PASSWORD). Set them the way the\n'
      + 'backend does, then re-run this script inside the container.'
    );
    process.exit(1);
  }

  console.log(
    'Stop the backend before running this. If it keeps serving while the copy runs,\n'
    + 'anything written after the export is left behind in SQLite and becomes invisible\n'
    + 'once the engine switches. This script checks for that afterwards and fails loudly,\n'
    + 'but stopping the container first is the only way to be sure.\n'
  );

  const sourceData = JSON.parse(runPhase('user-data', 'sqlite3'));
  console.log(`  source : ${sqlitePath} — ${summariseUserData(sourceData) || 'no user data'}`);
  if (!Object.keys(sourceData).length) {
    console.error(
      '\nThe SQLite database holds no user data at all (no galleries, admins, customers or\n'
      + 'accounting records). There is nothing to migrate.'
    );
    process.exit(1);
  }
  const sqliteBefore = JSON.parse(runPhase('fingerprint', 'sqlite3'));

  // Read the target BEFORE creating the schema: migration 001 seeds a bootstrap
  // admin when ADMIN_PASSWORD is set (common on legacy installs), and counting
  // that as "user data" would refuse a migration into a genuinely empty
  // database — pushing the operator towards --force for no reason.
  const { hasMigrationInProgress, migrationInProgressPath } = require('../src/utils/databaseEngine');
  // The retry allowance is bound to the TARGET, not just to this SQLite file:
  // if the operator repointed DB_HOST/DB_NAME since the failed attempt, the
  // rows in front of us belong to some other database and must not be replaced
  // without an explicit --force.
  const pgEnv = normalisedPgEnv();
  const targetId = `${pgEnv.DB_HOST}:${pgEnv.DB_PORT}/${pgEnv.DB_NAME}`;
  let retryingOwnRun = false;
  if (hasMigrationInProgress(sqlitePath)) {
    try {
      const pin = JSON.parse(fs.readFileSync(migrationInProgressPath(sqlitePath), 'utf8'));
      retryingOwnRun = pin.target === targetId;
      if (!retryingOwnRun) {
        console.log(`  (an earlier attempt targeted ${pin.target}; this run targets ${targetId})`);
      }
    } catch (_) {
      retryingOwnRun = false; // unreadable pin — treat as unknown, require --force
    }
  }
  const targetData = JSON.parse(runPhase('user-data', 'pg', ['--ignore-bootstrap-admins']));
  console.log(`  target : postgres — ${summariseUserData(targetData) || 'empty'}`);
  if (retryingOwnRun && Object.keys(targetData).length) {
    // Whatever is in Postgres came from a previous attempt of THIS script that
    // never completed — re-running is the documented recovery, so don't make
    // the operator reach for a destructive-sounding flag to do it.
    console.log('  (an earlier migration did not finish; re-running replaces what it left behind)');
  } else if (Object.keys(targetData).length && !args.force) {
    console.error(
      `\nPostgreSQL already holds user data (${summariseUserData(targetData)}).\n`
      + 'The import REPLACES every table, so this would delete it — including admins,\n'
      + 'customers and accounting records that have no galleries attached.\n'
      + 'Re-run with --force only if you are certain you want that data gone.'
    );
    process.exit(1);
  }

  // Pin the boot to SQLite for the duration. Everything below writes to
  // Postgres — schema creation alone seeds a bootstrap admin when
  // ADMIN_PASSWORD is set — and a run that dies half way would otherwise leave
  // Postgres looking occupied enough for the next restart to switch to it.
  const inProgress = migrationInProgressPath(sqlitePath);
  fs.writeFileSync(inProgress, JSON.stringify({
    started_at: new Date().toISOString(),
    target: targetId,
  }, null, 2));

  // Now build the schema — the import replaces table CONTENTS, it never creates
  // them, and a fresh database has no tables at all.
  //
  // core/001_init.js writes data/ADMIN_CREDENTIALS.txt when ADMIN_PASSWORD is
  // set, and that data directory belongs to the SOURCE install — so bootstrapping
  // the schema would replace the operator's real credentials file with ones for
  // a temporary admin the import then discards. Preserve it across the phase.
  const credFile = path.join(BACKEND_ROOT, 'data', 'ADMIN_CREDENTIALS.txt');
  const credBefore = fs.existsSync(credFile) ? fs.readFileSync(credFile) : null;
  console.log('\n  Preparing PostgreSQL schema…');
  try {
    runPhase('migrate-schema', 'pg');
  } finally {
    if (credBefore !== null) fs.writeFileSync(credFile, credBefore);
    else fs.rmSync(credFile, { force: true });
  }

  console.log('\n  Exporting rows from SQLite…');
  const archive = runPhase('export', 'sqlite3');
  // From here on, every exit path must remove the archive: it holds password
  // hashes, SMTP credentials and API keys in plaintext.
  archiveToClean = args.keepArchive ? null : archive;
  const sizeMb = (fs.statSync(archive).size / 1024 / 1024).toFixed(1);
  console.log(`  archive: ${archive} (${sizeMb} MB)`);

  // Check BEFORE touching Postgres: if the backend wrote to SQLite while the
  // export ran, the snapshot is already incomplete and there is no reason to
  // load it. Bailing here leaves Postgres exactly as it was.
  const driftDuringExport = describeDrift(sqliteBefore, JSON.parse(runPhase('fingerprint', 'sqlite3')));
  if (driftDuringExport.length) {
    console.error(
      '\nSQLite CHANGED WHILE THE EXPORT RAN — the backend is still writing to it:\n'
      + driftDuringExport.map((d) => `  ${d}`).join('\n')
      + '\n\nNothing was loaded into Postgres, and this install stays pinned to SQLite\n'
      + 'until a run completes. Stop the backend and run this again.'
    );
    process.exit(1);
  }

  console.log('\n  Loading into PostgreSQL…');
  runPhase('import', 'pg', [`--archive=${archive}`]);

  // And again afterwards: writes can also land while the load runs, and those
  // rows would vanish from view the moment the engine switches.
  const driftDuringImport = describeDrift(sqliteBefore, JSON.parse(runPhase('fingerprint', 'sqlite3')));
  if (driftDuringImport.length) {
    console.error(
      '\nSQLite CHANGED WHILE THE IMPORT RAN — the backend is still writing to it:\n'
      + driftDuringImport.map((d) => `  ${d}`).join('\n')
      + '\n\nPostgres now holds an incomplete copy. Your SQLite data is intact and stays\n'
      + 'the one being served — the boot is pinned to it until a run completes. Stop the\n'
      + 'backend and run this again; the import replaces every table, so re-running is safe.'
    );
    process.exit(1);
  }

  // Row-for-row comparison of the whole database, not just galleries: every
  // table the export carried must have arrived with the same row count.
  const targetAfter = JSON.parse(runPhase('fingerprint', 'pg'));
  // Only a SHORTFALL is a problem. The import legitimately adds rows of its own
  // afterwards — setSessionsValidAfter() writes an app_settings row so tokens
  // minted before the restore stop authenticating — and a target that gained
  // rows has not lost anything.
  const missing = [];
  const gained = [];
  const skipped = [];
  for (const [table, src] of Object.entries(sqliteBefore)) {
    const dst = targetAfter[table];
    if (!dst) {
      // SQLite-only tables exist: initializeDatabase() builds an `events_new`
      // scratch table and, if its legacy copy throws, the catch leaves the empty
      // table behind (db.js). The importer correctly skips tables Postgres does
      // not have — so an ABSENT table only matters if it actually held rows.
      // Flagging empty ones failed the whole migration after the data had
      // already landed, leaving the install pinned to SQLite forever.
      if (src.count > 0) missing.push(`${table}: ${src.count} rows, no such table in Postgres`);
      else skipped.push(table);
      continue;
    }
    if (dst.count < src.count) missing.push(`${table}: ${src.count} rows → ${dst.count}`);
    else if (dst.count > src.count) gained.push(`${table}: ${src.count} → ${dst.count}`);
  }
  if (skipped.length) {
    console.log(`  (empty SQLite-only tables with no Postgres counterpart, skipped: ${skipped.join(', ')})`);
  }
  if (gained.length) console.log(`  (rows added by the import itself: ${gained.join(', ')})`);
  console.log(`\n  PostgreSQL now holds ${summariseUserData(JSON.parse(runPhase('user-data', 'pg')))}.`);

  if (missing.length) {
    console.error(
      '\nROW COUNTS DO NOT MATCH — Postgres did not receive everything:\n'
      + missing.map((m) => `  ${m}`).join('\n')
      + '\n\nYour SQLite data is untouched and stays the one being served — the boot is\n'
      + 'pinned to it until a run completes. Report this with the list above.'
    );
    process.exit(1);
  }

  // Pin the engine choice so a later "Postgres looks empty" moment can never
  // send the install back to this now-stale file.
  const { migrationMarkerPath } = require('../src/utils/databaseEngine');
  const marker = migrationMarkerPath(sqlitePath);
  const retired = `${sqlitePath}.pre-postgres-${new Date().toISOString().replace(/[:.]/g, '-')}`;

  // Marker FIRST, rename second. The other order has a window where a failure
  // (a full disk, say) leaves the source renamed away with no success marker:
  // the next run reports "No SQLite database", the in-progress pin is still
  // there, and the operator never sees the rollback path. Writing the marker
  // first means a failure here leaves everything exactly where it was.
  fs.writeFileSync(marker, JSON.stringify({
    migrated_at: new Date().toISOString(),
    retired_sqlite_file: null,
    target: targetId,
  }, null, 2));

  let retiredTo = null;
  try {
    fs.renameSync(sqlitePath, retired);
    retiredTo = retired;
    fs.writeFileSync(marker, JSON.stringify({
      migrated_at: new Date().toISOString(),
      retired_sqlite_file: retiredTo,
      target: targetId,
    }, null, 2));
  } catch (err) {
    // The marker already pins the engine to Postgres, so leaving the file in
    // place is safe — it just is not renamed out of the way.
    console.log(`  (could not rename the SQLite file: ${err.message} — leaving it in place)`);
  }
  // Success — release the pin. Order matters: the success marker exists before
  // the pin is dropped, so no restart in between can pick the wrong engine.
  fs.rmSync(inProgress, { force: true });

  if (args.keepArchive) {
    console.log(`  archive kept at ${archive} — it contains plaintext secrets, delete it when done`);
  } else {
    cleanupArchive();
  }

  console.log(`
Done. Your data is now in PostgreSQL.

  rollback copy : ${retiredTo || sqlitePath}
  marker        : ${marker}

Restart the container to pick up PostgreSQL. Keep the rollback copy until you
have confirmed the galleries look right.

To roll back, all three steps are needed — with data on both sides the boot
picks PostgreSQL, so restoring the file alone changes nothing:

  1. rm ${marker}
  2. mv ${retiredTo || sqlitePath} ${sqlitePath}
  3. set DATABASE_CLIENT=sqlite3 in your deployment
`);
}

process.on('exit', cleanupArchive);

main().catch((err) => {
  console.error(`\nMigration failed: ${err.message}`);
  console.error('Nothing was changed in SQLite; your data is still there.');
  process.exit(1);
});
