/**
 * Admin → Tax Report Routes
 *
 * Mounted at /api/admin/tax-report. Three endpoints with the same
 * query-string contract (from / to / currency / locale):
 *
 *   GET /          → JSON: { rows, totalsByVatRate, grandTotal*, ... }
 *   GET /pdf       → landscape A4 PDF, Content-Disposition: attachment
 *   GET /csv       → RFC-4180 CSV, Content-Disposition: attachment
 *
 * Gated by the Accounting master flag + the `taxReport` sub-flag
 * (independent of `bills` — Tax export was moved out of CRM into
 * Accounting). Still uses the `bills.view` permission: tax data is just
 * a different lens on invoice data, so admins who can read invoices can
 * read the tax report; no new RBAC surface needed.
 */

const express = require('express');
const { query } = require('express-validator');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const taxReportService = require('../services/taxReportService');
const { db } = require('../database/db');

const router = express.Router();

// The tax report now lives under the Accounting master flag and has its
// own dedicated `taxReport` sub-flag — it is INDEPENDENT of `bills`
// (Tax export was moved permanently out of CRM into Accounting). The
// frontend mirrors the dependency rule (accounting off → taxReport off)
// but we re-check both server-side for defence in depth.
async function requireTaxReportFlag(req, res, next) {
  try {
    const rows = await db('feature_flags').whereIn('key', ['accounting', 'taxReport']).select('key', 'value');
    const isOn = (row) => row && (row.value === true || row.value === 1 || row.value === '1');
    const accounting = isOn(rows.find((r) => r.key === 'accounting'));
    const taxReport  = isOn(rows.find((r) => r.key === 'taxReport'));
    if (!accounting) {
      return res.status(403).json({ error: 'Accounting feature is disabled', code: 'ACCOUNTING_DISABLED' });
    }
    if (!taxReport) {
      return res.status(403).json({ error: 'Tax report feature is disabled', code: 'TAX_REPORT_DISABLED' });
    }
    next();
  } catch (err) { next(err); }
}

router.use(adminAuth);
router.use(requireTaxReportFlag);

// Shared validators for from/to/currency. ISO date (YYYY-MM-DD) and
// ISO 4217 alpha-3 currency are enforced — anything else is rejected
// before the service layer to keep error messages crisp.
const QUERY_VALIDATORS = [
  query('from').exists().withMessage('from is required')
    .matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('from must be YYYY-MM-DD'),
  query('to').exists().withMessage('to is required')
    .matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('to must be YYYY-MM-DD'),
  query('currency').exists().withMessage('currency is required')
    .matches(/^[A-Za-z]{3}$/).withMessage('currency must be an ISO 4217 alpha-3 code'),
  query('locale').optional({ values: 'falsy' })
    .isIn(['en', 'de', 'fr', 'nl', 'pt', 'ru'])
    .withMessage('locale must be one of en/de/fr/nl/pt/ru'),
];

function parseParams(req) {
  // scope (export only): all | income | cost. Anything else → 'all'.
  const rawScope = String(req.query.scope || 'all');
  const scope = ['all', 'income', 'cost'].includes(rawScope) ? rawScope : 'all';
  return {
    from: req.query.from,
    to: req.query.to,
    currency: String(req.query.currency || '').toUpperCase(),
    locale: req.query.locale || undefined,
    scope,
  };
}

// ---- JSON ------------------------------------------------------------
router.get(
  '/',
  requirePermission('bills.view'),
  QUERY_VALIDATORS,
  handleAsync(async (req, res) => {
    validateRequest(req);
    const report = await taxReportService.getTaxReport(parseParams(req));
    return successResponse(res, { report });
  })
);

// ---- PDF -------------------------------------------------------------
router.get(
  '/pdf',
  requirePermission('bills.view'),
  QUERY_VALIDATORS,
  handleAsync(async (req, res) => {
    validateRequest(req);
    const params = parseParams(req);
    const buffer = await taxReportService.renderTaxReportPdf(params);
    const scopeTag = params.scope && params.scope !== 'all' ? `${params.scope}_` : '';
    const filename = `tax_report_${scopeTag}${params.from}_to_${params.to}_${params.currency}.pdf`;
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.set('Content-Length', String(buffer.length));
    return res.end(buffer);
  })
);

// ---- CSV -------------------------------------------------------------
router.get(
  '/csv',
  requirePermission('bills.view'),
  QUERY_VALIDATORS,
  handleAsync(async (req, res) => {
    validateRequest(req);
    const params = parseParams(req);
    const { content, filename, contentType } = await taxReportService.renderTaxReportCsv(params);
    res.set('Content-Type', contentType);
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    // BOM for Excel UTF-8 detection — without it Excel on Windows
    // mis-decodes Umlauts/special chars. Three-byte EF BB BF prefix.
    const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
    const body = Buffer.concat([bom, Buffer.from(content, 'utf8')]);
    res.set('Content-Length', String(body.length));
    return res.end(body);
  })
);

module.exports = router;
