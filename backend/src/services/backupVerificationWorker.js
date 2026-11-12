'use strict';

/**
 * The child-process half of a backup restore test (backupVerificationService
 * is the parent). Two modes, each run in its own process at low priority:
 *
 *   deep   fetch the dump and the selected files back from the destination
 *          (local directory or S3) and hash them against the manifest. The
 *          dump is kept in the work directory for the drill.
 *   drill  load the dump into a throwaway database and check it: integrity,
 *          foreign keys, row counts against the dump's table checksums,
 *          migrating it forward to this version, and a few invariants.
 *
 * The drill process is started with its database environment pointing at
 * the drill database (DATABASE_PATH / DB_NAME), so everything that opens the
 * default connection in here, the migration runner included, opens the drill
 * database. It re-checks that before touching anything and aborts when the
 * configured target is not the drill target or equals the live one.
 *
 * Only plain data crosses the process boundary: the job arrives as JSON on
 * stdin, the result leaves as one `PICPEAK_VERIFY_RESULT=` line on stdout.
 */

const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

const RESULT_PREFIX = 'PICPEAK_VERIFY_RESULT=';
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

function contained(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function hashingStream(hash, maxBytes) {
  let seen = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      if (maxBytes && seen > maxBytes) return cb(new Error('larger than recorded'));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
}

// A manifest path is relative and stays inside the restore point; a link or
// anything that is not a regular file is reported, never followed.
async function openLocal(realRoot, relPath) {
  if (typeof relPath !== 'string' || !relPath || path.isAbsolute(relPath)) throw new Error('invalid path in manifest');
  const target = path.join(realRoot, relPath);
  if (!contained(realRoot, target)) throw new Error('path leaves the restore point');
  const stat = await fsp.lstat(target).catch((error) => {
    if (error.code === 'ENOENT') throw new Error('missing');
    throw error;
  });
  if (!stat.isFile()) throw new Error(stat.isSymbolicLink() ? 'is a symbolic link' : 'not a regular file');
  const real = await fsp.realpath(target);
  if (!contained(realRoot, real)) throw new Error('path leaves the restore point');
  const handle = await fsp.open(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  return handle.createReadStream();
}

async function openSource(source, adapter, relPath) {
  if (source.type === 'local') return openLocal(source.realRoot, relPath);
  const key = path.posix.join(source.prefix, relPath.split(path.sep).join('/'));
  if (!key.startsWith(`${source.prefix}/`)) throw new Error('path leaves the restore point');
  try {
    return await adapter.downloadStream(key);
  } catch (error) {
    if (error && (error.name === 'NoSuchKey' || error.Code === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404)) {
      throw new Error('missing');
    }
    throw error;
  }
}

async function hashEntry(source, adapter, entry, copyTo) {
  const hash = crypto.createHash('sha256');
  const stream = await openSource(source, adapter, entry.path);
  const limit = Number(entry.size) > 0 ? Number(entry.size) : 0;
  if (copyTo) {
    await fsp.mkdir(path.dirname(copyTo), { recursive: true });
    await pipeline(stream, hashingStream(hash, limit), fs.createWriteStream(copyTo, { mode: 0o600 }));
  } else {
    await pipeline(stream, hashingStream(hash, limit), new (require('stream').Writable)({ write(_c, _e, cb) { cb(); } }));
  }
  return hash.digest('hex');
}

async function runDeep(job) {
  const source = { ...job.source };
  let adapter = null;
  if (source.type === 'local') {
    source.realRoot = await fsp.realpath(source.root).catch((error) => {
      throw new Error(error.code === 'ENOENT' ? 'The restore point is gone from the destination' : error.message);
    });
  } else if (source.type === 's3') {
    const S3StorageAdapter = require('./storage/s3Storage');
    adapter = new S3StorageAdapter(job.s3);
  } else {
    throw new Error(`Unsupported destination ${source.type}`);
  }

  const result = { dump: null, files: [] };
  if (job.dump) {
    try {
      const actual = await hashEntry(source, adapter, job.dump, job.dumpTarget);
      result.dump = { ok: actual === job.dump.checksum, actual };
    } catch (error) {
      result.dump = { ok: false, error: error.message };
    }
  }
  for (const entry of job.files) {
    try {
      const actual = await hashEntry(source, adapter, entry, null);
      result.files.push(actual === entry.checksum ? { path: entry.path, ok: true } : { path: entry.path, ok: false, error: 'checksum mismatch' });
    } catch (error) {
      result.files.push({ path: entry.path, ok: false, error: error.message });
    }
  }
  return result;
}

// ---------------------------------------------------------------- drill --

function check(name, result, detail = null) {
  return { name, result, detail };
}

async function isGzip(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(2), 0, 2, 0);
    return bytesRead === 2 && buffer.equals(GZIP_MAGIC);
  } finally {
    await handle.close();
  }
}

