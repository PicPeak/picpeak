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

let warnedUnverifiedTls = false;

/**
 * TLS towards PostgreSQL.
 *
 * DB_SSL=true alone used to mean `rejectUnauthorized: false`: encrypted, but
 * any certificate accepted, so whoever can redirect the database connection
 * can impersonate the database (Codex security audit 2026-09-30). Verification
 * is now on whenever the operator gives us the means or asks for it:
 *
 *   DB_SSL_CA                  PEM text, or a path to a PEM file — verify
 *                              against it (private CAs, managed databases).
 *   DB_SSL_REJECT_UNAUTHORIZED true  — verify against the system CA store
 *                              false — accept any certificate (explicit)
 *
 * DB_SSL=true with neither set keeps the old behaviour so existing installs
 * with self-signed certificates keep connecting, and logs one warning at
 * boot so the gap is visible rather than silent.
 */
function pgSslFromEnv() {
  if (process.env.DB_SSL !== 'true') return false;
  const ssl = {};
  const ca = (process.env.DB_SSL_CA || '').trim();
  if (ca) {
    ssl.ca = ca.includes('-----BEGIN') ? ca : require('fs').readFileSync(ca, 'utf8');
  }
  const explicit = (process.env.DB_SSL_REJECT_UNAUTHORIZED || '').trim().toLowerCase();
  if (explicit === 'false') {
    ssl.rejectUnauthorized = false;
  } else if (explicit === 'true' || ca) {
    ssl.rejectUnauthorized = true;
  } else {
    ssl.rejectUnauthorized = false;
    if (!warnedUnverifiedTls && process.env.NODE_ENV !== 'test') {
      warnedUnverifiedTls = true;
      console.warn('[db] DB_SSL=true without DB_SSL_CA or DB_SSL_REJECT_UNAUTHORIZED: the PostgreSQL certificate is NOT verified. Set DB_SSL_CA to your CA, or DB_SSL_REJECT_UNAUTHORIZED=true for a publicly trusted certificate.');
    }
  }
  return ssl;
}

function pgConnectionFromEnv() {
  return {
    host: process.env.DB_HOST || 'postgres',
    port: process.env.DB_PORT || 5432,
    user: process.env.DB_USER || 'picpeak',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'picpeak',
    ssl: pgSslFromEnv(),
  };
}

module.exports = { pgConnectionFromEnv, pgSslFromEnv };
