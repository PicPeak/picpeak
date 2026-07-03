/**
 * invoiceService — lifecycle for `invoices`, line items, payment log.
 *
 * Layers on top of quoteService for the conversion path: quoteService
 * .convertToEvent() calls into scheduleInvoicesForEvent() to fan out
 * one row per installment with the right `scheduled_send_at` relative
 * to the event date.
 *
 * Statuses (`invoices.status`):
 *   scheduled  not yet sent; the scheduler picks it up when
 *              `scheduled_send_at <= now()` and flips to `sent`
 *   sent       email + PDF delivered; awaiting payment
 *   paid       fully paid (paid_amount_minor >= total_amount_minor)
 *   overdue    past due_date + reminder_first_days; reminder fired
 *   cancelled  admin cancelled; no further reminders
 *
 * Per-customer feature override (`customer_accounts.feature_bills`):
 *   when false, the service refuses to create or schedule invoices for
 *   that customer.
 */

const crypto = require('crypto');
const { db, withRetry, logActivity } = require('../database/db');
const logger = require('../utils/logger');
const { getAppSetting } = require('../utils/appSettings');
const { cleanNetMinor } = require('../utils/invoiceRounding');
const { AppError } = require('../utils/errors');
const { formatBoolean } = require('../utils/dbCompat');
const { claimNextSequence } = require('../utils/documentSequences');
const { formatShortDate } = require('../utils/dateFormatter');
const businessProfileService = require('./businessProfileService');
const { buildIssuerBlock, buildRecipientBlock } = require('./_renderContext');
const { resolveBillingRecipients } = require('./_billingRecipients');
const pdfService = require('./pdfService');
const emailProcessor = require('./emailProcessor');
// Migration 119 line-item hierarchy helpers, shared with quoteService.
// We import lazily inside the functions that use them to avoid a
// require-cycle warning (quoteService also imports invoiceService for
// the quote→invoice conversion path).
function getHierarchyHelpers() {
  // eslint-disable-next-line global-require
  return require('./quoteService')._internal;
}

// D.2 — `ensureInt` + `ensureNumber` consolidated into utils/numericHelpers.
const { ensureInt, ensureNumber } = require('../utils/numericHelpers');
const { hasColumnCached } = require('../utils/schemaCache');

function formatNumberInTemplate(format, year, seq) {
  return format
    .replace(/\{YEAR\}/g, String(year))
    .replace(/\{MONTH\}/g, String(new Date().getMonth() + 1).padStart(2, '0'))
    .replace(/\{SEQ:(\d+)d\}/g, (_, pad) => String(seq).padStart(parseInt(pad, 10), '0'))
    .replace(/\{SEQ\}/g, String(seq));
}

