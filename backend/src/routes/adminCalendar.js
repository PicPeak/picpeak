/**
 * Admin calendar aggregate endpoint.
 *
 * One read returns four layers the frontend renders together on the
 * admin calendar surface (`/admin/clients/calendar`):
 *
 *   1. events       — galleries from the `events` table. Blue solid.
 *   2. hours        — customer_hour_entries. Green solid; greyed when
 *                     locked (entry's invoice is past send/draft state).
 *   3. quotes       — quotes that haven't been converted to an event yet,
 *                     `status IN ('sent','accepted')`. Amber dashed.
 *   4. contracts    — contracts that haven't been converted to an event
 *                     yet, `status IN ('signed_by_customer','fully_signed')`.
 *                     Purple dashed.
 *
 * Each item carries a `kind` discriminator so the frontend can union-type
 * the response.
 *
 * **Access**
 *
 * Behind the `calendar` master feature flag (admin can disable globally
 * via Settings → Features). Read permission is `customers.view` —
 * mirrors the existing hour-entry list permission, since the calendar's
 * primary mutation surface is hour entries and we want the same audience
 * for read.
 *
 * **Range guard**
 *
 * `from` / `to` are required ISO date strings. We cap `to-from` at
 * **90 days** so a misconfigured client (e.g. an infinite scroll that
 * keeps expanding the range) can't trigger a multi-year scan. FullCalendar
 * fetches month-by-month by default, so 90 days is a comfortable margin.
 *
 * **Drift guards**
 *
 * The `events.event_time_start / event_time_end / is_full_day` columns
 * (migration 137) are read through `hasColumnCached` so un-migrated
 * installs default to all-day rendering without 500-ing.
 *
 * **No mutations here**
 *
 * Hour-entry CRUD stays on the existing `/api/admin/customers/:id/
 * hour-entries` routes (migration 129 + B.6 permission split). The
 * calendar's drag-create / inline-edit modals call those directly.
 */

const express = require('express');
const { query } = require('express-validator');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const { hasColumnCached } = require('../utils/schemaCache');
const { db } = require('../database/db');
const customerHoursService = require('../services/customerHoursService');

const router = express.Router();

// ----- feature flag gate (admin global) ----------------------------------
async function requireCalendarFlag(req, res, next) {
  try {
    const row = await db('feature_flags').where({ key: 'calendar' }).first();
    const enabled = row && (row.value === true || row.value === 1 || row.value === '1');
    if (!enabled) {
      return res.status(403).json({ error: 'Calendar feature is disabled', code: 'CALENDAR_DISABLED' });
    }
    next();
  } catch (err) {
    next(err);
  }
}

router.use(adminAuth);
router.use(requireCalendarFlag);

const MAX_RANGE_DAYS = 90;
const PENDING_QUOTE_STATUSES = ['sent', 'accepted'];
const PENDING_CONTRACT_STATUSES = ['signed_by_customer', 'fully_signed'];

/**
 * Normalise a date column value to the `YYYY-MM-DD` string the
 * frontend mapper expects.
 *
 * Different drivers return the value differently:
 *   - SQLite (dev) returns a string like "2026-05-18" — slice it.
 *   - node-postgres (prod) returns a JS Date set to UTC midnight of
 *     the stored day — extract the UTC components.
 *
 * The previous shape kept the Date object as-is in the JSON response
 * ("2026-05-18T00:00:00.000Z"), which the frontend then concatenated
 * with the entry time as `${dateStr}T${time}` to feed FullCalendar.
 * The resulting `"2026-05-18T00:00:00.000ZT09:00"` was invalid ISO,
 * FC parsed it to NaN, and the entry silently failed to render —
 * making logged hours "disappear" on every hard refresh (entries
 * created in-session still appeared because the imperative addEvent
 * received a clean YYYY-MM-DD from the modal).
 */
function toIsoDateString(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return null;
}

