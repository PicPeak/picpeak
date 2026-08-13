'use strict';

/**
 * Which database engine is this process actually using, and is that what the
 * operator intended? (#1038)
 *
 * knexfile.js selects its config block by NODE_ENV, and the `development`
 * block defaults to sqlite3. The Docker image never set NODE_ENV, so every
 * deployment that doesn't go through our compose files — Kubernetes, Helm,
 * plain `docker run` — silently landed on SQLite and ignored DB_HOST /
 * DB_USER / DB_PASSWORD entirely. wait-for-db.sh is shell and reads DB_HOST
 * directly, so the same container happily reported "PostgreSQL is up" while
 * the app wrote to a SQLite file.
 *
 * Now that the image pins NODE_ENV=production, those installs would resolve to
 * Postgres on their next pull — and come up against an EMPTY database, which
 * reads as total data loss. Blocking the boot would protect the data but take
 * the galleries offline for an operator who did nothing wrong, so instead we
 * STAY on SQLite (the engine that holds their data), say so loudly, and point
 * at the migration script. Nothing moves until the operator decides.
 *
 * decideBootEngine() is pure so the matrix is testable; the probes around it
 * are deliberately thin.
 */

const fs = require('fs');
const { resolveSqliteFilename } = require('./sqlitePath');
// Shared with knexfile so the engine guard can never probe a different target
// than the application opens (#1038).
const { pgConnectionFromEnv } = require('./pgConnection');

// Diagnostics go through an injected sink, never a module-level logger: the
// resolver's STDOUT is a protocol channel (wait-for-db.sh captures it), and the
// app logger writes there whenever LOG_TO_CONSOLE=true.
const warnToStderr = (msg) => process.stderr.write(`${msg}\n`);

/** Absolute path of the SQLite file this install would use — the SAME
 *  resolution knexfile performs, so the guard can never probe a different file
 *  than the one knex opens. */
function resolveSqlitePath() {
  return resolveSqliteFilename(process.env.DATABASE_PATH || './data/photo_sharing.db');
}

/** Human-readable "engine + target", safe to log — never includes credentials. */
function describeEngine(knexConfig) {
  const client = knexConfig?.client || 'unknown';
  if (client === 'pg') {
    const c = knexConfig.connection || {};
    return `postgres (${c.host || 'unknown-host'}:${c.port || 5432}/${c.database || 'unknown-db'})`;
  }
  const filename = knexConfig?.connection?.filename || resolveSqlitePath();
  return `sqlite (${filename})`;
}

/**
 * Which engine should this boot actually use?
 *
 * @param {object}  state
 * @param {string}  state.configuredClient  what knexfile resolved to
 * @param {string=} state.explicitClient    DATABASE_CLIENT, if the operator set it
 * @param {boolean} state.pgHasData         the Postgres target already holds galleries
 * @param {boolean} state.sqliteHasData     a SQLite file exists AND holds events
 * @returns {{ client: string, overridden: boolean, reason: string|null }}
 */