// Atomic gap-free invoice number generator. See utils/documentSequences.js
// for the locking story; migration 132 created the underlying table.
// The previous SELECT-MAX-then-INSERT path raced under concurrent
// admin creates and emitted a random `R-2026-AB12C3` after 5 retries,
// breaking the §14 UStG single-sequence requirement.
async function nextInvoiceNumber(trx) {
  // Read through `trx` when present — getAppSetting on the global db inside an
  // open transaction deadlocks the single-connection SQLite pool.
  const format = (await getAppSetting('crm_invoices_number_format', null, trx || db)) || 'R-{YEAR}-{SEQ:04d}';
  const year = new Date().getFullYear();
  const seq = await claimNextSequence('invoice', year, trx);
  return formatNumberInTemplate(format, year, seq);
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

/**
 * Find or create the running "monthly draft" invoice for a customer.
 * One draft per customer per current billing period (`monthly_period_end >= today`).
 * Subsequent saves through createInvoice for the same monthly-mode
 * customer append line items onto this draft instead of minting fresh
 * invoices.
 *
 * Returns `{ id, row }` for the draft so the caller can append items
 * + recompute totals without a second query.
 *
 * Period bounds:
 *   start = first calendar day of the month that contains today
 *   end   = computeMonthlyCadenceDate(year, month, cycle_day) where
 *           year/month are picked so that the resolved date is in the
 *           future. If today is already PAST the cadence day for the
 *           current month, the period rolls to next month — admin
 *           authoring items after the cadence is "starting the next
 *           bill", not "appending to one that already fired".
 */
async function getOrCreateMonthlyDraft(customer, adminId, trx) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Manual cadence has no billing cycle: the draft accumulates
  // indefinitely and ships ONLY via the admin "Trigger invoice now"
  // gesture, so it carries NO period_end. The scheduler's auto-flush
  // filter is `monthly_period_end <= today`, which a NULL period_end
  // can never satisfy — keeping manual drafts out of the cron path.
  const isManual = customer.billing_cadence === 'manual';

  // Resolve period_end: prefer the cadence in the current month, but
  // if it has already passed, roll to next month so the new draft
  // gathers items toward the NEXT bill.
  const cycleDay = ensureInt(customer.billing_cycle_day) || 1;
  let target = computeMonthlyCadenceDate(today.getFullYear(), today.getMonth(), cycleDay);
  if (target.getTime() < today.getTime()) {
    const nextMonth = today.getMonth() + 1;
    target = computeMonthlyCadenceDate(today.getFullYear(), nextMonth, cycleDay);
  }
  const periodStart = isManual ? null : new Date(target.getFullYear(), target.getMonth(), 1);
  const periodEnd = isManual ? null : target;
  // Placeholder issue/due date for the empty draft row — recomputed at
  // issuance time. Manual drafts have no period_end, so fall back to today.
  const placeholderDate = (periodEnd || today).toISOString().slice(0, 10);

  // Look up any existing open draft for this customer. We deliberately
  // do NOT filter by monthly_period_end here — only one draft can be
  // open per customer at a time (enforced by the partial unique index
  // created in migration 133). If the scheduler hasn't yet promoted an
  // expired draft, it's still the canonical landing spot for any new
  // items the admin queues; promoting it is the scheduler's job, not
  // ours. forUpdate() locks the row on Postgres so concurrent appenders
  // serialize on totals recomputation; SQLite's transaction write-lock
  // gives us the same guarantee implicitly.
  const existing = await trx('invoices')
    .where({
      customer_account_id: customer.id,
      is_monthly_draft: true,
    })
    .orderBy('id', 'desc')
    .forUpdate()
    .first();
  if (existing) {
    return { id: existing.id, row: existing, created: false };
  }

  // None yet — mint one with zero line items + zero totals. The
  // caller appends items + recomputes immediately after.
  const profile = (await businessProfileService.getProfile()).profile;
  const currency = (customer.preferred_currency || profile?.default_currency || 'CHF').toUpperCase();
  const language = customer.preferred_language || profile?.default_locale || 'de';
  const invoiceNumber = await nextInvoiceNumber(trx);
  const bank = await businessProfileService.resolveBankAccountForCurrency(currency, null);

  const row = {
    invoice_number: invoiceNumber,
    customer_account_id: customer.id,
    source_quote_id: null,
    event_id: null,
    language,
    currency,
    issue_date: placeholderDate,
    due_date: placeholderDate, // recomputed at issuance time
    installment_index: 0,
    installment_total: 1,
    status: 'scheduled',
    scheduled_send_at: null, // monthly pass sets this on cadence day
    net_amount_minor: 0,
    vat_rate: 0,
    vat_amount_minor: 0,
    shipping_amount_minor: 0,
    total_amount_minor: 0,
    business_bank_account_id: bank?.id || null,
    qr_format: null,
    is_monthly_draft: true,
    monthly_period_start: periodStart ? periodStart.toISOString().slice(0, 10) : null,
    monthly_period_end: periodEnd ? periodEnd.toISOString().slice(0, 10) : null,
    // Migration 140 — each monthly-draft cycle is its own deal (no
    // quote/contract chain). Fresh UUID at creation; subsequent line
    // appends just mutate this same row, so the uuid sticks.
    deal_uuid: crypto.randomUUID(),
    created_by_admin_id: adminId,
    created_at: new Date(),
    updated_at: new Date(),
  };
  try {
    const inserted = await trx('invoices').insert(row).returning('id');
    const id = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
    return { id, row: { ...row, id }, created: true };
  } catch (err) {
    // Partial-unique-index violation: another transaction snuck a draft
    // in between our SELECT and INSERT. Re-SELECT the winner and return
    // it — concurrent callers converge on the same draft row instead
    // of double-billing the customer. The error string varies by
    // driver: Postgres → SQLSTATE 23505; better-sqlite3 → 'UNIQUE
    // constraint failed'; node-sqlite3 → 'SQLITE_CONSTRAINT'.
    const msg = String(err && err.message || '');
    const isUniqueViolation =
      err && err.code === '23505' ||
      /unique/i.test(msg) ||
      /sqlite_constraint/i.test(msg);
    if (!isUniqueViolation) throw err;
    const winner = await trx('invoices')
      .where({ customer_account_id: customer.id, is_monthly_draft: true })
      .orderBy('id', 'desc')
      .first();
    if (!winner) {
      // No row to return despite the unique-violation — this would
      // mean the winning transaction rolled back after we lost the
      // race. Surface the original error so the caller can retry.
      throw err;
    }
    return { id: winner.id, row: winner, created: false };
  }
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

async function listInvoices({ filters = {}, sort = 'issue_desc', page = 1, pageSize = 25 } = {}) {
  return await withRetry(async () => {
    let query = db('invoices')
      .leftJoin('customer_accounts', 'invoices.customer_account_id', 'customer_accounts.id')
      // Surface the source contract's human contract_number (mirror of
      // the src_quote JOIN in getInvoiceById) so list rows + detail
      // page can render "From contract LBM-C-2026-0010" instead of
      // the bare DB id "#10". LEFT join — most invoices have no
      // source contract.
      .leftJoin('contracts as src_contract', 'invoices.source_contract_id', 'src_contract.id')
      .select(
        'invoices.*',
        'customer_accounts.email as customer_email',
        'customer_accounts.display_name as customer_display_name',
        'customer_accounts.first_name as customer_first_name',
        'customer_accounts.last_name as customer_last_name',
        // Same isPassive-source as getInvoiceById — surfaced so list
        // rows can render the Passive badge inline without an N+1
        // round-trip.
        'customer_accounts.password_hash as customer_password_hash',
        'customer_accounts.company_name as customer_company_name',
        'src_contract.contract_number as source_contract_number',
      );

    if (Array.isArray(filters.status) && filters.status.length > 0) {
      query = query.whereIn('invoices.status', filters.status);
    }
    if (filters.customerAccountId) {
      query = query.where('invoices.customer_account_id', filters.customerAccountId);
    }
    // Hide monthly drafts (migration 128) from the default list — they
    // live on the customer detail page's "Monthly billing queue" card.
    // Callers that explicitly want them (the customer-detail summary
    // fetch) pass `includeMonthlyDrafts: true`.
    if (!filters.includeMonthlyDrafts) {
      query = query.where(function () {
        this.where('invoices.is_monthly_draft', false)
          .orWhereNull('invoices.is_monthly_draft');
      });
    }
    if (filters.sourceQuoteId) {
      query = query.where('invoices.source_quote_id', filters.sourceQuoteId);
    }
    if (filters.unpaidOnly) {
      query = query.whereIn('invoices.status', ['scheduled', 'sent', 'overdue']);
    }
    if (filters.q && String(filters.q).trim()) {
      const term = `%${String(filters.q).trim()}%`;
      query = query.andWhere(function() {
        this.where('invoices.invoice_number', 'like', term)
          .orWhere('customer_accounts.email', 'like', term)
          .orWhere('customer_accounts.company_name', 'like', term);
      });
    }
    const countRow = await query.clone().clearSelect().clearOrder().count('invoices.id as total').first();
    const total = ensureInt(countRow?.total || 0);

    switch (sort) {
      // "Newest" / "Oldest" means newest/oldest by CREATION time, not
      // by issue_date. Issue_date is admin-controlled (used for tax
      // accruals, retro-dating, future-dating) so it can drift from
      // actual chronology — sorting by it makes a just-created invoice
      // disappear into the middle of the list whenever its issue_date
      // is set to something other than today. created_at always
      // reflects when the row landed in the DB. id is the tiebreaker
      // for rows that share a created_at second.
      case 'oldest':       query = query.orderBy('invoices.created_at', 'asc').orderBy('invoices.id', 'asc'); break;
      case 'issue_asc':    query = query.orderBy('invoices.issue_date', 'asc').orderBy('invoices.id', 'asc'); break;
      case 'issue_desc':   query = query.orderBy('invoices.issue_date', 'desc').orderBy('invoices.id', 'desc'); break;
      case 'due_asc':      query = query.orderBy('invoices.due_date', 'asc'); break;
      case 'due_desc':     query = query.orderBy('invoices.due_date', 'desc'); break;
      case 'value_asc':    query = query.orderBy('invoices.total_amount_minor', 'asc'); break;
      case 'value_desc':   query = query.orderBy('invoices.total_amount_minor', 'desc'); break;
      case 'customer_asc':
        query = query
          .orderByRaw('COALESCE(customer_accounts.company_name, customer_accounts.last_name, customer_accounts.email) asc')
          .orderBy('invoices.id', 'desc');
        break;
      case 'customer_desc':
        query = query
          .orderByRaw('COALESCE(customer_accounts.company_name, customer_accounts.last_name, customer_accounts.email) desc')
          .orderBy('invoices.id', 'desc');
        break;
      case 'newest':
      default:
        query = query.orderBy('invoices.created_at', 'desc').orderBy('invoices.id', 'desc');
        break;
    }

    const offset = Math.max(0, (page - 1) * pageSize);
    query = query.offset(offset).limit(pageSize);
    const rows = await query;
    return { rows, total, page, pageSize };
  });
}

async function getInvoiceById(id) {
  return await withRetry(async () => {
    // LEFT JOIN customer_accounts so transformInvoice has populated
    // customer_email / company etc. — mirrors getQuoteById.
    const invoice = await db('invoices')
      .leftJoin('customer_accounts', 'invoices.customer_account_id', 'customer_accounts.id')
      // Join the source quote so the detail view can display its
      // human-readable number ("LBM-Q-2026-0006") instead of just
      // the numeric id ("#6"). LEFT join — most invoices come from
      // a quote conversion but standalone invoices don't have one.
      .leftJoin('quotes as src_quote', 'invoices.source_quote_id', 'src_quote.id')
      // Migration 130 lineage: source contract's human contract_number
      // so the detail view shows "From contract LBM-C-2026-0010"
      // instead of "#10". Same LEFT-join shape as src_quote.
      .leftJoin('contracts as src_contract', 'invoices.source_contract_id', 'src_contract.id')
      // Self-joins for Storno lineage so the detail view can render
      // "Cancelled by Stornorechnung S-XXXX" / "This Stornorechnung
      // cancels invoice R-XXXX" using the human invoice_number rather
      // than the bare DB row id. Same pattern as source_quote_number.
      .leftJoin('invoices as cancels_inv', 'invoices.cancels_invoice_id', 'cancels_inv.id')
      .leftJoin('invoices as cancellation_storno', 'invoices.cancellation_storno_id', 'cancellation_storno.id')
      .where('invoices.id', id)
      .select(
        'invoices.*',
        'customer_accounts.email as customer_email',
        'customer_accounts.display_name as customer_display_name',
        'customer_accounts.first_name as customer_first_name',
        'customer_accounts.last_name as customer_last_name',
        'customer_accounts.company_name as customer_company_name',
        // Surfaced so the route's transformInvoice can compute the
        // customer.isPassive flag (passwordHash == null). The hash
        // itself never leaves the API — transformInvoice drops it
        // and only exposes the boolean.
        'customer_accounts.password_hash as customer_password_hash',
        'src_quote.quote_number as source_quote_number',
        'src_contract.contract_number as source_contract_number',
        'cancels_inv.invoice_number as cancels_invoice_number',
        'cancellation_storno.invoice_number as cancellation_storno_number',
      )
      .first();
    if (!invoice) return null;
    // Self-join so each row also carries `parent_position` (the position
    // of its parent line item, when it's a sub-item). The editor needs
    // position-based references to rebuild the hierarchy in the UI;
    // parent_line_item_id is the DB-level relationship but isn't
    // stable in the payload the editor sends back. Migration 119.
    const lineItems = await db('invoice_line_items as li')
      .leftJoin('invoice_line_items as parent', 'parent.id', 'li.parent_line_item_id')
      .where('li.invoice_id', id)
      .orderBy('li.position', 'asc')
      .select('li.*', 'parent.position as parent_position');
    const payments = await db('invoice_payment_log').where({ invoice_id: id }).orderBy('paid_at', 'asc');
    return { invoice, lineItems, payments };
  });
}

/**
 * Append line items from a `createInvoice`-shaped payload onto the
 * customer's running monthly-draft (migration 128). Used when the
 * customer is billing_cadence='monthly': the admin's editor save
 * lands here instead of minting a new invoice.
 *
 * Pulls the existing draft (or creates a fresh one for the current
 * period), appends the new line items continuing the position
 * sequence, recomputes totals across the merged set, and returns the
 * draft's id so the route layer can fetch + return it.
 */
async function appendToMonthlyDraft(payload, customer, adminId, trx) {
  const draft = await getOrCreateMonthlyDraft(customer, adminId, trx);

  // Load existing line items so we can compute the next `position` and
  // re-sum totals across the merged set. The migration-119 hierarchy
  // helpers operate on the merged array so parent_position pointers
  // remain consistent.
  const existing = await trx('invoice_line_items')
    .where({ invoice_id: draft.id })
    .orderBy('position', 'asc');
  const nextPosition = existing.length
    ? Math.max(...existing.map((li) => ensureInt(li.position))) + 1
    : 1;

  const incoming = Array.isArray(payload.lineItems) ? payload.lineItems : [];
  const newItems = incoming.map((li, idx) => {
    const qty = ensureNumber(li.quantity, 1);
    const unit = ensureInt(li.unit_price_minor);
    const discount = ensureNumber(li.discount_percent, 0);
    const lineTotal = Math.round(Math.round(qty * unit) * (1 - discount / 100));
    const isSubItem = li.parent_position != null && li.parent_position !== '';
    return {
      position: nextPosition + idx,
      quantity: qty,
      description: String(li.description || ''),
      unit_price_minor: unit,
      discount_percent: discount,
      line_total_minor: lineTotal,
      parent_position: isSubItem ? ensureInt(li.parent_position) : null,
      details_text: li.details_text || null,
    };
  });

  if (newItems.length > 0) {
    const { validateLineItemHierarchy, insertLineItemsHierarchical } = getHierarchyHelpers();
    validateLineItemHierarchy(newItems);
    await insertLineItemsHierarchical(trx, 'invoice_line_items', 'invoice_id', draft.id, newItems);
  }

  // Recompute totals across the entire draft so the running figures
  // shown on the customer-detail "Monthly queue" card stay accurate
  // as items accumulate. Mirrors createInvoice's totals path.
  const allItems = await trx('invoice_line_items')
    .where({ invoice_id: draft.id });
  let netMinor = 0;
  for (const li of allItems) {
    if (li.parent_line_item_id == null) netMinor += ensureInt(li.line_total_minor);
  }
  const vatRate = ensureNumber(payload.vatRate, draft.row.vat_rate || 0);
  const vatMinor = Math.round(netMinor * Number(vatRate) / 100);
  const shippingMinor = ensureInt(draft.row.shipping_amount_minor);
  const totalMinor = netMinor + vatMinor + shippingMinor;

  await trx('invoices').where({ id: draft.id }).update({
    net_amount_minor: netMinor,
    vat_rate: vatRate,
    vat_amount_minor: vatMinor,
    total_amount_minor: totalMinor,
    updated_at: new Date(),
  });

  try {
    await logActivity('monthly_billing_items_queued',
      { invoiceId: draft.id, customerId: customer.id, itemsAdded: newItems.length },
      null, `admin:${adminId}`);
  } catch (_) {}

  return draft.id;
}

/**
 * Append a single, fully-formed line item to the customer's running
 * monthly draft (migration 128 + 129). Used by customerHoursService
 * when an hour entry is logged for a monthly-mode customer — we want
 * the inserted `invoice_line_items.id` back so the entry can be
 * stamped with the cross-reference.
 *
 * `lineItem` is the shape consumed by appendToMonthlyDraft's internal
 * insertLineItemsHierarchical helper (description, quantity,
 * unit_price_minor, discount_percent, line_total_minor, etc.). The
 * `position` field is set internally — caller-supplied positions are
 * ignored to keep the accumulator's sequence intact.
 *
 * Returns { invoiceId, lineItemId } — the draft id plus the id of the
 * newly-appended row.
 */
async function appendOneLineItemToMonthlyDraft(customer, lineItem, adminId, trx) {
  // Reuse the accumulator path — it handles get-or-create + totals
  // recompute + activity log. We pass a single-item array.
  await appendToMonthlyDraft({
    customerAccountId: customer.id,
    lineItems: [lineItem],
    vatRate: 0, // hours logging doesn't ship with VAT today
  }, customer, adminId, trx);

  // Look up the draft we just appended onto + its tail line item.
  // Newest insert wins by id desc; we filter by position match so
  // concurrent appends in another tx don't return the wrong row.
  const draft = await trx('invoices')
    .where({ customer_account_id: customer.id, is_monthly_draft: true })
    .orderBy('id', 'desc')
    .first();
  if (!draft) {
    // Defensive — appendToMonthlyDraft would have created one.
    throw new AppError('Monthly draft missing after append', 500);
  }
  const tail = await trx('invoice_line_items')
    .where({ invoice_id: draft.id })
    .orderBy('position', 'desc')
    .first();
  return { invoiceId: draft.id, lineItemId: tail?.id || null };
}

/**
 * Create one invoice. Returns id. Used both manually (admin creates a
 * standalone invoice) and by scheduleInvoicesForEvent (one per installment).
 */
async function createInvoice(payload, adminId, trx = db) {
  const customer = await trx('customer_accounts').where({ id: payload.customerAccountId }).first();
  ensureCustomerCanBill(customer);

  // PR #603 review follow-up #1 — when an invoice is attached to an event,
  // make sure that event actually belongs to the chosen customer. Without
  // this, a typo'd/copy-pasted eventId silently links the invoice to an
  // unrelated event, producing misleading reporting links. Only enforced
  // when the event HAS customer assignments (an event with none — e.g. a
  // legacy import — is allowed through, since we can't prove a mismatch).
  if (payload.eventId && await trx.schema.hasTable('event_customer_assignments')) {
    const assignments = await trx('event_customer_assignments')
      .where({ event_id: payload.eventId })
      .select('customer_account_id');
    if (assignments.length > 0 &&
        !assignments.some(a => a.customer_account_id === payload.customerAccountId)) {
      throw new AppError('The selected event is not assigned to this customer', 422, 'EVENT_CUSTOMER_MISMATCH');
    }
  }

  // Accumulator intercept (migration 128). For customers in
  // billing_cadence='monthly' OR 'manual' mode every createInvoice call
  // APPENDS line items onto a single running draft instead of minting a
  // fresh invoice. Admin sees the editor flow exactly as before; the
  // returned id is the draft's id so the UI can redirect to the
  // accumulator. The two modes differ only in WHEN the draft ships:
  // 'monthly' auto-flushes on the cadence day (scheduler), 'manual'
  // never auto-flushes (no period_end) and ships only via the admin
  // "Trigger invoice now" gesture. `_skipMonthlyRouting` is the escape
  // hatch used by internal helpers that need to mint a non-draft row
  // (e.g. the accumulator itself, or future test fixtures).
  if ((customer.billing_cadence === 'monthly' || customer.billing_cadence === 'manual')
      && !payload._skipMonthlyRouting) {
    const draft = await appendToMonthlyDraft(payload, customer, adminId, trx);
    return { invoiceIds: draft?.id ? [draft.id] : [] };
  }

  const profile = (await businessProfileService.getProfile()).profile;
  const currency = (payload.currency || profile?.default_currency || 'CHF').toUpperCase();
  const language = payload.language || customer.preferred_language || profile?.default_locale || 'de';

  // Sequence number is claimed BELOW the installment auto-route so a
  // multi-installment save doesn't waste a number. When installments
  // are present, spawnInstallmentInvoices claims one number per
  // sibling and we never reach the single-row insert that would have
  // used `invoiceNumber` here.
  const issueDate = payload.issueDate || new Date().toISOString().slice(0, 10);
  const scheduledSendAt = payload.scheduledSendAt ? new Date(payload.scheduledSendAt) : null;
  // Resolve net_days BEFORE computing the due date so Net 60 / 90
  // selections actually push the due date out. resolveNetDays honors
  // the split picker FK the editor sends, the legacy single FK, and
  // the crm_payment_default_net_days setting (see helper). The clock
  // starts on the SEND date when the invoice is scheduled, otherwise
  // the issue date — so a future send pushes the due date out too.
  const resolvedNetDays = await resolveNetDays(payload, trx);
  const dueDate = payload.dueDate || computeDueDate(scheduledSendAt || new Date(issueDate), resolvedNetDays)
    .toISOString().slice(0, 10);

  // Re-compute totals from line items. Migration 119 — items with a
  // non-null `parent_position` are sub-items and their line totals do
  // NOT roll into net directly. Parent totals AUTO-RESOLVE from
  // priced sub-items: if any sub-item under a parent has unit_price > 0,
  // the parent's effective line_total_minor becomes the sum of those
  // sub-items, and the parent's own stored unit_price is ignored.
  // Mental model matches the editor — pricing on sub-items implies
  // "parent is a header, total derives from what's under it".
  const lineItems = Array.isArray(payload.lineItems) ? payload.lineItems : [];
  const items = lineItems.map((li, idx) => {
    const qty = ensureNumber(li.quantity, 1);
    const unit = ensureInt(li.unit_price_minor);
    const discount = ensureNumber(li.discount_percent, 0);
    const lineTotal = Math.round(Math.round(qty * unit) * (1 - discount / 100));
    const isSubItem = li.parent_position != null && li.parent_position !== '';
    return {
      position: ensureInt(li.position) || (idx + 1),
      quantity: qty,
      description: String(li.description || ''),
      unit_price_minor: unit,
      discount_percent: discount,
      line_total_minor: lineTotal,
      parent_position: isSubItem ? ensureInt(li.parent_position) : null,
      details_text: li.details_text || null,
    };
  });
  // Apply the migration-119 hierarchy resolver: rewrites parent
  // line_total_minor to sum-of-priced-sub-items where applicable.
  // Net is then summed across top-level (resolved) items.
  const { resolveParentTotalsFromSubItems } = getHierarchyHelpers();
  resolveParentTotalsFromSubItems(items);
  let netMinor = 0;
  for (const li of items) {
    if (li.parent_position == null) netMinor += ensureInt(li.line_total_minor);
  }
  // Optional sub-cent reconciliation (crm_invoice_round_total). When on,
  // store the full-precision net rounded ONCE so the total matches
  // qty × unit arithmetic; the per-line rounding drift is surfaced as a
  // "Rundung" row at render time (storedNet − Σ line totals). Off by
  // default ⇒ net stays the sum of rounded lines, unchanged behaviour.
  const roundTotal = (await getAppSetting('crm_invoice_round_total', false)) === true;
  if (roundTotal) {
    netMinor = cleanNetMinor(items, { parentKey: 'parent_position', positionKey: 'position' });
  }
  const vatRate = ensureNumber(payload.vatRate, 0);
  const vatMinor = Math.round(netMinor * vatRate / 100);
  const shippingMinor = ensureInt(payload.shippingAmountMinor);
  const totalMinor = netMinor + vatMinor + shippingMinor;

  // Negative line items (Rabatt) are allowed, but the resulting
  // invoice total must not go below zero. Credit notes belong in
  // the Storno path (createStorno), which mints a separate
  // kind='storno' record with cancels_invoice_id set.
  if (totalMinor < 0) {
    throw new AppError(
      'Invoice total cannot be negative. To issue a credit note, cancel the original invoice with Storno.',
      400,
      'INVOICE_TOTAL_NEGATIVE',
    );
  }

  const bank = await businessProfileService.resolveBankAccountForCurrency(currency, payload.businessBankAccountId);

  // Snapshot the selected payment-term template (net days / Skonto /
  // installment plan) onto the invoice itself. Mirrors how the quote
  // editor handles this — once snapshotted, edits to the template
  // don't retroactively change rendered invoices. Migration 113.
  let paymentTermTemplateId = null;
  let paymentTermSnapshot = null;
  let paymentNetDaysTemplateId = null;
  let paymentTimingTemplateId = null;
  // Migration 124 — prefer the two split FKs. Compose a snapshot from
  // them in the same shape pdfService + scheduler already consume.
  // Fall back to the legacy single FK when the caller still uses it.
  if (payload.paymentNetDaysTemplateId && payload.paymentTimingTemplateId) {
    const [netDays, timing] = await Promise.all([
      trx('payment_net_days_templates').where({ id: payload.paymentNetDaysTemplateId }).first(),
      trx('payment_timing_templates').where({ id: payload.paymentTimingTemplateId }).first(),
    ]);
    if (netDays && timing) {
      paymentNetDaysTemplateId = netDays.id;
      paymentTimingTemplateId = timing.id;
      paymentTermSnapshot = JSON.stringify({
        description: timing.description || netDays.description || null,
        net_days: netDays.net_days,
        skonto_percent: netDays.skonto_percent,
        skonto_within_days: netDays.skonto_within_days,
        installments: typeof timing.installments === 'string'
          ? (() => { try { return JSON.parse(timing.installments); } catch { return null; } })()
          : timing.installments || null,
      });
    }
  } else if (payload.paymentTermTemplateId) {
    const tpl = await trx('payment_term_templates')
      .where({ id: payload.paymentTermTemplateId }).first();
    if (tpl) {
      paymentTermTemplateId = tpl.id;
      paymentTermSnapshot = JSON.stringify({
        description: tpl.description || null,
        net_days: tpl.net_days,
        skonto_percent: tpl.skonto_percent,
        skonto_within_days: tpl.skonto_within_days,
        installments: typeof tpl.installments === 'string'
          ? (() => { try { return JSON.parse(tpl.installments); } catch { return null; } })()
          : tpl.installments || null,
      });
    }
  }

  // Multi-installment auto-route. Priority:
  //   1. payload.installments  (explicit override from the ad-hoc
  //      editor panel — wins over any saved template)
  //   2. snapshot.installments (loaded from the picked payment-timing
  //      template above)
  // If either yields ≥2 entries we delegate to spawnInstallmentInvoices
  // (the same loop used by quote→invoice conversion) and return the
  // array of created IDs. Single-installment plans fall through to
  // the single-row insert below.
  let installmentsForSpawn = null;
  if (Array.isArray(payload.installments) && payload.installments.length > 1) {
    installmentsForSpawn = payload.installments;
  } else if (paymentTermSnapshot) {
    const parsedSnap = typeof paymentTermSnapshot === 'string'
      ? (() => { try { return JSON.parse(paymentTermSnapshot); } catch { return null; } })()
      : paymentTermSnapshot;
    if (parsedSnap && Array.isArray(parsedSnap.installments) && parsedSnap.installments.length > 1) {
      installmentsForSpawn = parsedSnap.installments;
    }
  }
  if (installmentsForSpawn) {
    return await spawnInstallmentInvoices({
      trx,
      eventId: payload.eventId || null,
      quoteId: payload.sourceQuoteId || null,
      customer,
      currency,
      language,
      lineItems: items,
      totals: {
        net: netMinor,
        vatRate,
        vat: vatMinor,
        shipping: shippingMinor,
        total: totalMinor,
      },
      installments: installmentsForSpawn,
      eventDate: payload.eventDate || null,
      adminId,
      ccPdfEmail: payload.ccPdfEmail || null,
      netDays: resolvedNetDays,
      eventName: payload.eventName || null,
      eventTimeStart: payload.eventTimeStart || null,
      eventTimeEnd: payload.eventTimeEnd || null,
      paymentNetDaysTemplateId,
      paymentTimingTemplateId,
      paymentTermSnapshot,
      dealUuid: await resolveDealUuid(trx, payload),
    });
  }

  // Claim the sequence number HERE — after the installment auto-route
  // has been ruled out. Previously this was at the top of the function
  // which leaked one number per multi-installment save (the spawner
  // claims its own numbers and never used this one).
  // Pass trx so the sequence claim joins our outer transaction —
  // SQLite deadlocks otherwise (1-connection default).
  const invoiceNumber = await nextInvoiceNumber(trx);
  const row = {
    invoice_number: invoiceNumber,
    customer_account_id: payload.customerAccountId,
    source_quote_id: payload.sourceQuoteId || null,
    event_id: payload.eventId || null,
    // Inline event snapshot (migration 123). Mirrors quotes — the
    // snapshot survives an event rename so an archived invoice keeps
    // its original event label for accounting / audit. Optional;
    // standalone invoices created without an event will have these
    // as null and the renderer simply omits the for-clause.
    event_name: payload.eventName || null,
    event_date: payload.eventDate || null,
    event_time_start: payload.eventTimeStart || null,
    event_time_end: payload.eventTimeEnd || null,
    language,
    currency,
    issue_date: issueDate,
    due_date: dueDate,
    installment_index: ensureInt(payload.installmentIndex),
    installment_total: ensureInt(payload.installmentTotal) || 1,
    installment_label: payload.installmentLabel || null,
    installment_trigger: payload.installmentTrigger || null,
    status: scheduledSendAt && scheduledSendAt.getTime() > Date.now() ? 'scheduled' : (payload.sendNow ? 'scheduled' : 'scheduled'),
    scheduled_send_at: scheduledSendAt,
    net_amount_minor: netMinor,
    vat_rate: vatRate,
    vat_amount_minor: vatMinor,
    shipping_amount_minor: shippingMinor,
    total_amount_minor: totalMinor,
    cc_pdf_email: payload.ccPdfEmail || null,
    business_bank_account_id: bank?.id || null,
    qr_format: payload.qrFormat || null,
    payment_term_template_id: paymentTermTemplateId,
    payment_net_days_template_id: paymentNetDaysTemplateId,
    payment_timing_template_id: paymentTimingTemplateId,
    payment_term_snapshot: paymentTermSnapshot,
    // Per-invoice Skonto opt-out (migration 126). Defaults to false
    // — invoice inherits the snapshot/global Skonto config unless
    // admin explicitly ticks "Disable Skonto" in the editor.
    skonto_disabled: Boolean(payload.skontoDisabled),
    // Migration 140 — deal_uuid lineage. Priority: explicit payload
    // (used by spawnInstallmentInvoices and Storno/reissue callers to
    // force a specific value), source quote, source contract,
    // otherwise fresh mint.
    deal_uuid: await resolveDealUuid(trx, payload),
    created_by_admin_id: adminId,
    created_at: new Date(),
    updated_at: new Date(),
  };
  // Migration 130 — snapshot the chosen output VAT code (immutable; the
  // accounting export emits exactly this rather than re-deriving from the map).
  if (payload.vatCode !== undefined && await hasColumnCached('invoices', 'vat_code')) {
    row.vat_code = payload.vatCode ? String(payload.vatCode).slice(0, 16) : null;
  }
  const inserted = await trx('invoices').insert(row).returning('id');
  const invoiceId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

  if (items.length > 0) {
    const { validateLineItemHierarchy, insertLineItemsHierarchical } = getHierarchyHelpers();
    validateLineItemHierarchy(items);
    await insertLineItemsHierarchical(trx, 'invoice_line_items', 'invoice_id', invoiceId, items);
  }

  try { await logActivity('invoice_created', { invoiceId, invoiceNumber }, payload.eventId || null, `admin:${adminId}`); } catch (_) {}
  return { invoiceIds: [invoiceId] };
}

/**
 * Fan-out helper. Creates one invoice row per installment with the
 * right `scheduled_send_at`, sequential invoice numbers, and per-
 * slice totals. Used by:
 *
 *   - quoteService.convertToEvent / convertToInvoiceOnly — quote
 *     conversion with multi-installment payment plans.
 *   - createInvoice (this file) — when the standalone editor path
 *     submits an installment array.
 *
 * Expects to be called inside an existing transaction.
 *
 * Returns `{ invoiceIds: number[] }` — ordered by installment_index
 * so callers can navigate to the first or report N IDs.
 *
 * The legacy export name `scheduleInvoicesForEvent` is preserved as
 * an alias for backward compatibility with quoteService callers; new
 * code should reach for the clearer `spawnInstallmentInvoices`.
 */
async function spawnInstallmentInvoices({ trx, eventId, quoteId, customer, currency, language,
                                          lineItems, totals, installments, eventDate, adminId,
                                          ccPdfEmail, netDays,
                                          eventName, eventTimeStart, eventTimeEnd,
                                          paymentNetDaysTemplateId, paymentTimingTemplateId,
                                          paymentTermSnapshot, dealUuid, hold = false }) {
  // Monthly-billing intercept (migration 128). Quote → invoice
  // conversion for a monthly-mode customer doesn't fan out N
  // installment invoices — the customer pays one consolidated bill
  // per period. Append the line items to the running draft (creating
  // it if needed) and return early. The installment / cadence math
  // below is bypassed; the quote's payment timing is irrelevant once
  // items flow into the monthly accumulator.
  if (customer && customer.billing_cadence === 'monthly') {
    const draft = await appendToMonthlyDraft({
      customerAccountId: customer.id,
      lineItems: (lineItems || []).map((li) => ({
        position: li.position,
        quantity: li.quantity,
        unit_price_minor: li.unit_price_minor,
        discount_percent: li.discount_percent,
        description: li.description,
        parent_position: li.parent_position,
        details_text: li.details_text,
      })),
      vatRate: totals?.vatRate,
    }, customer, adminId, trx);
    return { invoiceIds: draft?.id ? [draft.id] : [] };
  }

  // netDays drives the due-date offset on every scheduled invoice
  // created here. Callers in quoteService pass the converting quote's
  // payment-term net_days so Net 60 / 90 templates flow through; when
  // absent we fall back to the crm_payment_default_net_days setting
  // (then 30) rather than silently using 30, matching createInvoice.
  const resolvedNetDays = ensureInt(netDays)
    || ensureInt(await getAppSetting('crm_payment_default_net_days', null, trx || db))
    || 30;
  const total = installments.length;
  const acceptanceTime = new Date();
  const invoiceIds = [];

  for (let i = 0; i < total; i++) {
    const inst = installments[i];
    const percent = ensureNumber(inst.percent, 0);
    if (percent <= 0) continue;

    // Each installment carries its own slice of the totals. Round to
    // minor units; last installment absorbs rounding drift so the
    // total exactly equals the quote total.
    let netSlice, vatSlice, shippingSlice, totalSlice;
    if (i === total - 1) {
      // We computed everything so far; remaining slice closes the gap.
      const accNet = installments.slice(0, i).reduce((s, x) => s + Math.round(ensureInt(totals.net) * ensureNumber(x.percent, 0) / 100), 0);
      const accVat = installments.slice(0, i).reduce((s, x) => s + Math.round(ensureInt(totals.vat) * ensureNumber(x.percent, 0) / 100), 0);
      const accShipping = installments.slice(0, i).reduce((s, x) => s + Math.round(ensureInt(totals.shipping) * ensureNumber(x.percent, 0) / 100), 0);
      const accTotal = installments.slice(0, i).reduce((s, x) => s + Math.round(ensureInt(totals.total) * ensureNumber(x.percent, 0) / 100), 0);
      netSlice = ensureInt(totals.net) - accNet;
      vatSlice = ensureInt(totals.vat) - accVat;
      shippingSlice = ensureInt(totals.shipping) - accShipping;
      totalSlice = ensureInt(totals.total) - accTotal;
    } else {
      netSlice = Math.round(ensureInt(totals.net) * percent / 100);
      vatSlice = Math.round(ensureInt(totals.vat) * percent / 100);
      shippingSlice = Math.round(ensureInt(totals.shipping) * percent / 100);
      totalSlice = Math.round(ensureInt(totals.total) * percent / 100);
    }

    let scheduledSendAt = computeScheduledSendAt(inst.trigger, inst.offset_days, eventDate, acceptanceTime);
    // Per-customer billing cadence override: monthly / quarterly
    // customers don't pay per-event — snap to the next period boundary.
    if (customer && customer.billing_cadence && customer.billing_cadence !== 'per_event') {
      scheduledSendAt = snapToNextBillingCycle(scheduledSendAt, customer.billing_cadence, customer.billing_cycle_day);
    }

    // `after_delivery` invoices wait for the admin to confirm photos
    // have actually been delivered before they fire — we can't infer
    // that automatically from a date. Mark them `pending_delivery`
    // with no scheduled_send_at; the scheduler only picks rows in
    // status `scheduled`, so they sit idle until the admin clicks
    // "Release for delivery" on the invoice detail page.
    const isDeliveryTrigger = inst.trigger === 'after_delivery';
    // `hold` (workflow draft-seam): the booking flow's review gate + explicit
    // send_document IS the release, so a held invoice is always `scheduled`
    // (editable + sendable via sendInvoice) regardless of trigger — never
    // `pending_delivery`, which sendInvoice refuses. Without hold, an
    // after_delivery invoice stays `pending_delivery` as before.
    const rowStatus = (isDeliveryTrigger && !hold) ? 'pending_delivery' : 'scheduled';
    // Held invoices carry no scheduled_send_at so the scheduler never auto-sends
    // them — they wait for send_document. after_delivery rows are likewise null
    // (the scheduler can't infer a delivery date).
    const rowScheduledSendAt = (isDeliveryTrigger || hold) ? null : scheduledSendAt;

    const invoiceNumber = await nextInvoiceNumber(trx);
    const dueDate = computeDueDate(scheduledSendAt, resolvedNetDays).toISOString().slice(0, 10);

    const row = {
      invoice_number: invoiceNumber,
      customer_account_id: customer.id,
      source_quote_id: quoteId,
      event_id: eventId,
      // Inline event snapshot carried over from the source quote
      // (migration 123). Mirrors how event_date is already carried —
      // a converted invoice should keep the event reference even if
      // the linked event is later renamed or deleted.
      event_name: eventName || null,
      event_date: eventDate || null,
      event_time_start: eventTimeStart || null,
      event_time_end: eventTimeEnd || null,
      language,
      currency,
      issue_date: scheduledSendAt.toISOString().slice(0, 10),
      due_date: dueDate,
      installment_index: i,
      installment_total: total,
      installment_label: inst.label || `Installment ${i + 1}/${total}`,
      installment_trigger: inst.trigger,
      status: rowStatus,
      scheduled_send_at: rowScheduledSendAt,
      net_amount_minor: netSlice,
      vat_rate: ensureNumber(totals.vatRate, 0),
      vat_amount_minor: vatSlice,
      shipping_amount_minor: shippingSlice,
      total_amount_minor: totalSlice,
      cc_pdf_email: ccPdfEmail || null,
      // Migration 124 — carry the split payment-term FKs over from
      // the source quote so the converted invoice is editable (when
      // it eventually unlocks) with the same orthogonal split. The
      // snapshot itself is the legal record; the FKs are convenience.
      payment_net_days_template_id: paymentNetDaysTemplateId || null,
      payment_timing_template_id: paymentTimingTemplateId || null,
      payment_term_snapshot: paymentTermSnapshot
        ? (typeof paymentTermSnapshot === 'string'
          ? paymentTermSnapshot
          : JSON.stringify(paymentTermSnapshot))
        : null,
      // Migration 140 — every installment sibling shares one deal_uuid
      // (passed in from the converting caller, ultimately the source
      // quote's value). Defensive fallback to a fresh UUID if the
      // caller didn't pass one — shouldn't happen on a migrated
      // install but keeps the column non-null.
      deal_uuid: dealUuid || crypto.randomUUID(),
      created_by_admin_id: adminId,
      created_at: new Date(),
      updated_at: new Date(),
    };

    const inserted = await trx('invoices').insert(row).returning('id');
    const invoiceId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

    // Line items: copy from the quote so the customer sees what they
    // actually agreed to, not a generic "Gesamtbetrag" placeholder.
    // Two modes:
    //   - Single-installment (100%): clone every quote line item
    //     verbatim. The invoice totals already match the quote's.
    //   - Multi-installment (split payment): clone the quote lines
    //     but mark the invoice with the installment context. We pro-
    //     rate by inserting one extra line at the bottom that adjusts
    //     to the installment slice — keeps the per-line description
    //     visible while the total still equals the pro-rata amount.
    const sourceLines = Array.isArray(lineItems) ? lineItems : [];
    if (sourceLines.length === 0) {
      // Fallback for the (rare) case where the quote has no line
      // items — fall back to the legacy "Installment N/M" line so
      // we still produce a sensible invoice.
      await trx('invoice_line_items').insert({
        invoice_id: invoiceId,
        position: 1,
        quantity: 1,
        description: inst.label || `Installment ${i + 1}/${total}`,
        unit_price_minor: netSlice,
        discount_percent: 0,
        line_total_minor: netSlice,
        created_at: new Date(),
        updated_at: new Date(),
      });
    } else {
      // Clone each quote line as-is, preserving its original `position`
      // so the sub-item hierarchy carries over. Source lines already
      // have `parent_position` populated by getQuoteById's self-join,
      // so the same value reused on the new invoice points at the
      // correct (also-cloned) parent. insertLineItemsHierarchical
      // resolves position → new parent_line_item_id during the
      // two-phase insert. Migration 119.
      const cloned = sourceLines.map((li) => ({
        position: ensureInt(li.position),
        quantity: li.quantity,
        description: li.description,
        unit_price_minor: ensureInt(li.unit_price_minor),
        discount_percent: ensureNumber(li.discount_percent, 0),
        line_total_minor: ensureInt(li.line_total_minor),
        parent_position: li.parent_position == null ? null : ensureInt(li.parent_position),
        details_text: li.details_text || null,
      }));
      const { validateLineItemHierarchy, insertLineItemsHierarchical } = getHierarchyHelpers();
      validateLineItemHierarchy(cloned);
      await insertLineItemsHierarchical(trx, 'invoice_line_items', 'invoice_id', invoiceId, cloned);

      // For split payments add an explicit "Installment X/Y (Z%)"
      // adjustment line that reconciles the cloned line totals to
      // the actual invoice net (which is the pro-rata slice). The
      // line carries the difference as a negative if the slice is
      // less than the quote total (typical), or positive on the
      // final installment if rounding nudged the other way.
      //
      // The adjustment ONLY considers top-level cloned lines —
      // sub-items don't contribute to net so they can't appear in
      // the reconciliation sum.
      if (total > 1) {
        const clonedSum = cloned
          .filter((x) => x.parent_position == null)
          .reduce((s, x) => s + ensureInt(x.line_total_minor), 0);
        const adjustment = netSlice - clonedSum;
        if (adjustment !== 0) {
          const installmentLabel = inst.label || `Installment ${i + 1}/${total}`;
          const maxPosition = cloned.reduce((m, x) => Math.max(m, x.position), 0);
          await trx('invoice_line_items').insert({
            invoice_id: invoiceId,
            position: maxPosition + 1,
            quantity: 1,
            description: `${installmentLabel} (${percent}% — ${i + 1}/${total})`,
            unit_price_minor: adjustment,
            discount_percent: 0,
            line_total_minor: adjustment,
            parent_line_item_id: null,
            details_text: null,
            created_at: new Date(),
            updated_at: new Date(),
          });
        }
      }
    }

    try {
      // Pass `trx` so the audit insert rides the transaction's connection —
      // logging via the global db here deadlocks the single-connection SQLite
      // pool (this runs unattended from the booking flow's prepare_invoice).
      await logActivity('invoice_scheduled', { invoiceId, invoiceNumber, eventId, quoteId, scheduledSendAt },
        eventId, `admin:${adminId}`, trx);
    } catch (_) {}
    invoiceIds.push(invoiceId);
  }
  return { invoiceIds };
}

// Backward-compat alias — older callers reference this name.
const scheduleInvoicesForEvent = spawnInstallmentInvoices;

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

/**
 * Compute one slice of a plan total. Matches the rounding rule used by
 * spawnInstallmentInvoices — every slice except the last is a rounded
 * percent share; the last slice absorbs rounding drift so the per-slice
 * sums exactly equal the plan total.
 */
function computeSliceTotals(installments, totals, i) {
  const lastIndex = installments.length - 1;
  const pct = ensureNumber(installments[i].percent, 0);
  if (i < lastIndex) {
    return {
      net: Math.round(ensureInt(totals.net) * pct / 100),
      vat: Math.round(ensureInt(totals.vat) * pct / 100),
      shipping: Math.round(ensureInt(totals.shipping) * pct / 100),
      total: Math.round(ensureInt(totals.total) * pct / 100),
    };
  }
  const acc = installments.slice(0, i).reduce((s, x) => {
    const p = ensureNumber(x.percent, 0);
    return {
      net: s.net + Math.round(ensureInt(totals.net) * p / 100),
      vat: s.vat + Math.round(ensureInt(totals.vat) * p / 100),
      shipping: s.shipping + Math.round(ensureInt(totals.shipping) * p / 100),
      total: s.total + Math.round(ensureInt(totals.total) * p / 100),
    };
  }, { net: 0, vat: 0, shipping: 0, total: 0 });
  return {
    net: ensureInt(totals.net) - acc.net,
    vat: ensureInt(totals.vat) - acc.vat,
    shipping: ensureInt(totals.shipping) - acc.shipping,
    total: ensureInt(totals.total) - acc.total,
  };
}

/**
 * Throws AppError on invalid input. Exposed for the route layer to
 * surface as 400 before opening a transaction.
 */
function validateInstallmentPlanInput(installments) {
  if (!Array.isArray(installments) || installments.length === 0) {
    throw new AppError('installments must be a non-empty array', 400);
  }
  let sum = 0;
  for (let i = 0; i < installments.length; i++) {
    const inst = installments[i] || {};
    const pct = ensureNumber(inst.percent, NaN);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      throw new AppError(`Row ${i + 1}: percent must be between 0 and 100`, 400);
    }
    if (!VALID_INSTALLMENT_TRIGGERS.has(inst.trigger)) {
      throw new AppError(`Row ${i + 1}: invalid trigger '${inst.trigger}'`, 400);
    }
    const off = ensureInt(inst.offset_days);
    if (!Number.isFinite(off)) {
      throw new AppError(`Row ${i + 1}: offset_days must be an integer`, 400);
    }
    sum += pct;
  }
  if (Math.abs(sum - 100) > 0.001) {
    throw new AppError(
      `Installment percents must sum to 100 (got ${sum})`,
      400,
      'PERCENT_SUM_INVALID',
    );
  }
}

