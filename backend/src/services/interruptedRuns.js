/**
 * Backup and restore run rows left at 'running' with no run behind them.
 *
 * A run writes its row as 'running' first and makes it final when it ends.
 * Two things leave a row that never ends:
 *
 *   - The database dump of a backup is taken while that backup (and the
 *     dump's own database_backup_runs row) is still running, so every dump
 *     holds its own run as 'running'. A database or full restore of it
 *     brings that row back.
 *   - A process that dies mid-run (crash, container restart).
 *
 * Nothing else clears such a row, and the admin UI refuses to delete a
 * running one. This marks them failed:
 *
 *   - after a database or full restore, every running row started before the
 *     restore began: it came from the dump, so no run can still update it
 *     (minus the runs this process holds right now);
 *   - at boot and hourly, a running row only once it is older than
 *     RUNNING_ROW_WINDOW_MS AND started before this process booted. Backups
 *     have no lease or heartbeat, so a row another replica is still writing
 *     cannot be told apart from a dead one; the same 12-hour window is where
 *     backupVerificationService.sharedWorkRunning already stops counting a
 *     row as live. The cost: after a crash the row stays 'running' (and the
 *     dashboard flags it as possibly crashed) for up to 13 hours.
 */

const { db } = require('../database/db');
const logger = require('../utils/logger');
const { toTimestamp } = require('../utils/dateNormalize');
const applicationWork = require('./activeApplicationWork');

const TABLES = ['backup_runs', 'database_backup_runs', 'restore_runs'];
const RUNNING_ROW_WINDOW_MS = 12 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const BOOTED_AT = Date.now() - Math.round(process.uptime() * 1000);

const RESTORED_MESSAGE = 'Interrupted: this run was still in progress when the restored backup was taken, '
  + 'so its outcome is not in the restored database';
const STALE_MESSAGE = 'Interrupted: the run did not finish (the process stopped before it completed)';

/** Row ids the runs of this process are writing right now, per table. */
function liveRunIds() {
  const backupService = require('./backupService');
  const { databaseBackupService } = require('./databaseBackup');
  return {
    backup_runs: [backupService.currentRunId()],
    database_backup_runs: [databaseBackupService.currentRunId],
  };
}

/**
 * Mark running rows started before `before` (epoch ms) as failed. `exclude`
 * maps a table to ids to leave alone. Returns the number of rows marked.
 */
async function markInterrupted({ before, message, exclude = {} }) {
  let marked = 0;
  for (const table of TABLES) {
    try {
      const skip = new Set((exclude[table] || []).filter((id) => id !== null && id !== undefined).map(Number));
      const rows = await db(table).where({ status: 'running' }).select('id', 'started_at');
      const ids = rows.filter((row) => {
        const at = toTimestamp(row.started_at);
        return Number.isFinite(at) && at < before && !skip.has(Number(row.id));
      }).map((row) => row.id);
      if (!ids.length) continue;
      const count = await db(table).whereIn('id', ids).where({ status: 'running' })
        .update({ status: 'failed', error_message: message, completed_at: new Date().toISOString() });
      if (count) logger.warn(`Marked ${count} interrupted ${table} row(s) as failed`);
      marked += count;
    } catch (error) {
      logger.warn(`Could not clear interrupted ${table} rows: ${error.message}`);
    }
  }
  return marked;
}

/**
 * After a database or full restore replaced the database. The restore's own
 * row started at `restoreStartedAt`, so it is not before it; the caller makes
 * it final.
 */
function markRestoredRuns(restoreStartedAt) {
  return markInterrupted({ before: restoreStartedAt, message: RESTORED_MESSAGE, exclude: liveRunIds() });
}

/** Boot and hourly: rows of runs that died with an earlier process. */
async function sweepStaleRuns(now = Date.now()) {
  // A restore in this process is about to replace (or is replacing) the
  // database; it clears what it brings back itself.
  if (require('./restoreService').restoreService.isRunning || applicationWork.isClosed()) return 0;
  return markInterrupted({
    before: Math.min(BOOTED_AT, now - RUNNING_ROW_WINDOW_MS),
    message: STALE_MESSAGE,
    exclude: liveRunIds(),
  });
}

let sweepTimer = null;

async function startStaleRunSweep() {
  await sweepStaleRuns();
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    applicationWork.track('interrupted run sweep', () => sweepStaleRuns()).catch(() => {});
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

module.exports = {
  BOOTED_AT,
  markRestoredRuns,
  sweepStaleRuns,
  startStaleRunSweep,
};
