#!/usr/bin/env node
'use strict';

// Startup's psql probes must use the same TLS policy as the application pool
// and backup/restore commands. No shell or arbitrary command execution.
const { spawnAsync } = require('../src/utils/safeExec');

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command !== 'psql') throw new Error('The startup PostgreSQL client must be psql');
  const { stdout, stderr } = await spawnAsync(command, args);
  process.stdout.write(stdout);
  process.stderr.write(stderr);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = Number.isInteger(error.code) && error.code > 0 ? error.code : 1;
});