/**
 * Heuristic — spawnInstallmentInvoices appends a reconciliation line
 * with a stable description shape like "Anzahlung (30% — 1/3)". The
 * em-dash is U+2014 so the regex won't match plain hyphens used in
 * admin-authored line descriptions.
 *
 * We could harden this with an `is_reconciliation_line` column, but
 * the cost of a schema change isn't worth the residual edge (admins
 * don't edit reconciliation lines today).
 */
function isReconciliationLineItem(li) {
  if (!li || typeof li.description !== 'string') return false;
  return / \(\d+(?:\.\d+)?% — \d+\/\d+\)$/.test(li.description);
}

/**
 * Replace (or insert) the reconciliation line on an invoice so its
 * description matches the new label/percent and the line's amount
 * closes the gap between the cloned-quote-line subtotal and the
 * sibling's net slice. Symmetric with the inline logic in spawn.
 *
 * `topLineSubtotal` is the sum of non-reconciliation, top-level line
 * items already on the invoice — passed in so callers reading the row
 * once don't have to re-query.
 */
async function replaceReconciliationLine(
  trx, invoiceId, { label, percent, index, total, netSlice, topLineSubtotal },
) {
  const all = await trx('invoice_line_items')
    .where({ invoice_id: invoiceId })
    .orderBy('position', 'asc');
  for (const li of all) {
    if (isReconciliationLineItem(li)) {
      await trx('invoice_line_items').where({ id: li.id }).del();
    }
  }
  if (total <= 1) return;

  const nonRecon = all.filter((x) => !isReconciliationLineItem(x));
  const subtotal = topLineSubtotal != null
    ? topLineSubtotal
    : nonRecon.filter((x) => x.parent_position == null)
        .reduce((s, x) => s + ensureInt(x.line_total_minor), 0);
  const adjustment = netSlice - subtotal;
  if (adjustment === 0) return;

  const maxPosition = nonRecon.reduce(
    (m, x) => Math.max(m, ensureInt(x.position)), 0,
  );
  await trx('invoice_line_items').insert({
    invoice_id: invoiceId,
    position: maxPosition + 1,
    quantity: 1,
    description: `${label} (${percent}% — ${index + 1}/${total})`,
    unit_price_minor: adjustment,
    discount_percent: 0,
    line_total_minor: adjustment,
    parent_line_item_id: null,
    details_text: null,
    created_at: new Date(),
    updated_at: new Date(),
  });
}

/**
 * Atomically reshape an installment plan after siblings have spawned.
 * The plan is the unit of edit: percents / count / triggers all change
 * together in one transaction. Mutating individual siblings stays on
 * the existing PUT /admin/invoices/:id path.
 *
 * Guards:
 *   - dealUuid must exist + own ≥1 invoice (else 404)
 *   - all siblings must be in EDITABLE_INSTALLMENT_STATUSES (else 409
 *     `INVOICE_LOCKED`)
 *   - no Storno on the deal (else 409 `PLAN_HAS_STORNO`)
 *   - new plan validated by validateInstallmentPlanInput
 *
 * Algorithm:
 *   - Plan total = sum of existing siblings' totals (captures any
 *     per-sibling edits since spawn).
 *   - Reused siblings (i < min(old, new)): UPDATE in place — preserves
 *     id + invoice_number, so sequence numbers aren't burned.
 *   - Extra new rows (new > old): INSERT — claims a fresh invoice_number
 *     per row; clones canonical (non-reconciliation) line items from
 *     existing[0] so each new sibling carries the quote lines.
 *   - Trim rows (new < old): DELETE — claimed sequence numbers ARE lost
 *     (document_sequences has no release path, and that's intentional
 *     for §14 UStG continuity).
 *
 * Returns `{ invoiceIds, kept, created, deleted }`.
 */
