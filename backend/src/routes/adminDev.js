/**
 * Admin → Dev tools
 *
 * Internal-use endpoints surfaced via the "Development" sub-tab
 * under Clients. Strictly gated behind THREE layers:
 *   - admin auth + `settings.edit` permission
 *   - the `crmDevelopment` feature flag (defense-in-depth — the
 *     frontend hides the tab when off, this check stops API
 *     callers from poking endpoints that aren't supposed to fire)
 *   - the `PICPEAK_ENABLE_DEV_TOOLS=1` environment variable
 *     (production-safety hard gate — a stray feature flag flip in
 *     a real install can't enable these endpoints)
 *
 * Currently exposes:
 *   POST /send-test-email   queue any CRM email template to the
 *                           currently-logged-in admin's mailbox,
 *                           with SYNTHETIC data only (PDFs are
 *                           rendered from hard-coded sample data,
 *                           never from real customer records)
 *
 * Security history: a prior version of this route queried real
 * customer records (`SELECT … FROM quotes ORDER BY id DESC LIMIT 1`)
 * to source the sample PDFs, which leaked one customer's invoice to
 * a different admin's inbox in multi-admin installs. The synthetic-
 * only data path closes that leak; the env gate prevents accidental
 * production exposure if the feature flag is ever flipped on by
 * mistake.
 */

const express = require('express');
const { body } = require('express-validator');
const path = require('path');
const fs = require('fs');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const { db } = require('../database/db');
const emailProcessor = require('../services/emailProcessor');
const pdfService = require('../services/pdfService');
const { AppError } = require('../utils/errors');
const logger = require('../utils/logger');

const router = express.Router();

router.use(adminAuth);

/**
 * Production-safety gate. Even if the crmDevelopment feature flag is
 * accidentally enabled in a production install (one wrong DB toggle),
 * this env check prevents the endpoints from doing anything. Operators
 * who genuinely want dev tools in a non-production environment set
 * PICPEAK_ENABLE_DEV_TOOLS=1 in the env file.
 */
router.use(handleAsync(async (req, res, next) => {
  if (process.env.PICPEAK_ENABLE_DEV_TOOLS !== '1') {
    return res.status(403).json({
      error: 'CRM development tools are disabled (PICPEAK_ENABLE_DEV_TOOLS env var not set)',
      code: 'CRM_DEV_ENV_DISABLED',
    });
  }
  next();
}));

/**
 * Gate every endpoint below the crmDevelopment feature flag.
 * Mirrors the parent /admin/clients/development route guard.
 */
router.use(handleAsync(async (req, res, next) => {
  const row = await db('feature_flags').where({ key: 'crmDevelopment' }).first();
  const enabled = row && (row.value === true || row.value === 1 || row.value === '1');
  if (!enabled) {
    return res.status(403).json({
      error: 'CRM development tools are disabled',
      code: 'CRM_DEV_DISABLED',
    });
  }
  next();
}));

const TEMPLATES_KEYS = [
  'quote_sent',
  'quote_accepted_customer',
  'quote_accepted_admin',
  'quote_declined_admin',
  'invoice_sent',
  'invoice_reminder_first',
  'invoice_reminder_second',
  'invoice_payment_check_admin',
  // Contracts (migration 130). All three flows are exercised:
  //   - contract_sent: admin → customer, with a sample contract PDF
  //   - contract_signed_admin_notification: customer-signed ping back
  //     to the admin (no attachment in the real flow either)
  //   - contract_fully_signed: dual-party send when both signatures
  //     are in. Real flow attaches the stamped contract + audit cert;
  //     the dev tester attaches the stamped contract only (the audit
  //     cert is reproducible from contract data so its absence here
  //     doesn't change what's being tested — the template body).
  'contract_sent',
  'contract_signed_admin_notification',
  'contract_fully_signed',
  // Pre-event reminder emails (migration 143). The runtime resolver
  // picks `event_reminder_<events.event_type>` with fallback to
  // `event_reminder_default`. The dev tester exposes every seeded
  // template so the maintainer can eyeball each category's body
  // without staging a real event for each.
  'event_reminder_default',
  'event_reminder_wedding',
  'event_reminder_birthday',
  'event_reminder_corporate',
  'event_reminder_other',
];

