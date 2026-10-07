'use strict';

const net = require('net');

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

/**
 * TLS towards PostgreSQL. Enabling TLS authenticates the server by default.
 * Private/self-signed deployments must supply DB_SSL_CA (PEM text or a file).
 * DB_SSL_REJECT_UNAUTHORIZED=false is an explicit, insecure compatibility
 * override, not the default. Malformed controls must not disable protection.
 * Accept an environment argument so libpq children use this same policy.
 */
function pgSslFromEnv(env = process.env, host = env.DB_HOST) {
  const enabled = (env.DB_SSL || '').trim().toLowerCase();
  if (enabled === '' || enabled === 'false') return false;
  if (enabled !== 'true') throw new Error('DB_SSL must be true or false');

  const explicit = (env.DB_SSL_REJECT_UNAUTHORIZED || '').trim().toLowerCase();
  if (explicit !== '' && explicit !== 'true' && explicit !== 'false') {
    throw new Error('DB_SSL_REJECT_UNAUTHORIZED must be true or false');
  }
  const ssl = { rejectUnauthorized: explicit !== 'false' };
  // pg supplies TLS servername only for DNS hosts. Without host/servername,
  // Node verifies the chain but skips identity checks for IP destinations.
  // `host` enables IP SAN checks without sending an invalid IP-valued SNI.
  if (host && net.isIP(host)) ssl.host = host;
  const ca = (env.DB_SSL_CA || '').trim();
  if (ca) {
    ssl.ca = ca.includes('-----BEGIN') ? ca : require('fs').readFileSync(ca, 'utf8');
    if (!ssl.ca.trim()) throw new Error('DB_SSL_CA must contain a PEM certificate');
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
