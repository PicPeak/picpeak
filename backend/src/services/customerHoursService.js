/**
 * Customer hour-logging service (migration 129).
 *
 * Admin records discrete time blocks against a customer; each entry
 * eventually folds into an invoice as a single line item. Two flows:
 *
 *   1. Monthly-mode customer + feature_hours_logging on
 *      → saving an entry immediately appends a line item onto the
 *        running monthly draft (migration 128 accumulator) and flips
 *        the entry to status='billed'. Admin doesn't have to remember
 *        to convert; the running totals on the customer detail page
 *        reflect the bill that will eventually go out.
 *
 *   2. Per-event customer + feature_hours_logging on
 *      → entries sit at status='unbilled' until admin clicks
 *        "Bill these hours" (billUnbilledEntries below). That call
 *        mints a standalone invoice with one line per entry.
 *
 * Lockout: once an entry's invoice is "armed for send" (the monthly
 * scheduler has cleared is_monthly_draft + set scheduled_send_at, or
 * the invoice transitioned to sent/paid/cancelled), edits + deletes
 * are refused. Admin must Storno the invoice to change billed hours
 * — same legal-record discipline as line items today.
 */
const { db, logActivity } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const { AppError } = require('../utils/errors');
const { hasColumnCached } = require('../utils/schemaCache');
const logger = require('../utils/logger');
const invoiceService = require('./invoiceService');

// ---------------------------------------------------------------------
// Pure helpers — exported under `_internal` for direct unit testing.
// ---------------------------------------------------------------------

/**
 * Parse two "HH:MM" strings and return the elapsed minutes. Caller
 * has already validated that start < end; this throws if either is
 * malformed (defensive — UI should never send a non-conforming value).
 */
function computeDurationMinutes(start, end) {
  const re = /^([01]\d|2[0-3]):([0-5]\d)$/;
  if (!re.test(String(start))) throw new AppError(`Invalid start_time: ${start}`, 400);
  if (!re.test(String(end))) throw new AppError(`Invalid end_time: ${end}`, 400);
  const [sh, sm] = String(start).split(':').map((n) => parseInt(n, 10));
  const [eh, em] = String(end).split(':').map((n) => parseInt(n, 10));
  const startM = sh * 60 + sm;
  const endM = eh * 60 + em;
  if (endM <= startM) throw new AppError('end_time must be after start_time', 400);
  return endM - startM;
}

/**
 * Resolve the rate this entry should bill at. Resolution chain:
 *   1. per-entry override
 *   2. per-customer default rate
 *   3. install-wide default rate (business_profile, migration 113)
 * Only when all three are unset do we throw — the hours UI surfaces a
 * "set a rate" CTA off the back of HOURLY_RATE_REQUIRED rather than a
 * raw error. `installDefaultMinor` is loaded once per request by the
 * caller (see getInstallDefaultRateMinor) and passed in so this stays
 * a pure function.
 */
function resolveEffectiveRate(entry, customer, installDefaultMinor = null) {
  if (entry.hourly_rate_minor_override != null) {
    return Number(entry.hourly_rate_minor_override);
  }
  if (customer.hourly_rate_minor != null) {
    return Number(customer.hourly_rate_minor);
  }
  if (installDefaultMinor != null) {
    return Number(installDefaultMinor);
  }
  throw new AppError(
    'No hourly rate: set a per-entry override, a customer default, or an install-wide default rate.',
    400,
    'HOURLY_RATE_REQUIRED',
  );
}

/**
 * Read the install-wide default hourly rate (minor units) off the
 * singleton business_profile row. Returns null when unset OR when the
 * column doesn't exist yet (pre-migration-113 install) — callers then
 * fall through to the HOURLY_RATE_REQUIRED path. Accepts an optional
 * transaction so it joins the caller's atomic unit.
 */
async function getInstallDefaultRateMinor(trx) {
  const conn = trx || db;
  if (!(await hasColumnCached('business_profile', 'default_hourly_rate_minor'))) {
    return null;
  }
  const row = await conn('business_profile').where({ id: 1 })
    .first('default_hourly_rate_minor');
  return row && row.default_hourly_rate_minor != null
    ? Number(row.default_hourly_rate_minor)
    : null;
}

