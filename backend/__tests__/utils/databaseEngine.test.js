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

const os = require('os');
const {
  resolveSqlitePath,
  describeEngine,
  decideBootEngine,
  probeSqliteData,
  migrationMarkerPath,
  hasMigrationMarker,
} = require('../../src/utils/databaseEngine');
const {
  epochToIso,
  parseJsonText,
  coerceForTargetEngine,
} = require('../../src/services/picpeakImportService');

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

describe('decideBootEngine — what an existing install gets after the fix', () => {
  test('STAYS on SQLite when Postgres is configured but holds no galleries', () => {
    // The install that has been unknowingly running on SQLite. Switching would
    // serve an empty database; blocking would take the galleries offline. It
    // keeps running exactly as before, loudly.
    const r = decideBootEngine({
      configuredClient: 'pg', explicitClient: null, pgHasData: false, sqliteHasData: true,
    });
    expect(r.client).toBe('sqlite3');
    expect(r.overridden).toBe(true);
    expect(r.reason).toBe('stranded-sqlite-data');
  });

  test('switches to Postgres by itself once the data is there', () => {
    // i.e. straight after scripts/migrate-sqlite-to-postgres.js — no further
    // operator action needed on the next restart.
    const r = decideBootEngine({
      configuredClient: 'pg', explicitClient: null, pgHasData: true, sqliteHasData: true,
    });
    expect(r.client).toBe('pg');
    expect(r.overridden).toBe(false);
  });

  test('a fresh install with no SQLite file goes straight to Postgres', () => {
    expect(decideBootEngine({
      configuredClient: 'pg', explicitClient: null, pgHasData: false, sqliteHasData: false,
    }).client).toBe('pg');
  });

  test('an explicit DATABASE_CLIENT is always honoured', () => {
    expect(decideBootEngine({
      configuredClient: 'pg', explicitClient: 'sqlite3', pgHasData: true, sqliteHasData: true,
    }).client).toBe('sqlite3');
    expect(decideBootEngine({
      configuredClient: 'sqlite3', explicitClient: 'pg', pgHasData: false, sqliteHasData: false,
    }).client).toBe('pg');
  });

  test('forcing pg while SQLite still holds data is allowed, but flagged', () => {
    const r = decideBootEngine({
      configuredClient: 'pg', explicitClient: 'pg', pgHasData: false, sqliteHasData: true,
    });
    expect(r.client).toBe('pg');
    expect(r.reason).toBe('explicit-pg-leaves-sqlite-behind');
  });

  test('keyed on DATA, not on tables: a migrated-but-empty Postgres still defers to SQLite', () => {
    // A stray `run-migrations` against the empty Postgres creates every table.
    // Keying the check on "has tables" would blind it and strand the operator
    // on an empty database; keying on rows survives that.
    expect(decideBootEngine({
      configuredClient: 'pg', explicitClient: null, pgHasData: false, sqliteHasData: true,
    }).client).toBe('sqlite3');
  });
});

describe('cross-engine row coercion (#1038)', () => {
  test('epoch milliseconds become an ISO timestamp Postgres accepts', () => {
    // SQLite writes Date objects as epoch ms; pg rejects the bare number with
    // "date/time field value out of range".
    expect(epochToIso(1786548038763)).toBe('2026-08-12T15:20:38.763Z');
  });

  test('epoch seconds are recognised too', () => {
    expect(epochToIso(1786548038)).toBe('2026-08-12T15:20:38.000Z');
  });

  test('a non-numeric value is left alone', () => {
    expect(epochToIso('not-a-date')).toBe('not-a-date');
  });

  test('timestamp and boolean columns are coerced, others untouched', () => {
    const rows = [{
      id: 1, created_at: 1786548038763, expires_at: '1786548038763',
      allow_downloads: 0, allow_user_uploads: 1, event_name: 'Wedding', hero_photo_id: null,
    }];
    const [out] = coerceForTargetEngine(rows, {
      timestamps: ['created_at', 'expires_at'],
      booleans: ['allow_downloads', 'allow_user_uploads'],
    });
    expect(out.created_at).toBe('2026-08-12T15:20:38.763Z');
    expect(out.expires_at).toBe('2026-08-12T15:20:38.763Z');
    expect(out.allow_downloads).toBe(false);
    expect(out.allow_user_uploads).toBe(true);
    expect(out.event_name).toBe('Wedding');
    expect(out.hero_photo_id).toBeNull();
    expect(out.id).toBe(1);
  });

  test('nulls and empty strings survive untouched', () => {
    const [out] = coerceForTargetEngine(
      [{ created_at: null, expires_at: '', allow_downloads: null }],
      { timestamps: ['created_at', 'expires_at'], booleans: ['allow_downloads'] },
    );
    expect(out.created_at).toBeNull();
    expect(out.expires_at).toBe('');
    expect(out.allow_downloads).toBeNull();
  });

  test('an ISO string is not mangled into a number', () => {
    const [out] = coerceForTargetEngine(
      [{ created_at: '2026-08-12T15:20:38.763Z' }], { timestamps: ['created_at'], booleans: [] },
    );
    expect(out.created_at).toBe('2026-08-12T15:20:38.763Z');
  });
});