async function plainDump(dumpPath, workDir) {
  if (!(await isGzip(dumpPath))) return dumpPath;
  const out = path.join(workDir, 'dump.plain');
  await pipeline(fs.createReadStream(dumpPath), zlib.createGunzip(), fs.createWriteStream(out, { mode: 0o600 }));
  return out;
}

// The configured default connection, as this process resolved it, must be
// the drill target and not the live database.
function assertTarget(job, knexConfig) {
  const { assertDrillDatabaseName } = require('../utils/drillDatabase');
  if (job.engine === 'pg') {
    if (knexConfig.client !== 'pg') throw new Error('Drill process is not configured for PostgreSQL');
    const database = knexConfig.connection && knexConfig.connection.database;
    assertDrillDatabaseName(database, job.liveTarget.database);
    if (database !== job.drillTarget.database) throw new Error('Drill process resolved another database than the drill database');
    return;
  }
  const filename = knexConfig.connection && knexConfig.connection.filename;
  if (!filename || path.resolve(filename) !== path.resolve(job.drillTarget.filename)) {
    throw new Error('Drill process resolved another SQLite file than the drill copy');
  }
  if (job.liveTarget.filename && path.resolve(filename) === path.resolve(job.liveTarget.filename)) {
    throw new Error('Refusing to use the live database as a restore-drill database');
  }
  if (!contained(path.resolve(job.workDir), path.resolve(filename))) {
    throw new Error('The drill copy must live in the verification work directory');
  }
}

function migrationNumber(filename) {
  const match = /^(\d+)_/.exec(String(filename || ''));
  return match ? Number(match[1]) : null;
}

// The schema level the migration runner records: the highest numeric prefix
// in `migrations.filename`, falling back to knex_migrations for an install
// that only has that. Same shape as the planned fix for issue 2458.
async function schemaLevel(knex) {
  for (const [table, column] of [['migrations', 'filename'], ['knex_migrations', 'name']]) {
    if (!(await knex.schema.hasTable(table))) continue;
    const rows = await knex(table).select(column);
    const numbers = rows.map((row) => migrationNumber(row[column])).filter((n) => n !== null);
    if (numbers.length) return Math.max(...numbers);
  }
  return null;
}

function countOf(rows) {
  const row = Array.isArray(rows) ? rows[0] : rows;
  const value = row && (row.c ?? row.count ?? Object.values(row)[0]);
  return Number(value) || 0;
}

