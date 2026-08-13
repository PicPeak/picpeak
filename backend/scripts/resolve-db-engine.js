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

// Must cover every level resolveBootEngine uses. An incomplete shim threw
// inside the conflict path, was swallowed by the catch below, and fell back to
// the configured client — silently choosing the engine this is meant to refuse
// to choose.
const logger = {
  info: (m) => process.stderr.write(`${m}\n`),
  warn: (m) => process.stderr.write(`${m}\n`),
  error: (m) => process.stderr.write(`${m}\n`),
  debug: () => {},
};

// Distinct exit code for "two populated databases, no record of which is
// current" (#1038). Callers must stop rather than pick one.
const CONFLICT_EXIT = 3;

(async () => {
  let client = knexConfig.client;
  try {
    const { resolveBootEngine } = require('../src/utils/databaseEngine');
    const decision = await resolveBootEngine({ knexConfig, logger });
    if (decision.reason === 'ambiguous-both-populated'
        || decision.reason === 'marker-target-mismatch') {
      process.exit(CONFLICT_EXIT);
    }
    ({ client } = decision);
  } catch (err) {
    // Never let engine detection stop a boot: fall back to whatever knexfile
    // resolved, which is exactly the behaviour before this script existed.
    logger.warn(`Database engine detection failed (${err.message}); using ${client}`);
  }
  process.stdout.write(String(client || ''));
  process.exit(0);
})();