/**
 * Decide whether an entry is still editable. Pure function — callers
 * pass the loaded entry + (optionally) its current invoice row.
 *
 * Rules:
 *   - Unbilled entry (no invoice_id) → always editable.
 *   - Linked invoice is still a monthly draft → editable (period open).
 *   - Linked invoice has no scheduled_send_at AND status='scheduled'
 *     → editable (standalone draft).
 *   - Linked invoice has scheduled_send_at > now AND status='scheduled'
 *     → editable until the scheduler arms it.
 *   - Anything else (armed, sent, paid, overdue, cancelled) → locked.
 */
function isEntryLocked(entry, invoice) {
  if (!entry.invoice_id) return false;
  if (!invoice) return false; // entry references a deleted invoice — treat as unbilled
  if (invoice.is_monthly_draft === true || invoice.is_monthly_draft === 1) return false;
  if (invoice.status !== 'scheduled') return true;
  if (!invoice.scheduled_send_at) return false;
  return new Date(invoice.scheduled_send_at).getTime() <= Date.now();
}

/**
 * Translate an entry row into the line-item shape consumed by
 * createInvoice / appendToMonthlyDraft. Format:
 *   "{date} {start}–{end} ({hours}h): {note}"
 * Note suffix omitted when entry.description is null/empty.
 */
function buildLineItemFromEntry(entry, rateMinor) {
  const hours = (entry.duration_minutes / 60).toFixed(2);
  // Keep the entry description portable (admin's locale formatting happens at
  // PDF render time). `entry_date` is a `date` column: Postgres hands it back as
  // a JS Date, SQLite as a 'YYYY-MM-DD' string — so `String(dateObj).slice(0,10)`
  // would bake "Wed Apr 06" into the invoice line on PG. Normalise via the Date
  // branch (see feedback_pg_date_columns_serialize).
  const datePart = entry.entry_date instanceof Date
    ? entry.entry_date.toISOString().slice(0, 10)
    : String(entry.entry_date).slice(0, 10);
  const note = (entry.description || '').trim();
  const description = `${datePart} ${entry.start_time}–${entry.end_time} (${hours}h)${note ? ': ' + note : ''}`;
  const qty = Number(hours);
  const lineTotalMinor = Math.round(qty * rateMinor);
  return {
    description,
    quantity: qty,
    unit_price_minor: rateMinor,
    discount_percent: 0,
    line_total_minor: lineTotalMinor,
    parent_position: null,
    details_text: null,
  };
}

// ---------------------------------------------------------------------
// CRUD + billing surface
// ---------------------------------------------------------------------

/**
 * List entries for a customer. Optional status filter; default sort
 * is newest entry_date first. Joins to invoices.invoice_number so the
 * UI can render "Billed on R-2026-0019" without an N+1 round-trip.
 */
async function listEntries(customerId, { status, limit = 200, offset = 0 } = {}) {
  let q = db('customer_hour_entries as h')
    .leftJoin('invoices as i', 'h.invoice_id', 'i.id')
    .where('h.customer_account_id', customerId);
  if (status) q = q.where('h.status', status);
  q = q.orderBy('h.entry_date', 'desc')
    .orderBy('h.start_time', 'desc')
    .orderBy('h.id', 'desc')
    .limit(limit)
    .offset(offset);
  const rows = await q.select(
    'h.*',
    'i.invoice_number as invoice_number',
    'i.status as invoice_status',
    'i.is_monthly_draft as invoice_is_monthly_draft',
    'i.scheduled_send_at as invoice_scheduled_send_at',
  );
  return rows;
}

/**
 * Create a new entry. Routes per cadence:
 *   - monthly + feature_hours_logging → append to running draft, flip to billed
 *   - per_event                       → leave at unbilled, admin bills later
 */