async function checkRowCounts(knex, expected) {
  const tables = Object.keys(expected || {});
  if (tables.length === 0) {
    return check('drill_row_counts', 'skipped', 'The dump has no recorded table checksums to compare with');
  }
  const missing = [];
  const differing = [];
  for (const table of tables) {
    const want = Number(expected[table] && (expected[table].rowCount ?? expected[table]));
    if (!(await knex.schema.hasTable(table))) { missing.push(table); continue; }
    const got = countOf(await knex(table).count({ c: '*' }));
    if (Number.isFinite(want) && got !== want) differing.push(`${table} ${got}/${want}`);
  }
  if (missing.length) {
    return check('drill_row_counts', 'failed', `Missing tables: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ', …' : ''}`);
  }
  if (differing.length) {
    // Counts are taken just before the dump on a live install; a few rows
    // written in between are expected, so this warns rather than fails.
    return check('drill_row_counts', 'warning',
      `${differing.length} of ${tables.length} tables differ from the counts taken before the dump (restored/recorded): ${differing.slice(0, 10).join(', ')}${differing.length > 10 ? ', …' : ''}`);
  }
  return check('drill_row_counts', 'passed', `${tables.length} tables match`);
}

async function migrateForward() {
  const realExit = process.exit;
  const lines = [];
  const realError = console.error;
  console.error = (...args) => { lines.push(args.map((a) => (a && a.message) || String(a)).join(' ')); };
  try {
    const code = await new Promise((resolve) => {
      // The runner ends with process.exit; here that only reports its code.
      process.exit = (exitCode) => resolve(exitCode ?? 0);
      require('../../migrations/run-migrations-safe').runMigrations();
    });
    return { code, error: lines.filter(Boolean).slice(0, 3).join(' ').slice(0, 500) };
  } finally {
    process.exit = realExit;
    console.error = realError;
  }
}

async function coreMigrationFiles() {
  const dir = path.join(__dirname, '../../migrations/core');
  return (await fsp.readdir(dir)).filter((f) => /^\d{3}_.*\.js$/.test(f));
}

async function checkInvariants(knex, engine) {
  const problems = [];
  const active = require('../utils/dbCompat').formatBoolean(true);
  if (!(await knex.schema.hasTable('admin_users')) || !(await knex.schema.hasTable('roles'))) {
    problems.push('admin_users or roles table missing');
  } else {
    const superAdmins = countOf(await knex('admin_users')
      .join('roles', 'roles.id', 'admin_users.role_id')
      .where('roles.name', 'super_admin')
      .where('admin_users.is_active', active)
      .count({ c: '*' }));
    if (superAdmins === 0) problems.push('no active super admin');
  }
  for (const table of ['roles', 'permissions', 'role_permissions', 'app_settings']) {
    if (!(await knex.schema.hasTable(table))) { problems.push(`${table} missing`); continue; }
    if (countOf(await knex(table).count({ c: '*' })) === 0) problems.push(`${table} empty`);
  }
  return problems.length
    ? check('drill_invariants', 'failed', problems.join('; '))
    : check('drill_invariants', 'passed', 'Active super admin, roles, permissions and settings present');
}

// pg_dump writes its session settings at the top of a plain dump, before the
// first object. A newer pg_dump writes settings an older server does not have
// (pg_dump 17 always writes `SET transaction_timeout = 0;`, which PostgreSQL
// 15 and 16 reject). A real restore runs psql without ON_ERROR_STOP and steps
// over that line; the drill stops on the first error, so it would fail a
// backup that restores fine. The scan reads comments, `\` meta lines, SET and
// set_config lines from the top, in either case as the server reads them, and
// stops at the first other statement (for a dump whose first object is a
// table, that takes in its `-- Name: …` comment and its `SET
// default_tablespace` lines too, which every server has). It never reads more
// than this many bytes.
const HEADER_SCAN_BYTES = 64 * 1024;
const HEADER_LINE = /^(?:--.*|\\.*|SET\s.*|SELECT pg_catalog\.set_config\(.*|\s*)$/i;
const HEADER_SET = /^SET\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*=|\s+TO\s)/i;
const SETTING_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Comments out, in place, every header `SET name = ...;` whose setting the
// target server does not have, by turning `SET` into `-- ` (same length, so
// nothing after the header moves and psql's line numbers stay right). Only
// the private copy in the work directory is ever edited. Dotted names are
// custom placeholders any server accepts, so they are never asked about.
// `findUnknown(names)` resolves to the subset the server does not have.
// Returns the names it commented out.
async function neutraliseUnknownSettings(file, workDir, findUnknown) {
  if (!contained(path.resolve(workDir), path.resolve(file))) {
    throw new Error('Refusing to edit a dump outside the work directory');
  }
  const handle = await fsp.open(file, 'r+');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(HEADER_SCAN_BYTES), 0, HEADER_SCAN_BYTES, 0);
    const head = buffer.subarray(0, bytesRead);
    const sets = [];
    let offset = 0;
    while (offset < head.length) {
      const end = head.indexOf(0x0a, offset);
      if (end === -1) break; // a line cut off by the scan window is not judged
      const line = head.subarray(offset, end).toString('utf8').replace(/\r$/, '');
      if (!HEADER_LINE.test(line)) break; // first other statement: the scan is over
      const match = HEADER_SET.exec(line);
      if (match) sets.push({ name: match[1].toLowerCase(), offset });
      offset = end + 1;
    }
    if (sets.length === 0) return [];
    const unknown = new Set(await findUnknown([...new Set(sets.map((s) => s.name))]));
    const skipped = [];
    for (const set of sets) {
      if (!unknown.has(set.name)) continue;
      await handle.write(Buffer.from('-- '), 0, 3, set.offset);
      skipped.push(set.name);
    }
    return skipped;
  } finally {
    await handle.close();
  }
}

