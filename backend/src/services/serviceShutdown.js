const logger = require('../utils/logger');
// Resolve only services already loaded by startup. Shutdown must not construct
// unrelated singletons or start new work just to stop it.
const resources = [
  ['../middleware/sessionTimeout', 'dispose'], ['./chunkedUploadService', 'stop'],
  ['../utils/cleanupTempUploads', 'stopTempUploadCleanup'],
  ['../middleware/secureImageMiddleware', 'dispose'], ['../middleware/feedbackRateLimit', 'dispose'],
  ['./downloadZipService', 'stop'],
  ['./fileWatcher', 'stopFileWatcher'], ['./externalMediaWatcher', 'stopExternalMediaWatcher'],
  ['./expirationChecker', 'stopExpirationChecker'], ['./transferCleanupService', 'stopTransferCleanup'],
  ['./customerDocumentRetentionService', 'stopCustomerDocumentRetention'],
  ['./customerDocumentRescanService', 'stopCustomerDocumentRescan'],
  ['./customerDocumentRequestReminderService', 'stopDocumentRequestReminders'],
  ['./contract/expiry', 'stopContractSigningSweep'], ['./contract/signingSignals', 'stopSigningSignals'],
  ['./downloadJobCleanupService', 'stopDownloadJobCleanup'], ['./revealScheduler', 'stopRevealScheduler'],
  ['./feedbackRateLimitCleanupService', 'stopFeedbackRateLimitCleanup'],
  ['./invoiceSchedulerService', 'stopInvoiceScheduler'], ['./emailProcessor', 'stopEmailQueueProcessor'],
  ['./whatsappProcessor', 'stopWhatsAppQueueProcessor'], ['./emailIntakeService', 'stopIncomingMailPoller'],
  ['./webhookDeliveryWorker', 'stopWebhookDeliveryWorker'], ['./s3AutoImporter', 'stopS3AutoImporter'],
  ['./backupService', 'stopBackupService'], ['./databaseBackup', 'stopScheduledBackups'],
  ['./backgroundProcessor', 'stop'], ['./faceQueue', 'stop'], ['./secureImageService', 'dispose'],
  ['../utils/authSecurity', 'stopCleanupJob'], ['../utils/tokenRevocation', 'stopRevocationCleanup'],
];
async function stopServices() {
  const results = await Promise.allSettled(resources.map(async ([path, method]) => {
    const loaded = require.cache[require.resolve(path)];
    if (typeof loaded?.exports[method] === 'function') await loaded.exports[method]();
  }));
  const failures = results.filter(result => result.status === 'rejected');
  failures.forEach(result => logger.error('Service shutdown failed', { error: result.reason.message }));
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Service shutdown failed');
}
module.exports = { stopServices };