function decideBootEngine({
  configuredClient, explicitClient, pgHasData, sqliteHasData,
  migrationInProgress = false, migrationCompleted = false, pgConfigured = false,
}) {
  // A migration that never finished outranks everything, including an explicit
  // DATABASE_CLIENT=pg: Postgres may hold a half-written copy while SQLite is
  // still the database of record. Deleting the marker is the documented
  // override. (Explicit sqlite3 already points at the data, so leave it alone.)
  if (migrationInProgress && sqliteHasData && explicitClient !== 'sqlite3') {
    return { client: 'sqlite3', overridden: true, reason: 'migration-incomplete' };
  }

  // The data was migrated to Postgres, but nothing in the environment says so:
  // DATABASE_CLIENT is unset and NODE_ENV still resolves to the development
  // block, i.e. sqlite3. That is the state the affected installs are IN — it is
  // why they ended up on SQLite in the first place — so an operator can easily
  // migrate before fixing it. The source file has been renamed away by then, so
  // honouring the implicit sqlite3 would create a NEW, empty database and serve
  // it. The marker is durable proof of where the data actually is.
  if (!explicitClient && configuredClient !== 'pg' && migrationCompleted && pgConfigured) {
    return { client: 'pg', overridden: true, reason: 'migrated-to-postgres' };
  }

  // An explicit DATABASE_CLIENT is an instruction, not a guess. Never override
  // it — this is also the documented way to force Postgres and start fresh.
  if (explicitClient) {
    return {
      client: explicitClient,
      overridden: false,
      reason: explicitClient === 'pg' && sqliteHasData && !pgHasData
        ? 'explicit-pg-leaves-sqlite-behind'
        : null,
    };
  }

  // A migration started and never finished. Postgres may hold a partial copy,
  // which would otherwise read as "occupied" and win — while SQLite is still
  // the database of record.
  if (configuredClient === 'pg' && migrationInProgress && sqliteHasData) {
    return { client: 'sqlite3', overridden: true, reason: 'migration-incomplete' };
  }

  // Both sides hold data and nothing records which is authoritative. This is
  // the shape of an install that ran on Postgres, silently fell to SQLite when
  // NODE_ENV was lost, and kept working there: the Postgres rows are real but
  // stale, and the SQLite rows are real and newer. A completed migration would
  // have left a marker; without one, guessing either way hides data and splits
  // subsequent writes across two databases. Stop and let a human decide.
  if (configuredClient === 'pg' && !migrationCompleted && pgHasData && sqliteHasData) {
    return { client: null, overridden: false, reason: 'ambiguous-both-populated' };
  }

  // Configured for Postgres, Postgres holds no galleries, and real data sits in
  // a SQLite file: this install has been unknowingly running on SQLite. Keep
  // serving from where the data actually is. Deliberately keyed on DATA, not on
  // "has tables" — a stray migration run against the empty Postgres would
  // otherwise blind this check and strand the operator on an empty database.
  if (configuredClient === 'pg' && !pgHasData && sqliteHasData) {
    return { client: 'sqlite3', overridden: true, reason: 'stranded-sqlite-data' };
  }

  return { client: configuredClient, overridden: false, reason: null };
}

/** Marker written by scripts/migrate-sqlite-to-postgres.js once the data is in
 *  Postgres. Its presence pins the install to Postgres for good: without it, a
 *  Postgres that is merely EMPTY (every gallery deleted, say) would look
 *  identical to one that was never migrated, and the boot would fall back to a
 *  stale SQLite file that has been out of date since the migration. */
function migrationMarkerPath(sqlitePath = resolveSqlitePath()) {
  return `${sqlitePath}.migrated-to-postgres`;
}

function hasMigrationMarker(sqlitePath = resolveSqlitePath()) {
  return fs.existsSync(migrationMarkerPath(sqlitePath));
}

/** The marker's contents, or null when absent/unreadable. */
function readMigrationMarker(sqlitePath = resolveSqlitePath()) {
  try {
    return JSON.parse(fs.readFileSync(migrationMarkerPath(sqlitePath), 'utf8'));
  } catch (_) {
    return null;
  }
}

/** `host:port/database`, the identity the migration records and compares. */
function currentPgTargetId() {
  const c = pgConnectionFromEnv();
  return `${c.host}:${c.port}/${c.database}`;
}

/** Written before the migration touches Postgres, cleared only on success.
 *  While it exists, Postgres may hold a PARTIAL copy — or just the bootstrap
 *  admin that schema creation seeds — and SQLite is still the authoritative
 *  database. Without this pin, a migration that failed after writing anything
 *  to Postgres would make the next boot switch engines and hide the real data. */
function migrationInProgressPath(sqlitePath = resolveSqlitePath()) {
  return `${sqlitePath}.migration-in-progress`;
}

function hasMigrationInProgress(sqlitePath = resolveSqlitePath()) {
  return fs.existsSync(migrationInProgressPath(sqlitePath));
}