describe('SQLite JSON text is decoded before Postgres serialisation (#1038 review)', () => {
  // SQLite has no json type: its json columns are TEXT holding JSON. The export
  // dumps that as a STRING, and serialiseJsonColumns would then stringify it a
  // SECOND time, so Postgres stored `true` as the scalar string "true".
  // app_settings.setting_value is json on every install, so this reshaped every
  // migrated setting.
  test('a JSON object in text form is decoded', () => {
    expect(parseJsonText('{"primaryColor":"#123456"}')).toEqual({ primaryColor: '#123456' });
  });

  test('JSON scalars are decoded to their real type', () => {
    expect(parseJsonText('true')).toBe(true);
    expect(parseJsonText('42')).toBe(42);
    expect(parseJsonText('[1,2]')).toEqual([1, 2]);
  });

  test('a plain word stays a plain word — text columns are not reinterpreted', () => {
    expect(parseJsonText('PicPeak')).toBe('PicPeak');
    expect(parseJsonText('hero')).toBe('hero');
    expect(parseJsonText('')).toBe('');
  });

  test('malformed JSON is left untouched rather than thrown away', () => {
    expect(parseJsonText('{not json')).toBe('{not json');
  });

  test('non-strings pass through', () => {
    expect(parseJsonText(null)).toBeNull();
    expect(parseJsonText(7)).toBe(7);
    expect(parseJsonText({ a: 1 })).toEqual({ a: 1 });
  });

  test('json columns are decoded alongside the timestamp/boolean coercion', () => {
    const [out] = coerceForTargetEngine(
      [{ setting_value: 'true', created_at: 1786548038763, feedback_enabled: 1, name: 'plain' }],
      {
        timestamps: ['created_at'],
        booleans: ['feedback_enabled'],
        jsonCols: new Set(['setting_value']),
      },
    );
    expect(out.setting_value).toBe(true);
    expect(out.created_at).toBe('2026-08-12T15:20:38.763Z');
    expect(out.feedback_enabled).toBe(true);
    expect(out.name).toBe('plain');
  });
});

describe('probeSqliteData fails closed (#1038 review)', () => {
  function tmpDb(contents) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-probe-'));
    const file = path.join(dir, 'photo_sharing.db');
    fs.writeFileSync(file, contents);
    return file;
  }

  test('a corrupt/unreadable file counts as "holds data", never as empty', async () => {
    // Reporting "no data" here would switch the install to an empty Postgres —
    // the exact failure this module exists to prevent.
    await expect(probeSqliteData(tmpDb('this is not a sqlite database'))).resolves.toBe(true);
  });

  test('a missing file is genuinely no data', async () => {
    await expect(probeSqliteData('/nonexistent/photo_sharing.db')).resolves.toBe(false);
  });

  test('the migration marker pins the install to Postgres', async () => {
    // Once migrated, a Postgres that merely LOOKS empty (every gallery deleted)
    // must not send the install back to the now-stale SQLite file.
    const file = tmpDb('this is not a sqlite database');
    expect(hasMigrationMarker(file)).toBe(false);
    expect(await probeSqliteData(file)).toBe(true);

    fs.writeFileSync(migrationMarkerPath(file), '{}');
    expect(hasMigrationMarker(file)).toBe(true);
    expect(await probeSqliteData(file)).toBe(false);
  });

  test('the marker sits next to the database file', () => {
    expect(migrationMarkerPath('/app/data/photo_sharing.db'))
      .toBe('/app/data/photo_sharing.db.migrated-to-postgres');
  });
});