async function createEntry(customerId, payload, adminId) {
  const customer = await db('customer_accounts').where({ id: customerId }).first();
  if (!customer) throw new AppError('Customer not found', 404);
  // Both layers must be on: global master switch AND per-customer flag
  // (matches the quotes/bills AND-logic). Migration 130 added the
  // global toggle; defaults true on fresh installs.
  const customerAccountsService = require('./customerAccountsService');
  const eff = await customerAccountsService.getEffectiveFeaturesForCustomer(customer);
  if (!eff.hoursLogging) {
    throw new AppError('Hour logging is not enabled for this customer', 409, 'FEATURE_OFF');
  }

  const entryDate = String(payload.entryDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) {
    throw new AppError('entryDate must be YYYY-MM-DD', 400);
  }
  const startTime = String(payload.startTime || '');
  const endTime = String(payload.endTime || '');
  const duration = computeDurationMinutes(startTime, endTime);

  let override = null;
  if (payload.hourlyRateMinorOverride !== undefined && payload.hourlyRateMinorOverride !== null
      && payload.hourlyRateMinorOverride !== '') {
    const v = parseInt(payload.hourlyRateMinorOverride, 10);
    if (!Number.isFinite(v) || v < 0) {
      throw new AppError('hourlyRateMinorOverride must be a non-negative integer', 400);
    }
    override = v;
  }
  const description = payload.description ? String(payload.description).slice(0, 1000) : null;

  // Install-wide fallback rate (migration 113) — the last link in the
  // resolution chain. Loaded once and reused for the pre-validate and
  // the accumulator append below.
  const installDefaultMinor = await getInstallDefaultRateMinor();

  // Pre-validate the rate resolves to something — fail before insert
  // if neither override, customer default, nor install default is set.
  resolveEffectiveRate({ hourly_rate_minor_override: override }, customer, installDefaultMinor);

  // logActivity writes via the GLOBAL db; calling it inside the transaction
  // below deadlocks against the held write lock on a SQLite-backed install (a
  // second write connection blocks). Stage it here, fire it AFTER commit.
  // (The monthly/billing paths additionally route through createInvoice, whose
  // OWN internal logActivity still runs in-trx — that shared root limitation is
  // tracked in feedback_sqlite_global_write_in_transaction.)
  let logInfo = null;
  const result = await db.transaction(async (trx) => {
    const row = {
      customer_account_id: customer.id,
      entry_date: entryDate,
      start_time: startTime,
      end_time: endTime,
      duration_minutes: duration,
      hourly_rate_minor_override: override,
      description,
      status: 'unbilled',
      recorded_by_admin_id: adminId,
      created_at: new Date(),
      updated_at: new Date(),
    };
    // Migration 118 — optional "book to project" link. A project belongs to
    // at most one customer, so reject booking hours onto a project owned by a
    // DIFFERENT customer (defence-in-depth behind the customer-scoped picker).
    // Unassigned projects (customer_account_id null) are allowed for anyone.
    if (payload.projectId !== undefined && await hasColumnCached('customer_hour_entries', 'project_id')) {
      const projectId = payload.projectId || null;
      if (projectId && await trx.schema.hasTable('projects')) {
        const project = await trx('projects').where({ id: projectId }).select('customer_account_id').first();
        if (!project) throw new AppError('Project not found', 404, 'PROJECT_NOT_FOUND');
        if (project.customer_account_id != null && project.customer_account_id !== customer.id) {
          throw new AppError('That project belongs to a different customer', 422, 'PROJECT_CUSTOMER_MISMATCH');
        }
      }
      row.project_id = projectId;
    }
    const inserted = await trx('customer_hour_entries').insert(row).returning('id');
    const entryId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

    // Accumulator-mode customers (monthly + manual) get the auto-append
    // treatment — the entry lands on the running draft instead of staying
    // unbilled. Manual differs only in that its draft never auto-flushes.
    if (customer.billing_cadence === 'monthly' || customer.billing_cadence === 'manual') {
      const fullEntry = { ...row, id: entryId };
      const rate = resolveEffectiveRate(fullEntry, customer, installDefaultMinor);
      const lineItem = buildLineItemFromEntry(fullEntry, rate);
      const { invoiceId, lineItemId } = await invoiceService.appendOneLineItemToMonthlyDraft(
        customer, lineItem, adminId, trx,
      );
      await trx('customer_hour_entries').where({ id: entryId }).update({
        status: 'billed',
        invoice_id: invoiceId,
        invoice_line_item_id: lineItemId,
        billed_at: new Date(),
        updated_at: new Date(),
      });
      logInfo = { type: 'hour_entry_logged_to_monthly_draft', meta: { entryId, customerId: customer.id, invoiceId } };
      return { id: entryId, status: 'billed', invoiceId };
    }

    logInfo = { type: 'hour_entry_logged', meta: { entryId, customerId: customer.id } };
    return { id: entryId, status: 'unbilled' };
  });
  if (logInfo) { try { await logActivity(logInfo.type, logInfo.meta, null, `admin:${adminId}`); } catch (_) {} }
  return result;
}

