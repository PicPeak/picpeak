#!/usr/bin/env node
'use strict';

// Startup's psql probes must use the same TLS policy as the application pool
// and backup/restore commands. No shell or arbitrary command execution.
const { spawnAsync } = require('../src/utils/safeExec');
const { pgSslFromEnv, PG_TLS_GUIDANCE } = require('../src/utils/pgConnection');

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--check-config' && args.length === 0) {
    const ssl = pgSslFromEnv();
    if (ssl && ssl.rejectUnauthorized) process.stderr.write(`${PG_TLS_GUIDANCE}\n`);
    else if (ssl) process.stderr.write('WARNING: PostgreSQL TLS certificate verification is explicitly disabled. Configure DB_SSL_CA instead.\n');
    return;
  }
  if (command !== 'psql') throw new Error('The startup PostgreSQL client must be psql');
  const { stdout, stderr } = await spawnAsync(command, args);
  process.stdout.write(stdout);
  process.stderr.write(stderr);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  if ((process.env.DB_SSL || '').trim().toLowerCase() === 'true') process.stderr.write(`${PG_TLS_GUIDANCE}\n`);
  process.exitCode = Number.isInteger(error.code) && error.code > 0 ? error.code : 1;
});
