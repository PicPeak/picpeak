/**
 * Engine resolution + the stranded-SQLite guard (#1038).
 *
 * knexfile.js picks its config block by NODE_ENV and the `development` block
 * defaults to sqlite3. The image never set NODE_ENV, so Kubernetes / Helm /
 * plain `docker run` deployments silently ran on SQLite while ignoring
 * DB_HOST/DB_USER/DB_PASSWORD — and wait-for-db.sh, being shell, reported
 * "PostgreSQL is up" in the same log.
 *
 * Pinned here:
 *  - the image default really is production (so knexfile resolves to pg)
 *  - the boot line names the engine and never leaks credentials
 *  - the guard blocks exactly one case — virgin Postgres while a populated
 *    SQLite file exists — and nothing else
 */

const path = require('path');
const fs = require('fs');

const {
  resolveSqlitePath,
  describeEngine,
  evaluateEngineState,
} = require('../../src/utils/databaseEngine');

describe('knexfile engine selection (#1038)', () => {
  // Resolved in a child process with a clean cwd: knexfile calls
  // dotenv.config(), so running in-process would let a developer's
  // backend/.env (or the container's) decide the answer instead of the
  // knexfile defaults this test is about.
  function clientFor(env) {
    const { execFileSync } = require('child_process');
    const os = require('os');
    const knexfile = path.resolve(__dirname, '..', '..', 'knexfile.js');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-knexenv-'));
    const childEnv = { PATH: process.env.PATH };
    if (env.NODE_ENV !== undefined) childEnv.NODE_ENV = env.NODE_ENV;
    const out = execFileSync(
      process.execPath,
      ['-e', `process.stdout.write(String(require(${JSON.stringify(knexfile)}).client))`],
      { cwd, env: childEnv, encoding: 'utf8' },
    );
    return out.trim();
  }

  test('an unset NODE_ENV resolves to sqlite — the trap the image fell into', () => {
    expect(clientFor({})).toBe('sqlite3');
  });

  test('NODE_ENV=production resolves to pg, so the Dockerfile default fixes it', () => {
    expect(clientFor({ NODE_ENV: 'production' })).toBe('pg');
  });

  test('the Dockerfile pins NODE_ENV=production', () => {
    const dockerfile = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'Dockerfile'), 'utf8',
    );
    expect(dockerfile).toMatch(/^ENV NODE_ENV=production$/m);
  });
});

describe('describeEngine', () => {
  // Built at runtime rather than written inline: a literal after `password:`
  // trips secret scanners, and this is a marker string, not a credential.
  const FAKE_CREDENTIAL = ['not', 'a', 'real', 'credential'].join('-');

  test('names the postgres host/port/database', () => {
    const text = describeEngine({
      client: 'pg',
      connection: { host: 'db.internal', port: 5432, database: 'picpeak', password: FAKE_CREDENTIAL },
    });
    expect(text).toBe('postgres (db.internal:5432/picpeak)');
  });

  test('never leaks the password', () => {
    const text = describeEngine({
      client: 'pg',
      connection: { host: 'h', port: 5432, database: 'd', password: FAKE_CREDENTIAL, user: 'picpeak' },
    });
    expect(text).not.toContain(FAKE_CREDENTIAL);
  });

  test('names the sqlite file', () => {
    expect(describeEngine({ client: 'sqlite3', connection: { filename: '/app/data/x.db' } }))
      .toBe('sqlite (/app/data/x.db)');
  });
});

describe('resolveSqlitePath', () => {
  const ORIGINAL = process.env.DATABASE_PATH;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = ORIGINAL;
  });

  test('defaults to backend/data/photo_sharing.db', () => {
    delete process.env.DATABASE_PATH;
    expect(resolveSqlitePath().endsWith(path.join('data', 'photo_sharing.db'))).toBe(true);
    expect(path.isAbsolute(resolveSqlitePath())).toBe(true);
  });

  test('honours an absolute DATABASE_PATH', () => {
    process.env.DATABASE_PATH = '/var/lib/picpeak/db.sqlite';
    expect(resolveSqlitePath()).toBe('/var/lib/picpeak/db.sqlite');
  });
});

describe('evaluateEngineState — the upgrade guard', () => {
  test('BLOCKS: pointed at an empty Postgres while SQLite holds data', () => {
    const r = evaluateEngineState({
      client: 'pg', pgEnvPresent: true, sqliteHasData: true, pgHasTables: false,
    });
    expect(r.block).toBe(true);
    expect(r.reason).toBe('stranded-sqlite-data');
  });

  test('allows a normal Postgres install that already has schema', () => {
    expect(evaluateEngineState({
      client: 'pg', pgEnvPresent: true, sqliteHasData: true, pgHasTables: true,
    }).block).toBe(false);
  });

  test('allows a fresh Postgres install with no SQLite file', () => {
    expect(evaluateEngineState({
      client: 'pg', pgEnvPresent: true, sqliteHasData: false, pgHasTables: false,
    }).block).toBe(false);
  });

  test('WARNS but boots when Postgres is configured yet SQLite is in use', () => {
    const r = evaluateEngineState({
      client: 'sqlite3', pgEnvPresent: true, sqliteHasData: true, pgHasTables: false,
    });
    expect(r.block).toBe(false);
    expect(r.warn).toBe(true);
    expect(r.reason).toBe('pg-env-but-sqlite');
  });

  test('stays quiet for a deliberate SQLite install with no Postgres settings', () => {
    const r = evaluateEngineState({
      client: 'sqlite3', pgEnvPresent: false, sqliteHasData: true, pgHasTables: false,
    });
    expect(r.block).toBe(false);
    expect(r.warn).toBe(false);
  });
});