// Tables that are EMPTY on a freshly migrated schema, so a row in any of them
// means a human has used this install. Deliberately wider than `events`:
// judging occupancy by galleries alone would abandon an install whose galleries
// were all deleted but whose admins, customers and accounting records remain.
// Mirrors USER_DATA_TABLES in scripts/migrate-sqlite-to-postgres.js.
const USER_DATA_TABLES = [
  'events', 'photos', 'photo_feedback', 'admin_users', 'customer_accounts',
  'quotes', 'invoices', 'projects', 'expenses', 'inbound_documents',
];

// core/001_init.js seeds an admin with must_change_password = true when
// ADMIN_PASSWORD is set; setupService writes false once a human completes
// first-run setup. So the FLAG, not the table, is what distinguishes an
// untouched bootstrap row from a real account. Dropping the whole table (as an
// earlier revision did) made a legitimately set-up Postgres look empty, which
// would hand the install to a stale SQLite file and lose the admin's
// credentials and configuration.
const isUntouchedBootstrapRow = (v) => v === true || v === 1 || v === '1';

// Has anyone actually USED this install's admin accounts? Layered, because no
// single column survives every path:
//   - more than one admin  → somebody created accounts
//   - any admin has logged in → real use, even if the password was later reset
//   - must_change_password false → first-run setup was completed
// Only the exact shape core/001_init.js leaves behind — one admin, never logged
// in, still flagged — reads as an untouched bootstrap seed.
function adminsIndicateUse(rows) {
  if (rows.length > 1) return true;
  return rows.some((r) => r.last_login || !isUntouchedBootstrapRow(r.must_change_password));
}

async function countsAsUse(conn, table, { ignoreBootstrapAdmins }) {
  if (table === 'admin_users' && ignoreBootstrapAdmins) {
    const cols = ['must_change_password'];
    if (await conn.schema.hasColumn('admin_users', 'last_login')) cols.push('last_login');
    return adminsIndicateUse(await conn('admin_users').select(cols));
  }
  const row = await conn(table).count('* as count').first();
  return Number(row?.count || 0) > 0;
}

async function anyUserData(conn, { ignoreBootstrapAdmins = false } = {}) {
  for (const table of USER_DATA_TABLES) {
    if (!(await conn.schema.hasTable(table))) continue;
    if (await countsAsUse(conn, table, { ignoreBootstrapAdmins })) return true;
  }
  return false;
}

/** True when a SQLite file exists and carries user data. */
async function probeSqliteData(sqlitePath = resolveSqlitePath(), onWarn = warnToStderr) {
  if (hasMigrationMarker(sqlitePath)) return false;
  if (!fs.existsSync(sqlitePath)) return false;
  const knex = require('knex');
  const probe = knex({
    client: 'sqlite3',
    connection: { filename: sqlitePath },
    useNullAsDefault: true,
  });
  try {
    // Same discrimination as the Postgres side. An accidental SQLite database
    // gets a seeded admin from core/001_init.js when ADMIN_PASSWORD is set, and
    // counting that as use would make a healthy Postgres install look like a
    // both-populated conflict and refuse to boot. A setup-completed or
    // logged-in admin still counts.
    return await anyUserData(probe, { ignoreBootstrapAdmins: true });
  } catch (err) {
    // Unreadable or corrupt: fail CLOSED. Reporting "no data" here would switch
    // the install to an empty Postgres — the precise failure this module exists
    // to prevent. Staying on SQLite surfaces the real error instead.
    onWarn(
      `[database-engine] SQLite at ${sqlitePath} exists but could not be probed (${err.message}); `
      + 'assuming it holds data and staying on it.'
    );
    return true;
  } finally {
    await probe.destroy();
  }
}

