'use strict';

/**
 * argv for a `sqlite3` CLI call against the LIVE database file.
 *
 * The sqlite3 shell's busy timeout defaults to 0: if the running app holds a
 * write lock at that instant (the scheduled backup has just inserted its own
 * backup_runs row; other jobs share the 02:00 slot), `.backup` fails at once
 * with "Error: database is locked" instead of waiting for the commit.
 * `-cmd '.timeout N'` installs a busy handler before the command runs, so the
 * call waits up to N ms for the lock.
 *
 * The command string is passed through unchanged; callers stay responsible
 * for keeping any interpolated path in the safe charset (assertSafeSqlitePath).
 */
const SQLITE_CLI_BUSY_TIMEOUT_MS = 30000;

function liveSqliteArgs(dbPath, command) {
  return ['-cmd', `.timeout ${SQLITE_CLI_BUSY_TIMEOUT_MS}`, dbPath, command];
}

module.exports = { SQLITE_CLI_BUSY_TIMEOUT_MS, liveSqliteArgs };
