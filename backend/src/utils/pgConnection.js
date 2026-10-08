'use strict';

const net = require('net');
const tls = require('tls');
const { X509Certificate } = require('crypto');
const PG_TLS_GUIDANCE = 'PostgreSQL TLS verifies the certificate and DB_HOST. For private/self-signed certificates, configure DB_SSL_CA with the CA PEM or a readable CA file; if the certificate carries another name than DB_HOST, set DB_SSL_SERVERNAME; do not disable verification.';
const PG_TLS_UNVERIFIED_WARNING = 'WARNING: PostgreSQL TLS certificate verification is explicitly disabled. Configure DB_SSL_CA instead.';
let announcedTlsNotice = false;

// Node 22.23's DNS ASCII normalisation misclassifies IPv6 literals. Use
// OpenSSL's exact iPAddress SAN check, never a DNS/CN fallback for an IP.
// TLS still verifies the certificate chain before calling this identity hook.
function checkPgServerIdentity(host, certificate) {
  if (!net.isIP(host)) return tls.checkServerIdentity(host, certificate);
  try {
    if (certificate.raw && new X509Certificate(certificate.raw).checkIP(host)) return undefined;
  } catch (_) { /* malformed certificate fails closed below */ }
  const error = new Error('Hostname/IP does not match certificate IP subject alternative names');
  error.code = 'ERR_TLS_CERT_ALTNAME_INVALID';
  return error;
}

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
 * DB_SSL_SERVERNAME names the certificate when DB_HOST is an IP or an alias
 * the certificate does not carry; the chain is verified either way.
 * Accept an environment argument so libpq children use this same policy.
 */
// Accept the usual boolean spellings rather than refusing to boot over
// DB_SSL=1; anything else is still an error, never a silent "off".
function pgBooleanFromEnv(env, name) {
  const value = (env[name] || '').trim().toLowerCase();
  if (value === '') return undefined;
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off'].includes(value)) return false;
  throw new Error(`${name} must be true or false`);
}

function pgSslFromEnv(env = process.env, host = env.DB_HOST) {
  if (!pgBooleanFromEnv(env, 'DB_SSL')) return false;

  const ssl = { rejectUnauthorized: pgBooleanFromEnv(env, 'DB_SSL_REJECT_UNAUTHORIZED') !== false };
  // pg supplies TLS servername only for DNS hosts. Without host/servername,
  // Node verifies the chain but skips identity checks for IP destinations.
  // `host` enables IP SAN checks without sending an invalid IP-valued SNI.
  if (host && net.isIP(host)) {
    ssl.host = host;
    if (ssl.rejectUnauthorized) ssl.checkServerIdentity = checkPgServerIdentity;
  }
  const servername = (env.DB_SSL_SERVERNAME || '').trim();
  if (servername && ssl.rejectUnauthorized) {
    // pg overwrites `servername` with a DNS DB_HOST, so the identity hook, not
    // the option, is what binds the certificate to the configured name.
    if (!net.isIP(servername)) ssl.servername = servername;
    ssl.checkServerIdentity = (_host, certificate) => checkPgServerIdentity(servername, certificate);
  }
  const ca = (env.DB_SSL_CA || '').trim();
  if (ca) {
    ssl.ca = ca.includes('-----BEGIN') ? ca : require('fs').readFileSync(ca, 'utf8');
    if (!ssl.ca.trim()) throw new Error('DB_SSL_CA must contain a PEM certificate');
  }
  return ssl;
}

// What an operator needs to read at boot. A verified connection with its own
// CA is the healthy end state and stays quiet.
function pgTlsNotice(ssl) {
  if (!ssl) return null;
  if (!ssl.rejectUnauthorized) return PG_TLS_UNVERIFIED_WARNING;
  return ssl.ca ? null : PG_TLS_GUIDANCE;
}

function pgConnectionFromEnv() {
  const ssl = pgSslFromEnv();
  const notice = pgTlsNotice(ssl);
  if (notice && !announcedTlsNotice && process.env.NODE_ENV !== 'test') {
    announcedTlsNotice = true;
    process.stderr.write(`[db] ${notice}\n`);
  }
  return {
    host: process.env.DB_HOST || 'postgres',
    port: process.env.DB_PORT || 5432,
    user: process.env.DB_USER || 'picpeak',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'picpeak',
    ssl,
  };
}

module.exports = { pgConnectionFromEnv, pgSslFromEnv, pgTlsNotice, checkPgServerIdentity, PG_TLS_GUIDANCE };
