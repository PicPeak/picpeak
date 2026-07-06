'use strict';

// Portable ".picpeak" export — a single, self-describing archive that can be
// downloaded from one instance and re-uploaded to another via the web UI only
// (see picpeakImportService for the receiving half).
//
// Deliberately ENGINE-NEUTRAL: instead of a native pg_dump / sqlite .backup
// (which can only ever restore into the same engine and version), each table is
// written as NDJSON. The target rebuilds its own schema by running migrations,
// then loads these rows into it — so an older backup restores cleanly onto a
// newer target (forward-only), and pg↔pg / sqlite↔sqlite both work.
//
// This module is purely additive: it introduces a new artifact and touches no
// existing backup/restore path.

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const archiver = require('archiver');
const { db } = require('../database/db');
const knexConfig = require('../../knexfile');
const { getStoragePath } = require('../config/storage');
const logger = require('../utils/logger');
const packageJson = require('../../package.json');

// Bump only on a breaking change to the on-disk layout below.
const PICPEAK_FORMAT_VERSION = 1;

// Never exported as data — the target owns these (its own migrations set them).
const EXCLUDED_TABLES = new Set(['knex_migrations', 'knex_migrations_lock']);

// Storage subdirs holding non-recalculable blobs — always included.
const DOC_DIRS = ['business-docs', 'uploads'];
// Original gallery photos — only when includePhotos is true (large; otherwise
// the admin re-uploads originals per gallery and previews are re-rendered).
const PHOTO_DIRS = ['events/active', 'events/archived'];

const isPostgres = () => knexConfig.client === 'pg';

// db.raw returns `{ rows: [...] }` on Postgres and a bare array on SQLite.
const rawRows = (result) => (isPostgres() ? result.rows : result);

// All user tables, minus knex bookkeeping. Introspected at runtime so the
// export never rots as tables are added (no hardcoded list to maintain).
async function listDataTables() {
  let names;
  if (isPostgres()) {
    const result = await db.raw(`
      SELECT table_name AS name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    names = rawRows(result).map((r) => r.name);
  } else {
    const result = await db.raw(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `);
    names = rawRows(result).map((r) => r.name);
  }
  return names.filter((n) => !EXCLUDED_TABLES.has(n));
}

// The latest applied migration — recorded in the manifest so the importer can
// refuse a backup that is NEWER than the target (forward-only guarantee).
async function getLatestMigration() {
  try {
    const rows = await db('knex_migrations').orderBy('id', 'desc').limit(1);
    return rows[0]?.name || null;
  } catch (_) {
    return null;
  }
}

