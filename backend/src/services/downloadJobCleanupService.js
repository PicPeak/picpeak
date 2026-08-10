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
 * Runs every 20 minutes, offset from the hourly jobs so the three cleanup
 * schedulers don't all wake at once.
 */

const cron = require('node-cron');
const logger = require('../utils/logger');
const downloadJobService = require('./downloadJobService');

function startDownloadJobCleanup() {
  // A restart leaves any in-flight build with no worker. Fail those rows once
  // at startup so their owners get a clear error instead of polling forever.
  downloadJobService.recoverOrphanedJobs().catch((err) =>
    logger.error('Download job recovery failed', { error: err.message }));

  cron.schedule('7,27,47 * * * *', async () => {
    await runDownloadJobCleanup();
  });
  logger.info('Download job cleanup scheduler started');
}

async function runDownloadJobCleanup() {
  try {
    await downloadJobService.sweepExpired();
  } catch (err) {
    logger.error('Download job cleanup failed', { error: err.message });
  }
}

module.exports = {
  startDownloadJobCleanup,
  // exported for tests / manual invocation
  runDownloadJobCleanup,
};
