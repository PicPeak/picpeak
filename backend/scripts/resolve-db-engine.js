#!/usr/bin/env node
'use strict';

/**
 * Prints the database client this boot should use — `pg` or `sqlite3` — for
 * wait-for-db.sh to export as DATABASE_CLIENT (#1038).
 *
 * Runs BEFORE the migration step on purpose: the decision has to be made while
 * the Postgres target is still untouched, so an install that has been
 * unknowingly running on SQLite keeps serving from its SQLite file instead of
 * coming up against an empty database.
 *
 * stdout is the client and nothing else — the caller captures it. Everything
 * human-readable goes to stderr so it lands in the container log.
 */

const knexConfig = require('../knexfile');

const logger = {
  info: (m) => process.stderr.write(`${m}\n`),
  warn: (m) => process.stderr.write(`${m}\n`),
};

(async () => {
  let client = knexConfig.client;
  try {
    const { resolveBootEngine } = require('../src/utils/databaseEngine');
    ({ client } = await resolveBootEngine({ knexConfig, logger }));
  } catch (err) {
    // Never let engine detection stop a boot: fall back to whatever knexfile
    // resolved, which is exactly the behaviour before this script existed.
    logger.warn(`Database engine detection failed (${err.message}); using ${client}`);
  }
  process.stdout.write(String(client || ''));
  process.exit(0);
})();
