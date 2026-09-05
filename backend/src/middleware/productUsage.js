// Only successful authenticated ADMIN capability operations set a coarse
// marker. Never mount on gallery/customer/public routes. No request values,
// identifiers, paths, timing, or counts are retained or sent.
const service = require('../services/productUsageService');
const logger = require('../utils/logger');
// Mirrors emailWebhookTransport: the webhook is in play only when both are
// set, which is when adminEmail routes the test send through it.
const webhookTransportConfigured = () =>
  Boolean(
    (process.env.EMAIL_WEBHOOK_URL || '').trim() &&
      (process.env.EMAIL_WEBHOOK_SECRET || '').trim()
  );

const RULES = [
  [/^\/customers(?:\/|$)/, ['crm']],
  [/^\/quotes(?:\/|$)/, ['crm', 'crm_quotes']],
  [/^\/invoices(?:\/|$)/, ['crm', 'crm_invoices']],
  [/^\/contracts(?:\/|$)/, ['crm', 'crm_contracts']],
  [/^\/projects(?:\/|$)/, ['crm', 'crm_projects']],
  [/^\/calendar(?:\/|$)/, ['crm', 'crm_calendar']],
  [/^\/customers\/(?:[^/]+\/)?hour-entries(?:\/|$)/, ['crm', 'crm_hours']],
  [/^\/customers\/(?:invite|[^/]+\/send-invite)(?:\/|$)/, ['customer_portal']],
  [
    /^\/(?:ledger|expenses|tax-report|incoming-invoices)(?:\/|$)/,
    ['accounting']
  ],
  [/^\/workflows(?:\/|$)/, ['workflows']],
  [/^\/newsletters(?:\/|$)/, ['newsletters']],
  [/^\/events\/[^/]+\/(?:faces|people)(?:\/|$)/, ['face_recognition']],
  [/^\/whatsapp\/(?:send|test)(?:\/|$)/, ['whatsapp']],
  [
    /^\/(?:backup|database-backup)\/(?:run|backup|create|start|test|picpeak\/export)(?:\/|$)/,
    ['backup']
  ],
  [/^\/backup\/s3\/test-upload(?:\/|$)/, ['s3_storage']],
  [/^\/email\/(?:test|send)(?:\/|$)/, ['smtp']],
  [/^\/external-media(?:\/|$)/, ['share_mounts']]
];
// Backup operations that write to the CONFIGURED destination, and so imply
// S3 use when that destination is S3. Deliberately excludes
// /backup/picpeak/export and everything under /database-backup/, which
// produce a local file regardless of where scheduled backups go.
const DESTINATION_BACKUP = /^\/backup\/(?:run|backup|create|start|test)(?:\/|$)/;

function productUsage(req, res, next) {
  const pathname = req.path;
  res.once('finish', () => {
    if (!req.admin?.id || res.statusCode < 200 || res.statusCode >= 300) return;
    let features = RULES.filter(([pattern]) =>
      pattern.test(pathname)
    ).flatMap(([, keys]) => keys);
    // A webhook-only install sends /email/test through the webhook transport
    // and never touches SMTP (adminEmail.js has an explicit path for it,
    // #1225), so recording smtp here would permanently misclassify it.
    if (features.includes('smtp') && webhookTransportConfigured())
      features = features.filter((f) => f !== 'smtp');
    if (
      process.env.STORAGE_BACKEND === 's3' &&
      /^\/(?:photos|events)\/[^/]+\/upload(?:\/|$)/.test(pathname)
    )
      features.push('s3_storage');
    if (features.length)
      service
        .markUsed(features, {
          destinationBackup: DESTINATION_BACKUP.test(pathname)
        })
        .catch(() => logger.warn('Product usage marker could not be recorded'));
  });
  next();
}
module.exports = { productUsage, RULES, DESTINATION_BACKUP };