/**
 * Update an entry. Refuses when the entry is locked (linked invoice
 * has already been armed for send). Otherwise: recomputes duration
 * from start/end, recomputes the linked line item if billed-but-still-
 * draft, and recomputes the invoice totals so the running figures
 * stay accurate.
 */
async function updateEntry(entryId, payload, adminId) {
  let logInfo = null; // logged after commit — see createEntry note.
  const result = await db.transaction(async (trx) => {
    const entry = await trx('customer_hour_entries').where({ id: entryId }).first();
    if (!entry) throw new AppError('Entry not found', 404);
    const invoice = entry.invoice_id
      ? await trx('invoices').where({ id: entry.invoice_id }).first()
      : null;
    if (isEntryLocked(entry, invoice)) {
      throw new AppError(
        'Entry locked: invoice already armed for send. Storno the invoice to change billed hours.',
        409,
        'ENTRY_LOCKED',
      );
    }
    const customer = await trx('customer_accounts').where({ id: entry.customer_account_id }).first();

    // Merge incoming payload onto the existing row.
    const next = { ...entry };
    if (payload.entryDate !== undefined) {
      const ed = String(payload.entryDate || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ed)) throw new AppError('entryDate must be YYYY-MM-DD', 400);
      next.entry_date = ed;
    }
    if (payload.startTime !== undefined) next.start_time = String(payload.startTime || '');
    if (payload.endTime !== undefined) next.end_time = String(payload.endTime || '');
    if (next.start_time !== entry.start_time || next.end_time !== entry.end_time) {
      next.duration_minutes = computeDurationMinutes(next.start_time, next.end_time);
    }
    if (payload.hourlyRateMinorOverride !== undefined) {
      if (payload.hourlyRateMinorOverride === null || payload.hourlyRateMinorOverride === '') {
        next.hourly_rate_minor_override = null;
      } else {
        const v = parseInt(payload.hourlyRateMinorOverride, 10);
        if (!Number.isFinite(v) || v < 0) throw new AppError('hourlyRateMinorOverride must be non-negative', 400);
        next.hourly_rate_minor_override = v;
      }
    }
    if (payload.description !== undefined) {
      next.description = payload.description ? String(payload.description).slice(0, 1000) : null;
    }
    next.updated_at = new Date();

    // Recompute the linked line item if the entry is billed (on a
    // draft — the lock check above already proved it's mutable).
    if (entry.invoice_id && entry.invoice_line_item_id) {
      const installDefaultMinor = await getInstallDefaultRateMinor(trx);
      const rate = resolveEffectiveRate(next, customer, installDefaultMinor);
      const newLineItem = buildLineItemFromEntry(next, rate);
      await trx('invoice_line_items').where({ id: entry.invoice_line_item_id }).update({
        description: newLineItem.description,
        quantity: newLineItem.quantity,
        unit_price_minor: newLineItem.unit_price_minor,
        line_total_minor: newLineItem.line_total_minor,
        updated_at: new Date(),
      });
      // Recompute invoice totals — same shape as appendToMonthlyDraft.
      const allItems = await trx('invoice_line_items').where({ invoice_id: entry.invoice_id });
      let netMinor = 0;
      for (const li of allItems) {
        if (li.parent_line_item_id == null) netMinor += Number(li.line_total_minor || 0);
      }
      const vatRate = Number(invoice.vat_rate || 0);
      const vatMinor = Math.round(netMinor * vatRate / 100);
      const shippingMinor = Number(invoice.shipping_amount_minor || 0);
      const totalMinor = netMinor + vatMinor + shippingMinor;
      await trx('invoices').where({ id: entry.invoice_id }).update({
        net_amount_minor: netMinor,
        vat_amount_minor: vatMinor,
        total_amount_minor: totalMinor,
        updated_at: new Date(),
      });
    }

    await trx('customer_hour_entries').where({ id: entryId }).update({
      entry_date: next.entry_date,
      start_time: next.start_time,
      end_time: next.end_time,
      duration_minutes: next.duration_minutes,
      hourly_rate_minor_override: next.hourly_rate_minor_override,
      description: next.description,
      updated_at: next.updated_at,
    });

    logInfo = { type: 'hour_entry_updated', meta: { entryId, customerId: entry.customer_account_id } };
    return { id: entryId };
  });
  if (logInfo) { try { await logActivity(logInfo.type, logInfo.meta, null, `admin:${adminId}`); } catch (_) {} }
  return result;
}

