/**
 * customerPortalService — the read models behind the portal dashboard and the
 * per-event page (#1444).
 *
 * Both screens are built here from the same queries, so "Needs action" on the
 * dashboard and the event page can't disagree. Every query is scoped by the
 * caller's customer_account_id, and each section is only filled when the
 * matching feature is effective for the customer (global flag AND the
 * per-customer override — getEffectiveFeaturesForCustomer).
 *
 * Gallery state is decided here, not in the browser: `availability` is
 * `active`, `expired` (a history entry with its expiry date; it can't be
 * opened — decision #24c) or `unavailable` (inactive or still a draft).
 */

const { db } = require('../database/db');
const { isGalleryAvailable, isGalleryExpired } = require('../utils/galleryLifecycle');
const { toIso } = require('../utils/dateNormalize');
const customerAccountsService = require('./customerAccountsService');
const customerDocumentsService = require('./customerDocumentsService');

const isTrue = (v) => v === true || v === 1 || v === '1';
const pad = (n) => String(n).padStart(2, '0');

/**
 * `date` columns come back as a local-midnight Date on Postgres and as a
 * 'YYYY-MM-DD' string on SQLite; both become 'YYYY-MM-DD' here.
 */
function toDateOnly(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  if (typeof value === 'number') return new Date(value).toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function todayDateOnly(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function galleryAvailability(event) {
  if (isGalleryExpired(event)) return 'expired';
  return isGalleryAvailable(event) ? 'active' : 'unavailable';
}

function shapeEvent(e) {
  return {
    id: e.id,
    slug: e.slug,
    eventName: e.event_name,
    eventType: e.event_type,
    eventDate: toDateOnly(e.event_date),
    expiresAt: toIso(e.expires_at) || null,
    isActive: isTrue(e.is_active),
    assignedAt: toIso(e.assigned_at) || null,
    availability: galleryAvailability(e),
  };
}

const money = (v) => Number(v) || 0;

async function needsActionFor(customerId, features) {
  const today = todayDateOnly();
  const out = { quotes: [], contracts: [], invoices: [] };

  if (features.quotes) {
    const rows = await db('quotes')
      .where({ customer_account_id: customerId, status: 'sent' })
      .whereNull('response_locked_at')
      .orderBy('id', 'desc')
      .select('id', 'quote_number', 'event_name', 'valid_until', 'sent_at', 'total_amount_minor', 'currency');
    out.quotes = rows
      .filter((q) => { const until = toDateOnly(q.valid_until); return !until || until >= today; })
      .map((q) => ({
        id: q.id,
        quoteNumber: q.quote_number,
        eventName: q.event_name || null,
        validUntil: toDateOnly(q.valid_until),
        sentAt: toIso(q.sent_at) || null,
        totalAmountMinor: money(q.total_amount_minor),
        currency: q.currency,
      }));
  }

  if (features.contracts) {
    const rows = await db('contracts')
      .where({ customer_account_id: customerId })
      .whereIn('status', ['sent', 'signed_by_admin'])
      .whereNull('signed_by_customer_at')
      .orderBy('id', 'desc')
      .select('id', 'contract_number', 'title', 'event_name', 'valid_until', 'sent_at');
    out.contracts = rows.map((c) => ({
      id: c.id,
      contractNumber: c.contract_number,
      title: c.title || null,
      eventName: c.event_name || null,
      validUntil: toDateOnly(c.valid_until),
      sentAt: toIso(c.sent_at) || null,
    }));
  }

  if (features.bills) {
    // Storno rows and invoices already reversed by one are never "due".
    const rows = await db('invoices')
      .where({ customer_account_id: customerId })
      .whereIn('status', ['sent', 'overdue'])
      .andWhere((q) => q.where('kind', 'invoice').orWhereNull('kind'))
      .whereNull('cancellation_storno_id')
      .orderBy('due_date', 'asc')
      .orderBy('id', 'asc')
      .select('id', 'invoice_number', 'status', 'due_date', 'event_name',
        'total_amount_minor', 'paid_amount_minor', 'currency');
    out.invoices = rows.map((i) => {
      const dueDate = toDateOnly(i.due_date);
      return {
        id: i.id,
        invoiceNumber: i.invoice_number,
        status: i.status,
        dueDate,
        overdue: i.status === 'overdue' || (!!dueDate && dueDate < today),
        eventName: i.event_name || null,
        totalAmountMinor: money(i.total_amount_minor),
        openAmountMinor: Math.max(0, money(i.total_amount_minor) - money(i.paid_amount_minor)),
        currency: i.currency,
      };
    });
  }

  return out;
}

async function getDashboard(customerId) {
  const features = await customerAccountsService.getEffectiveFeaturesForCustomer(customerId);
  const events = (await customerAccountsService.listEventsForCustomer(customerId)).map(shapeEvent);
  return {
    needsAction: await needsActionFor(customerId, features),
    galleries: {
      active: events.filter((e) => e.availability !== 'expired'),
      expired: events.filter((e) => e.availability === 'expired'),
    },
  };
}

/**
 * Everything the customer has for one event: gallery state, quotes,
 * contracts, invoices and shared documents. Documents are tied to the event
 * directly or through the deal lineage (deal_uuid) of a quote / contract /
 * invoice that points at the event. Returns null when the event is unknown,
 * archived or not assigned to this customer — the route answers 404 for all
 * three so the endpoint can't be used to probe for other customers' events.
 */
async function getEventOverview(customerId, slug) {
  const event = await db('events').where({ slug }).first();
  if (!event || isTrue(event.is_archived)) return null;
  if (!(await customerAccountsService.customerHasAccessToEvent(customerId, event.id))) return null;

  const features = await customerAccountsService.getEffectiveFeaturesForCustomer(customerId);

  const deals = new Set();
  const collect = (rows) => rows.forEach((r) => { if (r.deal_uuid) deals.add(r.deal_uuid); });
  collect(await db('invoices').where({ customer_account_id: customerId, event_id: event.id }).select('deal_uuid'));
  collect(await db('quotes').where({ customer_account_id: customerId, converted_event_id: event.id }).select('deal_uuid'));
  collect(await db('contracts').where({ customer_account_id: customerId, converted_event_id: event.id }).select('deal_uuid'));
  const dealList = [...deals];
  const linkedTo = (column) => (q) => {
    q.where(column, event.id);
    if (dealList.length > 0) q.orWhereIn('deal_uuid', dealList);
  };

  let quotes = [];
  if (features.quotes) {
    quotes = (await db('quotes')
      .where({ customer_account_id: customerId })
      .whereNot('status', 'draft')
      .andWhere(linkedTo('converted_event_id'))
      .orderBy('id', 'desc')
      .select('id', 'quote_number', 'status', 'issue_date', 'valid_until', 'total_amount_minor', 'currency'))
      .map((q) => ({
        id: q.id,
        quoteNumber: q.quote_number,
        status: q.status,
        issueDate: toDateOnly(q.issue_date),
        validUntil: toDateOnly(q.valid_until),
        totalAmountMinor: money(q.total_amount_minor),
        currency: q.currency,
      }));
  }

  let contracts = [];
  if (features.contracts) {
    contracts = (await db('contracts')
      .where({ customer_account_id: customerId })
      .whereNot('status', 'draft')
      .andWhere(linkedTo('converted_event_id'))
      .orderBy('id', 'desc')
      .select('id', 'contract_number', 'status', 'title', 'issue_date', 'pdf_path', 'signed_pdf_path'))
      .map((c) => ({
        id: c.id,
        contractNumber: c.contract_number,
        status: c.status,
        title: c.title || null,
        issueDate: toDateOnly(c.issue_date),
        hasPdf: !!c.pdf_path,
        hasSignedPdf: !!c.signed_pdf_path,
      }));
  }

  let invoices = [];
  if (features.bills) {
    // Same visibility as GET /api/customer/invoices.
    invoices = (await db('invoices')
      .where({ customer_account_id: customerId })
      .whereNotIn('status', ['scheduled', 'skipped'])
      .andWhere((q) => q.whereNot('status', 'cancelled').orWhereNotNull('cancellation_storno_id'))
      .andWhere(linkedTo('event_id'))
      .orderBy('id', 'desc')
      .select('id', 'kind', 'invoice_number', 'status', 'issue_date', 'due_date',
        'total_amount_minor', 'paid_amount_minor', 'currency'))
      .map((i) => ({
        id: i.id,
        kind: i.kind || 'invoice',
        invoiceNumber: i.invoice_number,
        status: i.status,
        issueDate: toDateOnly(i.issue_date),
        dueDate: toDateOnly(i.due_date),
        totalAmountMinor: money(i.total_amount_minor),
        paidAmountMinor: money(i.paid_amount_minor),
        currency: i.currency,
      }));
  }

  const documents = features.documents
    ? await customerDocumentsService.listForCustomer(customerId, { eventId: event.id })
    : [];

  return {
    event: shapeEvent(event),
    sections: {
      quotes: !!features.quotes,
      contracts: !!features.contracts,
      invoices: !!features.bills,
      documents: !!features.documents,
    },
    quotes,
    contracts,
    invoices,
    documents,
  };
}

module.exports = { shapeEvent, getDashboard, getEventOverview, _internal: { toDateOnly, needsActionFor } };
