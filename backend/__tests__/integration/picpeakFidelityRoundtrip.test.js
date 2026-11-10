'use strict';

/**
 * Generic .picpeak fidelity: export → import into a FRESH database → export
 * again, then compare the two archives table by table and file by file.
 *
 * The suite knows nothing about any feature. helpers/fidelityInstance.js
 * seeds one synthetic row into every table the migrations leave empty (from
 * the schema alone), so a column added tomorrow that the restore silently
 * drops or mangles fails here without anyone writing a test for it.
 *
 *   sqlite → sqlite   always (Linux: the coordinated restore needs it)
 *   pg     → pg       gated on PICPEAK_PG_TEST_URL
 *   sqlite → pg       gated on PICPEAK_PG_TEST_URL (the upgrade path)
 *
 * The Postgres cases create their own databases next to the one
 * PICPEAK_PG_TEST_URL names (CREATE DATABASE picpeak_fidelity_<hex>) and drop
 * them afterwards; they never touch that database itself.
 *
 * Same-engine: every table's rowCount + checksum in manifest #2 must equal
 * manifest #1, except the few tables the restore rewrites on purpose
 * (RESTORE_REWRITES below); those are compared row by row instead.
 * Cross-engine: checksums cannot match (pg returns Date / boolean / parsed
 * json where SQLite returns epoch numbers / 0-1 / text), so every table is
 * compared row by row after normalising those representations.
 * Files: path + size + sha256 must match in every case.
 */

const crypto = require('crypto');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const knex = require('knex');
const StreamZip = require('node-stream-zip');
const { OPERATOR } = require('./helpers/fidelityInstance');

const executeFile = promisify(execFile);
const BACKEND = path.resolve(__dirname, '../..');
const INSTANCE = path.join(__dirname, 'helpers', 'fidelityInstance.js');
const PG_URL = process.env.PICPEAK_PG_TEST_URL;
const linux = process.platform === 'linux';
const sqliteDescribe = linux ? describe : describe.skip;
const pgDescribe = linux && PG_URL ? describe : describe.skip;

// Exported tables that still have 0 rows after seeding. The fidelity check
// says nothing about a table with no rows, so this list may only shrink: a
// new table that lands here needs a fixture (an OVERRIDES entry in
// helpers/fidelityInstance.js, or a parent the seeding can reach).
const ZERO_ROW_TABLES = [];

// What a restore changes ON PURPOSE. Every entry names the code that does it.
// A table that differs for any other reason is a fidelity failure.
const RESTORE_REWRITES = {
  // preserveOperatorPasskeys: the archive's keys on the operator's own
  // account are dropped; the operator keeps the target's (here: none).
  admin_webauthn_credentials: {
    dropSourceRows: (row, { operatorId }) => String(row.admin_user_id) === String(operatorId),
  },
  // The restore invalidates every session issued before it.
  app_settings: { dropRestoredRows: row => row.setting_key === 'security_sessions_valid_after' },
  // utils/costTimestamps: epoch cost timestamps come back as ISO text.
  expenses: {},
  inbound_documents: {},
  // utils/invoiceSendAt: numeric send dates come back as ISO text.
  invoices: {},
  // mediaAttemptService.resetImportedMediaAttempts re-queues derived media
  // work, and backfillCommentCounts recounts comment_count from the rows.
  photos: {
    ignoreColumns: ['comment_count',
      'processing_attempt_id', 'processing_attempts', 'processing_retry_at', 'processing_started_at', 'processing_error',
      'processing_status', 'web_attempt_id', 'web_attempts', 'web_retry_at', 'web_started_at', 'web_error', 'web_status',
      'hls_path', 'hls_status', 'hls_attempt_id', 'hls_attempts', 'hls_retry_at', 'hls_started_at', 'hls_error'],
  },
};

let workRoot;

async function runInstance(env, ...args) {
  // TZ pinned: pg returns a `date` column as local midnight.
  const childEnv = { ...process.env, TZ: 'UTC', ...env };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete childEnv[key];
  let stdout;
  try {
    ({ stdout } = await executeFile(process.execPath, [INSTANCE, ...args], {
      cwd: BACKEND, env: childEnv, timeout: 240000, maxBuffer: 256 * 1024 * 1024,
    }));
  } catch (error) {
    throw new Error(`fidelity instance ${args[0]} failed:\n${String(error.stderr || error.message).slice(-4000)}`);
  }
  const line = stdout.split('\n').find(value => value.startsWith('FIDELITY_RESULT:'));
  if (!line) throw new Error(`fidelity instance ${args[0]} printed no result:\n${stdout.slice(-4000)}`);
  return JSON.parse(line.slice('FIDELITY_RESULT:'.length));
}