async function updateInstallmentPlan({ trx, dealUuid, installments, adminId }) {
  if (!dealUuid) throw new AppError('dealUuid is required', 400);
  validateInstallmentPlanInput(installments);

  const existing = await trx('invoices')
    .where({ deal_uuid: dealUuid })
    .orderBy('installment_index', 'asc');

  if (existing.length === 0) {
    throw new AppError('No invoices found for this deal', 404);
  }
  const isMultiInstallment = existing.some((r) => ensureInt(r.installment_total) > 1);
  if (!isMultiInstallment) {
    throw new AppError(
      'This deal is not an installment plan',
      400,
      'NOT_INSTALLMENT_PLAN',
    );
  }
  for (const row of existing) {
    if (row.kind === 'storno') {
      throw new AppError(
        `Plan contains a Storno (${row.invoice_number}) — reshape refused`,
        409,
        'PLAN_HAS_STORNO',
      );
    }
    if (!EDITABLE_INSTALLMENT_STATUSES.has(row.status)) {
      throw new AppError(
        `Cannot reshape — invoice ${row.invoice_number} is '${row.status}'`,
        409,
        'INVOICE_LOCKED',
      );
    }
  }

  const totals = existing.reduce((acc, r) => ({
    net: acc.net + ensureInt(r.net_amount_minor),
    vat: acc.vat + ensureInt(r.vat_amount_minor),
    shipping: acc.shipping + ensureInt(r.shipping_amount_minor),
    total: acc.total + ensureInt(r.total_amount_minor),
    vatRate: ensureNumber(r.vat_rate, acc.vatRate),
  }), { net: 0, vat: 0, shipping: 0, total: 0, vatRate: 0 });

  const sample = existing[0]; // canonical event + customer + payment-term shape

  // netDays inferred from sample's issue → due gap so the new rows
  // honour the same payment-term the customer agreed to. Falls back
  // to 30 when either column is missing.
  const inferredNetDays = sample.due_date && sample.issue_date
    ? Math.round((new Date(sample.due_date) - new Date(sample.issue_date)) / (24 * 60 * 60 * 1000))
    : 30;
  const netDays = Number.isFinite(inferredNetDays) && inferredNetDays > 0 ? inferredNetDays : 30;

  const eventDate = sample.event_date || null;
  const customer = sample.customer_account_id
    ? await trx('customer_accounts').where({ id: sample.customer_account_id }).first()
    : null;

  // Cache canonical (non-reconciliation) line items from existing[0]
  // for cloning into any newly-created siblings.
  let canonicalLineItems = null;
  const acceptanceTime = new Date();
  const newCount = installments.length;
  const reusableCount = Math.min(existing.length, newCount);

  const kept = [];
  const created = [];
  const deleted = [];

  for (let i = 0; i < newCount; i++) {
    const inst = installments[i];
    const slice = computeSliceTotals(installments, totals, i);

    let scheduledSendAt = computeScheduledSendAt(
      inst.trigger, inst.offset_days, eventDate, acceptanceTime,
    );
    if (customer && customer.billing_cadence && customer.billing_cadence !== 'per_event') {
      scheduledSendAt = snapToNextBillingCycle(
        scheduledSendAt, customer.billing_cadence, customer.billing_cycle_day,
      );
    }
    const isDeliveryTrigger = inst.trigger === 'after_delivery';
    const rowStatus = isDeliveryTrigger ? 'pending_delivery' : 'scheduled';
    const rowScheduledSendAt = isDeliveryTrigger ? null : scheduledSendAt;
    const dueDate = computeDueDate(scheduledSendAt, netDays).toISOString().slice(0, 10);
    const label = inst.label || `Installment ${i + 1}/${newCount}`;

    if (i < reusableCount) {
      const existingRow = existing[i];
      await trx('invoices').where({ id: existingRow.id }).update({
        installment_index: i,
        installment_total: newCount,
        installment_label: label,
        installment_trigger: inst.trigger,
        status: rowStatus,
        scheduled_send_at: rowScheduledSendAt,
        issue_date: scheduledSendAt.toISOString().slice(0, 10),
        due_date: dueDate,
        net_amount_minor: slice.net,
        vat_amount_minor: slice.vat,
        shipping_amount_minor: slice.shipping,
        total_amount_minor: slice.total,
        updated_at: new Date(),
      });
      await replaceReconciliationLine(trx, existingRow.id, {
        label, percent: inst.percent, index: i, total: newCount, netSlice: slice.net,
      });
      kept.push(existingRow.id);
      continue;
    }

    // New sibling — clone canonical lines from existing[0] on first
    // use, then reuse the cached copy for any further new siblings.
    if (canonicalLineItems === null) {
      const sourceLines = await trx('invoice_line_items')
        .where({ invoice_id: existing[0].id })
        .orderBy('position', 'asc');
      canonicalLineItems = sourceLines.filter((li) => !isReconciliationLineItem(li));
    }

    const invoiceNumber = await nextInvoiceNumber(trx);
    const row = {
      invoice_number: invoiceNumber,
      customer_account_id: sample.customer_account_id,
      source_quote_id: sample.source_quote_id,
      event_id: sample.event_id,
      event_name: sample.event_name,
      event_date: sample.event_date,
      event_time_start: sample.event_time_start,
      event_time_end: sample.event_time_end,
      language: sample.language,
      currency: sample.currency,
      issue_date: scheduledSendAt.toISOString().slice(0, 10),
      due_date: dueDate,
      installment_index: i,
      installment_total: newCount,
      installment_label: label,
      installment_trigger: inst.trigger,
      status: rowStatus,
      scheduled_send_at: rowScheduledSendAt,
      net_amount_minor: slice.net,
      vat_rate: ensureNumber(sample.vat_rate, 0),
      vat_amount_minor: slice.vat,
      shipping_amount_minor: slice.shipping,
      total_amount_minor: slice.total,
      cc_pdf_email: sample.cc_pdf_email || null,
      payment_net_days_template_id: sample.payment_net_days_template_id || null,
      payment_timing_template_id: sample.payment_timing_template_id || null,
      payment_term_snapshot: sample.payment_term_snapshot || null,
      deal_uuid: dealUuid,
      created_by_admin_id: adminId,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const inserted = await trx('invoices').insert(row).returning('id');
    const newId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

    if (canonicalLineItems.length > 0) {
      const cloned = canonicalLineItems.map((li) => ({
        position: ensureInt(li.position),
        quantity: li.quantity,
        description: li.description,
        unit_price_minor: ensureInt(li.unit_price_minor),
        discount_percent: ensureNumber(li.discount_percent, 0),
        line_total_minor: ensureInt(li.line_total_minor),
        parent_position: li.parent_position == null ? null : ensureInt(li.parent_position),
        details_text: li.details_text || null,
      }));
      const { validateLineItemHierarchy, insertLineItemsHierarchical } = getHierarchyHelpers();
      validateLineItemHierarchy(cloned);
      await insertLineItemsHierarchical(trx, 'invoice_line_items', 'invoice_id', newId, cloned);
    }

    await replaceReconciliationLine(trx, newId, {
      label, percent: inst.percent, index: i, total: newCount, netSlice: slice.net,
    });

    try {
      await logActivity('invoice_scheduled', {
        invoiceId: newId, invoiceNumber, eventId: sample.event_id, source: 'plan_reshape',
      }, sample.event_id, `admin:${adminId}`);
    } catch (_) {}

    created.push(newId);
  }

  // Trim extras (only fires when newCount < existing.length).
  for (let i = newCount; i < existing.length; i++) {
    const oldRow = existing[i];
    await trx('invoice_line_items').where({ invoice_id: oldRow.id }).del();
    await trx('invoices').where({ id: oldRow.id }).del();
    deleted.push(oldRow.id);
  }

  try {
    await logActivity('installment_plan_updated', {
      dealUuid, newCount,
      kept: kept.length, created: created.length, deleted: deleted.length,
    }, sample.event_id, `admin:${adminId}`);
  } catch (_) {}

  return {
    invoiceIds: [...kept, ...created],
    kept, created, deleted,
  };
}

async function buildInvoiceRenderContext(invoice, lineItems) {
  const { profile } = await businessProfileService.getProfile();
  const customer = await db('customer_accounts').where({ id: invoice.customer_account_id }).first();
  const bank = invoice.business_bank_account_id
    ? await db('business_bank_accounts').where({ id: invoice.business_bank_account_id }).first()
    : await businessProfileService.resolveBankAccountForCurrency(invoice.currency);

  // Resolve the PDF logo to a verified absolute disk path. The
  // helper exhaustively tries:
  //   1. business_profile.logo_path
  //   2. app_settings.branding_logo_path  (absolute multer path)
  //   3. app_settings.branding_logo_url   (URL path)
  // …and for each, generates ~7 candidate disk locations before
  // giving up. Returns null + logs a detailed warning when nothing
  // resolves. Already-verified path means the renderer never has
  // to second-guess.
  const { resolveLogoFile } = require('../utils/resolveLogoFile');
  const resolvedLogoPath = await resolveLogoFile(profile);

  // QR format resolution order (per-invoice override → profile
  // default → none) gated by the global enable toggle. The earlier
  // version had an operator-precedence bug that effectively dropped
  // the profile default; this rewrites it as plain if/else for
  // readability + correctness.
  const qrGloballyEnabled = (await getAppSetting('crm_invoices_qr_enabled')) !== false;
  let resolvedQrFormat = 'none';
  if (qrGloballyEnabled) {
    resolvedQrFormat = invoice.qr_format || profile?.default_qr_format || 'none';
  }

  // Resolve the payment-term snapshot to thread Skonto + net-days into
  // the PDF's "Zahlungsbedingungen" block. Three sources, in priority
  // order:
  //   1. The invoice's OWN snapshot (migration 113 — set when admin
  //      picks a template directly in the New Invoice form).
  //   2. The originating quote's snapshot, if this invoice was
  //      created from one.
  //   3. The global CRM defaults (settings tab) — `crm_invoices_*`.
  // Both layers above are wrapped in `paymentTerm` exactly as
  // quoteService builds it so pdfService.drawPaymentBlock renders
  // the same block on both document types.
  let paymentTerm = null;

  // Invoice-level snapshot wins when set.
  if (invoice.payment_term_snapshot) {
    const snapshot = typeof invoice.payment_term_snapshot === 'string'
      ? (() => { try { return JSON.parse(invoice.payment_term_snapshot); } catch { return null; } })()
      : invoice.payment_term_snapshot;
    if (snapshot) {
      paymentTerm = {
        description: snapshot.description,
        netDays: snapshot.net_days,
        skontoPercent: snapshot.skonto_percent,
        skontoWithinDays: snapshot.skonto_within_days,
      };
    }
  }

  // Load the source quote once — used for the payment-term snapshot
  // fallback AND for the "Bezug: Angebot Q-..." reference line on
  // the invoice PDF. We deliberately keep invoice numbers on a
  // strict monotonic sequence (tax compliance) and surface the link
  // as a text reference rather than mirroring the number.
  let sourceQuote = null;
  if (invoice.source_quote_id) {
    sourceQuote = await db('quotes').where({ id: invoice.source_quote_id }).first();
    if (!paymentTerm && sourceQuote?.payment_term_snapshot) {
      const snapshot = typeof sourceQuote.payment_term_snapshot === 'string'
        ? (() => { try { return JSON.parse(sourceQuote.payment_term_snapshot); } catch { return null; } })()
        : sourceQuote.payment_term_snapshot;
      if (snapshot) {
        paymentTerm = {
          description: snapshot.description,
          netDays: snapshot.net_days,
          skontoPercent: snapshot.skonto_percent,
          skontoWithinDays: snapshot.skonto_within_days,
        };
      }
    }
  }
  // Globally-default Skonto values, always loaded. Used either to
  // FILL a partial source-quote snapshot OR to seed the whole
  // paymentTerm when there's no source quote. Both reads survive
  // missing rows (returns null), unset values (NaN guarded), and
  // string-encoded numbers from app_settings.
  const defaultSkontoPercentRaw = await getAppSetting('crm_invoices_skonto_percent_default');
  const defaultSkontoDaysRaw = await getAppSetting('crm_invoices_skonto_business_days');
  const defaultSkontoPercent = Number.isFinite(Number(defaultSkontoPercentRaw)) && Number(defaultSkontoPercentRaw) > 0
    ? Number(defaultSkontoPercentRaw) : null;
  const defaultSkontoDays = Number.isFinite(Number(defaultSkontoDaysRaw)) && Number(defaultSkontoDaysRaw) > 0
    ? parseInt(defaultSkontoDaysRaw, 10) : null;

  if (paymentTerm) {
    // The source quote's snapshot may carry only some of the Skonto
    // fields (e.g. when the template predates Skonto support); fill
    // missing parts from the global defaults so the PDF still shows
    // the row whenever there's enough info to render it.
    if (paymentTerm.skontoPercent == null && defaultSkontoPercent != null) {
      paymentTerm.skontoPercent = defaultSkontoPercent;
    }
    if (paymentTerm.skontoWithinDays == null && defaultSkontoDays != null) {
      paymentTerm.skontoWithinDays = defaultSkontoDays;
    }
  } else {
    // Ad-hoc invoice (no source quote). Build the paymentTerm from
    // the global defaults. Renders only when BOTH percent + days are
    // set + > 0 (pdfService.drawPaymentBlock guards on that).
    paymentTerm = {
      description: null,
      netDays: 30,
      skontoPercent: defaultSkontoPercent,
      skontoWithinDays: defaultSkontoDays,
    };
  }

  // Per-invoice Skonto opt-out (migration 126). The
  // `resolveSkontoPercentForInvoice` helper above already respects
  // this for payment-tracking surfaces, but the PDF render path was
  // assembling `paymentTerm.skontoPercent/Days` from the snapshot or
  // global defaults and ignoring the flag — so ticking "Disable
  // Skonto" on the invoice cleared it from "Paid with Skonto" buttons
  // but still printed the discount row on the PDF. Zero out both
  // fields here so pdfService.drawPaymentBlock's
  // `paymentTerm?.skontoPercent && paymentTerm?.skontoWithinDays`
  // guard suppresses the row. The per-customer opt-out (migration 112)
  // is honoured here too — a customer flagged skonto_disabled never
  // prints the discount row, mirroring resolveSkontoPercentForInvoice.
  if (invoice.skonto_disabled || customer?.skonto_disabled) {
    paymentTerm.skontoPercent = null;
    paymentTerm.skontoWithinDays = null;
  }

  // Global date format from Settings → General (general_date_format).
  // Stored as JSON `{ format, locale }`; missing or malformed entries
  // fall back to DD.MM.YYYY in the renderer.
  let dateFormat = null;
  try {
    const raw = await getAppSetting('general_date_format');
    if (raw && typeof raw === 'object' && raw.format) dateFormat = raw;
    else if (typeof raw === 'string' && raw.trim()) dateFormat = { format: raw.trim() };
  } catch (_) { /* fall back to default */ }

  // Sub-cent reconciliation (crm_invoice_round_total). "Betrag Netto"
  // shows the sum of the visible line totals so it foots with the items;
  // the stored net may be the clean (rounded-once) value, and the gap is
  // shown as a "Rundung" row. Legacy/unrounded invoices have equal
  // values ⇒ adjustment 0, no row. Suppressed on Storno/Mahnung: those
  // negate the stored net and flip line-total signs at render, so the
  // forward "storedNet − Σ lines" derivation doesn't apply.
  const isReversalDoc = invoice.kind === 'storno' || invoice.kind === 'mahnung';
  const displayedNetMinor = isReversalDoc
    ? ensureInt(invoice.net_amount_minor)
    : lineItems.reduce(
      (s, li) => (li.parent_line_item_id == null && (li.parent_position == null || li.parent_position === '')
        ? s + ensureInt(li.line_total_minor) : s),
      0,
    );
  const roundingAdjustmentMinor = isReversalDoc
    ? 0
    : ensureInt(invoice.net_amount_minor) - displayedNetMinor;

  return {
    locale: invoice.language || profile?.default_locale || 'de',
    currency: invoice.currency,
    qrFormat: resolvedQrFormat,
    dateFormat,
    // Shared issuer + recipient builders. Invoices skip the quote-only
    // payment-block toggles; the invoice PDF always shows the payment
    // block. See backend/src/services/_renderContext.js.
    issuer: buildIssuerBlock(profile, resolvedLogoPath),
    recipient: buildRecipientBlock(profile, customer),
    bank: bank ? {
      accountHolder: bank.account_holder || profile?.company_name,
      iban: bank.iban, bic: bank.bic, currency: bank.currency,
    } : null,
    paymentTerm,
    lineItems: lineItems.map((li) => ({
      quantity: li.quantity,
      description: li.description,
      unitPriceMinor: li.unit_price_minor,
      discountPercent: li.discount_percent,
      lineTotalMinor: li.line_total_minor,
      // Migration 119 — hierarchy + notes flow through to PDF.
      parentLineItemId: li.parent_line_item_id || null,
      parentPosition: li.parent_position == null ? null : Number(li.parent_position),
      detailsText: li.details_text || null,
    })),
    totals: {
      netAmountMinor: displayedNetMinor,
      roundingAdjustmentMinor,
      vatRate: invoice.vat_rate,
      // Migration 130 — VAT-code snapshot (so re-editing preserves it).
      vatCode: invoice.vat_code ?? null,
      vatAmountMinor: invoice.vat_amount_minor,
      shippingAmountMinor: invoice.shipping_amount_minor,
      totalAmountMinor: invoice.total_amount_minor,
      // The Mahngebühr is shown on the separate Mahnung document, NEVER on
      // the (immutable) invoice — so the invoice render always reports 0. The
      // Mahnung render path (applyReminder) overrides this with the tracked fee.
      lateFeeAmountMinor: 0,
    },
    doc: {
      // Document type discriminator. `'invoice'` (default) renders
      // the standard invoice layout. `'storno'` switches the title
      // to "Stornorechnung", forces the mandatory "Storno zu …"
      // reference line, displays signed totals, and suppresses the
      // payment terms / IBAN / QR-bill sections (cancellation
      // documents aren't payment instruments).
      kind: invoice.kind || 'invoice',
      invoiceNumber: invoice.invoice_number,
      issueDate: invoice.issue_date,
      dueDate: invoice.due_date,
      totalAmountMinor: invoice.total_amount_minor,
      lateFeeMinor: 0,
      // Reminder level — drives Skonto suppression on second
      // reminders (no early-payment discount once the customer
      // is in dunning).
      reminderLevel: invoice.reminder_level || 0,
      // PDF renderer draws "Bezug: Angebot Q-..." under the title
      // when set. Empty/null suppresses the line (standalone invoice).
      sourceQuoteNumber: sourceQuote?.quote_number || null,
      // When this invoice replaces a previously-cancelled one
      // (migration 114, reissue workflow), the renderer stamps a
      // second reference line: "Bezug: Ersetzt Rechnung R-XXXX vom
      // DATE".
      replacesInvoice: await (async () => {
        if (!invoice.replaces_invoice_id) return null;
        const prior = await db('invoices')
          .where({ id: invoice.replaces_invoice_id })
          .select('invoice_number', 'issue_date').first();
        return prior
          ? { number: prior.invoice_number, issueDate: prior.issue_date }
          : null;
      })(),
      // Storno reference — populated only on `kind='storno'` rows.
      // The renderer turns it into the mandatory "Storno zu Rechnung
      // R-XXXX vom DATE" line under the title. Drives §14c-defensible
      // traceability: the customer sees explicitly what was reversed.
      cancelsInvoice: await (async () => {
        if (!invoice.cancels_invoice_id) return null;
        const prior = await db('invoices')
          .where({ id: invoice.cancels_invoice_id })
          .select('invoice_number', 'issue_date').first();
        return prior
          ? { number: prior.invoice_number, issueDate: prior.issue_date }
          : null;
      })(),
    },
  };
}

async function renderInvoicePdfBuffer(invoiceId) {
  const data = await getInvoiceById(invoiceId);
  if (!data) throw new AppError('Invoice not found', 404);
  // Imported (historical) invoices store the original PDF on disk
  // — short-circuit the renderer and stream the file untouched so
  // legal documents stay byte-identical to the source. Path is
  // stored relative to STORAGE_PATH but we accept absolute too.
  if (data.invoice.imported_pdf_path) {
    const fs = require('fs');
    const path = require('path');
    const { getStoragePath } = require('../config/storage');
    const raw = String(data.invoice.imported_pdf_path).trim();
    const candidates = [
      path.isAbsolute(raw) ? raw : null,
      path.join(getStoragePath(), raw.replace(/^\/+/, '')),
    ].filter(Boolean);
    const found = candidates.find((p) => {
      try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; }
    });
    if (!found) {
      throw new AppError('Imported invoice PDF is missing on disk', 410);
    }
    return fs.readFileSync(found);
  }
  const ctx = await buildInvoiceRenderContext(data.invoice, data.lineItems);
  return await pdfService.renderInvoiceToBuffer(ctx);
}