/** True when the configured Postgres target already holds user data. */
async function probePgData(pgConnection, onWarn = warnToStderr) {
  const knex = require('knex');
  const probe = knex({ client: 'pg', connection: pgConnection, pool: { min: 0, max: 1 } });
  try {
    // Two very different failures hide behind one catch, and they need opposite
    // answers, so establish reachability first — this branch returns, so
    // everything below it is reachable-by-construction.
    try {
      await probe.raw('SELECT 1');
    } catch (err) {
      // Cannot reach Postgres at all. The app could not run on it either way,
      // so report "occupied" to avoid diverting a healthy pg install to a stale
      // SQLite file over a transient network blip — startup then fails with the
      // real connection error, exactly as it always has.
      onWarn(`[database-engine] Postgres unreachable while probing (${err.message}); leaving the configured engine alone.`);
      return true;
    }

    try {
      // Substantive use only: an untouched bootstrap admin does not make a
      // Postgres target worth switching to, but a completed setup does.
      return await anyUserData(probe, { ignoreBootstrapAdmins: true });
    } catch (err) {
      // Connected, but the query failed — a half-built or damaged schema. That
      // is NOT evidence of data: reporting "occupied" here would boot the empty
      // Postgres and hide a populated SQLite file, the exact failure this guard
      // exists to prevent. Say "not proven occupied" and let the SQLite side win
      // if it actually holds data.
      onWarn(`[database-engine] Postgres reachable but could not be inspected (${err.message}); treating it as unproven rather than occupied.`);
      return false;
    }
  } finally {
    await probe.destroy();
  }
}

const CONFLICT_MESSAGE = (sqlitePath, pgTarget) => `
${'='.repeat(78)}
REFUSING TO START — two databases, both with data, and no record of which is current.

  sqlite   : ${sqlitePath}
  postgres : ${pgTarget}

This is what an install looks like after it ran on PostgreSQL, lost NODE_ENV or
DATABASE_CLIENT, and kept working on SQLite without anyone noticing (see
https://github.com/PicPeak/picpeak/issues/1038). The PostgreSQL rows are real
but probably old; the SQLite rows are real and probably newer.

Starting either one would hide the other's galleries and split every new upload
across two databases, so PicPeak will not choose for you. Compare them, then say
which is authoritative:

  DATABASE_CLIENT=sqlite3   keep serving the SQLite file (its data is newer)
  DATABASE_CLIENT=pg        keep serving PostgreSQL

To combine them, start on SQLite and run:  node scripts/migrate-sqlite-to-postgres.js
(it replaces the PostgreSQL contents with the SQLite data and records the switch).
${'='.repeat(78)}
`.trim();

const STRANDED_WARNING = (sqlitePath, pgTarget) => `
${'='.repeat(78)}
STILL RUNNING ON SQLITE — Postgres is configured but empty.

  data in use : ${sqlitePath}
  configured  : ${pgTarget} (no galleries in it)

This install has been running on SQLite. Until now the image left NODE_ENV
unset, so knexfile.js fell back to its development block and ignored DB_HOST /
DB_USER / DB_PASSWORD — see https://github.com/PicPeak/picpeak/issues/1038.

Nothing has changed for you: your galleries are served from the SQLite file
above, exactly as before. Switching engines now would start from an empty
database, so PicPeak will not do that on its own.

To move your data to Postgres when you are ready:

  node scripts/migrate-sqlite-to-postgres.js

It copies every row into Postgres and leaves the SQLite file untouched as a
fallback. To go to Postgres WITHOUT the data, set DATABASE_CLIENT=pg.
${'='.repeat(78)}
`.trim();

/**
 * Resolve the engine for this boot, log what happened, and return the client
 * the process should use. Called before migrations touch anything.
 */