router.get(
  '/email-templates',
  requirePermission('settings.edit'),
  handleAsync(async (_req, res) => {
    // Return the keys + whether each template exists in the DB so
    // the UI can grey out missing ones (e.g. on an install that
    // hasn't run migration 116 yet).
    const rows = await db('email_templates')
      .whereIn('template_key', TEMPLATES_KEYS)
      .select('template_key');
    const present = new Set(rows.map((r) => r.template_key));
    return successResponse(res, {
      templates: TEMPLATES_KEYS.map((k) => ({ key: k, present: present.has(k) })),
    });
  })
);

const FRONTEND_URL_FALLBACK = 'https://app.example.com';
const DEV_TEST_DIR = () => path.join(process.cwd(), 'storage', 'business-docs', 'dev-test');

function fakeMoney(major, currency, locale = 'de') {
  return new Intl.NumberFormat(locale === 'de' ? 'de-CH' : 'en-GB', {
    style: 'currency', currency: (currency || 'CHF').toUpperCase(),
  }).format(major);
}
function fakeShortDate(d) {
  const date = d instanceof Date ? d : new Date(d);
  return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.${date.getFullYear()}`;
}

/**
 * Keep the dev-test PDF directory bounded: retain only the 7 newest
 * files per cleanup pass. Each test-email render writes a fresh file;
 * without cleanup the directory grows unbounded.
 *
 * Best-effort: failures are logged and swallowed (cleanup never blocks
 * the test-email flow).
 */
function pruneDevTestDir() {
  try {
    const dir = DEV_TEST_DIR();
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.pdf'))
      .map((e) => {
        const full = path.join(dir, e.name);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime); // newest first
    for (const old of entries.slice(7)) {
      try { fs.unlinkSync(old.full); } catch (_) { /* best-effort */ }
    }
  } catch (err) {
    logger.warn('dev send-test-email: cleanup of dev-test dir failed', { err: err.message });
  }
}

/**
 * Shared synthetic issuer + recipient blocks used by all three
 * sample-PDF builders. The issuer pulls from `business_profile` so
 * the admin sees their own brand on the test PDF (logo, address,
 * fonts) — that's the operator's own data, safe to render. The
 * recipient block is fully synthetic so no customer PII is ever
 * embedded.
 *
 * Returning `null` for issuer is acceptable; pdfService's
 * normaliseContext defaults each missing field. We still fetch the
 * profile when available to make the test render look realistic.
 */
async function buildSyntheticParties() {
  let profile = {};
  try {
    const businessProfileService = require('../services/businessProfileService');
    profile = (await businessProfileService.getProfile()).profile || {};
  } catch (_) {
    // Fresh install with no business_profile row: render with
    // generic defaults below.
  }
  const issuer = {
    companyName: profile.company_name || 'Sample Studio',
    addressLine1: profile.address_line1 || 'Beispielstrasse 1',
    addressLine2: profile.address_line2,
    postalCode: profile.postal_code || '8000',
    city: profile.city || 'Zürich',
    state: profile.state,
    countryCode: profile.country_code || 'CH',
    phone: profile.phone,
    mobile: profile.mobile,
    email: profile.email || 'studio@example.test',
    website: profile.website,
    footerLine: profile.footer_line,
    vatId: profile.vat_id,
    logoPath: null, // skip logo file lookup for the synthetic render
    pdfFontTtfPath: profile.pdf_font_ttf_path,
    pdfFontFamily: profile.pdf_font_family || null,
    countryName: profile.country_name || null,
    showLogo: false,
    showCompanyName: true,
    logoHeight: 56,
    companyNameInline: false,
    foldingMarks: 'none',
    quoteShowNetDays: false,
    quoteShowSkonto: false,
  };
  const recipient = {
    issuerLine: profile.company_name
      ? `${profile.company_name} * ${profile.address_line1 || ''} * ${profile.postal_code || ''} ${profile.city || ''}`
      : '',
    companyName: 'Sample Customer GmbH',
    hasCompany: true,
    attentionLine: 'z. Hd. Maria Sample',
    salutation: 'Frau',
    lastName: 'Sample',
    addressLine1: 'Musterstrasse 1',
    addressLine2: null,
    postalCode: '8000',
    city: 'Zürich',
    country: null,
    countryCodeIso: 'CH',
  };
  return { issuer, recipient };
}

const SYNTHETIC_LINE_ITEMS = [
  { quantity: 1, description: 'Photo session (sample)', unitPriceMinor: 80000, discountPercent: 0, lineTotalMinor: 80000, parentLineItemId: null, parentPosition: null, detailsText: null },
  { quantity: 2, description: 'Photo prints A4 (sample)', unitPriceMinor: 1500, discountPercent: 0, lineTotalMinor: 3000, parentLineItemId: null, parentPosition: null, detailsText: null },
];
const SYNTHETIC_TOTALS = { netAmountMinor: 83000, vatRate: 7.7, vatAmountMinor: 6391, shippingAmountMinor: 0, totalAmountMinor: 89391 };

/**
 * Render a sample QUOTE PDF from synthetic data — no DB read of real
 * quotes. Uses pdfService.renderQuoteToBuffer directly with a render
 * context matching the shape produced by quoteService.buildRenderContext.
 */
async function renderSyntheticQuotePdf(adminId) {
  try {
    const { issuer, recipient } = await buildSyntheticParties();
    const today = new Date();
    const ctx = {
      locale: 'de',
      currency: 'CHF',
      qrFormat: 'none',
      issuer,
      recipient,
      lineItems: SYNTHETIC_LINE_ITEMS,
      totals: SYNTHETIC_TOTALS,
      doc: {
        quoteNumber: 'Q-DEV-0001',
        issueDate: today,
        validUntil: new Date(today.getTime() + 14 * 86400000),
        introText: 'Sample quote — synthetic data only. Not a real customer record.',
        outroText: null,
        totalAmountMinor: SYNTHETIC_TOTALS.totalAmountMinor,
      },
      bank: null,
      paymentTerm: null,
    };
    const buffer = await pdfService.renderQuoteToBuffer(ctx);
    return writeSyntheticPdf(buffer, `quote-sample-${adminId}-${Date.now()}.pdf`, 'Q-DEV-0001-sample.pdf');
  } catch (err) {
    logger.warn('dev send-test-email: synthetic quote PDF render failed', { err: err.message });
    return null;
  }
}

async function renderSyntheticInvoicePdf(adminId) {
  try {
    const { issuer, recipient } = await buildSyntheticParties();
    const today = new Date();
    const ctx = {
      locale: 'de',
      currency: 'CHF',
      qrFormat: 'none',
      issuer,
      recipient,
      lineItems: SYNTHETIC_LINE_ITEMS,
      totals: SYNTHETIC_TOTALS,
      doc: {
        invoiceNumber: 'R-DEV-0001',
        issueDate: today,
        dueDate: new Date(today.getTime() + 30 * 86400000),
        introText: 'Sample invoice — synthetic data only. Not a real customer record.',
        outroText: null,
        kind: 'invoice',
        lateFeeMinor: 0,
      },
      bank: null,
      paymentTerm: null,
    };
    const buffer = await pdfService.renderInvoiceToBuffer(ctx);
    return writeSyntheticPdf(buffer, `invoice-sample-${adminId}-${Date.now()}.pdf`, 'R-DEV-0001-sample.pdf');
  } catch (err) {
    logger.warn('dev send-test-email: synthetic invoice PDF render failed', { err: err.message });
    return null;
  }
}

async function renderSyntheticContractPdf(adminId) {
  try {
    const { issuer, recipient } = await buildSyntheticParties();
    const today = new Date();
    const ctx = {
      locale: 'de',
      dateFormat: null,
      issuer,
      recipient,
      today,
      doc: {
        contractNumber: 'C-DEV-0001',
        title: 'Sample contract — synthetic data only',
        issueDate: today,
        validUntil: new Date(today.getTime() + 30 * 86400000),
        introText: null,
        outroText: null,
      },
      sections: [{
        section: 'basics',
        blocks: [{
          slug: 'basics_service',
          name: 'Subject of contract (sample)',
          section: 'basics',
          body: 'This is a synthetic dev-test contract. Not a real customer agreement.',
        }],
      }],
      signatures: { customer: null, admin: null },
    };
    const buffer = await pdfService.renderContractToBuffer(ctx);
    return writeSyntheticPdf(buffer, `contract-sample-${adminId}-${Date.now()}.pdf`, 'C-DEV-0001-sample.pdf');
  } catch (err) {
    logger.warn('dev send-test-email: synthetic contract PDF render failed', { err: err.message });
    return null;
  }
}

function writeSyntheticPdf(buffer, onDiskName, attachmentName) {
  const dir = DEV_TEST_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, onDiskName);
  fs.writeFileSync(filePath, buffer);
  pruneDevTestDir();
  return { path: filePath, filename: attachmentName };
}

/**
 * Build a payload tailored to each template. All variables map back
 * to the `{{tokens}}` the seeded templates reference, so the email
 * the admin sees is identical to what the real flow would send.
 */
async function buildPayloadFor(key, adminId, frontendUrl) {
  const dummyToken = 'dev-test-token-' + Math.random().toString(16).slice(2, 12).padEnd(64, '0').slice(0, 64);
  const total = 1234.56;
  const lateFee = 25.00;
  const today = new Date();
  const dueDate = new Date(today.getTime() - 5 * 86400000);
  const validUntil = new Date(today.getTime() + 14 * 86400000);
  // Pre-event reminder mock: pretend the event is 2 days out (the
  // global default for `crm_event_reminders_days_before`). Renders
  // {{event_date}} + {{days_before}} for the event_reminder_*
  // templates.
  const eventDate = new Date(today.getTime() + 2 * 86400000);
  const businessProfile = await db('business_profile').first().catch(() => null);

  const common = {
    customer_name: 'Sample Customer',
    customer_email: 'sample.customer@example.test',
    event_name: 'Sample Event',
    event_date: fakeShortDate(eventDate),
    days_before: 2,
    business_name: businessProfile?.legal_name || 'Sample Studio',
    invoice_number: 'R-DEV-0001',
    quote_number: 'Q-DEV-0001',
    total_amount: fakeMoney(total, 'CHF'),
    new_total_amount: fakeMoney(total + lateFee, 'CHF'),
    late_fee_amount: fakeMoney(lateFee, 'CHF'),
    late_fee_due: true,
    due_date: fakeShortDate(dueDate),
    valid_until: fakeShortDate(validUntil),
    days_overdue: 5,
    installment_label: 'Anzahlung',
    installment_index: 1,
    installment_total: 2,
    admin_dashboard_url: `${frontendUrl}/admin/clients/bills`,
    response_url: `${frontendUrl}/quote/${dummyToken}`,
    accept_url:   `${frontendUrl}/quote/${dummyToken}?action=accept`,
    decline_url:  `${frontendUrl}/quote/${dummyToken}?action=decline`,
    paid_url:     `${frontendUrl}/payment-check/${dummyToken}?action=paid_full`,
    partial_url:  `${frontendUrl}/payment-check/${dummyToken}?action=partial`,
    unpaid_url:   `${frontendUrl}/payment-check/${dummyToken}?action=unpaid`,
    accepted_on_behalf: true,
    // Contract-specific variables. Title + contract_number stand in
    // for the matching {{tokens}} in the seeded contract templates.
    contract_number: 'C-DEV-0001',
    title: 'Sample contract — synthetic data only',
    signed_customer_name: 'Sample Customer',
  };

  // Templates with PDF attachments get a SYNTHETIC sample PDF. Never
  // pulls from real records on disk — every render builds from
  // hardcoded sample data via the renderSynthetic*Pdf helpers above.
  let attachments;
  if (key === 'quote_sent' || key === 'quote_accepted_customer') {
    const pdf = await renderSyntheticQuotePdf(adminId);
    if (pdf) attachments = [{ filename: pdf.filename, contentPath: pdf.path, contentType: 'application/pdf' }];
  } else if (key === 'invoice_sent' || key === 'invoice_reminder_first' || key === 'invoice_reminder_second') {
    const pdf = await renderSyntheticInvoicePdf(adminId);
    if (pdf) attachments = [{ filename: pdf.filename, contentPath: pdf.path, contentType: 'application/pdf' }];
  } else if (key === 'contract_sent' || key === 'contract_fully_signed') {
    const pdf = await renderSyntheticContractPdf(adminId);
    if (pdf) attachments = [{ filename: pdf.filename, contentPath: pdf.path, contentType: 'application/pdf' }];
  }

  return attachments ? { ...common, attachments } : common;
}

router.post(
  '/send-test-email',
  requirePermission('settings.edit'),
  [body('templateKey').isString().isIn(TEMPLATES_KEYS)],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const admin = await db('admin_users').where({ id: req.admin.id }).first();
    if (!admin?.email) throw new AppError('Logged-in admin has no email on file', 400);

    const template = await db('email_templates')
      .where({ template_key: req.body.templateKey }).first();
    if (!template) {
      throw new AppError(`Template "${req.body.templateKey}" not seeded yet — run migrations`, 409, 'TEMPLATE_MISSING');
    }

    const frontendUrl = (process.env.FRONTEND_URL || FRONTEND_URL_FALLBACK).replace(/\/$/, '');
    const payload = await buildPayloadFor(req.body.templateKey, req.admin.id, frontendUrl);

    await emailProcessor.queueEmail(null, admin.email, req.body.templateKey, payload);

    return successResponse(res, {
      sent: true,
      to: admin.email,
      template: req.body.templateKey,
    }, 200, 'Test email queued');
  })
);

module.exports = router;