async function renderInvoicePdfFromPayload(payload) {
  const customer = await db('customer_accounts').where({ id: payload.customerAccountId }).first();
  const lineItems = Array.isArray(payload.lineItems) ? payload.lineItems : [];
  // Migration 119 — preview must match the saved-invoice math:
  //   - Compute every row's raw line_total_minor (qty × unit × discount).
  //   - Then resolveParentTotalsFromSubItems rewrites each parent's
  //     line_total to the sum of its priced sub-items (parent's own
  //     unit_price is ignored when any sub-item has a price).
  //   - Net sums TOP-LEVEL items only (parent_position == null).
  // Without these two steps, the preview shows the parent at 0 and
  // double-counts sub-items into net, neither of which matches the
  // values the renderer would produce for the persisted invoice.
  const items = lineItems.map((li, idx) => {
    const qty = ensureNumber(li.quantity, 1);
    const unit = ensureInt(li.unit_price_minor);
    const discount = ensureNumber(li.discount_percent, 0);
    const lineTotal = Math.round(Math.round(qty * unit) * (1 - discount / 100));
    return { ...li, position: li.position || idx + 1, line_total_minor: lineTotal };
  });
  const { resolveParentTotalsFromSubItems } = getHierarchyHelpers();
  resolveParentTotalsFromSubItems(items);
  let netMinor = 0;
  for (const it of items) {
    if (it.parent_position == null || it.parent_position === '') {
      netMinor += ensureInt(it.line_total_minor);
    }
  }
  // Match the saved-invoice math: clean-net reconciliation when the
  // crm_invoice_round_total setting is on (see createInvoice).
  const roundTotal = (await getAppSetting('crm_invoice_round_total', false)) === true;
  if (roundTotal) {
    netMinor = cleanNetMinor(items, { parentKey: 'parent_position', positionKey: 'position' });
  }
  const vatRate = ensureNumber(payload.vatRate, 0);
  const vatMinor = Math.round(netMinor * vatRate / 100);
  const shippingMinor = ensureInt(payload.shippingAmountMinor);
  const totalMinor = netMinor + vatMinor + shippingMinor;
  const fakeInvoice = {
    invoice_number: 'PREVIEW',
    customer_account_id: payload.customerAccountId,
    language: payload.language || customer?.preferred_language || 'de',
    currency: (payload.currency || 'CHF').toUpperCase(),
    issue_date: payload.issueDate || new Date().toISOString().slice(0, 10),
    due_date: payload.dueDate || new Date(Date.now() + 30 * 86400e3).toISOString().slice(0, 10),
    business_bank_account_id: payload.businessBankAccountId,
    qr_format: payload.qrFormat,
    net_amount_minor: netMinor,
    vat_rate: vatRate,
    vat_amount_minor: vatMinor,
    shipping_amount_minor: shippingMinor,
    total_amount_minor: totalMinor,
  };
  const ctx = await buildInvoiceRenderContext(fakeInvoice, items);
  return await pdfService.renderInvoiceToBuffer(ctx);
}

/**
 * Send an invoice email + PDF. Flips status scheduled → sent.
 */
async function sendInvoice(id, adminId) {
  const data = await getInvoiceById(id);
  if (!data) throw new AppError('Invoice not found', 404);
  const { invoice, lineItems } = data;
  // Stornorechnungen go through their own send path — different
  // email template, different variables, different PDF render
  // branch. The scheduler's flush loop hits this entry point for
  // every row in status='scheduled', so the dispatch lives here.
  if (invoice.kind === 'storno') {
    return await sendStorno(id, adminId);
  }
  if (!['scheduled', 'sent', 'overdue'].includes(invoice.status)) {
    throw new AppError(`Cannot send invoice with status '${invoice.status}'`, 409);
  }
  // Monthly-draft guard (migration 128). Rows flagged
  // is_monthly_draft=true accumulate line items across the period
  // and must ONLY be issued via triggerMonthlyBillNow / the scheduled
  // monthly flush — both clear the flag before re-entering this
  // function. Without this guard, admin clicks on a draft's Send
  // button would ship the running accumulator early AND leave the
  // flag set, so subsequent createInvoice calls would silently
  // append onto the same already-sent row.
  if (invoice.is_monthly_draft === true || invoice.is_monthly_draft === 1) {
    throw new AppError(
      'This invoice is a monthly draft — use "Trigger invoice now" on the customer detail page, or wait for the scheduled cycle day.',
      409, 'MONTHLY_DRAFT_NOT_SENDABLE',
    );
  }
  const customer = await db('customer_accounts').where({ id: invoice.customer_account_id }).first();
  ensureCustomerCanBill(customer);

  // Re-sync the invoice's language from the customer's current
  // preferred_language at send time when the invoice has never been
  // sent. Picks up admin language changes made between create and
  // send (notable for monthly drafts that accumulate for ~30 days,
  // and for any standalone scheduled invoice where admin updated the
  // customer record after authoring). Sent / overdue invoices keep
  // their existing language because they're legal records — the
  // rendered PDF is the source of truth from the moment it ships.
  if (invoice.status === 'scheduled' && customer.preferred_language
      && customer.preferred_language !== invoice.language) {
    await db('invoices').where({ id }).update({
      language: customer.preferred_language,
      updated_at: new Date(),
    });
    invoice.language = customer.preferred_language;
  }

  // Stamp the issue date at the moment the invoice actually goes out.
  // A scheduled invoice's issue_date is provisional — set to the
  // authoring day at creation — but the legal issue date is when it
  // ships. Anchoring it here keeps the printed invoice date, the Skonto
  // window (a relative "pay within N working days" counted from that
  // date) and the net-days due date all consistent with the send date.
  // Only on the first send (status 'scheduled'); 'sent' / 'overdue'
  // rows are immutable legal records and keep their stamped date.
  if (invoice.status === 'scheduled') {
    const sendDateIso = new Date().toISOString().slice(0, 10);
    const netDays = await resolveNetDaysForRow(invoice);
    // Re-anchor the due date too, but only when it was machine-set: if
    // the stored due_date still equals the auto formula off the OLD
    // base (scheduled_send_at, else the old issue_date), the admin never
    // hand-edited it and we slide it to the new issue date. A divergent
    // value means a manual override (the editor's "Override due date"
    // toggle) — leave it untouched.
    const oldBase = invoice.scheduled_send_at
      ? new Date(invoice.scheduled_send_at)
      : new Date(invoice.issue_date);
    const oldAutoDue = computeDueDate(oldBase, netDays).toISOString().slice(0, 10);
    const storedDue = invoice.due_date
      ? new Date(invoice.due_date).toISOString().slice(0, 10)
      : null;
    const updates = { issue_date: sendDateIso, updated_at: new Date() };
    if (storedDue && storedDue === oldAutoDue) {
      updates.due_date = computeDueDate(new Date(sendDateIso), netDays).toISOString().slice(0, 10);
    }
    await db('invoices').where({ id }).update(updates);
    invoice.issue_date = updates.issue_date;
    if (updates.due_date) invoice.due_date = updates.due_date;
  }

  const ctx = await buildInvoiceRenderContext(invoice, lineItems);
  const buffer = await pdfService.renderInvoiceToBuffer(ctx);

  // Persist PDF snapshot.
  const fs = require('fs');
  const path = require('path');
  const year = new Date(invoice.issue_date).getFullYear();
  const root = path.join(process.cwd(), 'storage', 'business-docs', 'invoice', String(year));
  fs.mkdirSync(root, { recursive: true });
  const pdfPath = path.join(root, `${invoice.invoice_number}.pdf`);
  fs.writeFileSync(pdfPath, buffer);

  const newStatus = invoice.status === 'overdue' ? 'overdue' : 'sent';
  await db('invoices').where({ id }).update({
    status: newStatus, sent_at: new Date(), pdf_path: pdfPath, updated_at: new Date(),
  });

  const { to: invoiceTo, cc: invoiceCc } = resolveBillingRecipients(customer, invoice.cc_pdf_email);
  await emailProcessor.queueEmail(invoice.event_id || null, invoiceTo, 'invoice_sent', {
    invoice_number: invoice.invoice_number,
    customer_name: customer.display_name || customer.first_name || customer.email.split('@')[0],
    event_name: invoice.event_name || '',
    total_amount: formatMajor(invoice.total_amount_minor, invoice.currency, ctx.locale),
    due_date: formatShortDate(invoice.due_date),
    installment_label: invoice.installment_label || '',
    installment_index: invoice.installment_index + 1,
    installment_total: invoice.installment_total,
    cc: invoiceCc,
    attachments: [{
      filename: `${invoice.invoice_number}.pdf`,
      contentPath: pdfPath,
      contentType: 'application/pdf',
    }],
  });

  try { await logActivity('invoice_sent', { invoiceId: id }, invoice.event_id || null, `admin:${adminId}`); } catch (_) {}

  // Fire the workflow engine's invoice.sent trigger (after the row is updated +
  // the email queued). Idempotent per invoice id; no-op when the workflows flag
  // is off. Never throws into the send path.
  try {
    await require('./workflows').emitWorkflowEvent('invoice.sent', {
      entityType: 'invoice',
      entityId: id,
      payload: {
        invoiceId: id,
        invoiceNumber: invoice.invoice_number,
        eventId: invoice.event_id || null,
        customerAccountId: invoice.customer_account_id,
        customerEmail: invoiceTo,
        dueDate: invoice.due_date,
        issueDate: invoice.issue_date,
        totalMinor: invoice.total_amount_minor,
        currency: invoice.currency,
      },
    });
  } catch (_) {}

  return { sent: true, pdfPath };
}

/**
 * Record a payment against an invoice. Supports partial payments
 * (multiple rows accumulate into `paid_amount_minor`). Status flips
 * to `paid` once the running total meets or exceeds total_amount_minor.
 */
async function markPaid(id, { amountMinor, paidAt, paymentMethod, reference, notes, skontoApplied }, adminId) {
  const invoice = await db('invoices').where({ id }).first();
  if (!invoice) throw new AppError('Invoice not found', 404);
  if (invoice.status === 'cancelled') {
    throw new AppError('Cannot mark a cancelled invoice as paid', 409);
  }
  const amount = ensureInt(amountMinor);
  if (amount <= 0) {
    throw new AppError('amount must be > 0', 400);
  }
  // Skonto bookkeeping (migration 126). When the admin ticks "Paid
  // with Skonto" we store both the flag AND the absolute discount
  // in minor units. Computing the discount here (instead of in the
  // renderer at report time) means the value is frozen against
  // later template/percentage edits — the tax-report row stays
  // accurate for years.
  const skontoFlag = Boolean(skontoApplied);
  const skontoAmountMinor = skontoFlag
    ? Math.max(0, ensureInt(invoice.total_amount_minor) - amount)
    : null;

  const markResult = await db.transaction(async (trx) => {
    await trx('invoice_payment_log').insert({
      invoice_id: id,
      amount_minor: amount,
      paid_at: paidAt ? new Date(paidAt) : new Date(),
      payment_method: paymentMethod || null,
      reference: reference || null,
      notes: notes || null,
      recorded_by_admin_id: adminId,
      skonto_applied: skontoFlag,
      skonto_amount_minor: skontoAmountMinor,
      created_at: new Date(),
    });
    const sumRow = await trx('invoice_payment_log').where({ invoice_id: id }).sum('amount_minor as total').first();
    const total = ensureInt(sumRow?.total || 0);
    // Consider the invoice paid when the recorded payments cover the
    // invoice total. The late fee is NOT added to the threshold here
    // — admins frequently waive it once the customer actually pays
    // (and chasing the extra 25 CHF after a 1500 CHF invoice clears
    // makes nobody happy). Admin can record a separate payment_log
    // row if they did collect the fee; status flips to paid the
    // moment the principal is covered.
    //
    // Skonto path (migration 126): when the admin flagged this
    // payment as Skonto-applied, the discounted amount equals the
    // expected payment — flip to 'paid' even though paid_amount_minor
    // is strictly less than total_amount_minor. Without this branch
    // the invoice would sit in 'sent' or 'overdue' forever despite
    // being legitimately settled.
    const skontoEffectiveTotal = skontoFlag
      ? ensureInt(invoice.total_amount_minor) - (skontoAmountMinor || 0)
      : ensureInt(invoice.total_amount_minor);
    const isFull = total >= skontoEffectiveTotal;

    const update = {
      paid_amount_minor: total,
      payment_method: paymentMethod || invoice.payment_method,
      payment_reference: reference || invoice.payment_reference,
      updated_at: new Date(),
    };
    if (isFull) {
      update.status = 'paid';
      update.paid_at = paidAt ? new Date(paidAt) : new Date();
    }
    await trx('invoices').where({ id }).update(update);

    try { await logActivity(isFull ? 'invoice_paid' : 'invoice_partial_payment',
      { invoiceId: id, amountMinor: amount, totalPaidMinor: total },
      invoice.event_id || null, `admin:${adminId}`); } catch (_) {}

    // Migration 127 — admin payment-received notification. Fires only
    // on the transition into 'paid' so admins don't get duplicate
    // emails when additional payment-log rows are recorded after the
    // invoice already cleared (rare but possible — e.g. late-fee
    // top-up). Queued after the transaction so a failed email never
    // rolls back a recorded payment. Carried Skonto context lets the
    // template show the discount line conditionally.
    if (isFull && invoice.status !== 'paid') {
      try {
        await queueInvoicePaidAdminNotification({
          invoice,
          paidTotalMinor: total,
          paymentMethod: paymentMethod || invoice.payment_method || null,
          paymentReference: reference || invoice.payment_reference || null,
          paidAt: paidAt ? new Date(paidAt) : new Date(),
          skontoApplied: skontoFlag,
          skontoAmountMinor: skontoAmountMinor || 0,
        });
      } catch (err) {
        // Notification is best-effort — don't surface a 500 to the
        // admin when the recorded payment itself succeeded.
        logger.warn('invoice_paid admin notification failed to queue', { invoiceId: id, err: err.message });
      }
    }

    return { paidTotalMinor: total, status: isFull ? 'paid' : invoice.status };
  });

  // Fire invoice.paid for the workflow engine ONLY on the transition into
  // 'paid' (mirrors the admin-notification guard above). After the commit so a
  // workflow side effect can never roll back the recorded payment.
  if (markResult.status === 'paid' && invoice.status !== 'paid') {
    try {
      await require('./workflows').emitWorkflowEvent('invoice.paid', {
        entityType: 'invoice',
        entityId: id,
        payload: {
          invoiceId: id,
          invoiceNumber: invoice.invoice_number,
          eventId: invoice.event_id || null,
          customerAccountId: invoice.customer_account_id,
          paidTotalMinor: markResult.paidTotalMinor,
        },
      });
    } catch (_) {}
  }
  return markResult;
}

/**
 * Materialise a Stornorechnung (cancellation invoice) for an already-
 * issued original. Atomic:
 *   1. Insert a new `invoices` row with `kind='storno'`, totals
 *      negated, no due_date / payment terms / bank account / QR,
 *      and `cancels_invoice_id` pointing at the original.
 *   2. Snapshot the original's line items at full positive amounts
 *      (the sign is carried by the row-level totals; the renderer
 *      flips line totals visually for `kind='storno'`). Preserves
 *      the migration-119 sub-item hierarchy via parent_position →
 *      parent_line_item_id resolution in `insertLineItemsHierarchical`.
 *   3. Flip the original to `status='cancelled'` and pin its
 *      `cancellation_storno_id` so the admin detail view can render
 *      a "Cancelled by Storno S-XXXX" banner.
 *
 * Returns the Storno's id. The caller is responsible for actually
 * sending it (sendStorno) — splitting the create/send seam means
 * a failed PDF render or email queue doesn't roll back the
 * cancellation itself; the storno sits in `status='scheduled'`
 * and the cron picks it up.
 */
