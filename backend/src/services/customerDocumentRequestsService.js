/**
 * customerDocumentRequestsService — the photographer asks a customer for a
 * document (#1444, plan slice 10; migration 243).
 *
 * A request is `open` until the customer uploads against it (`fulfilled`,
 * in the same transaction as the upload — see customerDocumentsService
 * .createDocument) or the admin cancels it. Open requests show under the
 * portal's "Needs action"; reminder mails follow the ladder in
 * customer_documents_request_reminder_days (see
 * customerDocumentRequestReminderService).
 *
 * Every read is scoped by customer_account_id; another customer's request
 * id is the same 404 as one that doesn't exist.
 */

const { db, logActivity } = require('../database/db');
const { toIso } = require('../utils/dateNormalize');
const { AppError, ValidationError } = require('../utils/errors');
const { filterOwnedEventIds } = require('../middleware/ownership');

const NOT_FOUND = () => new AppError('Document request not found', 404, 'DOCUMENT_REQUEST_NOT_FOUND');
const adminActor = (admin) => ({ type: 'admin', id: admin.id, name: admin.username || 'admin' });

function toAdminDto(row) {
  return {
    id: row.id,
    title: row.title,
    note: row.note || null,
    dueAt: toIso(row.due_at) || null,
    status: row.status,
    eventId: row.event_id || null,
    contractId: row.contract_id || null,
    // Kept on an open request as its last answer (restoreForDocument);
    // only a fulfilled one has an answer to show.
    fulfilledDocumentId: row.status === 'fulfilled' ? (row.fulfilled_document_id || null) : null,
    fulfilledAt: toIso(row.fulfilled_at) || null,
    cancelledAt: toIso(row.cancelled_at) || null,
    reminderCount: Number(row.reminder_count) || 0,
    remindedAt: toIso(row.reminded_at) || null,
    createdAt: toIso(row.created_at) || null,
  };
}

function toCustomerDto(row) {
  return {
    id: row.id,
    title: row.title,
    note: row.note || null,
    dueAt: toIso(row.due_at) || null,
    status: row.status,
    eventId: row.event_id || null,
    createdAt: toIso(row.created_at) || null,
  };
}

function cleanText(value, max) {
  // eslint-disable-next-line no-control-regex
  const text = String(value == null ? '' : value).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
  return text.slice(0, max);
}

function parseDue(value) {
  if (value === undefined || value === null || value === '') return null;
  const ms = Date.parse(String(value));
  if (!Number.isFinite(ms)) throw new ValidationError('dueAt must be a date');
  return new Date(ms).toISOString();
}

async function checkLinks(customerId, { eventId, contractId }, admin) {
  if (eventId) {
    const assigned = await db('event_customer_assignments')
      .where({ customer_account_id: customerId, event_id: eventId }).first('id');
    let allowed = !!assigned;
    if (allowed && admin) {
      const { allowed: owned } = await filterOwnedEventIds(admin, [eventId]);
      allowed = owned.length === 1;
    }
    if (!allowed) throw new ValidationError('eventId is not an event of this customer');
  }
  if (contractId) {
    const contract = await db('contracts').where({ id: contractId, customer_account_id: customerId }).first('id');
    if (!contract) throw new ValidationError('contractId is not a contract of this customer');
  }
}

async function listForAdmin(customerId) {
  const rows = await db('customer_document_requests')
    .where({ customer_account_id: customerId })
    .orderBy('id', 'desc');
  return rows.map(toAdminDto);
}

async function create(customerId, input, admin) {
  const title = cleanText(input.title, 200);
  if (!title) throw new ValidationError('title is required');
  const eventId = input.eventId ? Number(input.eventId) : null;
  const contractId = input.contractId ? Number(input.contractId) : null;
  for (const id of [eventId, contractId]) {
    if (id !== null && (!Number.isInteger(id) || id < 1 || id > 2147483647)) {
      throw new ValidationError('eventId and contractId must be positive integers');
    }
  }
  await checkLinks(customerId, { eventId, contractId }, admin);
  const now = new Date().toISOString();
  const inserted = await db('customer_document_requests').insert({
    customer_account_id: customerId,
    event_id: eventId,
    contract_id: contractId,
    title,
    note: cleanText(input.note, 1000) || null,
    due_at: parseDue(input.dueAt),
    status: 'open',
    created_by_admin_id: admin.id,
    reminder_count: 0,
    ladder_started_at: now,
    created_at: now,
    updated_at: now,
  }).returning('id');
  const id = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
  await logActivity('customer_document_request_created', { requestId: id, customerId }, eventId, adminActor(admin));
  return db('customer_document_requests').where({ id }).first();
}