// The SQLite file and the storage root come from bootCrmDb, which gives every
// instance its own temporary directory.
function sqliteEnv() {
  return {
    DATABASE_CLIENT: 'sqlite3',
    DB_HOST: undefined, DB_PORT: undefined, DB_USER: undefined, DB_PASSWORD: undefined, DB_NAME: undefined,
  };
}

function pgEnv(database) {
  const url = new URL(PG_URL);
  return {
    DATABASE_CLIENT: 'pg', DB_HOST: url.hostname, DB_PORT: url.port || '5432',
    DB_USER: decodeURIComponent(url.username), DB_PASSWORD: decodeURIComponent(url.password), DB_NAME: database,
  };
}

// One failed DROP must not keep the rest behind. WITH (FORCE) needs
// PostgreSQL 13 or later (CI runs 15).
async function dropDatabases(admin, names) {
  for (const name of names) {
    try { await admin.raw('DROP DATABASE IF EXISTS ?? WITH (FORCE)', [name]); } catch (error) {
      console.warn(`fidelity: could not drop ${name}: ${error.message}`);
    }
  }
}

async function readTables(file) {
  const zip = new StreamZip.async({ file });
  try {
    const tables = {};
    for (const name of Object.keys(await zip.entries())) {
      const match = /^data\/(.+)\.ndjson$/.exec(name);
      if (!match) continue;
      tables[match[1]] = (await zip.entryData(name)).toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
    }
    return tables;
  } finally {
    await zip.close();
  }
}

// ── Value normalisation ─────────────────────────────────────────────────────
// SQLite writes Dates as epoch ms, booleans as 0/1 and json as text; pg
// returns Date (serialised as ISO), true/false, parsed json, and numeric /
// bigint as strings. Normalise both sides to one shape. Timestamps compare
// as instants: a zone-less "YYYY-MM-DD HH:MM:SS" is UTC, as the app writes it.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const NUMERIC = /^-?\d+(\.\d+)?$/;

function normaliseValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map(normaliseValue);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, normaliseValue(value[key])]));
  }
  if (typeof value !== 'string') return value;
  if (DATE_ONLY.test(value)) return { instant: Date.parse(`${value}T00:00:00Z`) };
  if (DATE_TIME.test(value)) {
    const zoned = /(Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
    const instant = Date.parse(zoned);
    if (!Number.isNaN(instant)) return { instant };
  }
  if (NUMERIC.test(value)) return Number(value);
  if (/^[[{]/.test(value)) {
    try { return normaliseValue(JSON.parse(value)); } catch (_) { /* plain text */ }
  }
  return value;
}

// An epoch number in one archive and an ISO string in the other are the same
// instant; the column type is not in the archive, so decide per pair.
// Two column kinds are spelled differently by the engines and need the
// target's column type (reported by the restore instance) to compare:
//   json: SQLite stores JSON text ('"en"', 'true'), pg returns it parsed.
//   date: a pg `date` keeps the calendar day of a SQLite epoch.
function sameValue(a, b, { kind } = {}) {
  if (kind === 'date') return utcDay(a) === utcDay(b);
  // Kinds come from a pg target, so `a` is the SQLite source's spelling (JSON
  // text) and `b` the value pg already parsed, a plain string included.
  if (kind === 'json') {
    const source = typeof a === 'string' ? parseJson(a) : a;
    return JSON.stringify(normaliseValue(source)) === JSON.stringify(normaliseValue(b));
  }
  const x = normaliseValue(a);
  const y = normaliseValue(b);
  if (x && typeof x === 'object' && 'instant' in x && typeof y === 'number') return epochMs(y) === x.instant;
  if (y && typeof y === 'object' && 'instant' in y && typeof x === 'number') return epochMs(x) === y.instant;
  return JSON.stringify(x) === JSON.stringify(y);
}
const epochMs = n => (Math.abs(n) < 1e11 ? n * 1000 : n);
const parseJson = text => { try { return JSON.parse(text); } catch (_) { return { unparseable: text }; } };
function utcDay(value) {
  if (value === null || value === undefined) return null;
  const normalised = normaliseValue(value);
  const instant = typeof normalised === 'number' ? epochMs(normalised) : normalised?.instant;
  return instant === undefined ? JSON.stringify(normalised) : new Date(instant).toISOString().slice(0, 10);
}

// Keyless tables (composite keys) match on their normalised values, with
// instants as epoch numbers so an epoch on one side keys like an ISO string.
function rowKey(row) {
  if (row.id !== undefined && row.id !== null) return `id:${row.id}`;
  return JSON.stringify(Object.keys(row).sort().map((key) => {
    const value = normaliseValue(row[key]);
    return [key, value && typeof value === 'object' && 'instant' in value ? value.instant : value];
  }));
}

/** Row-by-row comparison; returns human-readable differences. */
function compareRows(table, sourceRows, restoredRows, rule = {}, context = {}) {
  const ignore = new Set(rule.ignoreColumns || []);
  const source = sourceRows.filter(row => !(rule.dropSourceRows && rule.dropSourceRows(row, context)));
  const restored = restoredRows.filter(row => !(rule.dropRestoredRows && rule.dropRestoredRows(row, context)));
  const differences = [];
  const byKey = new Map(restored.map(row => [rowKey(row), row]));
  if (byKey.size !== restored.length) differences.push(`${table}: restored rows have duplicate keys`);
  for (const row of source) {
    const key = rowKey(row);
    const other = byKey.get(key);
    if (!other) { differences.push(`${table} ${key}: missing after restore`); continue; }
    byKey.delete(key);
    for (const column of new Set([...Object.keys(row), ...Object.keys(other)])) {
      if (ignore.has(column)) continue;
      if (!(column in other)) differences.push(`${table} ${key}.${column}: column missing after restore`);
      else if (!(column in row)) differences.push(`${table} ${key}.${column}: column appeared after restore`);
      else if (!sameValue(row[column], other[column], { kind: context.columnKinds?.[table]?.[column] })) {
        differences.push(`${table} ${key}.${column}: ${JSON.stringify(row[column])} → ${JSON.stringify(other[column])}`);
      }
    }
  }
  for (const key of byKey.keys()) differences.push(`${table} ${key}: appeared after restore`);
  return differences;
}

const fileList = manifest => manifest.files
  .map(file => ({ path: file.path, size: Number(file.size), checksum: file.checksum }))
  .sort((a, b) => a.path.localeCompare(b.path));

async function assertFidelity(source, restored, { sameEngine }) {
  expect(restored.restore).toMatchObject({ restored: true, outcome: 'committed', crossEngine: !sameEngine });
  const first = source.manifest;
  const second = restored.manifest;

  // Same table set both ways.
  expect(Object.keys(second.tables).sort()).toEqual(Object.keys(first.tables).sort());

  // Seeding coverage: a table with no rows proves nothing, so the pinned list
  // may not grow (the reason says why the seeding could not fill it) and an
  // entry that now has rows must leave the list.
  const empty = Object.keys(first.tables).filter(table => !first.tables[table].rowCount);
  const newlyEmpty = empty.filter(table => !ZERO_ROW_TABLES.includes(table))
    .map(table => `${table}: ${source.seeding.unfilled[table] || 'no rows'}`);
  const nowFilled = ZERO_ROW_TABLES.filter(table => first.tables[table] && !empty.includes(table));
  expect({ newlyEmpty, nowFilled }).toEqual({ newlyEmpty: [], nowFilled: [] });

  const before = await readTables(source.filePath);
  const after = await readTables(restored.filePath);
  const operator = (before.admin_users || []).find(row => row.email === OPERATOR.email);
  expect(operator).toBeTruthy();
  const context = { operatorId: operator.id, columnKinds: sameEngine ? {} : restored.columnKinds };

  // Same-engine: manifests must agree byte for byte outside the rewrites.
  // The export reads each table with a plain SELECT (no ORDER BY), so on pg
  // a row the restore touched again can come back in another physical
  // position: same rows, other checksum. Such a table passes only when its
  // rows match exactly, compared without normalisation.
  if (sameEngine) {
    const drifted = Object.keys(first.tables).filter(table => !RESTORE_REWRITES[table]
      && (first.tables[table].rowCount !== second.tables[table].rowCount
        || first.tables[table].checksum !== second.tables[table].checksum));
    const sorted = rows => (rows || []).map(row => JSON.stringify(row)).sort();
    const changed = drifted.filter(table => JSON.stringify(sorted(before[table])) !== JSON.stringify(sorted(after[table])));
    const detail = changed.flatMap(table => compareRows(table, before[table] || [], after[table] || []));
    expect({ changed, detail }).toEqual({ changed: [], detail: [] });
  }

  // Row-level, normalised: every table (cross-engine) or the rewritten ones
  // (same-engine, where the rest already matched by checksum).
  const tables = sameEngine ? Object.keys(RESTORE_REWRITES) : Object.keys(first.tables);
  const differences = tables.flatMap(table => compareRows(table, before[table] || [], after[table] || [],
    RESTORE_REWRITES[table], context));
  expect(differences).toEqual([]);

  // Files: path, size and sha256.
  expect(fileList(second)).toEqual(fileList(first));
  expect(fileList(first).length).toBeGreaterThan(0);
}

beforeAll(async () => {
  workRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-fidelity-'));
});

afterAll(async () => {
  if (workRoot) await fs.rm(workRoot, { recursive: true, force: true });
});

describe('fidelity comparison helpers', () => {
  it('treats SQLite and pg representations of one value as equal', () => {
    expect(sameValue(1723400000000, '2024-08-11T18:13:20.000Z')).toBe(true);
    expect(sameValue(1723400000, '2024-08-11T18:13:20.000Z')).toBe(true);
    expect(sameValue('2024-08-11 18:13:20', '2024-08-11T18:13:20.000Z')).toBe(true);
    expect(sameValue('2024-08-11', '2024-08-11T00:00:00.000Z')).toBe(true);
    expect(sameValue(1, true)).toBe(true);
    expect(sameValue('1.50', 1.5)).toBe(true);
    expect(sameValue('{"b":1,"a":[true]}', { a: [true], b: 1 })).toBe(true);
    expect(sameValue('"en"', 'en', { kind: 'json' })).toBe(true);
    expect(sameValue('false', false, { kind: 'json' })).toBe(true);
    expect(sameValue('[{"b":1,"a":2}]', [{ a: 2, b: 1 }], { kind: 'json' })).toBe(true);
    expect(sameValue(1723400000000, '2024-08-11T00:00:00.000Z', { kind: 'date' })).toBe(true);
  });

  it('still tells different values apart', () => {
    expect(sameValue(1723400000000, '2024-08-11T18:13:21.000Z')).toBe(false);
    expect(sameValue('ü', 'u')).toBe(false);
    expect(sameValue(null, 0)).toBe(false);
    expect(sameValue('{"a":1}', { a: 2 })).toBe(false);
    expect(sameValue(1723400000000, '2024-08-12T00:00:00.000Z', { kind: 'date' })).toBe(false);
    expect(sameValue('"en"', 'en')).toBe(false); // outside a json column, text stays text
    expect(sameValue('"en"', 'de', { kind: 'json' })).toBe(false);
  });

  it('reports a dropped column and a changed value by table, key and column', () => {
    expect(compareRows('t', [{ id: 1, a: 'x', b: 2 }], [{ id: 1, a: 'y' }])).toEqual([
      't id:1.a: "x" → "y"', 't id:1.b: column missing after restore',
    ]);
  });
});

sqliteDescribe('.picpeak fidelity roundtrip (SQLite source)', () => {
  let source;

  beforeAll(async () => {
    source = await runInstance(sqliteEnv(), 'source', path.join(workRoot, 'sqlite-source-out'));
    expect(source.engine).toBe('sqlite');
  }, 300000);

  it('sqlite → sqlite restores every table and file unchanged', async () => {
    const restored = await runInstance(sqliteEnv(), 'restore', source.filePath,
      path.join(workRoot, 'sqlite-target-out'));
    expect(restored.engine).toBe('sqlite');
    await assertFidelity(source, restored, { sameEngine: true });
  }, 300000);

  pgDescribe('onto PostgreSQL', () => {
    let admin; const databases = [];
    beforeAll(async () => { admin = knex({ client: 'pg', connection: PG_URL }); });
    afterAll(async () => {
      await dropDatabases(admin, databases);
      if (admin) await admin.destroy();
    });

    it('sqlite → pg restores every value, after engine normalisation', async () => {
      const name = `picpeak_fidelity_${crypto.randomBytes(6).toString('hex')}`;
      await admin.raw('CREATE DATABASE ??', [name]);
      databases.push(name);
      const restored = await runInstance(pgEnv(name), 'restore', source.filePath,
        path.join(workRoot, 'xengine-target-out'));
      expect(restored.engine).toBe('pg');
      await assertFidelity(source, restored, { sameEngine: false });
    }, 300000);
  });
});

pgDescribe('.picpeak fidelity roundtrip (PostgreSQL source)', () => {
  let admin; const databases = [];
  const createDatabase = async () => {
    const name = `picpeak_fidelity_${crypto.randomBytes(6).toString('hex')}`;
    await admin.raw('CREATE DATABASE ??', [name]);
    databases.push(name);
    return name;
  };
  beforeAll(async () => { admin = knex({ client: 'pg', connection: PG_URL }); });
  afterAll(async () => {
    await dropDatabases(admin, databases);
    if (admin) await admin.destroy();
  });

  it('pg → pg restores every table and file unchanged', async () => {
    const source = await runInstance(pgEnv(await createDatabase()), 'source',
      path.join(workRoot, 'pg-source-out'));
    expect(source.engine).toBe('pg');
    const restored = await runInstance(pgEnv(await createDatabase()), 'restore', source.filePath,
      path.join(workRoot, 'pg-target-out'));
    expect(restored.engine).toBe('pg');
    await assertFidelity(source, restored, { sameEngine: true });
  }, 2 * 240000 + 60000);
});