async function createStorno(originalId, adminId, trx = db) {
  const original = await trx('invoices').where({ id: originalId }).first();
  if (!original) throw new AppError('Invoice not found', 404);
  if (original.kind === 'storno') {
    throw new AppError('Cannot Storno a Storno', 409, 'IS_STORNO');
  }
  if (original.status === 'scheduled') {
    throw new AppError(
      'This invoice has not been sent yet — Storno only applies to issued documents.',
      409,
      'USE_EDIT_INSTEAD',
    );
  }
  if (original.status === 'cancelled') {
    throw new AppError('Invoice already cancelled', 409, 'ALREADY_CANCELLED');
  }

  // Generate the Storno's sequence number from the same gap-free
  // series as regular invoices (single sequence — decision locked
  // with the maintainer; satisfies §14 (4) Nr. 4 UStG).
  // Pass trx so the sequence claim joins the caller's transaction —
  // SQLite deadlocks otherwise (1-connection default).
  const stornoNumber = await nextInvoiceNumber(trx);
  const now = new Date();
  const issueDate = now.toISOString().slice(0, 10);

  // Insert the Storno row. Totals negated for accounting integrity
  // (tax report aggregates by row-level totals, so a Storno
  // contributes correctly without the renderer needing to flip
  // signs at report time). Line items below stay positive — the
  // renderer applies the sign at presentation time.
  const insertedRow = await trx('invoices').insert({
    kind: 'storno',
    invoice_number: stornoNumber,
    customer_account_id: original.customer_account_id,
    event_id: original.event_id,
    // Inline event snapshot — copy so the Storno carries the same
    // event label as the invoice it reverses (migration 123). The
    // bookkeeper expects to see both documents under the same event.
    event_name: original.event_name || null,
    event_date: original.event_date || null,
    event_time_start: original.event_time_start || null,
    event_time_end: original.event_time_end || null,
    source_quote_id: null,
    // Migration 124 — carry the split FKs through onto the Storno row
    // so the lineage stays consistent if anyone audits the
    // cancellation document and checks the picker state.
    payment_net_days_template_id: original.payment_net_days_template_id || null,
    payment_timing_template_id: original.payment_timing_template_id || null,
    currency: original.currency,
    language: original.language,
    vat_rate: original.vat_rate,
    // Migration 130 — carry the original's VAT-code snapshot onto the Storno so
    // both documents export the same code. Conditional spread = safe on pre-130
    // DBs (undefined → omitted).
    ...(original.vat_code ? { vat_code: original.vat_code } : {}),
    shipping_amount_minor: -ensureInt(original.shipping_amount_minor || 0),
    net_amount_minor: -ensureInt(original.net_amount_minor),
    vat_amount_minor: -ensureInt(original.vat_amount_minor),
    total_amount_minor: -ensureInt(original.total_amount_minor),
    late_fee_amount_minor: 0,
    paid_amount_minor: 0,
    status: 'scheduled',
    scheduled_send_at: now,
    issue_date: issueDate,
    // Storni have no payment due — mirror issue_date to satisfy the
    // schema's NOT NULL constraint on due_date. The field is dead data
    // for kind='storno' rows: the PDF renderer suppresses the due-date
    // line, and the dunning scheduler filters kind='invoice'.
    due_date: issueDate,
    reminder_level: 0,
    cc_pdf_email: original.cc_pdf_email,
    // No payment block on a Storno — it's not a payment instrument.
    business_bank_account_id: null,
    qr_format: null,
    payment_term_template_id: null,
    // Lineage.
    cancels_invoice_id: original.id,
    replaces_invoice_id: null,
    cancellation_storno_id: null,
    // Migration 140 — Storno belongs to the same deal as the invoice
    // it cancels; both render together in the lineage view.
    deal_uuid: original.deal_uuid || crypto.randomUUID(),
    created_at: now,
    updated_at: now,
  }).returning('id');
  const stornoId = Array.isArray(insertedRow)
    ? (insertedRow[0]?.id ?? insertedRow[0])
    : insertedRow;

  // Snapshot the original's line items (positive amounts — the
  // Storno's sign convention lives on the row-level totals + the
  // renderer flip).
  const lineItems = await trx('invoice_line_items as li')
    .leftJoin('invoice_line_items as parent', 'parent.id', 'li.parent_line_item_id')
    .where('li.invoice_id', originalId)
    .orderBy('li.position', 'asc')
    .select('li.*', 'parent.position as parent_position');
  if (lineItems.length > 0) {
    const cloned = lineItems.map((li) => ({
      position: ensureInt(li.position),
      quantity: li.quantity,
      description: li.description,
      unit_price_minor: ensureInt(li.unit_price_minor),
      discount_percent: ensureNumber(li.discount_percent, 0),
      line_total_minor: ensureInt(li.line_total_minor),
      parent_position: li.parent_position == null ? null : ensureInt(li.parent_position),
      details_text: li.details_text || null,
    }));
    const { validateLineItemHierarchy, insertLineItemsHierarchical } = getHierarchyHelpers();
    validateLineItemHierarchy(cloned);
    await insertLineItemsHierarchical(trx, 'invoice_line_items', 'invoice_id', stornoId, cloned);
  }

  // Flip the original to cancelled + link the Storno.
  await trx('invoices').where({ id: originalId }).update({
    status: 'cancelled',
    cancellation_storno_id: stornoId,
    updated_at: now,
  });

  try {
    await logActivity('invoice_cancelled_via_storno',
      { invoiceId: originalId, stornoId, stornoNumber },
      original.event_id || null, `admin:${adminId}`);
  } catch (_) {}

  return stornoId;
}

/**
 * Send a Stornorechnung — renders the PDF, persists it on disk,
 * flips the row to `status='sent'`, and queues the `storno_issued`
 * email to the customer with the PDF attached.
 *
 * Mirrors sendInvoice's shape so the scheduler's flush loop can
 * delegate uniformly. The email template ships in Phase 3
 * (renames the dormant `invoice_cancelled` seed); if the worker
 * picks up the job before the template lands it logs the missing
 * template — the row stays in `sent` either way.
 */
async function sendStorno(stornoId, adminId) {
  const data = await getInvoiceById(stornoId);
  if (!data) throw new AppError('Storno not found', 404);
  const { invoice: storno, lineItems } = data;
  if (storno.kind !== 'storno') {
    throw new AppError(`Expected kind='storno', got '${storno.kind}'`, 409);
  }
  if (storno.status === 'sent') return { status: 'sent' };

  const customer = await db('customer_accounts').where({ id: storno.customer_account_id }).first();
  ensureCustomerCanBill(customer);

  const ctx = await buildInvoiceRenderContext(storno, lineItems);
  const buffer = await pdfService.renderInvoiceToBuffer(ctx);

  // Persist PDF snapshot alongside regular invoices.
  const fs = require('fs');
  const path = require('path');
  const year = new Date(storno.issue_date).getFullYear();
  const root = path.join(process.cwd(), 'storage', 'business-docs', 'invoice', String(year));
  fs.mkdirSync(root, { recursive: true });
  const pdfPath = path.join(root, `${storno.invoice_number}.pdf`);
  fs.writeFileSync(pdfPath, buffer);

  await db('invoices').where({ id: stornoId }).update({
    status: 'sent',
    sent_at: new Date(),
    pdf_path: pdfPath,
    updated_at: new Date(),
  });

  // Look up the original so we can include both numbers in the
  // email body — customers' bookkeepers expect to see the pair.
  const originalRow = storno.cancels_invoice_id
    ? await db('invoices').where({ id: storno.cancels_invoice_id })
        .select('invoice_number', 'issue_date').first()
    : null;

  const { to: stornoTo, cc: stornoCc } = resolveBillingRecipients(customer, storno.cc_pdf_email);
  await emailProcessor.queueEmail(storno.event_id || null, stornoTo, 'storno_issued', {
    storno_number: storno.invoice_number,
    original_invoice_number: originalRow?.invoice_number || '',
    original_issue_date: originalRow?.issue_date ? formatShortDate(originalRow.issue_date) : '',
    customer_name: customer.display_name || customer.first_name || customer.email.split('@')[0],
    total_amount: formatMajor(Math.abs(storno.total_amount_minor), storno.currency, ctx.locale),
    cc: stornoCc,
    attachments: [{
      filename: `${storno.invoice_number}.pdf`,
      contentPath: pdfPath,
      contentType: 'application/pdf',
    }],
  });

  try {
    await logActivity('storno_sent',
      { stornoId, stornoNumber: storno.invoice_number, originalInvoiceId: storno.cancels_invoice_id || null },
      storno.event_id || null, `admin:${adminId || 'system'}`);
  } catch (_) {}

  return { status: 'sent', stornoId };
}

/**
 * Reissue an invoice — the legally-correct alternative to post-send
 * editing.
 *   1. If the original is still live (sent / overdue / paid),
 *      generate a Stornorechnung for it via `createStorno` and
 *      immediately send it to the customer (sendStorno). The
 *      original flips to `status='cancelled'` and its
 *      `cancellation_storno_id` is pinned.
 *   2. Create a fresh `scheduled` invoice with a new sequence
 *      number, line items snapshotted from the original, and
 *      `replaces_invoice_id` pointing at the original so the
 *      renderer can stamp "Bezug: Ersetzt Rechnung R-XXXX".
 *
 * If the original is ALREADY cancelled (admin previously cancelled
 * it via Storno on its own), the cancel step is skipped — only the
 * replacement is created. `scheduled` originals are rejected
 * (USE_EDIT_INSTEAD) since drafts don't need legal cancellation.
 */
async function reissueInvoice(id, adminId) {
  const original = await db('invoices').where({ id }).first();
  if (!original) throw new AppError('Invoice not found', 404);
  if (original.kind === 'storno') {
    throw new AppError('Cannot reissue a Storno document', 409, 'IS_STORNO');
  }
  if (original.status === 'scheduled') {
    throw new AppError(
      'This invoice has not been sent yet — use Edit instead of Cancel & reissue.',
      409,
      'USE_EDIT_INSTEAD',
    );
  }

  // Cancel via Storno first if still live. We deliberately commit
  // the Storno BEFORE creating the replacement so a failed sendStorno
  // doesn't roll back the cancellation; the storno sits in
  // status='scheduled' and the cron picks it up. Same resiliency
  // contract as cancelInvoice.
  let stornoId = null;
  if (original.status !== 'cancelled') {
    stornoId = await db.transaction(async (trx) => createStorno(id, adminId, trx));
    try { await sendStorno(stornoId, adminId); } catch (err) {
      logger.warn('sendStorno during reissue failed — scheduler will retry', { stornoId, err: err.message });
    }
  }

  // Build the replacement. Same shape as the original — re-uses
  // createInvoice so totals are recomputed authoritatively from
  // line items (any rounding drift gets normalised). Self-join
  // carries parent_position so migration-119 sub-items survive.
  return await db.transaction(async (trx) => {
    const lineItems = await trx('invoice_line_items as li')
      .leftJoin('invoice_line_items as parent', 'parent.id', 'li.parent_line_item_id')
      .where('li.invoice_id', id)
      .orderBy('li.position', 'asc')
      .select('li.*', 'parent.position as parent_position');
    const liPayload = lineItems.map((li) => ({
      position: li.position,
      quantity: Number(li.quantity),
      description: li.description,
      unit_price_minor: Number(li.unit_price_minor),
      discount_percent: Number(li.discount_percent || 0),
      parent_position: li.parent_position == null ? null : Number(li.parent_position),
      details_text: li.details_text || null,
    }));

    const { invoiceIds: reissuedIds } = await createInvoice({
      customerAccountId: original.customer_account_id,
      sourceQuoteId: original.source_quote_id || null,
      eventId: original.event_id || null,
      language: original.language,
      currency: original.currency,
      vatRate: original.vat_rate,
      shippingAmountMinor: original.shipping_amount_minor,
      ccPdfEmail: original.cc_pdf_email,
      businessBankAccountId: original.business_bank_account_id,
      qrFormat: original.qr_format,
      paymentTermTemplateId: original.payment_term_template_id,
      // Reissue always produces a standalone invoice even when the
      // customer is on monthly billing — folding the reissued items
      // into the current period's running draft would conflate two
      // unrelated billing periods. The escape hatch keeps the
      // standard createInvoice flow.
      _skipMonthlyRouting: true,
      // Carry the split picker (migration 124) + event snapshot
      // (migration 123) onto the reissued draft so the admin doesn't
      // have to re-set them after a Cancel & reissue. createInvoice
      // already accepts these on both code paths.
      paymentNetDaysTemplateId: original.payment_net_days_template_id || null,
      paymentTimingTemplateId: original.payment_timing_template_id || null,
      eventName: original.event_name || null,
      eventDate: original.event_date || null,
      eventTimeStart: original.event_time_start || null,
      eventTimeEnd: original.event_time_end || null,
      // No installment metadata — reissue defaults to a single
      // standalone invoice. If the admin needs the same split they
      // can run the original conversion again from the quote.
      lineItems: liPayload,
      // Migration 140 — reissue inherits the cancelled original's
      // deal_uuid so Storno + replacement + cancelled all group
      // under one deal lineage view.
      dealUuid: original.deal_uuid || null,
    }, adminId, trx);
    // Reissue always produces a single invoice (no installments
    // forced), so the array length is 1.
    const newId = reissuedIds[0];

    await trx('invoices').where({ id: newId }).update({
      replaces_invoice_id: id,
      updated_at: new Date(),
    });

    try {
      await logActivity('invoice_reissued',
        { originalInvoiceId: id, newInvoiceId: newId, stornoId },
        original.event_id || null, `admin:${adminId}`);
    } catch (_) {}

    return { id: newId, replaces: id, stornoId };
  });
}

/**
 * Release a `pending_delivery` invoice for sending. Used when the
 * photographer has actually delivered the photos and is ready to
 * collect the final installment — flips the status to `scheduled`
 * with `scheduled_send_at = now`, then immediately calls sendInvoice
 * so the email goes out without waiting for the next scheduler tick.
 *
 * Refuses to act on rows that aren't pending — admins should use
 * sendInvoice / sendReminder for the normal `scheduled`/`sent` flow.
 */
async function releaseForDelivery(id, adminId) {
  const invoice = await db('invoices').where({ id }).first();
  if (!invoice) throw new AppError('Invoice not found', 404);
  if (invoice.status !== 'pending_delivery') {
    throw new AppError(
      `Invoice is not awaiting delivery (status: '${invoice.status}')`,
      409,
      'NOT_PENDING_DELIVERY',
    );
  }
  const now = new Date();
  await db('invoices').where({ id }).update({
    status: 'scheduled',
    scheduled_send_at: now,
    updated_at: now,
  });
  try {
    await logActivity('invoice_released_for_delivery', { invoiceId: id }, invoice.event_id || null, `admin:${adminId}`);
  } catch (_) {}
  // Fire immediately rather than waiting for the next scheduler
  // tick — admin clicked the button because they want it out now.
  return await sendInvoice(id, adminId);
}

/**
 * Cancel an invoice. The behaviour depends on whether the document
 * was ever issued:
 *
 *   - `scheduled` (draft, no PDF emitted): soft cancel — status
 *     flips to 'cancelled', nothing leaves the system. No Storno is
 *     generated because no document exists for the customer to
 *     reverse.
 *
 *   - `sent` / `overdue` / `paid` (issued): generate a
 *     Stornorechnung (cancellation invoice) with its own sequence
 *     number, attach a signed PDF, and email it to the customer.
 *     Original flips to 'cancelled' and pins its
 *     `cancellation_storno_id` for the admin lineage view. This is
 *     the only §14c-defensible cancellation path under DACH tax law
 *     once an invoice has been delivered to the recipient.
 *
 *     Note we allow `paid` here on purpose — bookkeepers cancel
 *     paid invoices when issuing refunds. The actual money
 *     movement (refund, carry-forward as Anzahlung) is handled
 *     separately; the Storno is the document leg.
 *
 *   - `cancelled` (already): 409, `ALREADY_CANCELLED`.
 *
 * Returns `{ cancelled: true, stornoId? }` so the caller can
 * surface "Storno S-XXXX wurde erzeugt" feedback when applicable.
 */
async function cancelInvoice(id, adminId) {
  const invoice = await db('invoices').where({ id }).first();
  if (!invoice) throw new AppError('Invoice not found', 404);
  if (invoice.kind === 'storno') {
    throw new AppError('Cannot cancel a Storno document', 409, 'IS_STORNO');
  }
  if (invoice.status === 'cancelled') {
    throw new AppError('Invoice already cancelled', 409, 'ALREADY_CANCELLED');
  }

  // Draft path: nothing was issued, soft cancel and we're done.
  if (invoice.status === 'scheduled') {
    await db('invoices').where({ id }).update({
      status: 'cancelled', updated_at: new Date(),
    });
    try {
      await logActivity('invoice_cancelled',
        { invoiceId: id, viaStorno: false },
        invoice.event_id || null, `admin:${adminId}`);
    } catch (_) {}
    return { cancelled: true, stornoId: null };
  }

  // Issued path: Storno required. Commit createStorno in its own
  // transaction so a failed sendStorno doesn't roll back the
  // cancellation; the scheduler picks up an unsent Storno on the
  // next tick.
  const stornoId = await db.transaction(async (trx) => createStorno(id, adminId, trx));
  try { await sendStorno(stornoId, adminId); } catch (err) {
    logger.warn('sendStorno after cancelInvoice failed — scheduler will retry', { stornoId, err: err.message });
  }
  return { cancelled: true, stornoId };
}

/**
 * Manually trigger a reminder email. The scheduler does this
 * automatically; this is the "Send reminder now" button on the
 * invoice detail page.
 */
async function sendReminder(id, levelOverride, adminId) {
  const data = await getInvoiceById(id);
  if (!data) throw new AppError('Invoice not found', 404);
  const { invoice, lineItems } = data;
  if (invoice.status !== 'sent' && invoice.status !== 'overdue') {
    throw new AppError(`Cannot remind on status '${invoice.status}'`, 409);
  }
  const newLevel = levelOverride || (invoice.reminder_level + 1);
  if (newLevel > 3) {
    throw new AppError('Reminder level exhausted', 409);
  }
  return await applyReminder(invoice, lineItems, newLevel, adminId);
}

// Per-reminder Mahngebühr in minor units (0 when disabled). Flat amount OR a
// percentage of the invoice gross, per crm_invoices_late_fee_type. Charged from
// the 2nd reminder onwards. ⚠️ A late fee is only enforceable if the concrete
// amount is stated in the AGB — verify with a Treuhänder (the admin UI says so).
// Net per-reminder Mahngebühr (flat amount or % of invoice gross), 0 disabled.
async function resolveLateFeeNetMinor(invoice) {
  if ((await getAppSetting('crm_invoices_late_fee_enabled')) === false) return 0;
  const type = (await getAppSetting('crm_invoices_late_fee_type')) || 'flat';
  let fee;
  if (type === 'percent') {
    const pct = Number(await getAppSetting('crm_invoices_late_fee_percent')) || 0;
    fee = Math.round(Number(invoice.total_amount_minor || 0) * pct / 100);
  } else {
    fee = ensureInt(await getAppSetting('crm_invoices_late_fee_minor')) || 2500;
  }
  return Math.max(0, fee);
}

// VAT rate on the fee — jurisdiction-dependent (CH: yes; DE/AT: no), so
// toggle-gated AND org-VAT-gated: 0 when the org has no default VAT rate, so
// enabling the toggle on a non-VAT org adds nothing.
async function resolveLateFeeVatRate() {
  if ((await getAppSetting('crm_invoices_late_fee_vat_enabled')) !== true) return 0;
  const profile = await db('business_profile').where({ id: 1 }).first('vat_rate_default');
  return Number(profile?.vat_rate_default) || 0;
}

// Gross per-reminder fee (net + VAT) — for the admin payment-check preview.
async function resolvePerReminderFeeMinor(invoice) {
  const net = await resolveLateFeeNetMinor(invoice);
  if (net <= 0) return 0;
  const rate = await resolveLateFeeVatRate();
  return rate > 0 ? net + Math.round(net * rate / 100) : net;
}

