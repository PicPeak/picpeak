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
const { toMillis } = require('../utils/queueTimestamps');
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
  const out = {
    quotes: [], contracts: [], invoices: [], documents: [], documentRequests: [],
  };

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

  if (features.documents) {
    // Only what the customer can act on: a rejected upload of theirs (upload
    // a corrected one, or delete it). A pending upload waits on the studio.
    //
    // A contract-linked upload can't be deleted by the customer and is kept
    // for the contract, so once a later upload for the same contract is in
    // (awaiting review or accepted) the rejected one is answered and drops
    // out — otherwise it would sit under Needs action for good.
    const rows = await db('customer_documents')
      .where({ customer_account_id: customerId, uploader_type: 'customer', status: 'rejected' })
      .whereNull('deleted_at')
      .andWhere((q) => q.whereNull('contract_id').orWhereNotExists(function replaced() {
        this.from('customer_documents as later')
          .whereColumn('later.contract_id', 'customer_documents.contract_id')
          .whereColumn('later.customer_account_id', 'customer_documents.customer_account_id')
          .whereColumn('later.id', '>', 'customer_documents.id')
          .where('later.uploader_type', 'customer')
          .whereIn('later.status', ['pending', 'clean'])
          .whereNull('later.deleted_at');
      }))
      .orderBy('id', 'desc')
      .select('id', 'original_name', 'review_note');
    out.documents = rows.map((d) => ({ id: d.id, name: d.original_name, reviewNote: d.review_note || null }));
    // What the studio asked for and is still waiting on (slice 10).
    out.documentRequests = (await db('customer_document_requests')
      .where({ customer_account_id: customerId, status: 'open' })
      .orderBy('id', 'desc')
      .select('id', 'title', 'note', 'due_at'))
      .map((r) => ({
        id: r.id,
        title: r.title,
        note: r.note || null,
        dueAt: toIso(r.due_at) || null,
        link: `/customer/documents?request=${r.id}`,
      }));
  } else {
    out.documents = [];
    out.documentRequests = [];
  }

  return out;
}

/**
 * What happened lately, for the dashboard's "Recent" (#1444 slice 6).
 *
 * Derived from the source tables — not from activity_logs — with the same
 * visibility rules as the lists each item links to. That is what keeps it
 * from drifting from "Needs action" and keeps studio-side actions (a review
 * note being edited, a document unshared) out of it: an unshared document
 * simply no longer matches customerVisibleQuery.
 *
 * Each item: { kind, id, title, at, link }.
 */
async function recentFor(customerId, features, limit = 10) {
  const items = [];
  const push = (kind, id, title, at, link) => {
    const ms = toMillis(at);
    if (ms !== null) items.push({ kind, id, title, at: new Date(ms).toISOString(), link });
  };

  if (features.documents) {
    const docs = await customerDocumentsService.listVisibleRows(customerId);
    for (const d of docs) {
      const link = `/customer/documents/${d.id}`;
      if (d.uploader_type === 'customer') {
        push('document_uploaded', d.id, d.original_name, d.created_at, link);
        if (d.reviewed_at && (d.status === 'clean' || d.status === 'rejected')) {
          push(d.status === 'clean' ? 'document_accepted' : 'document_rejected', d.id, d.original_name, d.reviewed_at, link);
        }
      } else {
        push('document_shared', d.id, d.original_name, d.shared_at, link);
      }
    }
  }
  if (features.contracts) {
    const rows = await db('contracts').where({ customer_account_id: customerId }).whereNot('status', 'draft')
      .select('id', 'contract_number', 'sent_at', 'signed_by_customer_at');
    for (const c of rows) {
      push('contract_sent', c.id, c.contract_number, c.sent_at, '/customer/contracts');
      push('contract_signed', c.id, c.contract_number, c.signed_by_customer_at, '/customer/contracts');
    }
  }
  if (features.quotes) {
    const rows = await db('quotes').where({ customer_account_id: customerId }).whereNot('status', 'draft')
      .select('id', 'quote_number', 'sent_at');
    for (const q of rows) push('quote_sent', q.id, q.quote_number, q.sent_at, '/customer/quotes');
  }
  if (features.bills) {
    // Same visibility as GET /api/customer/invoices.
    const rows = await db('invoices').where({ customer_account_id: customerId })
      .whereNotIn('status', ['scheduled', 'skipped'])
      .andWhere((q) => q.whereNot('status', 'cancelled').orWhereNotNull('cancellation_storno_id'))
      .select('id', 'invoice_number', 'sent_at');
    for (const i of rows) push('invoice_sent', i.id, i.invoice_number, i.sent_at, '/customer/bills');
  }
  const events = (await customerAccountsService.listEventsForCustomer(customerId))
    .filter((e) => !isTrue(e.is_draft));
  for (const e of events) {
    push('gallery_assigned', e.id, e.event_name, e.assigned_at, `/customer/events/${encodeURIComponent(e.slug)}`);
  }

  items.sort((a, b) => (b.at < a.at ? -1 : b.at > a.at ? 1 : 0));
  return items.slice(0, limit);
}

