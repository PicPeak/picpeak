/**
 * Server-side checks for the customer-document settings (#1444), applied by
 * PUT /api/admin/settings/general before anything is stored. Numbers must be
 * whole and in range, the reminder ladder a list of day counts, and the
 * formats known ones — the readers fall back to defaults on bad values, but
 * a stored bad value would still show in the settings UI as if it applied.
 *
 * normaliseCustomerDocumentSettings(settings) rewrites the keys it knows in
 * place to their stored shape, and returns an error message for the first
 * value it refuses (null when all are fine).
 */

const { ALL_FORMATS, isFormat } = require('../services/documentFormats');

const INTEGER_RANGES = {
  customer_documents_max_upload_size_mb: [1, 1024],
  customer_documents_quota_mb: [1, 1000000],
  customer_documents_retention_days: [1, 3650],
  customer_documents_forbidden_alert_threshold: [1, 100000],
};

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function normaliseCustomerDocumentSettings(settings) {
  for (const [key, [min, max]] of Object.entries(INTEGER_RANGES)) {
    if (!has(settings, key)) continue;
    const n = Number(settings[key]);
    if (settings[key] === '' || settings[key] === null || !Number.isInteger(n) || n < min || n > max) {
      return `${key} must be a whole number between ${min} and ${max}`;
    }
    settings[key] = n;
  }

  if (has(settings, 'customer_documents_notify_on_share')) {
    const v = settings.customer_documents_notify_on_share;
    if (typeof v !== 'boolean') return 'customer_documents_notify_on_share must be true or false';
  }

  if (has(settings, 'customer_documents_request_reminder_days')) {
    const raw = settings.customer_documents_request_reminder_days;
    if (raw !== null && typeof raw !== 'string') return 'customer_documents_request_reminder_days must be text';
    const parts = String(raw || '').split(',').map((p) => p.trim()).filter((p) => p !== '');
    if (parts.length > 10) return 'customer_documents_request_reminder_days takes at most 10 steps';
    const days = [];
    for (const part of parts) {
      if (!/^\d{1,4}$/.test(part) || Number(part) < 1 || Number(part) > 3650) {
        return 'customer_documents_request_reminder_days must be day counts between 1 and 3650, separated by commas';
      }
      days.push(Number(part));
    }
    settings.customer_documents_request_reminder_days = [...new Set(days)].sort((a, b) => a - b).join(',');
  }

  if (has(settings, 'customer_documents_allowed_formats')) {
    const list = settings.customer_documents_allowed_formats;
    if (!Array.isArray(list) || list.length === 0) {
      return 'customer_documents_allowed_formats must be a non-empty list';
    }
    for (const f of list) {
      if (!isFormat(f)) return `customer_documents_allowed_formats: unknown format "${String(f).slice(0, 20)}"`;
    }
    settings.customer_documents_allowed_formats = ALL_FORMATS.filter((f) => list.includes(f));
  }
  return null;
}

module.exports = { normaliseCustomerDocumentSettings };