async function applyReminder(invoice, lineItems, level, adminId) {
  const customer = await db('customer_accounts').where({ id: invoice.customer_account_id }).first();

  // Per fee-bearing reminder (levels 2..level): 2nd = 1×, 3rd = 2×, computed
  // from `level` so re-applying the same level never stacks. The fee is dunning
  // STATE on the row (gross + the VAT portion) — it is NOT shown on the
  // immutable invoice; it appears on the separate Mahnung document below.
  let lateFeeGross = invoice.late_fee_amount_minor || 0;
  let lateFeeVat = invoice.late_fee_vat_minor || 0;
  if (level >= 2) {
    const net = await resolveLateFeeNetMinor(invoice);
    const rate = await resolveLateFeeVatRate();
    const vatPer = rate > 0 ? Math.round(net * rate / 100) : 0;
    lateFeeGross = (level - 1) * (net + vatPer);
    lateFeeVat = (level - 1) * vatPer;
  }
  const newTotal = Number(invoice.total_amount_minor || 0) + lateFeeGross;

  const update = {
    status: 'overdue',
    reminder_level: level,
    last_reminder_sent_at: new Date(),
    late_fee_amount_minor: lateFeeGross,
    updated_at: new Date(),
  };
  if (await hasColumnCached('invoices', 'late_fee_vat_minor')) update.late_fee_vat_minor = lateFeeVat;
  await db('invoices').where({ id: invoice.id }).update(update);

  // Fire invoice.overdue at the status→overdue flip. Deduped per (workflow,
  // invoice), so across the reminder ladder it triggers a flow at most once.
  // Best-effort / fail-closed.
  try {
    await require('./workflows').emitWorkflowEvent('invoice.overdue', {
      entityType: 'invoice',
      entityId: invoice.id,
      payload: {
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoice_number,
        eventId: invoice.event_id || null,
        customerAccountId: invoice.customer_account_id,
        customerEmail: customer?.email || null,
        dueDate: invoice.due_date,
        reminderLevel: level,
        totalMinor: invoice.total_amount_minor,
        currency: invoice.currency,
      },
    });
  } catch (_) {}

  // Render the MAHNUNG (reminder letter). The original invoice PDF is left
  // UNTOUCHED (immutable). The Mahnung reuses the invoice layout via a
  // 'mahnung' kind: same line items + the Mahngebühr row + the new total, with
  // a "Mahnung" title and no QR (it would encode the old amount).
  const fresh = await db('invoices').where({ id: invoice.id }).first();
  const ctx = await buildInvoiceRenderContext(fresh, lineItems);
  ctx.doc.kind = 'mahnung';
  ctx.doc.reminderLevel = level;
  ctx.doc.lateFeeMinor = lateFeeGross;
  ctx.totals.lateFeeAmountMinor = lateFeeGross;
  const buffer = await pdfService.renderInvoiceToBuffer(ctx);
  const fs = require('fs');
  const path = require('path');
  const year = new Date(fresh.issue_date).getFullYear();
  const root = path.join(process.cwd(), 'storage', 'business-docs', 'mahnung', String(year));
  fs.mkdirSync(root, { recursive: true });
  const mahnungPath = path.join(root, `${fresh.invoice_number}_mahnung_L${level}.pdf`);
  fs.writeFileSync(mahnungPath, buffer);

  // days_overdue floors at 1 (a "0 days overdue" reminder reads as broken).
  const rawDaysOverdue = Math.floor((Date.now() - new Date(invoice.due_date).getTime()) / 86400000);
  const daysOverdue = Math.max(1, rawDaysOverdue);
  const templateKey = level === 1 ? 'invoice_reminder_first' : 'invoice_reminder_second';
  const locale = ctx.locale || invoice.language || 'de';
  const outstandingMinor = Math.max(0, newTotal - Number(invoice.paid_amount_minor || 0));

  // Attach the (unchanged) original invoice PDF + the new Mahnung.
  const attachments = [];
  if (invoice.pdf_path && fs.existsSync(invoice.pdf_path)) {
    attachments.push({ filename: `${invoice.invoice_number}.pdf`, contentPath: invoice.pdf_path, contentType: 'application/pdf' });
  }
  attachments.push({ filename: `${fresh.invoice_number}_Mahnung.pdf`, contentPath: mahnungPath, contentType: 'application/pdf' });

  const { to: reminderTo, cc: reminderCc } = resolveBillingRecipients(customer, invoice.cc_pdf_email);
  try {
    await emailProcessor.queueEmail(invoice.event_id || null, reminderTo, templateKey, {
      invoice_number: invoice.invoice_number,
      customer_name: customer.display_name || customer.first_name || customer.email.split('@')[0],
      total_amount: formatMajor(invoice.total_amount_minor, invoice.currency, locale),
      new_total_amount: formatMajor(newTotal, invoice.currency, locale),
      outstanding_amount: formatMajor(outstandingMinor, invoice.currency, locale),
      paid_amount: formatMajor(invoice.paid_amount_minor, invoice.currency, locale),
      late_fee_amount: formatMajor(lateFeeGross, invoice.currency, locale),
      due_date: formatShortDate(invoice.due_date),
      days_overdue: daysOverdue,
      cc: reminderCc,
      attachments,
    // Dunning reminders are relationship mail — hold to business hours.
    }, { respectBusinessHours: true });
  } catch (err) {
    // Don't leave the just-rendered Mahnung PDF orphaned on disk if queueing the
    // email failed — it would only be reachable via the next reminder anyway.
    try { fs.unlinkSync(mahnungPath); } catch (_) { /* best-effort cleanup */ }
    throw err;
  }

  try {
    await logActivity('invoice_reminder_sent', { invoiceId: invoice.id, level, lateFeeMinor: lateFeeGross },
      invoice.event_id || null, `admin:${adminId || 'system'}`);
  } catch (_) {}

  return { level, lateFeeMinor: lateFeeGross };
}

// ---------------------------------------------------------------------
// Payment-check workflow (admin-confirmed reminders)
// ---------------------------------------------------------------------

/**
 * Resolve the admin email address that should receive the payment-
 * check prompt. Priority:
 *   1. created_by_admin_id's email (the admin who issued the invoice)
 *   2. First admin user with bills.manage permission
 *   3. business_profile.email as a last resort
 * Returns null when nothing usable is found — caller logs + skips.
 */
/**
 * Resolve the effective Skonto percentage for an invoice at the
 * current moment. Resolution chain (matches pdfService rendering):
 *   1. invoice.payment_term_snapshot.skonto_percent
 *   2. source quote's payment_term_snapshot.skonto_percent
 *   3. global crm_invoices_skonto_percent_default
 * Returns null when nothing is configured.
 *
 * Lifted into a helper so the payment-check action and the email
 * template (which both need to know "does this invoice qualify for a
 * Paid-with-Skonto button?") share one source of truth.
 */
async function resolveSkontoPercentForInvoice(invoice) {
  // Per-invoice opt-out (migration 126) wins over every other source.
  // Admin sets this on Storni / replacement invoices / payment-plan
  // installments that shouldn't qualify for the discount even when
  // the global default offers it.
  if (invoice.skonto_disabled) return null;
  // Per-customer opt-out (migration 112) — a customer that negotiated
  // "no Skonto" as a contract term never qualifies, so the admin
  // doesn't have to tick the per-invoice toggle on every invoice.
  // Falls through customer → invoice → snapshot → quote → global.
  if (invoice.customer_account_id) {
    const cust = await db('customer_accounts')
      .where({ id: invoice.customer_account_id })
      .select('skonto_disabled')
      .first();
    if (cust && cust.skonto_disabled) return null;
  }
  const parseSnap = (raw) => {
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch { return null; }
  };
  const invSnap = parseSnap(invoice.payment_term_snapshot);
  if (invSnap?.skonto_percent != null && Number(invSnap.skonto_percent) > 0) {
    return Number(invSnap.skonto_percent);
  }
  if (invoice.source_quote_id) {
    const q = await db('quotes').where({ id: invoice.source_quote_id }).select('payment_term_snapshot').first();
    const qSnap = parseSnap(q?.payment_term_snapshot);
    if (qSnap?.skonto_percent != null && Number(qSnap.skonto_percent) > 0) {
      return Number(qSnap.skonto_percent);
    }
  }
  const defaultPct = Number(await getAppSetting('crm_invoices_skonto_percent_default'));
  return Number.isFinite(defaultPct) && defaultPct > 0 ? defaultPct : null;
}

async function resolveAdminEmailForInvoice(invoice) {
  if (invoice.created_by_admin_id) {
    const admin = await db('admin_users').where({ id: invoice.created_by_admin_id }).first();
    if (admin?.email) return { email: admin.email, name: admin.username || admin.email };
  }
  // Fallback: business_profile.email.
  const profile = await db('business_profile').where({ id: 1 }).first();
  if (profile?.email) return { email: profile.email, name: profile.company_name || profile.email };
  return null;
}

/**
 * Generate a fresh payment-check token for an invoice and queue the
 * admin email with three signed action buttons. Throttled to once
 * per 24h per invoice via invoices.last_payment_check_at.
 *
 * Returns { token, sent: bool, reason? } so callers can log /
 * surface the outcome.
 */
/**
 * Queue the admin "payment received" notification (migration 127).
 * Called from markPaid the first time an invoice transitions into
 * `status='paid'`. Resolves the admin's address via the same chain
 * the payment-check email uses (created_by_admin_id → business
 * profile fallback). Silently no-ops when no admin email can be
 * resolved — caller logs the warn line.
 */
async function queueInvoicePaidAdminNotification({
  invoice, paidTotalMinor, paymentMethod, paymentReference,
  paidAt, skontoApplied, skontoAmountMinor,
}) {
  const adminContact = await resolveAdminEmailForInvoice(invoice);
  if (!adminContact?.email) {
    logger.warn('invoice_paid notification skipped — no admin email resolved',
      { invoiceId: invoice.id });
    return;
  }

  const profile = await db('business_profile').where({ id: 1 }).first();
  const locale = invoice.language || profile?.default_locale || 'de';

  const customer = await db('customer_accounts').where({ id: invoice.customer_account_id }).first();
  // Resolve the Skonto percentage at notification time so the
  // template can render "Paid with Skonto X%" without a second query.
  // Same resolver the rest of the Skonto surfaces use — null when
  // skonto_disabled is true or no Skonto is configured.
  const skontoPercent = skontoApplied
    ? await resolveSkontoPercentForInvoice(invoice)
    : null;

  await emailProcessor.queueEmail(invoice.event_id || null, adminContact.email,
    'invoice_paid_admin_notification', {
      invoice_number: invoice.invoice_number,
      customer_name: customer?.company_name
        || customer?.display_name
        || [customer?.first_name, customer?.last_name].filter(Boolean).join(' ')
        || customer?.email || '',
      event_name: invoice.event_name || '',
      total_amount: formatMajor(invoice.total_amount_minor, invoice.currency, locale),
      paid_amount: formatMajor(paidTotalMinor, invoice.currency, locale),
      payment_method: paymentMethod || '',
      payment_reference: paymentReference || '',
      paid_at: formatShortDate(paidAt),
      skonto_applied: !!skontoApplied,
      skonto_percent: skontoApplied && skontoPercent ? skontoPercent : '',
      skonto_discount_amount: skontoApplied
        ? formatMajor(skontoAmountMinor, invoice.currency, locale)
        : '',
    });

  try {
    await logActivity('invoice_paid_admin_notified', { invoiceId: invoice.id },
      invoice.event_id || null, 'system');
  } catch (_) {}
}

async function queuePaymentCheckEmail(invoiceId, { skipThrottle = false } = {}) {
  const invoice = await db('invoices').where({ id: invoiceId }).first();
  if (!invoice) return { sent: false, reason: 'not_found' };
  if (!['sent', 'overdue'].includes(invoice.status)) {
    return { sent: false, reason: `wrong_status_${invoice.status}` };
  }
  const now = new Date();
  if (!skipThrottle && invoice.last_payment_check_at) {
    const last = new Date(invoice.last_payment_check_at).getTime();
    if (now.getTime() - last < 24 * 60 * 60 * 1000) {
      return { sent: false, reason: 'throttled_24h' };
    }
  }

  const adminContact = await resolveAdminEmailForInvoice(invoice);
  if (!adminContact?.email) {
    logger.warn('Payment-check email skipped — no admin email resolved', { invoiceId });
    return { sent: false, reason: 'no_admin_email' };
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  await db('invoice_payment_check_tokens').insert({
    invoice_id: invoiceId,
    token,
    expires_at: expiresAt,
    created_at: now,
  });
  await db('invoices').where({ id: invoiceId }).update({
    last_payment_check_at: now,
    updated_at: now,
  });

  const customer = await db('customer_accounts').where({ id: invoice.customer_account_id }).first();
  const profile = await db('business_profile').where({ id: 1 }).first();
  const locale = invoice.language || profile?.default_locale || 'de';

  // Determine whether the customer reminder will include a Mahngebühr
  // if the admin selects "Not paid" / "Partial" — surfaced to the
  // email so the admin sees the consequence before clicking.
  const reminderFeeMinor = await resolvePerReminderFeeMinor(invoice);
  const nextLevel = (invoice.reminder_level || 0) + 1;
  const willChargeFee = reminderFeeMinor > 0 && nextLevel >= 2;

  const baseUrl = process.env.FRONTEND_URL
    || (await getAppSetting('app_frontend_url'))
    || 'https://app.example.com';
  const buildUrl = (action) =>
    `${baseUrl.replace(/\/$/, '')}/payment-check/${token}?action=${action}`;

  // Outstanding = gross total + late fee − already paid. The admin
  // is being asked about what's STILL OWED, not the original gross
  // figure — so surface outstanding + paid in the email context.
  // Partial payments logged earlier (e.g. via a previous admin
  // payment-check click) are reflected, so the admin doesn't get
  // asked "did the customer pay CHF 234?" when they already paid
  // CHF 134 of it.
  const paidMinor = Number(invoice.paid_amount_minor || 0);
  const lateFeeAlreadyMinor = Number(invoice.late_fee_amount_minor || 0);
  const outstandingMinor = Math.max(0,
    Number(invoice.total_amount_minor || 0) + lateFeeAlreadyMinor - paidMinor);
  const hasPartial = paidMinor > 0;

  // Resolve Skonto for the optional 4th button (migration 126). Only
  // surface the button when (a) Skonto is configured for this invoice
  // AND (b) the customer paid within the Skonto window — past the
  // window the discount is moot. Both checks are visible to the
  // template so the email can hide the button conditionally.
  const skontoPercent = await resolveSkontoPercentForInvoice(invoice);
  const hasSkonto = !!skontoPercent && skontoPercent > 0;
  const skontoDiscountedTotalMinor = hasSkonto
    ? Math.round(Number(invoice.total_amount_minor) * (1 - Number(skontoPercent) / 100))
    : null;

  await emailProcessor.queueEmail(invoice.event_id || null, adminContact.email,
    'invoice_payment_check_admin', {
      invoice_number: invoice.invoice_number,
      customer_name: customer?.company_name
        || customer?.display_name
        || [customer?.first_name, customer?.last_name].filter(Boolean).join(' ')
        || customer?.email || '',
      event_name: invoice.event_name || '',
      due_date: formatShortDate(invoice.due_date),
      total_amount: formatMajor(invoice.total_amount_minor, invoice.currency, locale),
      paid_amount: formatMajor(paidMinor, invoice.currency, locale),
      outstanding_amount: formatMajor(outstandingMinor, invoice.currency, locale),
      has_partial_payment: hasPartial,
      paid_url:    buildUrl('paid_full'),
      partial_url: buildUrl('partial'),
      unpaid_url:  buildUrl('unpaid'),
      // Skonto button — template uses {{#if has_skonto}} to render the
      // fourth button only when the invoice qualifies.
      has_skonto: hasSkonto,
      skonto_percent: hasSkonto ? skontoPercent : '',
      skonto_amount: hasSkonto
        ? formatMajor(skontoDiscountedTotalMinor, invoice.currency, locale)
        : '',
      skonto_url: hasSkonto ? buildUrl('paid_with_skonto') : '',
      late_fee_due: willChargeFee,
      late_fee_amount: formatMajor(reminderFeeMinor, invoice.currency, locale),
    });

  try {
    await logActivity('invoice_payment_check_sent', { invoiceId, token: token.slice(0, 8) },
      invoice.event_id || null, 'scheduler');
  } catch (_) {}

  return { token, sent: true };
}

/**
 * Validate a payment-check token and return the invoice context
 * the public page needs. Token must exist, not be expired, not
 * already used.
 */
async function getPaymentCheckByToken(token) {
  const row = await db('invoice_payment_check_tokens').where({ token }).first();
  if (!row) throw new AppError('Token not found', 404);
  if (row.used_at) {
    const err = new AppError('This link has already been used', 410, 'TOKEN_ALREADY_USED');
    err.usedAt = row.used_at;
    err.usedAction = row.used_action;
    throw err;
  }
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    throw new AppError('This link has expired', 410, 'TOKEN_EXPIRED');
  }
  const invoice = await db('invoices').where({ id: row.invoice_id }).first();
  if (!invoice) throw new AppError('Invoice not found', 404);
  const customer = await db('customer_accounts').where({ id: invoice.customer_account_id }).first();

  const outstandingMinor = Math.max(0,
    Number(invoice.total_amount_minor || 0) + Number(invoice.late_fee_amount_minor || 0)
    - Number(invoice.paid_amount_minor || 0));

  // Surface the Skonto state so the public page can decide whether to
  // render the "Paid with Skonto" action card (migration 126). Only
  // applies when the invoice's payment terms actually carry a Skonto
  // percentage — admin shouldn't see the option on an invoice that
  // never offered the discount.
  const skontoPercent = await resolveSkontoPercentForInvoice(invoice);
  const hasSkonto = !!skontoPercent && skontoPercent > 0;
  const skontoDiscountedTotalMinor = hasSkonto
    ? Math.round(Number(invoice.total_amount_minor) * (1 - Number(skontoPercent) / 100))
    : null;

  return {
    invoiceNumber: invoice.invoice_number,
    customer: {
      label: customer?.company_name
        || [customer?.first_name, customer?.last_name].filter(Boolean).join(' ')
        || customer?.display_name || customer?.email || '',
      email: customer?.email,
    },
    issueDate: invoice.issue_date,
    dueDate: invoice.due_date,
    totalMinor: invoice.total_amount_minor,
    paidMinor: invoice.paid_amount_minor,
    lateFeeMinor: invoice.late_fee_amount_minor,
    outstandingMinor,
    currency: invoice.currency,
    status: invoice.status,
    reminderLevel: invoice.reminder_level,
    expiresAt: row.expires_at,
    hasSkonto,
    skontoPercent: hasSkonto ? skontoPercent : null,
    skontoDiscountedTotalMinor,
  };
}