/**
 * GET /api/admin/calendar/items?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Returns `{ items: [...], range: { from, to } }`.
 *
 * Items are concatenated across the four layers. Order is NOT guaranteed —
 * FullCalendar sorts by start time client-side. Each item shape:
 *
 *   - { kind: 'event',    id, slug, eventName, eventDate, eventTimeStart, eventTimeEnd, isFullDay, customerName }
 *   - { kind: 'hours',    id, customerAccountId, entryDate, startTime, endTime, description, locked, invoiceId, invoiceStatus, customerName }
 *   - { kind: 'quote',    id, quoteNumber, eventName, eventDate, eventTimeStart, eventTimeEnd, status, customerName }
 *   - { kind: 'contract', id, contractNumber, eventName, eventDate, eventTimeStart, eventTimeEnd, status, customerName }
 */
router.get(
  '/items',
  requirePermission('customers.view'),
  [
    query('from').isISO8601().withMessage('from must be ISO date'),
    query('to').isISO8601().withMessage('to must be ISO date'),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const from = String(req.query.from).slice(0, 10);
    const to = String(req.query.to).slice(0, 10);
    if (from > to) {
      return res.status(400).json({ error: 'from must be <= to', code: 'INVALID_RANGE' });
    }
    // Day-span guard. Date-string lex compare doesn't give a day count
    // directly; subtract via Date so DST + month boundaries are handled.
    const fromDate = new Date(from + 'T00:00:00Z');
    const toDate = new Date(to + 'T00:00:00Z');
    const daysSpan = Math.round((toDate.getTime() - fromDate.getTime()) / 86_400_000);
    if (daysSpan > MAX_RANGE_DAYS) {
      return res.status(400).json({
        error: `Range too wide (max ${MAX_RANGE_DAYS} days)`,
        code: 'RANGE_TOO_WIDE',
      });
    }

    const hasEventCalendarCols = await hasColumnCached('events', 'is_full_day');

    // -- 1. Events ---------------------------------------------------------
    const eventsQ = db('events')
      .whereBetween('event_date', [from, to])
      .where('is_active', true)
      .where('is_archived', false)
      .orderBy('event_date', 'asc');
    // Project columns. The new time columns are guarded so older installs
    // that ran the service before migration 137 still get sane defaults.
    const eventsRows = await eventsQ.select(
      'id', 'slug', 'event_name', 'event_date', 'customer_name',
      ...(hasEventCalendarCols
        ? ['event_time_start', 'event_time_end', 'is_full_day']
        : []),
    );
    const events = eventsRows.map((r) => ({
      kind: 'event',
      id: r.id,
      slug: r.slug,
      eventName: r.event_name,
      eventDate: toIsoDateString(r.event_date),
      eventTimeStart: r.event_time_start || null,
      eventTimeEnd: r.event_time_end || null,
      isFullDay: hasEventCalendarCols
        ? (r.is_full_day === true || r.is_full_day === 1 || r.is_full_day === '1')
        : true,
      customerName: r.customer_name || null,
    }));

    // -- 2. Hour entries ---------------------------------------------------
    // LEFT JOIN invoices so isEntryLocked has the invoice context it needs.
    // We use the SAME predicate shape the service uses internally
    // (customerHoursService._internal.isEntryLocked at lines 84-91) so
    // the calendar's lock badge matches what the UI shows on the customer
    // detail page.
    const hoursRows = await db('customer_hour_entries as h')
      .leftJoin('invoices as i', 'i.id', 'h.invoice_id')
      .leftJoin('customer_accounts as c', 'c.id', 'h.customer_account_id')
      .whereBetween('h.entry_date', [from, to])
      .orderBy('h.entry_date', 'asc')
      .select(
        'h.id', 'h.customer_account_id', 'h.entry_date',
        'h.start_time', 'h.end_time', 'h.description',
        'h.invoice_id', 'h.invoice_line_item_id', 'h.status',
        'i.status as invoice_status',
        'i.is_monthly_draft as invoice_is_monthly_draft',
        'i.scheduled_send_at as invoice_scheduled_send_at',
        'c.display_name as customer_display_name',
        'c.first_name as customer_first_name',
        'c.last_name as customer_last_name',
        'c.company_name as customer_company_name',
        'c.email as customer_email',
      );
    const isEntryLocked = customerHoursService._internal.isEntryLocked;
    const hours = hoursRows.map((r) => {
      // Reconstruct the minimal entry + invoice shapes the locked
      // predicate expects.
      const entry = {
        id: r.id,
        invoice_id: r.invoice_id,
        status: r.status,
      };
      const invoice = r.invoice_id ? {
        id: r.invoice_id,
        status: r.invoice_status,
        is_monthly_draft: r.invoice_is_monthly_draft,
        scheduled_send_at: r.invoice_scheduled_send_at,
      } : null;
      const locked = isEntryLocked(entry, invoice);
      const customerName = r.customer_company_name
        || [r.customer_first_name, r.customer_last_name].filter(Boolean).join(' ')
        || r.customer_display_name
        || r.customer_email
        || null;
      return {
        kind: 'hours',
        id: r.id,
        customerAccountId: r.customer_account_id,
        entryDate: toIsoDateString(r.entry_date),
        startTime: r.start_time,
        endTime: r.end_time,
        description: r.description || null,
        status: r.status,
        invoiceId: r.invoice_id || null,
        invoiceStatus: r.invoice_status || null,
        locked,
        customerName,
      };
    });

    // -- 3. Pending quotes ------------------------------------------------
    // Only quotes with status IN ('sent','accepted') AND no converted
    // event yet. The frontend renders these dashed amber.
    const quotesRows = await db('quotes as q')
      .leftJoin('customer_accounts as c', 'c.id', 'q.customer_account_id')
      .whereIn('q.status', PENDING_QUOTE_STATUSES)
      .whereNull('q.converted_event_id')
      .whereNotNull('q.event_date')
      .whereBetween('q.event_date', [from, to])
      .orderBy('q.event_date', 'asc')
      .select(
        'q.id', 'q.quote_number', 'q.event_name', 'q.event_date',
        'q.event_time_start', 'q.event_time_end', 'q.status',
        'c.display_name as customer_display_name',
        'c.first_name as customer_first_name',
        'c.last_name as customer_last_name',
        'c.company_name as customer_company_name',
        'c.email as customer_email',
      );
    const quotes = quotesRows.map((r) => ({
      kind: 'quote',
      id: r.id,
      quoteNumber: r.quote_number,
      eventName: r.event_name || null,
      eventDate: toIsoDateString(r.event_date),
      eventTimeStart: r.event_time_start || null,
      eventTimeEnd: r.event_time_end || null,
      status: r.status,
      customerName: r.customer_company_name
        || [r.customer_first_name, r.customer_last_name].filter(Boolean).join(' ')
        || r.customer_display_name
        || r.customer_email
        || null,
    }));

    // -- 4. Pending contracts --------------------------------------------
    const contractsRows = await db('contracts as c')
      .leftJoin('customer_accounts as ca', 'ca.id', 'c.customer_account_id')
      .whereIn('c.status', PENDING_CONTRACT_STATUSES)
      .whereNull('c.converted_event_id')
      .whereNotNull('c.event_date')
      .whereBetween('c.event_date', [from, to])
      .orderBy('c.event_date', 'asc')
      .select(
        'c.id', 'c.contract_number', 'c.event_name', 'c.event_date',
        'c.event_time_start', 'c.event_time_end', 'c.status',
        'ca.display_name as customer_display_name',
        'ca.first_name as customer_first_name',
        'ca.last_name as customer_last_name',
        'ca.company_name as customer_company_name',
        'ca.email as customer_email',
      );
    const contracts = contractsRows.map((r) => ({
      kind: 'contract',
      id: r.id,
      contractNumber: r.contract_number,
      eventName: r.event_name || null,
      eventDate: toIsoDateString(r.event_date),
      eventTimeStart: r.event_time_start || null,
      eventTimeEnd: r.event_time_end || null,
      status: r.status,
      customerName: r.customer_company_name
        || [r.customer_first_name, r.customer_last_name].filter(Boolean).join(' ')
        || r.customer_display_name
        || r.customer_email
        || null,
    }));

    const items = [...events, ...hours, ...quotes, ...contracts];
    return successResponse(res, { items, range: { from, to } });
  }),
);

module.exports = router;
