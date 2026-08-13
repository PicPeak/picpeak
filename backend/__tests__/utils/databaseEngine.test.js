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
  migrationInProgressPath,
  hasMigrationInProgress,
  isUntouchedBootstrapRow,
  adminsIndicateUse,
} = require('../../src/utils/databaseEngine');
const {
  epochToIso,
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
    // operator action needed on the next restart. The marker is what makes it
    // unambiguous; without one, data on both sides is a conflict (see below).
    const r = decideBootEngine({
      configuredClient: 'pg', explicitClient: null, pgHasData: true, sqliteHasData: true,
      migrationCompleted: true, pgConfigured: true,
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

describe('an unfinished migration pins the boot to SQLite (#1038 review)', () => {
  // A migration that dies after touching Postgres leaves rows there — schema
  // creation alone seeds a bootstrap admin when ADMIN_PASSWORD is set. Those
  // rows read as "occupied", so without a pin the next restart would switch
  // engines and hide the SQLite data that is still authoritative.
  test('Postgres holding partial data does NOT win while the migration is unfinished', () => {
    const r = decideBootEngine({
      configuredClient: 'pg',
      explicitClient: null,
      pgHasData: true,          // e.g. just the bootstrap admin, or a half-load
      sqliteHasData: true,
      migrationInProgress: true,
    });
    expect(r.client).toBe('sqlite3');
    expect(r.reason).toBe('migration-incomplete');
  });

  test('once the migration completes, Postgres wins again', () => {
    // Completed means the marker exists — that is what distinguishes this from
    // two populated databases nobody has reconciled.
    expect(decideBootEngine({
      configuredClient: 'pg',
      explicitClient: null,
      pgHasData: true,
      sqliteHasData: true,
      migrationInProgress: false,
      migrationCompleted: true,
      pgConfigured: true,
    }).client).toBe('pg');
  });

  test('the pin is irrelevant when there is no SQLite data to protect', () => {
    expect(decideBootEngine({
      configuredClient: 'pg',
      explicitClient: null,
      pgHasData: true,
      sqliteHasData: false,
      migrationInProgress: true,
    }).client).toBe('pg');
  });

  test('the pin file sits next to the database', () => {
    expect(migrationInProgressPath('/app/data/photo_sharing.db'))
      .toBe('/app/data/photo_sharing.db.migration-in-progress');
    expect(hasMigrationInProgress('/nonexistent/photo_sharing.db')).toBe(false);
  });
});

describe('the migration pin outranks an explicit client (#1038 review r6)', () => {
  // docker-compose sets DATABASE_CLIENT=pg, so without this an unfinished
  // migration would be ignored on exactly the deployments that pin it, and a
  // half-written Postgres would be served.
  test('explicit pg loses to an unfinished migration while SQLite holds data', () => {
    const r = decideBootEngine({
      configuredClient: 'pg', explicitClient: 'pg',
      pgHasData: true, sqliteHasData: true, migrationInProgress: true,
    });
    expect(r.client).toBe('sqlite3');
    expect(r.reason).toBe('migration-incomplete');
  });

  test('explicit sqlite3 is left alone — it already points at the data', () => {
    expect(decideBootEngine({
      configuredClient: 'pg', explicitClient: 'sqlite3',
      pgHasData: true, sqliteHasData: true, migrationInProgress: true,
    }).client).toBe('sqlite3');
  });

  test('once the migration finishes, explicit pg is honoured again', () => {
    expect(decideBootEngine({
      configuredClient: 'pg', explicitClient: 'pg',
      pgHasData: true, sqliteHasData: true, migrationInProgress: false,
    }).client).toBe('pg');
  });

  test('a pin with no SQLite data left does not strand the install', () => {
    expect(decideBootEngine({
      configuredClient: 'pg', explicitClient: 'pg',
      pgHasData: true, sqliteHasData: false, migrationInProgress: true,
    }).client).toBe('pg');
  });
});

describe('bootstrap admin vs real admin (#1038 review r7)', () => {
  // core/001_init.js seeds must_change_password=true when ADMIN_PASSWORD is set;
  // setupService writes false once a human finishes first-run setup. Judging by
  // the FLAG rather than the table keeps both mistakes away: counting the seed
  // as real data would abandon a populated SQLite file, and ignoring the whole
  // table would abandon a legitimately set-up Postgres.
  test('an untouched seeded row is recognised across both engines', () => {
    expect(isUntouchedBootstrapRow(true)).toBe(true);
    expect(isUntouchedBootstrapRow(1)).toBe(true);
    expect(isUntouchedBootstrapRow('1')).toBe(true);
  });

  test('a completed setup is not a bootstrap row', () => {
    expect(isUntouchedBootstrapRow(false)).toBe(false);
    expect(isUntouchedBootstrapRow(0)).toBe(false);
    expect(isUntouchedBootstrapRow('0')).toBe(false);
  });

  test('a legacy NULL counts as a real admin, not a seed', () => {
    expect(isUntouchedBootstrapRow(null)).toBe(false);
    expect(isUntouchedBootstrapRow(undefined)).toBe(false);
  });
});

describe('admin rows: bootstrap seed vs real use (#1038 review r7/r8)', () => {
  // must_change_password alone is mutable — resetAdminPassword() sets it on real
  // accounts — so it cannot be the only signal. Only the exact shape
  // core/001_init.js leaves behind reads as an untouched seed.
  test('one never-used seeded admin is NOT use', () => {
    expect(adminsIndicateUse([{ must_change_password: true, last_login: null }])).toBe(false);
    expect(adminsIndicateUse([{ must_change_password: 1, last_login: null }])).toBe(false);
  });

  test('a completed first-run setup IS use', () => {
    expect(adminsIndicateUse([{ must_change_password: false, last_login: null }])).toBe(true);
  });

  test('a real admin whose password was RESET is still use', () => {
    // resetAdminPassword() re-raises must_change_password on a live account.
    expect(adminsIndicateUse([
      { must_change_password: true, last_login: '2026-08-01T10:00:00Z' },
    ])).toBe(true);
  });

  test('more than one admin is use regardless of flags', () => {
    expect(adminsIndicateUse([
      { must_change_password: true, last_login: null },
      { must_change_password: true, last_login: null },
    ])).toBe(true);
  });

  test('no admins at all is not use', () => {
    expect(adminsIndicateUse([])).toBe(false);
  });

  test('installs predating the last_login column still work', () => {
    expect(adminsIndicateUse([{ must_change_password: true }])).toBe(false);
    expect(adminsIndicateUse([{ must_change_password: false }])).toBe(true);
  });
});

describe('cross-engine JSON columns pass through untouched (#1038 review r8)', () => {
  // SQLite keeps json columns as TEXT holding valid JSON, and pg accepts JSON
  // text directly, so the coercion must not touch them at all: serialising
  // would store `{"a":1}` as a scalar string, and parse-then-serialise turned
  // the JSON literal `null` into SQL NULL, breaking NOT NULL json columns.
  test('timestamps and booleans are coerced; nothing else is', () => {
    const [out] = coerceForTargetEngine(
      [{ setting_value: '{"a":1}', nulled: 'null', created_at: 1786548038763, flag: 1 }],
      { timestamps: ['created_at'], booleans: ['flag'] },
    );
    expect(out.setting_value).toBe('{"a":1}');
    expect(out.nulled).toBe('null');
    expect(out.created_at).toBe('2026-08-12T15:20:38.763Z');
    expect(out.flag).toBe(true);
  });
});

describe('Postgres probe: unreachable vs unusable (#1038 review r9)', () => {
  const { probePgData } = require('../../src/utils/databaseEngine');

  test('an unreachable Postgres reports "occupied" so a healthy install is not diverted', async () => {
    // A transient network failure must not hand a live pg install over to a
    // stale SQLite file; startup should surface the real connection error.
    const warnings = [];
    const result = await probePgData(
      { host: '127.0.0.1', port: 59999, user: 'nobody', password: 'x', database: 'nope' },
      (m) => warnings.push(m),
    );
    expect(result).toBe(true);
    expect(warnings.join(' ')).toMatch(/unreachable/i);
  }, 30000);
});

describe('a completed migration overrides an implicit SQLite config (#1038 review r11)', () => {
  // The affected installs ARE the ones with NODE_ENV unset — that is why they
  // ended up on SQLite. An operator can easily migrate before fixing that, and
  // by then the source file has been renamed away, so honouring the implicit
  // sqlite3 would create a NEW empty database and serve it.
  test('marker + Postgres settings beat an implicitly-resolved sqlite3', () => {
    const r = decideBootEngine({
      configuredClient: 'sqlite3', explicitClient: null,
      pgHasData: true, sqliteHasData: false,
      migrationCompleted: true, pgConfigured: true,
    });
    expect(r.client).toBe('pg');
    expect(r.reason).toBe('migrated-to-postgres');
  });

  test('an EXPLICIT sqlite3 still wins — that is a deliberate rollback', () => {
    expect(decideBootEngine({
      configuredClient: 'sqlite3', explicitClient: 'sqlite3',
      pgHasData: true, sqliteHasData: false,
      migrationCompleted: true, pgConfigured: true,
    }).client).toBe('sqlite3');
  });

  test('without Postgres settings there is nowhere to send it', () => {
    expect(decideBootEngine({
      configuredClient: 'sqlite3', explicitClient: null,
      pgHasData: false, sqliteHasData: false,
      migrationCompleted: true, pgConfigured: false,
    }).client).toBe('sqlite3');
  });

  test('no marker, no override — a plain SQLite install is left alone', () => {
    expect(decideBootEngine({
      configuredClient: 'sqlite3', explicitClient: null,
      pgHasData: false, sqliteHasData: true,
      migrationCompleted: false, pgConfigured: true,
    }).client).toBe('sqlite3');
  });
});

describe('two populated databases is a conflict, not a guess (#1038 review r12)', () => {
  // An install that ran on Postgres, lost NODE_ENV, and kept working on SQLite
  // has real data on BOTH sides: the Postgres rows are old, the SQLite rows are
  // newer. Picking either hides galleries and splits future writes.
  test('no marker + data on both sides refuses to choose', () => {
    const r = decideBootEngine({
      configuredClient: 'pg', explicitClient: null,
      pgHasData: true, sqliteHasData: true, migrationCompleted: false,
    });
    expect(r.client).toBeNull();
    expect(r.reason).toBe('ambiguous-both-populated');
  });

  test('a completed migration is not a conflict — the marker says which is current', () => {
    expect(decideBootEngine({
      configuredClient: 'pg', explicitClient: null,
      pgHasData: true, sqliteHasData: true, migrationCompleted: true, pgConfigured: true,
    }).client).toBe('pg');
  });

  test('an explicit choice always resolves it', () => {
    expect(decideBootEngine({
      configuredClient: 'pg', explicitClient: 'sqlite3',
      pgHasData: true, sqliteHasData: true, migrationCompleted: false,
    }).client).toBe('sqlite3');
    expect(decideBootEngine({
      configuredClient: 'pg', explicitClient: 'pg',
      pgHasData: true, sqliteHasData: true, migrationCompleted: false,
    }).client).toBe('pg');
  });

  test('only one side populated is not a conflict', () => {
    expect(decideBootEngine({
      configuredClient: 'pg', explicitClient: null,
      pgHasData: true, sqliteHasData: false, migrationCompleted: false,
    }).client).toBe('pg');
    expect(decideBootEngine({
      configuredClient: 'pg', explicitClient: null,
      pgHasData: false, sqliteHasData: true, migrationCompleted: false,
    }).client).toBe('sqlite3');
  });

  test('the pg probe target comes from the environment, not a sqlite config', () => {
    const { pgConnectionFromEnv } = require('../../src/utils/databaseEngine');
    const prev = { ...process.env };
    process.env.DB_HOST = 'db.internal';
    process.env.DB_NAME = 'picpeak_prod';
    try {
      const c = pgConnectionFromEnv();
      expect(c.host).toBe('db.internal');
      expect(c.database).toBe('picpeak_prod');
    } finally {
      process.env.DB_HOST = prev.DB_HOST;
      process.env.DB_NAME = prev.DB_NAME;
    }
  });
});

describe('the target is resolved once, with production defaults (#1038 review r13)', () => {
  // knexfile's DEVELOPMENT block defaults pg to localhost/postgres/photo_sharing
  // while production uses db/picpeak/picpeak. The CLI runs in the NODE_ENV-unset
  // state by design, so without an explicit resolution the migration could land
  // in a database the running application never opens.
  const { pgConnectionFromEnv } = require('../../src/utils/databaseEngine');

  test('falls back to what a running container actually uses', () => {
    // Host is `postgres`, matching wait-for-db.sh, which resolves and EXPORTS
    // that value — so it is the host a bare container really runs against.
    // knexfile's production block says `db`, but that default is only reached
    // when the entrypoint did not run; a `docker exec` CLI has to agree with
    // the runtime, not with the dormant default (#1038 review r14).
    const prev = { ...process.env };
    delete process.env.DB_HOST; delete process.env.DB_USER; delete process.env.DB_NAME;
    try {
      const c = pgConnectionFromEnv();
      expect(c.host).toBe('postgres');
      expect(c.user).toBe('picpeak');
      expect(c.database).toBe('picpeak');
    } finally {
      Object.assign(process.env, prev);
    }
  });

  test('explicit settings always win', () => {
    const prev = { ...process.env };
    process.env.DB_HOST = 'pg.example'; process.env.DB_NAME = 'mypics';
    try {
      const c = pgConnectionFromEnv();
      expect(c.host).toBe('pg.example');
      expect(c.database).toBe('mypics');
    } finally {
      Object.assign(process.env, prev);
    }
  });
});

describe('the marker is bound to the target it describes (#1038 review r15)', () => {
  const { currentPgTargetId, readMigrationMarker } = require('../../src/utils/databaseEngine');

  test('the target id has the shape the migration records', () => {
    const prev = { ...process.env };
    process.env.DB_HOST = 'pg.host'; process.env.DB_PORT = '6543'; process.env.DB_NAME = 'picpeak_prod';
    try {
      expect(currentPgTargetId()).toBe('pg.host:6543/picpeak_prod');
    } finally {
      Object.assign(process.env, prev);
    }
  });

  test('an absent or unreadable marker reads as null, not a throw', () => {
    expect(readMigrationMarker('/nonexistent/photo_sharing.db')).toBeNull();
  });

  test('inbound_documents is a real table; incoming_invoices never was', () => {
    // The occupancy lists silently skip tables that do not exist, so a wrong
    // name meant supplier documents never protected the install.
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'src', 'utils', 'databaseEngine.js'), 'utf8',
    );
    const cli = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'scripts', 'migrate-sqlite-to-postgres.js'), 'utf8',
    );
    for (const text of [src, cli]) {
      expect(text).toContain("'inbound_documents'");
      expect(text).not.toContain("'incoming_invoices'");
    }
  });
});