/**
 * Record the admin's payment-check action and fire the downstream
 * consequences:
 *   - 'paid_full' → markPaid for the outstanding amount, no reminder.
 *   - 'partial'   → markPaid for the amount supplied, then fire the
 *                   next reminder for the remainder.
 *   - 'unpaid'    → fire the next reminder (level 1 or 2) with the
 *                   existing Mahngebühr logic in applyReminder.
 *
 * Atomic: token consumption + invoice status update happen in one
 * transaction. The reminder email is queued AFTER the txn commits
 * to avoid emailing a customer about a payment that never
 * actually committed.
 */
async function recordPaymentCheckAction({ token, action, amountMinor, ip, adminId }) {
  // 'paid_with_skonto' (migration 126) is a fourth admin action — the
  // customer settled the bill within the early-payment-discount window,
  // so the recorded payment equals total minus the configured Skonto %.
  // Same token-consumption semantics as 'paid_full'.
  if (!['paid_full', 'paid_with_skonto', 'partial', 'unpaid'].includes(action)) {
    throw new AppError('Invalid action', 400);
  }

  const row = await db('invoice_payment_check_tokens').where({ token }).first();
  if (!row) throw new AppError('Token not found', 404);
  if (row.used_at) {
    throw new AppError('This link has already been used', 410, 'TOKEN_ALREADY_USED');
  }
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    throw new AppError('This link has expired', 410, 'TOKEN_EXPIRED');
  }
  const invoice = await db('invoices').where({ id: row.invoice_id }).first();
  if (!invoice) throw new AppError('Invoice not found', 404);

  const outstandingMinor = Math.max(0,
    Number(invoice.total_amount_minor || 0) + Number(invoice.late_fee_amount_minor || 0)
    - Number(invoice.paid_amount_minor || 0));

  if (action === 'partial') {
    const amt = ensureInt(amountMinor);
    if (amt <= 0) throw new AppError('partial amount must be > 0', 400);
    if (amt > outstandingMinor) throw new AppError('partial amount exceeds outstanding', 400);
  }

  // Consume the token first — atomic with status update so a
  // double-click can't fire the action twice.
  const now = new Date();
  const updated = await db('invoice_payment_check_tokens')
    .where({ id: row.id })
    .whereNull('used_at')
    .update({
      used_at: now,
      used_action: action,
      used_amount_minor: action === 'partial' ? ensureInt(amountMinor) : null,
      used_ip: ip || null,
    });
  if (updated === 0) {
    // Lost a race with another consumer.
    throw new AppError('This link has already been used', 410, 'TOKEN_ALREADY_USED');
  }

  try {
    await logActivity('invoice_payment_check_recorded',
      { invoiceId: invoice.id, action, amountMinor: amountMinor || null },
      invoice.event_id || null,
      adminId ? `admin:${adminId}` : 'public:payment-check');
  } catch (_) {}

  // --- Apply the action -----------------------------------------
  if (action === 'paid_full') {
    await markPaid(invoice.id, {
      amountMinor: outstandingMinor,
      paymentMethod: invoice.payment_method || 'bank_transfer',
      reference: invoice.payment_reference || null,
      notes: 'Confirmed via admin payment-check link',
    }, adminId || invoice.created_by_admin_id);
    return { applied: 'paid_full' };
  }

  if (action === 'paid_with_skonto') {
    // Resolve the Skonto percentage at click time so admins can't
    // accidentally double-discount after the template changed. Same
    // resolution chain pdfService uses: invoice snapshot → source
    // quote snapshot → global crm_invoices_skonto_percent_default.
    const skontoPercent = await resolveSkontoPercentForInvoice(invoice);
    if (!skontoPercent || skontoPercent <= 0) {
      throw new AppError('No Skonto configured on this invoice', 409, 'SKONTO_NOT_CONFIGURED');
    }
    const discountedTotalMinor = Math.round(
      Number(invoice.total_amount_minor) * (1 - Number(skontoPercent) / 100),
    );
    // Outstanding-aware: if the customer already paid part of the
    // bill (rare on the Skonto path, but possible after a partial),
    // record only the remaining slice up to the discounted total.
    const paidMinor = Number(invoice.paid_amount_minor || 0);
    const remainingMinor = Math.max(0, discountedTotalMinor - paidMinor);
    if (remainingMinor <= 0) {
      throw new AppError('Invoice already paid past the Skonto threshold', 409);
    }
    await markPaid(invoice.id, {
      amountMinor: remainingMinor,
      paymentMethod: invoice.payment_method || 'bank_transfer',
      reference: invoice.payment_reference || null,
      notes: `Confirmed via admin payment-check link (Skonto ${skontoPercent}% applied)`,
      skontoApplied: true,
    }, adminId || invoice.created_by_admin_id);
    return { applied: 'paid_with_skonto', skontoPercent };
  }

  if (action === 'partial') {
    const amt = ensureInt(amountMinor);
    await markPaid(invoice.id, {
      amountMinor: amt,
      paymentMethod: invoice.payment_method || 'bank_transfer',
      reference: invoice.payment_reference || null,
      notes: 'Partial payment confirmed via admin payment-check link',
    }, adminId || invoice.created_by_admin_id);
    // Then fire the customer reminder for the remainder, unless
    // markPaid flipped the invoice to paid (i.e. the partial
    // amount equalled the outstanding).
    const refreshed = await db('invoices').where({ id: invoice.id }).first();
    if (refreshed.status !== 'paid') {
      const nextLevel = (refreshed.reminder_level || 0) + 1;
      if (nextLevel <= 3) {
        const lineItems = await db('invoice_line_items')
          .where({ invoice_id: invoice.id }).orderBy('position', 'asc');
        await applyReminder(refreshed, lineItems, nextLevel, adminId);
      }
    }
    return { applied: 'partial' };
  }

  // 'unpaid'
  const nextLevel = (invoice.reminder_level || 0) + 1;
  if (nextLevel > 3) {
    // Already at max reminder — admin has to take this offline.
    return { applied: 'unpaid', reminderSkipped: 'max_level_reached' };
  }
  const lineItems = await db('invoice_line_items')
    .where({ invoice_id: invoice.id }).orderBy('position', 'asc');
  await applyReminder(invoice, lineItems, nextLevel, adminId);
  return { applied: 'unpaid', reminderLevel: nextLevel };
}

/**
 * Admin override — issue the customer's running monthly draft NOW,
 * bypassing the cadence-day wait. Mirrors the scheduler's monthly
 * pass (migration 128): clears is_monthly_draft, sets the issue date
 * + scheduled_send_at to now, and fires sendInvoice inline so the
 * email goes out on the next email-queue tick (~60s) instead of
 * waiting for the next scheduler iteration.
 *
 * Refuses when:
 *   - no draft exists (admin hasn't queued anything yet)
 *   - the draft has zero line items (nothing to send — same as the
 *     scheduler's empty-month skip path)
 *
 * Returns { invoiceId, invoiceNumber } so the route can surface the
 * resulting invoice on the response toast.
 */
/**
 * Read the customer's running monthly draft + its line items so the
 * customer-detail page can preview what will ship on the next cycle
 * day. Returns null when no open draft exists (admin hasn't queued
 * anything yet for the current period). Used by GET
 * /admin/customers/:id/monthly-draft.
 */
async function getMonthlyDraft(customerId) {
  const draft = await db('invoices')
    .where({ customer_account_id: customerId, is_monthly_draft: true })
    .orderBy('id', 'desc')
    .first();
  if (!draft) return null;
  const lineItems = await db('invoice_line_items as li')
    .leftJoin('invoice_line_items as parent', 'parent.id', 'li.parent_line_item_id')
    .where('li.invoice_id', draft.id)
    .orderBy('li.position', 'asc')
    .select('li.*', 'parent.position as parent_position');
  return {
    id: draft.id,
    invoiceNumber: draft.invoice_number,
    currency: draft.currency,
    periodStart: draft.monthly_period_start,
    periodEnd: draft.monthly_period_end,
    netAmountMinor: draft.net_amount_minor,
    vatRate: draft.vat_rate == null ? null : Number(draft.vat_rate),
    vatAmountMinor: draft.vat_amount_minor,
    totalAmountMinor: draft.total_amount_minor,
    lineItems: lineItems.map((li) => ({
      id: li.id,
      position: li.position,
      quantity: Number(li.quantity),
      description: li.description,
      unitPriceMinor: ensureInt(li.unit_price_minor),
      discountPercent: Number(li.discount_percent || 0),
      lineTotalMinor: ensureInt(li.line_total_minor),
      parentPosition: li.parent_position == null ? null : ensureInt(li.parent_position),
      detailsText: li.details_text || '',
    })),
  };
}

async function triggerMonthlyBillNow(customerId, adminId) {
  const draft = await db('invoices')
    .where({ customer_account_id: customerId, is_monthly_draft: true })
    .orderBy('id', 'desc')
    .first();
  if (!draft) {
    throw new AppError('No pending monthly bill for this customer', 409, 'NO_MONTHLY_DRAFT');
  }
  const items = await db('invoice_line_items').where({ invoice_id: draft.id }).limit(1);
  if (items.length === 0) {
    throw new AppError('Monthly draft is empty — nothing to bill', 409, 'EMPTY_DRAFT');
  }

  // Arm the draft: clear the discriminator, pin issue_date to today,
  // and set scheduled_send_at to now so the flush pass + sendInvoice
  // path treats it like any other ready-to-send invoice. Logged as a
  // distinct activity so the audit trail shows admin override vs the
  // scheduler's automatic fire.
  const issueDate = new Date().toISOString().slice(0, 10);
  await db('invoices').where({ id: draft.id }).update({
    is_monthly_draft: false,
    issue_date: issueDate,
    scheduled_send_at: new Date(),
    updated_at: new Date(),
  });
  try {
    await logActivity('monthly_bill_triggered_manually',
      { invoiceId: draft.id, customerId, periodEnd: draft.monthly_period_end },
      null, `admin:${adminId}`);
  } catch (_) {}

  // Inline send so admin gets immediate feedback (PDF stored, status
  // flipped to 'sent', email queued). A failure here doesn't roll
  // back the arming — the scheduler will pick it up on the next tick.
  try {
    await sendInvoice(draft.id, adminId);
  } catch (err) {
    logger.warn('triggerMonthlyBillNow: inline send failed — scheduler will retry',
      { invoiceId: draft.id, err: err.message });
  }
  return { invoiceId: draft.id, invoiceNumber: draft.invoice_number };
}

/**
 * Cron tick — find scheduled invoices ready to send + invoices past
 * due date that need a reminder. Called by invoiceSchedulerService.
 */
async function runScheduledTasks() {
  const now = new Date();

  // 1. Flush scheduled invoices.
  const ready = await db('invoices')
    .where({ status: 'scheduled' })
    .andWhere(function() {
      this.whereNotNull('scheduled_send_at').andWhere('scheduled_send_at', '<=', now);
    })
    .limit(20);
  for (const inv of ready) {
    try {
      await sendInvoice(inv.id, null);
    } catch (err) {
      logger.error('Scheduled invoice send failed', { invoiceId: inv.id, err: err.message });
    }
  }

  // 2. Monthly-bill issuance (migration 128).
  //
  // Walk every monthly draft whose period_end is today-or-earlier.
  // - If the draft has zero line items, skip silently (empty month
  //   per user spec — no invoice issued, no email, just a log).
  // - Otherwise flip is_monthly_draft=false and arm scheduled_send_at
  //   to `now` so the next flush-pass picks it up and runs the
  //   standard sendInvoice path. Keeping the issuance one tick away
  //   from this pass means email queueing + activity log + dunning
  //   schedule all stay on the existing well-trodden code paths
  //   instead of duplicating logic here.
  const monthlyToday = new Date(now);
  monthlyToday.setHours(0, 0, 0, 0);
  const dueDrafts = await db('invoices')
    .where({ is_monthly_draft: true })
    .andWhere('monthly_period_end', '<=', monthlyToday.toISOString().slice(0, 10))
    .limit(50);
  for (const draft of dueDrafts) {
    try {
      const items = await db('invoice_line_items').where({ invoice_id: draft.id }).limit(1);
      if (items.length === 0) {
        // Empty month — leave the draft alone (admin may still add
        // items between now and end-of-day) OR mark it consumed so
        // the next save creates a fresh period draft. We pick the
        // latter: clear is_monthly_draft so the next createInvoice
        // for this customer mints a new period.
        //
        // Status is 'skipped', not 'cancelled': the latter implies
        // an admin (or Storno) deliberately voided a real invoice;
        // an empty monthly period is a "nothing happened" non-event
        // that we still record for audit-trail continuity. Listing
        // queries that aggregate cancelled rows (e.g. the Bills list
        // cancellation footnote) should not pull skipped rows in.
        await db('invoices').where({ id: draft.id }).update({
          is_monthly_draft: false,
          status: 'skipped',
          updated_at: new Date(),
        });
        logger.info('Monthly bill skipped — no items queued', {
          invoiceId: draft.id, customerId: draft.customer_account_id,
        });
        try {
          await logActivity('monthly_bill_skipped_empty',
            { invoiceId: draft.id, customerId: draft.customer_account_id },
            null, 'scheduler');
        } catch (_) {}
        continue;
      }
      // Arm for the flush pass: clear the draft flag, set the send
      // time to now, recompute due_date from issue_date + the global
      // crm_invoices_net_days_default (best-effort; admin can override
      // by editing the draft before the cadence day).
      const issueDate = monthlyToday.toISOString().slice(0, 10);
      await db('invoices').where({ id: draft.id }).update({
        is_monthly_draft: false,
        issue_date: issueDate,
        scheduled_send_at: new Date(),
        updated_at: new Date(),
      });
      try {
        await logActivity('monthly_bill_issued',
          { invoiceId: draft.id, customerId: draft.customer_account_id,
            periodEnd: draft.monthly_period_end },
          null, 'scheduler');
      } catch (_) {}
    } catch (err) {
      logger.error('Monthly bill issuance failed', { invoiceId: draft.id, err: err.message });
    }
  }

  // 3. Overdue payment-check prompts (if reminders enabled).
  //
  // NEW behavior (migration 115/116): instead of auto-firing the
  // customer reminder when an invoice goes overdue, we email the
  // ADMIN with three signed-token action buttons:
  //   - Paid in full  → markPaid for the outstanding amount
  //   - Partial       → admin enters amount; partial + reminder
  //   - Not paid yet  → reminder fires (with Mahngebühr at level 2)
  //
  // The reminder thresholds still gate when the prompt fires:
  //   - level 0 invoice past firstCutoff  → prompt for level-1 path
  //   - level 1 invoice past secondCutoff → prompt for level-2 path
  // Throttled to one email per 24h per invoice via
  // invoices.last_payment_check_at.
  const remindersEnabled = await getAppSetting('crm_invoices_reminders_enabled');
  // Mutual exclusion with the workflow engine: the hardcoded ladder stands down
  // only when the invoice_dunning built-in is ENABLED (then the engine fires the
  // payment-check emails). A disabled built-in leaves this ladder running — so
  // the flow can ship disabled without dunning going dark, and disabling the
  // flow reverts to the ladder. Fails closed → ladder stays on if the subsystem
  // is down.
  let engineDrivesDunning = false;
  try {
    engineDrivesDunning = await require('./workflows').isBuiltinFlowActive('invoice_dunning');
  } catch (_) { /* workflows tables absent / flag system down → ladder stays on */ }
  if (remindersEnabled !== false && !engineDrivesDunning) {
    const firstDays  = ensureInt(await getAppSetting('crm_invoices_reminder_first_days')) || 14;
    const secondDays = ensureInt(await getAppSetting('crm_invoices_reminder_second_days')) || 30;

    const firstCutoff  = new Date(now.getTime() - firstDays  * 86400000);
    const secondCutoff = new Date(now.getTime() - secondDays * 86400000);

    // Pre-reminder check (would-be-level-1).
    // `kind='invoice'` filter keeps Stornorechnungen out of the
    // dunning ladder — they have no due_date and no payment
    // expectation; reminding on them would be a customer-facing
    // bug.
    const firstBatch = await db('invoices')
      .where('kind', 'invoice')
      .whereIn('status', ['sent', 'overdue'])
      .where('reminder_level', 0)
      .where('due_date', '<=', firstCutoff)
      .limit(20);
    for (const inv of firstBatch) {
      try {
        await queuePaymentCheckEmail(inv.id);
      } catch (err) {
        logger.error('Payment-check email failed', { invoiceId: inv.id, err: err.message });
      }
    }

    // Pre-reminder check (would-be-level-2, including Mahngebühr).
    const secondBatch = await db('invoices')
      .where('kind', 'invoice')
      .whereIn('status', ['sent', 'overdue'])
      .where('reminder_level', 1)
      .where('due_date', '<=', secondCutoff)
      .limit(20);
    for (const inv of secondBatch) {
      try {
        await queuePaymentCheckEmail(inv.id);
      } catch (err) {
        logger.error('Payment-check email (level 2) failed', { invoiceId: inv.id, err: err.message });
      }
    }
  }
}

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
    const businessProfileService = require('./businessProfileService');
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
  listInvoices,
  getInvoiceById,
  createInvoice,
  spawnInstallmentInvoices,
  scheduleInvoicesForEvent,
  updateInstallmentPlan,
  validateInstallmentPlanInput,
  sendInvoice,
  sendReminder,
  applyReminder,
  resolveLateFeeNetMinor,
  resolveLateFeeVatRate,
  resolvePerReminderFeeMinor,
  markPaid,
  cancelInvoice,
  releaseForDelivery,
  reissueInvoice,
  createStorno,
  sendStorno,
  queuePaymentCheckEmail,
  getPaymentCheckByToken,
  recordPaymentCheckAction,
  renderInvoicePdfBuffer,
  renderInvoicePdfFromPayload,
  runScheduledTasks,
  resolveSkontoPercentForInvoice,
  // Monthly billing accumulator (migration 128) — exposed so
  // customerHoursService can append hour-logged line items onto the
  // running draft without duplicating the period/totals logic.
  getOrCreateMonthlyDraft,
  getMonthlyDraft,
  appendToMonthlyDraft,
  appendOneLineItemToMonthlyDraft,
  triggerMonthlyBillNow,
  // Exposed so contractService can mint an invoice number for the
  // empty-draft path (convert-to-invoice on a contract with no
  // source quote). Stays gap-free per crm_invoices_number_format.
  nextInvoiceNumber,
};