async function getDashboard(customerId) {
  const features = await customerAccountsService.getEffectiveFeaturesForCustomer(customerId);
  const events = (await customerAccountsService.listEventsForCustomer(customerId)).map(shapeEvent);
  return {
    needsAction: await needsActionFor(customerId, features),
    recent: await recentFor(customerId, features),
    galleries: {
      active: events.filter((e) => e.availability !== 'expired'),
      expired: events.filter((e) => e.availability === 'expired'),
    },
  };
}

/**
 * The deal lineage of one event, for one customer: the deal_uuids of the
 * quotes, contracts and invoices that point at the event, the contracts in
 * those deals (or converted into the event), and the event's project when it
 * is this customer's. Every lookup is scoped by customer_account_id.
 *
 * Quotes, contracts and invoices follow the deal through deal_uuid; a
 * customer document has no deal_uuid and follows the links it already has —
 * its contract and its project (#1444 slice 5).
 */
async function dealLineageForEvent(customerId, event) {
  const deals = new Set();
  const collect = (rows) => rows.forEach((r) => { if (r.deal_uuid) deals.add(r.deal_uuid); });
  collect(await db('invoices').where({ customer_account_id: customerId, event_id: event.id }).select('deal_uuid'));
  collect(await db('quotes').where({ customer_account_id: customerId, converted_event_id: event.id }).select('deal_uuid'));
  collect(await db('contracts').where({ customer_account_id: customerId, converted_event_id: event.id }).select('deal_uuid'));
  const dealUuids = [...deals];

  const contractIds = (await db('contracts')
    .where({ customer_account_id: customerId })
    .andWhere((q) => {
      q.where('converted_event_id', event.id);
      if (dealUuids.length > 0) q.orWhereIn('deal_uuid', dealUuids);
    })
    .select('id')).map((r) => r.id);

  let projectIds = [];
  if (event.project_id) {
    const project = await db('projects')
      .where({ id: event.project_id, customer_account_id: customerId })
      .first('id');
    if (project) projectIds = [project.id];
  }
  return { dealUuids, contractIds, projectIds };
}

/**
 * Everything the customer has for one event: gallery state, quotes,
 * contracts, invoices and shared documents. Quotes, contracts and invoices
 * are matched on the event itself or through the deal lineage (deal_uuid) of
 * another document that points at it; a document when it names the event,
 * or a contract or the project of that lineage (dealLineageForEvent) — still
 * only among what the customer may see. Returns null when the event is
 * unknown, archived or not assigned to this customer — the route answers 404
 * for all three so the endpoint can't be used to probe for other customers'
 * events.
 */
async function getEventOverview(customerId, slug) {
  const event = await db('events').where({ slug }).first();
  if (!event || isTrue(event.is_archived)) return null;
  if (!(await customerAccountsService.customerHasAccessToEvent(customerId, event.id))) return null;

  const features = await customerAccountsService.getEffectiveFeaturesForCustomer(customerId);

  const lineage = await dealLineageForEvent(customerId, event);
  const dealList = lineage.dealUuids;
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
      .select('id', 'contract_number', 'status', 'title', 'issue_date', 'pdf_path', 'signed_pdf_path', 'sent_at', 'data_request'))
      .map((c) => ({
        id: c.id,
        contractNumber: c.contract_number,
        status: c.status,
        // Nothing of a contract still collecting details (#1446) but its number.
        title: require('./contract/helpers').neverFrozen(c) ? null : (c.title || null),
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
    ? await customerDocumentsService.listForCustomer(customerId, {
      eventId: event.id,
      contractIds: lineage.contractIds,
      projectIds: lineage.projectIds,
    })
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

module.exports = {
  shapeEvent, getDashboard, getEventOverview, dealLineageForEvent, _internal: { toDateOnly, needsActionFor, recentFor },
};
