// Extracted verbatim from invoiceService.js — see ../invoiceService.js for the
// module-level overview. Do not add behavior here without updating the entry re-exports.

const crypto = require('crypto');
const { db } = require('../../database/db');
const { getAppSetting } = require('../../utils/appSettings');
const { AppError } = require('../../utils/errors');
const { nextDocumentNumber } = require('../../utils/documentSequences');
const { ensureInt } = require('../../utils/numericHelpers');

// Migration 119 line-item hierarchy helpers, shared with quoteService.
// We import lazily inside the functions that use them to avoid a
// require-cycle warning (quoteService also imports invoiceService for
// the quote→invoice conversion path).
function getHierarchyHelpers() {
  // eslint-disable-next-line global-require
  return require('../quoteService')._internal;
}

// Atomic gap-free invoice number generator. See utils/documentSequences.js
// for the locking story; migration 132 created the underlying table.
// The previous SELECT-MAX-then-INSERT path raced under concurrent
// admin creates and emitted a random `R-2026-AB12C3` after 5 retries,
// breaking the §14 UStG single-sequence requirement.
async function nextInvoiceNumber(trx) {
  return nextDocumentNumber('invoice', 'crm_invoices_number_format', 'R-{YEAR}-{SEQ:04d}', trx);
}

function ensureCustomerCanBill(customer) {
  if (!customer) { throw new AppError('Customer not found', 404); }
  if (customer.is_active === false || customer.is_active === 0) {
    throw new AppError('Customer is deactivated', 409);
  }
  if (customer.feature_bills === false || customer.feature_bills === 0 || customer.feature_bills === '0') {
    throw new AppError('This customer has bills disabled', 409, 'CUSTOMER_FEATURE_DISABLED');
  }
}

/**
 * Resolve a trigger ('quote_accepted' | 'before_event' | ...) +
 * offset_days into a concrete date relative to the event.
 */
function computeScheduledSendAt(trigger, offsetDays, eventDate, baseDate = new Date()) {
  const ms = 24 * 60 * 60 * 1000;
  const offset = ensureInt(offsetDays) * ms;
  const eventTs = eventDate ? new Date(eventDate).getTime() : null;
  switch (trigger) {
  case 'quote_accepted':
    return new Date(baseDate.getTime() + offset);
  case 'before_event':
  case 'after_event':
    if (!eventTs) return new Date(baseDate.getTime() + offset);
    return new Date(eventTs + offset);
  case 'after_delivery':
    // Treat as event_date + 14 days as a sensible default; admin can
    // edit the scheduled_send_at on the invoice later.
    if (!eventTs) return new Date(baseDate.getTime() + 14 * ms + offset);
    return new Date(eventTs + 14 * ms + offset);
  case 'fixed_date':
  default:
    return new Date(baseDate.getTime() + offset);
  }
}

function computeDueDate(scheduledSendAt, netDays = 30) {
  return new Date(scheduledSendAt.getTime() + ensureInt(netDays) * 24 * 60 * 60 * 1000);
}

/**
 * Resolve the net-days a new invoice's due date should be anchored to.
 * Single source of truth so the editor (split picker), legacy callers,
 * and quote→invoice conversion all land on the same number. Priority:
 *
 *   1. `payload.netDays` — explicit caller override (installment spawn
 *      passes the snapshot's net_days here).
 *   2. Split picker (migration 124): payment_net_days_templates.net_days
 *      via `payload.paymentNetDaysTemplateId`. This is what the bill
 *      editor actually sends; the old code only read the legacy FK and
 *      so silently ignored Net 60 / 90 selections.
 *   3. Legacy single FK: payment_term_templates.net_days via
 *      `payload.paymentTermTemplateId`.
 *   4. The `crm_payment_default_net_days` setting (admin-configured).
 *   5. 30 — historical hard default.
 */
async function resolveNetDays(payload, trx = db) {
  if (payload && payload.netDays != null && payload.netDays !== '') {
    const n = ensureInt(payload.netDays);
    if (n) return n;
  }
  if (payload && payload.paymentNetDaysTemplateId) {
    const probe = await trx('payment_net_days_templates')
      .where({ id: payload.paymentNetDaysTemplateId })
      .select('net_days')
      .first();
    if (probe && probe.net_days != null) return ensureInt(probe.net_days) || 30;
  }
  if (payload && payload.paymentTermTemplateId) {
    const probe = await trx('payment_term_templates')
      .where({ id: payload.paymentTermTemplateId })
      .select('net_days')
      .first();
    if (probe && probe.net_days != null) return ensureInt(probe.net_days) || 30;
  }
  const setting = ensureInt(await getAppSetting('crm_payment_default_net_days'));
  if (setting) return setting;
  return 30;
}

