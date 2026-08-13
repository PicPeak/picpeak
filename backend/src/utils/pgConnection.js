'use strict';

/**
 * The PostgreSQL target, resolved in exactly one place (#1038).
 *
 * Three different defaults for the same connection used to coexist:
 *
 *   knexfile development : localhost / postgres / photo_sharing
 *   knexfile production  : db        / picpeak  / picpeak
 *   wait-for-db.sh       : postgres  / picpeak  / picpeak   (and it EXPORTS them)
 *
 * so a process that probed or migrated against one could hand over to a process
 * that opened another. Two review rounds in a row traced back to that, each
 * time through a caller the previous fix had not covered — the engine guard,
 * the migration CLI's child phases, then server.js.
 *
 * The host and user defaults are the ones a running container actually uses,
 * because wait-for-db.sh resolves and exports them before anything starts.
 * The database name matters most: a wrong host or user fails loudly at connect
 * time, while a wrong database name connects fine and presents an empty
 * installation.
 *
 * Reading process.env on every call is deliberate — the entrypoint and
 * server.js both normalise these variables before the app opens a pool.
 */

function pgConnectionFromEnv() {
  return {
    host: process.env.DB_HOST || 'postgres',
    port: process.env.DB_PORT || 5432,
    user: process.env.DB_USER || 'picpeak',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'picpeak',
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  };
}

module.exports = { pgConnectionFromEnv };
