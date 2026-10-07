'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const tls = require('tls');
const { pgSslFromEnv } = require('./pgConnection');

function quoteConnectionValue(value) {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new Error('PostgreSQL connection values must be strings without NUL bytes');
  }
  return `'${value.replace(/['\\]/g, '\\$&')}'`;
}

function defaultCaBundle(env) {
  // sslrootcert=system is unavailable on PostgreSQL 15. Export Node's trust
  // roots as PEM so the app and its libpq tools authenticate the same peer.
  if (typeof tls.getCACertificates === 'function') {
    return tls.getCACertificates('default').join('\n');
  }
  const extra = env.NODE_EXTRA_CA_CERTS ? fs.readFileSync(env.NODE_EXTRA_CA_CERTS, 'utf8') : '';
  return [...tls.rootCertificates, extra].join('\n');
}

/**
 * Apply the application's TLS policy to psql/pg_dump, including startup,
 * backups, restores and rollback. libpq's default "prefer" does not verify
 * certificates. An inherited PGSSLMODE or a dbname parsed as conninfo must
 * not override DB_SSL. Every repository caller supplies a named -d argument.
 */
function preparePgClient(args, options = {}) {
  const env = { ...(options.env || process.env) };
  const ssl = pgSslFromEnv(env);
  const sslmode = !ssl ? 'disable' : ssl.rejectUnauthorized ? 'verify-full' : 'require';
  let directory;
  const cleanup = () => {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  };

  try {
    // Resolve a literal TCP host too: libpq ignores TLS on Unix sockets.
    let host = env.PGHOST || env.DB_HOST || 'postgres';
    const databases = [];
    const valueOptions = new Set(['-p', '--port', '-U', '--username', '-c', '--command',
      '-f', '--file', '-v', '--set', '-tAc']);
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === '-d' || arg === '--dbname') databases.push({ index: ++i, database: args[i], prefix: '' });
      else if (arg.startsWith('--dbname=')) databases.push({ index: i, database: arg.slice('--dbname='.length), prefix: '--dbname=' });
      else if (arg.startsWith('-d') && arg.length > 2) databases.push({ index: i, database: arg.slice(2), prefix: '-d' });
      else if (arg === '-h' || arg === '--host') host = args[++i];
      else if (arg.startsWith('--host=')) host = arg.slice('--host='.length);
      else if (arg.startsWith('-h') && arg.length > 2) host = arg.slice(2);
      else if (valueOptions.has(arg)) i += 1;
    }
    if (databases.length !== 1) throw new Error('PostgreSQL client requires exactly one named database argument');
    const { index, database, prefix } = databases[0];
    const quotedDatabase = quoteConnectionValue(database);
    const quotedHost = quoteConnectionValue(host);
    if (ssl && (typeof host !== 'string' || host.split(',').some((entry) => !entry || entry.startsWith('/')))) {
      throw new Error('PostgreSQL TLS requires a TCP host, not a Unix socket');
    }
    let rootCert;
    if (ssl) {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-pg-ca-'));
      rootCert = path.join(directory, 'root.crt');
      if (ssl.rejectUnauthorized) {
        fs.writeFileSync(rootCert, ssl.ca || defaultCaBundle(env), { mode: 0o600 });
      }
      // For the explicit insecure override, keep root.crt absent: libpq's
      // "require" otherwise switches to verify-ca when a default CA exists.
      env.PGSSLROOTCERT = rootCert;
    }
    env.PGSSLMODE = sslmode;

    const protectedArgs = [...args];
    protectedArgs[index] = `${prefix}dbname=${quotedDatabase} host=${quotedHost} sslmode=${quoteConnectionValue(sslmode)}` +
      (rootCert ? ` sslrootcert=${quoteConnectionValue(rootCert)}` : '');
    return { args: protectedArgs, options: { ...options, env }, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

async function withPgClientPolicy(cmd, args, options, execute) {
  if (cmd !== 'psql' && cmd !== 'pg_dump') return execute(args, options);
  const prepared = preparePgClient(args, options);
  try {
    return await execute(prepared.args, prepared.options);
  } finally {
    prepared.cleanup();
  }
}

module.exports = { preparePgClient, withPgClientPolicy };
