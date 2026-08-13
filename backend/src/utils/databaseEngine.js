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
  configuredClient, explicitClient, pgHasData, sqliteHasData, migrationInProgress = false,
}) {
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
  'quotes', 'invoices', 'projects', 'expenses', 'incoming_invoices',
];

// Seeded by core/001_init.js when ADMIN_PASSWORD is set, so its presence proves
// nothing about a Postgres target having been used.
const SEEDED_ON_BOOTSTRAP = ['admin_users'];

async function anyUserData(conn, tables = USER_DATA_TABLES) {
  for (const table of tables) {
    if (!(await conn.schema.hasTable(table))) continue;
    const row = await conn(table).count('* as count').first();
    if (Number(row?.count || 0) > 0) return true;
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
    return await anyUserData(probe);
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
async function probePgData(pgConnection) {
  const knex = require('knex');
  const probe = knex({ client: 'pg', connection: pgConnection, pool: { min: 0, max: 1 } });
  try {
    // Substantive data only — see SEEDED_ON_BOOTSTRAP.
    return await anyUserData(probe, USER_DATA_TABLES.filter((t) => !SEEDED_ON_BOOTSTRAP.includes(t)));
  } catch (_) {
    // Unreachable Postgres is the entrypoint's problem (it exits before we get
    // here); treat as "has data" so we never divert a healthy pg install.
    return true;
  } finally {
    await probe.destroy();
  }
}

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
  const probing = effectiveClient === 'pg';
  const decision = decideBootEngine({
    configuredClient,
    explicitClient,
    pgHasData: probing ? await probePgData(knexConfig.connection) : true,
    sqliteHasData: probing ? await probeSqliteData(sqlitePath, (m) => logger.warn(m)) : false,
    migrationInProgress: hasMigrationInProgress(sqlitePath),
  });

  if (decision.reason === 'migration-incomplete') {
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

  logger.info(`Database engine: ${decision.client === 'pg' ? describeEngine(knexConfig) : `sqlite (${sqlitePath})`}`);
  return decision;
}

module.exports = {
  resolveSqlitePath,
  migrationMarkerPath,
  hasMigrationMarker,
  migrationInProgressPath,
  hasMigrationInProgress,
  describeEngine,
  decideBootEngine,
  probeSqliteData,
  probePgData,
  resolveBootEngine,
};
