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

function parseArgs(argv) {
  return {
    force: argv.includes('--force'),
    keepArchive: argv.includes('--keep-archive'),
    phase: (argv.find((a) => a.startsWith('--phase=')) || '').split('=')[1] || null,
    archive: (argv.find((a) => a.startsWith('--archive=')) || '').split('=')[1] || null,
    resultFile: (argv.find((a) => a.startsWith('--result-file=')) || '').split('=')[1] || null,
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
        env: { ...process.env, DATABASE_CLIENT: client },
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
  // includePhotos:false — photo files stay on the volume untouched; only rows move.
  const { filePath } = await createPicpeak({ includePhotos: false, outDir });
  return filePath;
}

// Tables whose contents an operator would notice losing. Used both to decide
// whether a database "has data" and to detect writes landing DURING the
// migration (#1038 review): if the backend is still running, uploads, feedback
// or admin edits made after the export would never reach Postgres, and after
// the engine switch they would be invisible.
const FINGERPRINT_TABLES = ['events', 'photos', 'photo_feedback', 'admin_users'];

async function phaseFingerprint() {
  const { db } = require('../src/database/db');
  const out = {};
  for (const table of FINGERPRINT_TABLES) {
    if (!(await db.schema.hasTable(table))) continue;
    const row = await db(table).count('id as count').max('id as maxId').first();
    out[table] = { count: Number(row?.count || 0), maxId: Number(row?.maxId || 0) };
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

function galleryCount(fingerprint) {
  return fingerprint.events ? fingerprint.events.count : 0;
}

function describeDrift(before, after) {
  const drifted = [];
  for (const table of Object.keys(before)) {
    const a = before[table];
    const b = after[table];
    if (!b) continue;
    if (a.count !== b.count || a.maxId !== b.maxId) {
      drifted.push(`${table}: ${a.count} rows/max id ${a.maxId} → ${b.count}/${b.maxId}`);
    }
  }
  return drifted;
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

  const sqliteBefore = JSON.parse(runPhase('fingerprint', 'sqlite3'));
  const sqliteCount = galleryCount(sqliteBefore);
  console.log(`  source : ${sqlitePath} — ${sqliteCount} galler${sqliteCount === 1 ? 'y' : 'ies'}`);
  if (!sqliteCount) {
    console.error('\nThe SQLite database holds no galleries. Refusing to overwrite Postgres with it.');
    process.exit(1);
  }

  // Build the Postgres schema first — a fresh database has no tables at all,
  // and the import replaces table CONTENTS, it does not create them.
  console.log('\n  Preparing PostgreSQL schema…');
  runPhase('migrate-schema', 'pg');

  const pgCount = galleryCount(JSON.parse(runPhase('fingerprint', 'pg')));
  console.log(`  target : postgres — ${pgCount} galler${pgCount === 1 ? 'y' : 'ies'}`);
  if (pgCount > 0 && !args.force) {
    console.error(
      `\nPostgreSQL already holds ${pgCount} galleries. The import REPLACES every table,\n`
      + 'so this would discard them. Re-run with --force if that is what you want.'
    );
    process.exit(1);
  }

  console.log('\n  Exporting rows from SQLite…');
  const archive = runPhase('export', 'sqlite3');
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
      + '\n\nNothing was written to Postgres. Stop the backend and run this again.'
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
      + '\n\nPostgres now holds an incomplete copy. Your SQLite data is still intact and\n'
      + 'still the one being served. Stop the backend and run this again; the import\n'
      + 'replaces every table, so re-running is safe.'
    );
    process.exit(1);
  }

  const finalCount = galleryCount(JSON.parse(runPhase('fingerprint', 'pg')));
  console.log(`\n  PostgreSQL now holds ${finalCount} galler${finalCount === 1 ? 'y' : 'ies'}.`);

  if (finalCount !== sqliteCount) {
    console.error(
      `\nWARNING: source had ${sqliteCount} galleries, target has ${finalCount}. Check the log above`
      + '\nbefore switching over — the SQLite file has not been modified.'
    );
    process.exit(1);
  }

  if (!args.keepArchive) {
    fs.rmSync(path.dirname(archive), { recursive: true, force: true });
  } else {
    console.log(`  archive kept at ${archive}`);
  }

  console.log(`
Done. Your data is now in PostgreSQL and the SQLite file is untouched at:

  ${sqlitePath}

Restart the container to pick up PostgreSQL. Keep that file until you have
confirmed the galleries look right — it is your rollback.
`);
}

main().catch((err) => {
  console.error(`\nMigration failed: ${err.message}`);
  console.error('Nothing was changed in SQLite; your data is still there.');
  process.exit(1);
});