async function resolveBootEngine({ knexConfig, logger }) {
  const explicitClient = process.env.DATABASE_CLIENT || null;
  const configuredClient = knexConfig?.client;
  const sqlitePath = resolveSqlitePath();

  // Probe whenever Postgres is the engine in play — including when it was named
  // explicitly, otherwise the "leaving SQLite behind" warning is unreachable.
  const effectiveClient = explicitClient || configuredClient;
  const migrationInProgress = hasMigrationInProgress(sqlitePath);
  const marker = readMigrationMarker(sqlitePath);
  const migrationCompleted = hasMigrationMarker(sqlitePath);
  // The marker vouches for ONE Postgres. If the configuration now points at a
  // different one, it says nothing about that target — and trusting it would
  // boot an unrelated empty database while the real data sits in the recorded
  // one and in the renamed rollback copy.
  const markerTargetMismatch = Boolean(
    migrationCompleted && marker && marker.target && marker.target !== currentPgTargetId(),
  );
  const pgConfigured = Boolean(process.env.DB_HOST || process.env.DB_PASSWORD);
  // Probe when Postgres is in play, and also whenever a migration is pinned or
  // finished — those decisions need to know what each side holds.
  const probing = effectiveClient === 'pg' || migrationInProgress || migrationCompleted;
  const decision = decideBootEngine({
    configuredClient,
    explicitClient,
    pgHasData: probing
      ? await probePgData(
        knexConfig.client === 'pg' ? knexConfig.connection : pgConnectionFromEnv(),
        (m) => logger.warn(m),
      )
      : true,
    sqliteHasData: probing ? await probeSqliteData(sqlitePath, (m) => logger.warn(m)) : false,
    migrationInProgress,
    migrationCompleted,
    pgConfigured,
  });

  if (markerTargetMismatch) {
    logger.error(`
${'='.repeat(78)}
REFUSING TO START — this install was migrated to a different PostgreSQL.

  migrated to : ${marker.target}
  configured  : ${currentPgTargetId()}

${migrationMarkerPath(sqlitePath)} records where the data was moved. The current
settings point somewhere else, so starting would open an unrelated database and
present an empty installation while your galleries stay in the one above.

Either restore the original connection settings, or — if this move is deliberate
and the data is already in the new target — update the "target" field in that
marker file to match.
${'='.repeat(78)}
`.trim());
    return { client: null, overridden: false, reason: 'marker-target-mismatch' };
  }

  if (decision.reason === 'ambiguous-both-populated') {
    logger.error(CONFLICT_MESSAGE(sqlitePath, describeEngine({
      client: 'pg', connection: pgConnectionFromEnv(),
    })));
    return decision;
  }

  if (decision.reason === 'migrated-to-postgres') {
    logger.warn(
      `This install's data was migrated to PostgreSQL (${migrationMarkerPath(sqlitePath)}), but the `
      + 'environment still resolves to SQLite. Using PostgreSQL — set NODE_ENV=production (or '
      + 'DATABASE_CLIENT=pg) to make that explicit.'
    );
  } else if (decision.reason === 'migration-incomplete') {
    logger.warn(
      `A SQLite → PostgreSQL migration did not finish (${migrationInProgressPath(sqlitePath)} is still `
      + 'present), so PostgreSQL may hold a partial copy. Staying on SQLite, which is still the '
      + 'database of record. Re-run scripts/migrate-sqlite-to-postgres.js with the backend stopped; '
      + 'delete that file only if you have decided to abandon the migration.'
    );
  } else if (decision.overridden && decision.reason === 'stranded-sqlite-data') {
    logger.warn(STRANDED_WARNING(sqlitePath, describeEngine(knexConfig)));
  } else if (decision.reason === 'explicit-pg-leaves-sqlite-behind') {
    logger.warn(
      'DATABASE_CLIENT=pg is set explicitly, so PicPeak is starting on an empty Postgres while '
      + `gallery data exists at ${sqlitePath}. Run scripts/migrate-sqlite-to-postgres.js to bring it across.`
    );
  }

  // Describe what was DECIDED, not what knexfile said: after a marker override
  // knexConfig still describes SQLite while the process goes to Postgres.
  logger.info(`Database engine: ${decision.client === 'pg'
    ? describeEngine(knexConfig.client === 'pg' ? knexConfig : { client: 'pg', connection: pgConnectionFromEnv() })
    : `sqlite (${sqlitePath})`}`);
  return decision;
}

module.exports = {
  resolveSqlitePath,
  pgConnectionFromEnv,
  isUntouchedBootstrapRow,
  adminsIndicateUse,
  migrationMarkerPath,
  hasMigrationMarker,
  readMigrationMarker,
  currentPgTargetId,
  migrationInProgressPath,
  hasMigrationInProgress,
  describeEngine,
  decideBootEngine,
  probeSqliteData,
  probePgData,
  resolveBootEngine,
};