async function loadPostgres(job, plain) {
  const { spawnAsync } = require('../utils/safeExec');
  const knexConfig = require('../../knexfile');
  const { host, port, user, password, database } = knexConfig.connection;
  const env = { ...process.env };
  if (password) env.PGPASSWORD = password;
  const target = ['-h', host, '-p', String(port), '-U', user, '-d', database];
  const firstErrors = (error) => String(error.stderr || error.message).trim().split('\n')
    .filter((l) => /ERROR|FATAL/.test(l)).slice(0, 3).join(' ') || error.message;

  // Asks the server itself, so an alias it accepts counts as known too
  // (pg_settings lists canonical names only). The names come from HEADER_SET,
  // and each is checked again here before it becomes a literal, so this does
  // not rest on that regex alone. (psql does not interpolate -v variables in
  // a -c command, so a psql variable is not an option here.)
  const findUnknown = async (names) => {
    if (!names.every((name) => SETTING_NAME.test(name))) throw new Error('Unexpected setting name in the dump header');
    const list = names.map((name) => `'${name}'`).join(', ');
    const { stdout } = await spawnAsync('psql', ['-X', '-q', '-A', '-t', ...target, '-c',
      `SELECT n FROM unnest(ARRAY[${list}]::text[]) AS n WHERE current_setting(n, true) IS NULL`], { env });
    return stdout.split('\n').map((name) => name.trim()).filter(Boolean);
  };
  let skipped;
  try {
    skipped = await neutraliseUnknownSettings(plain, job.workDir, findUnknown);
  } catch (error) {
    throw new Error(firstErrors(error));
  }
  // -f rather than stdin, so the statement that stopped the load is named
  // in the error instead of a broken pipe.
  try {
    await spawnAsync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', ...target, '-f', plain], { env });
  } catch (error) {
    throw new Error(firstErrors(error));
  }
  return { skipped };
}

