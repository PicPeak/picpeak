const logger = require('../utils/logger');
const applicationWork = require('./activeApplicationWork');
// Resolve only services already loaded by startup. Shutdown must not construct
// unrelated singletons or start new work just to stop it. A third entry is
// the function server.js starts the service with: a portable restore that was
// rolled back restarts those in the same process (resumeServices).
const resources = [
  ['../middleware/sessionTimeout', 'dispose', 'startSessionCleanup'], ['./chunkedUploadService', 'stop', 'start'],
  ['../utils/cleanupTempUploads', 'stopTempUploadCleanup', 'startTempUploadCleanup'],
  ['../middleware/secureImageMiddleware', 'dispose'], ['../middleware/feedbackRateLimit', 'dispose'],
  ['./downloadZipService', 'stop'],
  ['./fileWatcher', 'stopFileWatcher', 'startFileWatcher'], ['./externalMediaWatcher', 'stopExternalMediaWatcher', 'startExternalMediaWatcher'],
  ['./expirationChecker', 'stopExpirationChecker', 'startExpirationChecker'], ['./transferCleanupService', 'stopTransferCleanup', 'startTransferCleanup'],
  ['./customerDocumentRetentionService', 'stopCustomerDocumentRetention', 'startCustomerDocumentRetention'],
  ['./customerDocumentRescanService', 'stopCustomerDocumentRescan', 'startCustomerDocumentRescan'],
  ['./customerDocumentRequestReminderService', 'stopDocumentRequestReminders', 'startDocumentRequestReminders'],
  ['./contract/expiry', 'stopContractSigningSweep', 'startContractSigningSweep'], ['./contract/signingSignals', 'stopSigningSignals', 'startSigningSignals'],
  ['./downloadJobCleanupService', 'stopDownloadJobCleanup', 'startDownloadJobCleanup'], ['./revealScheduler', 'stopRevealScheduler', 'startRevealScheduler'],
  ['./feedbackRateLimitCleanupService', 'stopFeedbackRateLimitCleanup', 'startFeedbackRateLimitCleanup'],
  ['./invoiceSchedulerService', 'stopInvoiceScheduler', 'startInvoiceScheduler'], ['./emailProcessor', 'stopEmailQueueProcessor', 'startEmailQueueProcessor'],
  ['./whatsappProcessor', 'stopWhatsAppQueueProcessor', 'startWhatsAppQueueProcessor'], ['./emailIntakeService', 'stopIncomingMailPoller', 'startIncomingMailPoller'],
  ['./webhookDeliveryWorker', 'stopWebhookDeliveryWorker', 'startWebhookDeliveryWorker'], ['./s3AutoImporter', 'stopS3AutoImporter', 'startS3AutoImporter'],
  ['./backupService', 'stopBackupService', 'startBackupService'], ['./databaseBackup', 'stopScheduledBackups', 'startScheduledBackups'],
  ['./backgroundProcessor', 'stop', 'start'], ['./faceQueue', 'stop', 'start'], ['./videoRenditionQueue', 'stop', 'start'],
  ['./mediaProcessService', 'stop', 'start'], ['./nativeProcessRunner', 'stop', 'start'],
  ['./secureImageService', 'dispose'],
  ['../utils/authSecurity', 'stopCleanupJob', 'initializeCleanupJob'], ['../utils/tokenRevocation', 'stopRevocationCleanup'],
  ['./publicUploadQuota', 'stopMaintenance', 'startMaintenance'],
];
async function stopServices() {
  const results = await Promise.allSettled(resources.map(async ([path, method]) => {
    const loaded = require.cache[require.resolve(path)];
    if (typeof loaded?.exports[method] === 'function') await loaded.exports[method]();
  }));
  const failures = results.filter(result => result.status === 'rejected');
  failures.forEach(result => logger.error('Service shutdown failed', { error: result.reason.message }));
  // Timer/watcher stop methods must drain their own callbacks, and detached
  // API-started work has a separate owner. Neither alone proves quiescence.
  await applicationWork.drain();
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Service shutdown failed');
}
async function resumeServices() {
  const failures = [];
  for (const [path, , start] of resources) {
    const loaded = start && require.cache[require.resolve(path)];
    if (typeof loaded?.exports[start] !== 'function') continue;
    try { await loaded.exports[start](); }
    catch (error) { failures.push(error); logger.error('Service restart failed', { service: path, error: error.message }); }
  }
  if (failures.length) throw new AggregateError(failures, 'Service restart failed');
}
module.exports = { stopServices, resumeServices };