/**
 * Net-days for an already-persisted invoice row (no payload). Reads the
 * snapshot's net_days, then the crm_payment_default_net_days setting,
 * then 30. Used at send time to re-anchor the due date when the issue
 * date is stamped. Mirrors resolveNetDays' tail.
 */
async function resolveNetDaysForRow(invoice) {
  const snap = typeof invoice.payment_term_snapshot === 'string'
    ? (() => { try { return JSON.parse(invoice.payment_term_snapshot); } catch { return null; } })()
    : invoice.payment_term_snapshot;
  if (snap && snap.net_days != null) {
    const n = ensureInt(snap.net_days);
    if (n) return n;
  }
  const setting = ensureInt(await getAppSetting('crm_payment_default_net_days'));
  if (setting) return setting;
  return 30;
}

/**
 * Resolve the deal_uuid for a new invoice row (migration 140). Priority:
 *
 *   1. `payload.dealUuid` — explicit caller override. Used by
 *      spawnInstallmentInvoices (all siblings share one uuid),
 *      Storno (inherits from cancelled invoice), and reissue
 *      (inherits from the cancelled original).
 *   2. The source quote's deal_uuid, if `payload.sourceQuoteId` is set.
 *   3. The source contract's deal_uuid, if `payload.sourceContractId`
 *      is set.
 *   4. Fresh mint — standalone invoices that aren't part of any chain.
 *
 * Returns a UUID string. Never returns null.
 */
async function resolveDealUuid(trx, payload) {
  if (payload?.dealUuid) return payload.dealUuid;
  if (payload?.sourceQuoteId) {
    const q = await trx('quotes').where({ id: payload.sourceQuoteId }).first('deal_uuid');
    if (q?.deal_uuid) return q.deal_uuid;
  }
  if (payload?.sourceContractId) {
    const c = await trx('contracts').where({ id: payload.sourceContractId }).first('deal_uuid');
    if (c?.deal_uuid) return c.deal_uuid;
  }
  return crypto.randomUUID();
}

/**
 * Snap a baseline date to the next billing-cycle boundary for a
 * customer on a fixed cadence. Used by scheduleInvoicesForEvent so
 * monthly / quarterly customers don't get billed immediately on quote
 * acceptance — instead the invoice fires on `billing_cycle_day` of the
 * next period.
 *
 * `cycleDay` honours the sign-as-discriminator convention from
 * migration 128: positive 1..28 = that day of the month; negative
 * -1..-15 = that many days before end of month. Resolution is
 * delegated to `computeMonthlyCadenceDate` so the two helpers can't
 * disagree about what "-3 cycle day" means.
 *
 * Day numbers beyond the destination month's length are clamped
 * (e.g. day 31 in February rolls back to Feb 28/29). Negative days
 * are clamped to day 1 minimum (extreme values like -40 don't blow
 * past the start of the month).
 *
 * History: a prior version of this function did
 * `Math.max(1, Math.min(31, ensureInt(cycleDay) || 1))`, silently
 * clamping every negative value to 1 — so a customer configured
 * with cycle_day=-3 (last 3 days of month) got billed on day 1
 * instead. Audit finding: monthly cycle sign convention bug.
 */
function snapToNextBillingCycle(baseDate, cadence, cycleDay) {
  if (!cadence || cadence === 'per_event') return baseDate;
  const day = Number.isFinite(ensureInt(cycleDay)) ? ensureInt(cycleDay) : 1;
  const d = new Date(baseDate.getTime());

  if (cadence === 'monthly') {
    // Move to the cycleDay in the next calendar month. If we're already
    // before cycleDay this month and the base date is in the same month,
    // we still move forward to NEXT month so accepting a quote on
    // Jan 5 (cycleDay=1) fires on Feb 1, not Jan 5.
    const nextMonth = d.getMonth() + 1;
    return computeMonthlyCadenceDate(d.getFullYear(), nextMonth, day);
  }

  if (cadence === 'quarterly') {
    // First month of the next quarter. Quarter starts: Jan, Apr, Jul, Oct.
    const month = d.getMonth();
    const nextQuarterMonth = (Math.floor(month / 3) + 1) * 3; // 0,3,6,9
    return computeMonthlyCadenceDate(d.getFullYear(), nextQuarterMonth, day);
  }

  return baseDate;
}