async function runDrill(job) {
  const knexLib = require('knex');
  const knexConfig = require('../../knexfile');
  assertTarget(job, knexConfig);

  const checks = [];
  const plain = await plainDump(job.dumpPath, job.workDir);

  if (job.engine === 'pg') {
    try {
      const { skipped } = await loadPostgres(job, plain);
      checks.push(check('drill_load', 'passed', skipped.length
        ? `Loaded with psql (ON_ERROR_STOP); skipped dump settings this server does not have: ${skipped.join(', ')}`
        : 'Loaded with psql (ON_ERROR_STOP)'));
    } catch (error) {
      checks.push(check('drill_load', 'failed', String(error.message || error).slice(0, 500)));
      return { checks };
    }
  } else {
    // The fetched (or decompressed) dump is already a private file in the
    // work directory: move it into place.
    await fsp.rename(plain, job.drillTarget.filename);
    await fsp.chmod(job.drillTarget.filename, 0o600);
    checks.push(check('drill_load', 'passed', 'Opened a private copy of the dump'));
  }

  const knex = knexLib({ ...knexConfig, pool: { min: 0, max: 2 } });
  try {
    if (job.engine === 'pg') {
      checks.push(check('drill_integrity', 'passed', 'Every statement of the dump applied'));
      const unvalidated = await knex.raw('SELECT count(*) AS c FROM pg_constraint WHERE contype = ? AND NOT convalidated', ['f']);
      const n = countOf(unvalidated.rows);
      checks.push(n === 0
        ? check('drill_foreign_keys', 'passed', 'All foreign keys validated during the load')
        : check('drill_foreign_keys', 'warning', `${n} foreign keys are not validated`));
    } else {
      const integrity = await knex.raw('PRAGMA integrity_check');
      const verdict = (integrity[0] && Object.values(integrity[0])[0]) || '';
      if (verdict !== 'ok') {
        checks.push(check('drill_integrity', 'failed', String(verdict).slice(0, 500)));
        return { checks };
      }
      checks.push(check('drill_integrity', 'passed', 'PRAGMA integrity_check: ok'));
      const violations = await knex.raw('PRAGMA foreign_key_check');
      if (violations.length === 0) {
        checks.push(check('drill_foreign_keys', 'passed', 'No foreign key violations'));
      } else {
        const byTable = {};
        for (const row of violations) byTable[row.table] = (byTable[row.table] || 0) + 1;
        checks.push(check('drill_foreign_keys', 'warning', `${violations.length} rows point at missing parents: ${Object.entries(byTable).slice(0, 10).map(([t, n]) => `${t} ${n}`).join(', ')}`));
      }
    }

    checks.push(await checkRowCounts(knex, job.expectedRowCounts));
    const fromLevel = await schemaLevel(knex);
    await knex.destroy();

    const migration = await migrateForward();
    const after = knexLib({ ...knexConfig, pool: { min: 0, max: 2 } });
    try {
      if (migration.code !== 0) {
        checks.push(check('drill_migrate', 'failed', migration.error || 'The migration runner failed'));
      } else {
        const applied = new Set((await after('migrations').select('filename')).map((row) => row.filename));
        const pending = (await coreMigrationFiles()).filter((file) => !applied.has(file));
        const toLevel = await schemaLevel(after);
        checks.push(pending.length
          ? check('drill_migrate', 'failed', `Still pending after migrating: ${pending.slice(0, 5).join(', ')}`)
          : check('drill_migrate', 'passed', `Schema level ${fromLevel ?? 'unknown'} → ${toLevel ?? 'unknown'}`));
      }
      checks.push(await checkInvariants(after, job.engine));
    } finally {
      await after.destroy().catch(() => {});
    }
  } finally {
    await knex.destroy().catch(() => {});
  }
  return { checks };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function main(mode) {
  try { os.setPriority(19); } catch (_) { /* best effort */ }
  // Migration and library logging must not be mistaken for the result line.
  // eslint-disable-next-line no-console
  console.log = (...args) => process.stderr.write(`${args.join(' ')}\n`);
  const job = await readStdin();
  let result;
  try {
    if (mode === 'deep') result = await runDeep(job);
    else if (mode === 'drill') result = await runDrill(job);
    else throw new Error(`Unknown mode ${mode}`);
  } catch (error) {
    result = { error: String((error && error.message) || error).slice(0, 1000) };
  }
  await new Promise((resolve) => process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`, resolve));
}

module.exports = { main, RESULT_PREFIX, schemaLevel, migrationNumber, _internal: { runDeep, runDrill, checkRowCounts, assertTarget, neutraliseUnknownSettings, loadPostgres } };
