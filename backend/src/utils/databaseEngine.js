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
const path = require('path');

/** Absolute path of the SQLite file this install would use. */
function resolveSqlitePath() {
  const configured = process.env.DATABASE_PATH || './data/photo_sharing.db';
  const backendRoot = path.resolve(__dirname, '..', '..');
  return path.isAbsolute(configured)
    ? path.normalize(configured)
    : path.normalize(path.resolve(backendRoot, configured));
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
function decideBootEngine({ configuredClient, explicitClient, pgHasData, sqliteHasData }) {
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

/** True when a SQLite file exists and carries gallery data. */
async function probeSqliteData(sqlitePath = resolveSqlitePath()) {
  if (!fs.existsSync(sqlitePath)) return false;
  const knex = require('knex');
  const probe = knex({
    client: 'sqlite3',
    connection: { filename: sqlitePath },
    useNullAsDefault: true,
  });
  try {
    if (!(await probe.schema.hasTable('events'))) return false;
    const row = await probe('events').count('id as count').first();
    return Number(row?.count || 0) > 0;
  } catch (_) {
    // Unreadable/corrupt file — not our call to make here; let the normal
    // startup path surface it.
    return false;
  } finally {
    await probe.destroy();
  }
}

/** True when the configured Postgres target already holds galleries. */
async function probePgData(pgConnection) {
  const knex = require('knex');
  const probe = knex({ client: 'pg', connection: pgConnection, pool: { min: 0, max: 1 } });
  try {
    if (!(await probe.schema.hasTable('events'))) return false;
    const row = await probe('events').count('id as count').first();
    return Number(row?.count || 0) > 0;
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

  const needsProbe = !explicitClient && configuredClient === 'pg';
  const decision = decideBootEngine({
    configuredClient,
    explicitClient,
    pgHasData: needsProbe ? await probePgData(knexConfig.connection) : true,
    sqliteHasData: needsProbe ? await probeSqliteData(sqlitePath) : false,
  });

  if (decision.overridden && decision.reason === 'stranded-sqlite-data') {
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
  describeEngine,
  decideBootEngine,
  probeSqliteData,
  probePgData,
  resolveBootEngine,
};