// Write one table to <dataDir>/<table>.ndjson (one JSON object per line).
// Returns { rowCount, checksum } for the manifest. JSON.stringify serialises
// Dates to ISO strings, which re-import cleanly on both engines.
//
// Uses a plain select rather than knex `.stream()`: streaming on Postgres pulls
// in the optional `pg-query-stream` dependency (not bundled), so it throws on
// pg. A select works on both engines with no extra dependency. Rows are DB
// metadata (blobs live on disk under files/), so holding a table in memory is
// fine for the instance sizes PicPeak targets.
async function writeTableNdjson(table, dataDir) {
  const outPath = path.join(dataDir, `${table}.ndjson`);
  const hash = crypto.createHash('sha256');
  const rows = await db(table).select('*');
  const lines = rows.map((row) => {
    const line = JSON.stringify(row);
    hash.update(`${line}\n`);
    return line;
  });
  await fsp.writeFile(outPath, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
  return { rowCount: rows.length, checksum: hash.digest('hex') };
}

// Recursively collect files under a storage subdir as { abs, rel } where rel is
// relative to the storage root (so the importer restores the same layout).
async function collectDir(subdir, storageRoot, acc) {
  const abs = path.join(storageRoot, subdir);
  let entries;
  try {
    entries = await fsp.readdir(abs, { withFileTypes: true });
  } catch (_) {
    return; // subdir may not exist on this install — skip silently
  }
  for (const entry of entries) {
    const childRel = path.join(subdir, entry.name);
    if (entry.isDirectory()) {
      await collectDir(childRel, storageRoot, acc);
    } else if (entry.isFile()) {
      acc.push({ abs: path.join(storageRoot, childRel), rel: childRel });
    }
  }
}

async function collectFiles(includePhotos) {
  const storageRoot = getStoragePath();
  const dirs = includePhotos ? [...DOC_DIRS, ...PHOTO_DIRS] : [...DOC_DIRS];
  const acc = [];
  for (const d of dirs) {
    await collectDir(d, storageRoot, acc);
  }
  return acc;
}

/**
 * Build a .picpeak archive.
 * @param {Object} opts
 * @param {boolean} [opts.includePhotos=false] include original gallery photos
 * @param {string}  [opts.outDir] where to write the file (defaults to a temp dir)
 * @returns {Promise<{ filePath: string, manifest: object }>}
 */
async function createPicpeak({ includePhotos = false, outDir } = {}) {
  const staging = await fsp.mkdtemp(path.join(os.tmpdir(), 'picpeak-export-'));
  const dataDir = path.join(staging, 'data');
  await fsp.mkdir(dataDir, { recursive: true });

  try {
    // 1. Dump every table to NDJSON, tracking counts + checksums.
    const tables = await listDataTables();
    const tableMeta = {};
    for (const table of tables) {
      tableMeta[table] = await writeTableNdjson(table, dataDir);
    }

    // 2. Gather the non-recalculable blobs (PDFs, business-docs, uploads, and
    //    optionally original photos).
    const files = await collectFiles(includePhotos);

    // 3. Manifest — everything the importer needs to validate + reconstruct.
    const manifest = {
      format: PICPEAK_FORMAT_VERSION,
      kind: 'picpeak-backup',
      created_at: new Date().toISOString(),
      app_version: packageJson.version || null,
      database: {
        engine: isPostgres() ? 'pg' : 'sqlite',
        latest_migration: await getLatestMigration(),
      },
      options: { includePhotos: !!includePhotos },
      tables: tableMeta,
      file_count: files.length,
      // NOTE: contains secrets (SMTP password, admin hashes, API keys) in plain
      // text — the download surface must warn about this.
      contains_secrets: true,
    };
    await fsp.writeFile(
      path.join(staging, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8'
    );

    // 4. Zip staging (manifest + data/) plus the blobs under files/. The final
    //    .picpeak lands in outDir (caller-managed) or a fresh temp dir; either
    //    way the NDJSON scratch (which holds plaintext secrets) is always
    //    removed in `finally` below.
    const targetDir = outDir || (await fsp.mkdtemp(path.join(os.tmpdir(), 'picpeak-out-')));
    await fsp.mkdir(targetDir, { recursive: true });
    const stamp = manifest.created_at.replace(/[:.]/g, '-');
    const filePath = path.join(targetDir, `picpeak-backup-${stamp}.picpeak`);

    try {
      await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(filePath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        output.on('close', resolve);
        output.on('error', reject);
        archive.on('error', reject);
        // Surface archiver warnings (e.g. a file vanished mid-run) instead of
        // silently shipping an incomplete archive.
        archive.on('warning', (err) => reject(err));
        archive.pipe(output);
        archive.file(path.join(staging, 'manifest.json'), { name: 'manifest.json' });
        archive.directory(dataDir, 'data');
        for (const f of files) {
          archive.file(f.abs, { name: path.posix.join('files', f.rel.split(path.sep).join('/')) });
        }
        archive.finalize();
      });
    } catch (err) {
      // Archiver failed → the partial .picpeak holds plaintext secrets and is
      // useless; remove our own temp out dir so it isn't orphaned. A
      // caller-supplied outDir is left untouched.
      if (!outDir) await fsp.rm(targetDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }

    logger.info(
      `[picpeak-export] wrote ${filePath} (${tables.length} tables, ${files.length} files, includePhotos=${!!includePhotos})`
    );
    return { filePath, manifest };
  } finally {
    // Always remove the NDJSON scratch dir — it contains a plaintext dump of
    // every table (secrets included). The final .picpeak is elsewhere.
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  PICPEAK_FORMAT_VERSION,
  EXCLUDED_TABLES,
  createPicpeak,
  // exported for reuse/testing
  listDataTables,
  collectFiles,
};