/**
 * Delete an entry. Same lockout semantics as update. If the entry is
 * billed on a still-mutable draft, removes the linked line item and
 * recomputes invoice totals before deleting the entry row itself.
 */
async function deleteEntry(entryId, adminId) {
  let logInfo = null; // logged after commit — see createEntry note.
  const result = await db.transaction(async (trx) => {
    const entry = await trx('customer_hour_entries').where({ id: entryId }).first();
    if (!entry) throw new AppError('Entry not found', 404);
    const invoice = entry.invoice_id
      ? await trx('invoices').where({ id: entry.invoice_id }).first()
      : null;
    if (isEntryLocked(entry, invoice)) {
      throw new AppError(
        'Entry locked: invoice already armed for send. Storno the invoice to remove billed hours.',
        409,
        'ENTRY_LOCKED',
      );
    }

    if (entry.invoice_line_item_id) {
      await trx('invoice_line_items').where({ id: entry.invoice_line_item_id }).del();
    }
    if (entry.invoice_id) {
      const allItems = await trx('invoice_line_items').where({ invoice_id: entry.invoice_id });
      let netMinor = 0;
      for (const li of allItems) {
        if (li.parent_line_item_id == null) netMinor += Number(li.line_total_minor || 0);
      }
      const vatRate = Number(invoice.vat_rate || 0);
      const vatMinor = Math.round(netMinor * vatRate / 100);
      const shippingMinor = Number(invoice.shipping_amount_minor || 0);
      const totalMinor = netMinor + vatMinor + shippingMinor;
      await trx('invoices').where({ id: entry.invoice_id }).update({
        net_amount_minor: netMinor,
        vat_amount_minor: vatMinor,
        total_amount_minor: totalMinor,
        updated_at: new Date(),
      });
    }

    await trx('customer_hour_entries').where({ id: entryId }).del();

    logInfo = { type: 'hour_entry_deleted', meta: { entryId, customerId: entry.customer_account_id, hadInvoice: !!entry.invoice_id } };
    return { deleted: true };
  });
  if (logInfo) { try { await logActivity(logInfo.type, logInfo.meta, null, `admin:${adminId}`); } catch (_) {} }
  return result;
}

/**
 * Per-event flow: mint a standalone invoice from all unbilled entries
 * for this customer, one line per entry. Refuses when the customer is
 * in an accumulator mode (monthly / manual) — those entries auto-billed
 * onto the running draft on save, so there should be no unbilled rows.
 * Returns the new invoice id.
 */
async function billUnbilledEntries(customerId, adminId) {
  const customer = await db('customer_accounts').where({ id: customerId }).first();
  if (!customer) throw new AppError('Customer not found', 404);
  if (customer.billing_cadence === 'monthly' || customer.billing_cadence === 'manual') {
    throw new AppError(
      'Accumulator-mode customers (monthly / manual) auto-append entries to the running draft; "Bill these hours" is for per-event customers.',
      409,
      'CADENCE_MISMATCH',
    );
  }

  let logInfo = null; // logged after commit — see createEntry note.
  const result = await db.transaction(async (trx) => {
    const unbilled = await trx('customer_hour_entries')
      .where({ customer_account_id: customer.id, status: 'unbilled' })
      .orderBy('entry_date', 'asc').orderBy('start_time', 'asc');
    if (unbilled.length === 0) {
      throw new AppError('No unbilled entries to bill', 409, 'NO_UNBILLED');
    }

    const installDefaultMinor = await getInstallDefaultRateMinor(trx);
    const lineItems = unbilled.map((entry, idx) => {
      const rate = resolveEffectiveRate(entry, customer, installDefaultMinor);
      const li = buildLineItemFromEntry(entry, rate);
      return { ...li, position: idx + 1 };
    });

    // No installment metadata — hour-billing always mints a single
    // standalone invoice. createInvoice returns `{ invoiceIds: [N] }`
    // since migration 140 / the spawner refactor; extract the one id.
    const { invoiceIds } = await invoiceService.createInvoice({
      customerAccountId: customer.id,
      lineItems,
      // Reuse the customer/business currency-fallback chain inside
      // createInvoice.
    }, adminId, trx);
    const invoiceId = invoiceIds[0];

    // Locate the newly-inserted line item ids in insertion order so
    // each entry gets stamped with its specific row.
    const insertedLines = await trx('invoice_line_items')
      .where({ invoice_id: invoiceId })
      .orderBy('position', 'asc');
    const lineByPos = new Map(insertedLines.map((li) => [li.position, li.id]));

    const now = new Date();
    for (let i = 0; i < unbilled.length; i += 1) {
      const entry = unbilled[i];
      const lineItemId = lineByPos.get(i + 1) || null;
      await trx('customer_hour_entries').where({ id: entry.id }).update({
        status: 'billed',
        invoice_id: invoiceId,
        invoice_line_item_id: lineItemId,
        billed_at: now,
        updated_at: now,
      });
    }

    logInfo = { type: 'hour_entries_billed', meta: { customerId: customer.id, invoiceId, entryCount: unbilled.length } };
    return { invoiceId, entriesBilled: unbilled.length };
  });
  if (logInfo) { try { await logActivity(logInfo.type, logInfo.meta, null, `admin:${adminId}`); } catch (_) {} }
  return result;
}