/**
 * Compute the canonical "cadence day" for a given (year, month) using
 * the customer's `billing_cycle_day`. Migration 128 introduced the
 * sign-as-discriminator convention:
 *   positive  1..28 → that day of the month, clamped to month length
 *   negative -1..-15 → that many days before end of month
 * Zero falls back to 1 (matches the service-layer clamp).
 *
 * Returns a JS Date at local-midnight on the resolved day. Callers
 * compare against today's date with day-resolution math; the time
 * component never matters for monthly-bill issuance.
 */
function computeMonthlyCadenceDate(year, month /* 0-based */, cycleDay) {
  const day = Number.isFinite(cycleDay) ? Math.trunc(cycleDay) : 1;
  const monthLen = new Date(year, month + 1, 0).getDate();
  let target;
  if (day > 0) {
    target = Math.min(day, monthLen);
  } else if (day < 0) {
    // Sign-as-discriminator: -N = N days before month end. Documented
    // in the admin UI hint as "Use negative -1..-15 for 'N days before
    // month end' (so -3 fires on the 28th of a 31-day month)".
    // Formula: monthLen + day → -3 + 31 = 28 ✓.
    // Clamped to day 1 minimum so extreme values (-40) don't blow
    // past the start of the month.
    target = Math.max(1, monthLen + day);
  } else {
    target = 1;
  }
  return new Date(year, month, target);
}

// ----------------------------------------------------------------------
// updateInstallmentPlan — atomic post-spawn plan edit
// ----------------------------------------------------------------------

// Statuses that are still pre-customer (no PDF has gone out the door).
// Both `scheduled` and `pending_delivery` are reshapable; anything else
// belongs to the audit trail and can't be silently mutated.
const EDITABLE_INSTALLMENT_STATUSES = new Set(['scheduled', 'pending_delivery']);

const VALID_INSTALLMENT_TRIGGERS = new Set([
  'quote_accepted', 'before_event', 'after_event', 'after_delivery', 'fixed_date',
]);

// Module-cached issuer country code — refreshed on every business
// profile save by listening to the same query React-Query revalidates.
// For backend purposes we read it lazily once per process and cache
// the resolved Intl locale; admins changing the country in Settings
// take effect after the next backend restart, which is acceptable
// (this isn't on a hot path).
let _cachedIntlLocale = null;
async function resolveIntlLocale(docLocale) {
  if (_cachedIntlLocale) return _cachedIntlLocale;
  try {
    const businessProfileService = require('../businessProfileService');
    const profile = (await businessProfileService.getProfile()).profile || {};
    const cc = (profile.country_code || '').toUpperCase();
    if (['CH', 'LI', 'DE', 'AT'].includes(cc)) {
      _cachedIntlLocale = 'de-CH';
      return _cachedIntlLocale;
    }
  } catch (_) { /* fall through to per-locale default */ }
  return docLocale === 'de' ? 'de-CH' : 'en-GB';
}

function formatMajor(minor, currency, locale) {
  // Sync version — keeps the existing call-sites working. Reads the
  // module cache populated by the async warm-up on first send. When
  // the cache hasn't filled yet (first invocation in a process)
  // fall through to the legacy de-vs-en split; the cache fills after
  // the first send and every subsequent send uses the correct locale.
  const cached = _cachedIntlLocale;
  const intlLocale = cached || (locale === 'de' ? 'de-CH' : 'en-GB');
  // Best-effort warm-up — fire and forget; the next call hits cache.
  if (!cached) {
    resolveIntlLocale(locale).catch(() => { /* tolerate */ });
  }
  return new Intl.NumberFormat(intlLocale, {
    style: 'currency', currency: (currency || 'CHF').toUpperCase(),
  }).format(Number(minor || 0) / 100);
}

module.exports = {
  getHierarchyHelpers,
  nextInvoiceNumber,
  ensureCustomerCanBill,
  computeScheduledSendAt,
  computeDueDate,
  resolveNetDays,
  resolveNetDaysForRow,
  resolveDealUuid,
  snapToNextBillingCycle,
  computeMonthlyCadenceDate,
  EDITABLE_INSTALLMENT_STATUSES,
  VALID_INSTALLMENT_TRIGGERS,
  resolveIntlLocale,
  formatMajor,
};
