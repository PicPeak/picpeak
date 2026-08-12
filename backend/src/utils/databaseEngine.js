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
 * Two pieces here:
 *
 *   describeEngine()  — one line at boot naming the engine and target. Nothing
 *                       logged this before, which is why the misconfiguration
 *                       was invisible for so long.
 *
 *   shouldBlockBoot() — the upgrade guard. Now that the image pins
 *                       NODE_ENV=production, an affected install would flip to
 *                       Postgres on its next pull and come up against an EMPTY
 *                       database — indistinguishable from total data loss. So
 *                       when we are pointed at a virgin Postgres while a
 *                       populated SQLite file sits on disk, refuse to start and
 *                       say how to migrate.
 *
 * Kept as a pure decision function plus thin probes so the interesting part is
 * testable without a live Postgres.
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
 * The decision, isolated from IO.
 *
 * @param {object}  state
 * @param {string}  state.client          resolved knex client
 * @param {boolean} state.pgEnvPresent    DB_HOST / DB_PASSWORD supplied
 * @param {boolean} state.sqliteHasData   a SQLite file exists AND holds events
 * @param {boolean} state.pgHasTables     the Postgres target already has schema
 * @returns {{ block: boolean, warn: boolean, reason: string|null }}
 */
function evaluateEngineState({ client, pgEnvPresent, sqliteHasData, pgHasTables }) {
  // Configured for Postgres, Postgres is empty, and there is real data sitting
  // in a SQLite file: this is an install that has been unknowingly running on
  // SQLite. Booting would silently start from zero.
  if (client === 'pg' && !pgHasTables && sqliteHasData) {
    return { block: true, warn: false, reason: 'stranded-sqlite-data' };
  }
  // Postgres was configured but we are on SQLite anyway — the original bug.
  // Warn rather than block: an operator may genuinely want SQLite and simply
  // have stale PG variables lying around.
  if (client !== 'pg' && pgEnvPresent) {
    return { block: false, warn: true, reason: 'pg-env-but-sqlite' };
  }
  return { block: false, warn: false, reason: null };
}

function pgEnvPresent() {
  return Boolean(process.env.DB_HOST || process.env.DB_PASSWORD);
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
    // Unreadable/corrupt file — not our call to make here, let the normal
    // startup path surface it.
    return false;
  } finally {
    await probe.destroy();
  }
}

async function probePgTables(db) {
  try {
    return await db.schema.hasTable('events');
  } catch (_) {
    return false;
  }
}

const BLOCK_MESSAGE = (sqlitePath, target) => `
REFUSING TO START — this instance is configured for ${target}, but that
database is empty while a populated SQLite database exists at:

  ${sqlitePath}

That means this install has been running on SQLite, not Postgres (see
knexfile.js: the config block is chosen by NODE_ENV, and the image used to
leave it unset — https://github.com/PicPeak/picpeak/issues/1038). Starting now
would come up against an empty database and look like total data loss.

Your data is intact in the file above. To move it to Postgres:

  1. Start this container again with NODE_ENV unset (or DATABASE_CLIENT=sqlite3)
     so it comes back up on SQLite with your data.
  2. Admin → Backup → "Export .picpeak" and download the archive. The format is
     engine-neutral, so it restores onto Postgres.
  3. Restart with NODE_ENV=production (the new default) and import the archive
     through the setup/restore screen.

To deliberately start fresh on Postgres and leave the SQLite file behind, set
PICPEAK_ALLOW_EMPTY_PG=true.
`.trim();

/**
 * Run before migrations touch anything. Logs the resolved engine, blocks the
 * dangerous case, warns on the misconfigured one.
 *
 * @returns {Promise<{ ok: boolean, message: string|null }>}
 */
async function checkDatabaseEngine({ knexConfig, db, logger }) {
  const client = knexConfig?.client;
  const target = describeEngine(knexConfig);
  logger.info(`Database engine: ${target}`);

  if (process.env.PICPEAK_ALLOW_EMPTY_PG === 'true') {
    return { ok: true, message: null };
  }

  const sqlitePath = resolveSqlitePath();
  const state = evaluateEngineState({
    client,
    pgEnvPresent: pgEnvPresent(),
    sqliteHasData: client === 'pg' ? await probeSqliteData(sqlitePath) : false,
    pgHasTables: client === 'pg' ? await probePgTables(db) : true,
  });

  if (state.block) {
    return { ok: false, message: BLOCK_MESSAGE(sqlitePath, target) };
  }
  if (state.warn) {
    logger.warn(
      `PostgreSQL settings (DB_HOST/DB_PASSWORD) are present, but this instance is using ${target}. `
      + 'Set NODE_ENV=production (or DATABASE_CLIENT=pg) if Postgres was intended — '
      + 'https://github.com/PicPeak/picpeak/issues/1038'
    );
  }
  return { ok: true, message: null };
}

module.exports = {
  resolveSqlitePath,
  describeEngine,
  evaluateEngineState,
  checkDatabaseEngine,
};