/**
 * Landing aggregate for /admin/clients/hours: one row per customer that
 * currently carries unbilled hour entries, with the open hours + open
 * monetary amount. In practice only per-event customers surface here —
 * monthly/manual cadences auto-append each entry onto the running draft
 * at save time (status flips straight to 'billed'), so they never leave
 * unbilled rows behind. Each entry's amount resolves through the usual
 * override → customer-rate → install-default chain; if an entry has no
 * resolvable rate it still counts toward hours/entries but the row is
 * flagged rateResolvable=false so the UI can prompt for a rate rather
 * than silently undercounting. Sorted by open amount desc.
 */
async function getUnbilledSummaryByCustomer() {
  const installDefaultMinor = await getInstallDefaultRateMinor();
  const rows = await db('customer_hour_entries as h')
    .join('customer_accounts as c', 'h.customer_account_id', 'c.id')
    .where('h.status', 'unbilled')
    .select(
      'h.customer_account_id',
      'h.duration_minutes',
      'h.hourly_rate_minor_override',
      'c.hourly_rate_minor as customer_hourly_rate_minor',
      'c.company_name',
      'c.display_name',
      'c.first_name',
      'c.last_name',
      'c.email',
      'c.password_hash',
      'c.billing_cadence',
    );

  const byCustomer = new Map();
  for (const r of rows) {
    let agg = byCustomer.get(r.customer_account_id);
    if (!agg) {
      agg = {
        customerAccountId: r.customer_account_id,
        companyName: r.company_name || null,
        displayName: r.display_name || null,
        firstName: r.first_name || null,
        lastName: r.last_name || null,
        email: r.email || null,
        // passive = no portal password set, same rule as the customer
        // list / picker (adminCustomers transform).
        isPassive: r.password_hash == null,
        billingCadence: r.billing_cadence || null,
        entryCount: 0,
        totalMinutes: 0,
        openAmountMinor: 0,
        rateResolvable: true,
      };
      byCustomer.set(r.customer_account_id, agg);
    }
    agg.entryCount += 1;
    const minutes = Number(r.duration_minutes || 0);
    agg.totalMinutes += minutes;
    let rateMinor = null;
    if (r.hourly_rate_minor_override != null) rateMinor = Number(r.hourly_rate_minor_override);
    else if (r.customer_hourly_rate_minor != null) rateMinor = Number(r.customer_hourly_rate_minor);
    else if (installDefaultMinor != null) rateMinor = installDefaultMinor;
    if (rateMinor == null) {
      agg.rateResolvable = false;
    } else {
      agg.openAmountMinor += Math.round((minutes / 60) * rateMinor);
    }
  }

  return Array.from(byCustomer.values())
    .sort((a, b) => b.openAmountMinor - a.openAmountMinor);
}

module.exports = {
  listEntries,
  getUnbilledSummaryByCustomer,
  createEntry,
  updateEntry,
  deleteEntry,
  billUnbilledEntries,
  getInstallDefaultRateMinor,
  _internal: {
    computeDurationMinutes,
    resolveEffectiveRate,
    isEntryLocked,
    buildLineItemFromEntry,
  },
};