async function getOpen(customerId, requestId) {
  const row = await db('customer_document_requests')
    .where({ id: requestId, customer_account_id: customerId, status: 'open' })
    .first();
  if (!row) throw NOT_FOUND();
  return row;
}

async function update(customerId, requestId, input) {
  const row = await getOpen(customerId, requestId);
  const changes = { updated_at: new Date().toISOString() };
  if (input.title !== undefined) {
    const title = cleanText(input.title, 200);
    if (!title) throw new ValidationError('title is required');
    changes.title = title;
  }
  if (input.note !== undefined) changes.note = cleanText(input.note, 1000) || null;
  if (input.dueAt !== undefined) changes.due_at = parseDue(input.dueAt);
  await db('customer_document_requests').where({ id: row.id, status: 'open' }).update(changes);
  return db('customer_document_requests').where({ id: row.id }).first();
}

async function cancel(customerId, requestId, admin) {
  const row = await getOpen(customerId, requestId);
  const now = new Date().toISOString();
  const changed = await db('customer_document_requests')
    .where({ id: row.id, status: 'open' })
    .update({ status: 'cancelled', cancelled_at: now, updated_at: now });
  if (changed !== 1) throw NOT_FOUND();
  await logActivity('customer_document_request_cancelled', { requestId: row.id, customerId }, row.event_id, adminActor(admin));
}

async function listOpenForCustomer(customerId) {
  const rows = await db('customer_document_requests')
    .where({ customer_account_id: customerId, status: 'open' })
    .orderBy('id', 'desc');
  return rows.map(toCustomerDto);
}

/**
 * Inside the upload's transaction: mark the request fulfilled by the new
 * document. The conditional update is the check — a request that was
 * cancelled, fulfilled or isn't this customer's by now fails the upload
 * (and rolls back its row) with the usual 404.
 */
async function fulfilInTransaction(trx, customerId, requestId, documentId) {
  const now = new Date().toISOString();
  const changed = await trx('customer_document_requests')
    .where({ id: requestId, customer_account_id: customerId, status: 'open' })
    .update({ status: 'fulfilled', fulfilled_document_id: documentId, fulfilled_at: now, updated_at: now });
  if (changed !== 1) throw NOT_FOUND();
}

/**
 * The document that answered a request was rejected or deleted: the request
 * is open again, so "Needs action" and the reminders pick it up once more —
 * with the ladder starting over from now, not from the original request.
 * fulfilled_document_id stays as the last answer, so accepting that same
 * document after all (restoreForDocument) closes the request again; a new
 * upload answering it replaces the id, and a cancel ends it either way.
 */
async function reopenForDocument(documentId, conn = db) {
  const now = new Date().toISOString();
  return conn('customer_document_requests')
    .where({ fulfilled_document_id: documentId, status: 'fulfilled' })
    // Only while the document is still rejected or deleted: an acceptance
    // landing between the rejection and this write wins.
    .whereExists(function stillUnanswered() {
      this.from('customer_documents').where('customer_documents.id', documentId)
        .andWhere((q) => q.where('customer_documents.status', 'rejected').orWhereNotNull('customer_documents.deleted_at'));
    })
    .update({
      status: 'open',
      fulfilled_at: null,
      reminder_count: 0,
      ladder_started_at: now,
      updated_at: now,
    });
}

/** A rejected answer was accepted after all: its open request is fulfilled again. */
async function restoreForDocument(documentId, conn = db) {
  const now = new Date().toISOString();
  return conn('customer_document_requests')
    .where({ fulfilled_document_id: documentId, status: 'open' })
    .update({ status: 'fulfilled', fulfilled_at: now, updated_at: now });
}

module.exports = {
  reopenForDocument,
  restoreForDocument,
  toAdminDto,
  toCustomerDto,
  listForAdmin,
  create,
  update,
  cancel,
  getOpen,
  listOpenForCustomer,
  fulfilInTransaction,
};
