// Only successful authenticated ADMIN capability operations set a coarse
// marker. Never mount on gallery/customer/public routes. No request values,
// identifiers, paths, timing, or counts are retained or sent.
const service = require('../services/productUsageService');
const logger = require('../utils/logger');
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
function productUsage(req, res, next) {
  const pathname = req.path;
  res.once('finish', () => {
    if (!req.admin?.id || res.statusCode < 200 || res.statusCode >= 300) return;
    const features = RULES.filter(([pattern]) =>
      pattern.test(pathname)
    ).flatMap(([, keys]) => keys);
    if (
      process.env.STORAGE_BACKEND === 's3' &&
      /^\/(?:photos|events)\/[^/]+\/upload(?:\/|$)/.test(pathname)
    )
      features.push('s3_storage');
    if (features.length)
      service
        .markUsed(features)
        .catch(() => logger.warn('Product usage marker could not be recorded'));
  });
  next();
}
module.exports = { productUsage, RULES };
