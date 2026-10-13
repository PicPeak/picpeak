/**
 * downloadJobCleanupService — TTL sweep for custom-resolution download jobs
 * (#858).
 *
 * Job archives are one-off renditions of a gallery at a size nothing else
 * caches against, so they are pure disposable bytes: once the TTL passes the
 * row and its zip go away. Without this sweep, every guest who ever picked a
 * non-standard resolution would leave a full gallery-sized archive behind in
 * `.download-cache` forever.
 *
 * The same pass drops finished archives that can no longer be delivered (the
 * gallery expired or was archived, or changed underneath the archive), so a
 * retention of days does not keep dead archives on disk (issue 1733).
 *
 * Runs every 20 minutes, offset from the hourly jobs so the three cleanup
 * schedulers don't all wake at once.
 */

const { scheduledTask } = require('./scheduledTask');
const logger = require('../utils/logger');
const downloadJobService = require('./downloadJobService');

const task = scheduledTask(runDownloadJobCleanup, { schedule: '7,27,47 * * * *' });
function startDownloadJobCleanup() { task.start(); }
const stopDownloadJobCleanup = () => task.stop();

async function runDownloadJobCleanup() {
  try {
    await downloadJobService.sweepExpired();
    // Ready mails that could not be queued when their job finished.
    await require('./downloadJobNotifier').retryUnsent();
  } catch (err) {
    logger.error('Download job cleanup failed', { error: err.message });
  }
}

module.exports = {
  stopDownloadJobCleanup,
  startDownloadJobCleanup,
  // exported for tests / manual invocation
  runDownloadJobCleanup,
};
