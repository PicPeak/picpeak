/**
 * customerDocumentsService — PDFs exchanged between the studio and a customer
 * in the portal (#1444, migration 220).
 *
 * Rules the routes rely on (every read here is scoped by customer_account_id;
 * the routes never look a document up by id alone):
 *
 *  - Uploads are PDF only (decision #24a). The content decides: the first
 *    bytes must be the `%PDF-` signature, and an encrypted PDF is refused
 *    because nothing can inspect it.
 *  - Customer uploads start `pending` and stay unavailable for download until
 *    an admin marks them clean or rejects them (decision #24b). Admin uploads
 *    are recorded clean by the uploading admin, unless a registered scanner
 *    says otherwise.
 *  - A customer sees their own uploads (any status) and documents shared with
 *    them that are clean. They can download only clean ones.
 *  - Unsharing and deleting take effect on the next request. Delete is soft;
 *    the retention sweep removes the bytes later and keeps the row.
 *  - Bytes live under business-docs/customer-documents/<customer>/<uuid>.pdf,
 *    a generated key. The uploaded filename is display text only.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, logActivity } = require('../database/db');
const { getAppSetting } = require('../utils/appSettings');
const { getStorage } = require('./storage');
const { getStoragePath } = require('../config/storage');
const { assertPathInside } = require('../utils/safePath');
const { validateFileContent } = require('../utils/fileSecurityUtils');
const { toIso } = require('../utils/dateNormalize');
const { AppError, NotFoundError, ValidationError } = require('../utils/errors');
const { filterOwnedEventIds, ownedProjectIds } = require('../middleware/ownership');
const documentScanService = require('./documentScanService');
const logger = require('../utils/logger');

const STORAGE_PREFIX = 'business-docs/customer-documents';
const STORAGE_KEY_RE = /^business-docs\/customer-documents\/\d+\/[0-9a-f-]{36}\.pdf$/;
const MB = 1024 * 1024;
// The encryption dictionary is referenced from the trailer, which sits at the
// end of the file (also for cross-reference streams).
const ENCRYPT_SCAN_BYTES = MB;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function getLimits() {
  const maxMb = Number(await getAppSetting('customer_documents_max_upload_size_mb', 25)) || 25;
  const quotaMb = Number(await getAppSetting('customer_documents_quota_mb', 250)) || 250;
  return { maxUploadBytes: maxMb * MB, quotaBytes: quotaMb * MB };
}

async function getRetentionDays() {
  const days = Number(await getAppSetting('customer_documents_retention_days', 30));
  return Number.isFinite(days) && days >= 1 ? Math.floor(days) : 30;
}

/** Bytes the customer has uploaded themselves and not deleted. Admin uploads don't count. */
async function getUsageBytes(customerId) {
  const row = await db('customer_documents')
    .where({ customer_account_id: customerId, uploader_type: 'customer' })
    .whereNull('deleted_at')
    .sum({ total: 'size_bytes' })
    .first();
  return Number(row && row.total) || 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isShared = (row) => !!row.shared_at && !row.unshared_at;

/** Display name: the uploaded basename without control characters or path separators. */
function cleanDisplayName(originalName) {
  let name = path.basename(String(originalName || ''))
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/[/\\]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (!name) name = 'document.pdf';
  if (!/\.pdf$/i.test(name)) name = `${name}.pdf`;
  if (name.length > 200) name = `${name.slice(0, 196)}.pdf`;
  return name;
}

function parseOptionalId(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value);
  if (!/^\d{1,10}$/.test(s) || Number(s) < 1) {
    throw new ValidationError(`${field} must be a positive integer`);
  }
  return Number(s);
}

async function sha256OfFile(localPath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    fs.createReadStream(localPath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', resolve)
      .on('error', reject);
  });
  return hash.digest('hex');
}

async function isEncryptedPdf(localPath, size) {
  const length = Math.min(size, ENCRYPT_SCAN_BYTES);
  const handle = await fs.promises.open(localPath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, size - length));
    return buffer.includes('/Encrypt');
  } finally {
    await handle.close();
  }
}

/** Throws a 400 unless the file is an unencrypted PDF by content. */
async function assertPdf(localPath) {
  if (!(await validateFileContent(localPath, 'application/pdf'))) {
    throw new AppError('The file is not a PDF', 400, 'NOT_A_PDF');
  }
  const { size } = await fs.promises.stat(localPath);
  if (await isEncryptedPdf(localPath, size)) {
    throw new AppError('Password-protected PDFs cannot be uploaded', 400, 'PDF_ENCRYPTED');
  }
  return size;
}

function assertStorageKey(key) {
  if (!STORAGE_KEY_RE.test(String(key || ''))) {
    throw new AppError('Document storage key is not valid', 500, 'DOCUMENT_KEY_INVALID');
  }
}

/**
 * Check optional links against the owning customer. An event must be assigned
 * to the customer; a project and a contract must belong to them. For an admin
 * caller the event and project must also be ones that admin may access.
 * Anything else is a 400 — never a hint about whether the record exists.
 */
async function resolveLinks(customerId, input, { admin = null } = {}) {
  const eventId = parseOptionalId(input.eventId, 'eventId');
  const projectId = admin ? parseOptionalId(input.projectId, 'projectId') : null;
  const contractId = parseOptionalId(input.contractId, 'contractId');

  if (eventId) {
    const assigned = await db('event_customer_assignments')
      .where({ customer_account_id: customerId, event_id: eventId })
      .first('id');
    let allowed = !!assigned;
    if (allowed && admin) {
      const { allowed: owned } = await filterOwnedEventIds(admin, [eventId]);
      allowed = owned.length === 1;
    }
    if (!allowed) throw new ValidationError('eventId is not an event of this customer');
  }
  if (projectId) {
    const project = await db('projects').where({ id: projectId, customer_account_id: customerId }).first('id');
    let allowed = !!project;
    if (allowed) {
      const owned = await ownedProjectIds(admin);
      allowed = owned === null || owned.includes(projectId);
    }
    if (!allowed) throw new ValidationError('projectId is not a project of this customer');
  }
  if (contractId) {
    const contract = await db('contracts')
      .where({ id: contractId, customer_account_id: customerId })
      .first('id', 'status');
    // A customer can only refer to a contract they have been sent.
    if (!contract || (!admin && contract.status === 'draft')) {
      throw new ValidationError('contractId is not a contract of this customer');
    }
  }
  return { eventId, projectId, contractId };
}

// ---------------------------------------------------------------------------
// Serialisers
// ---------------------------------------------------------------------------

function toCustomerDto(row) {
  const own = row.uploader_type === 'customer';
  return {
    id: row.id,
    name: row.original_name,
    sizeBytes: Number(row.size_bytes) || 0,
    uploadedBy: own ? 'you' : 'studio',
    status: row.status,
    downloadable: row.status === 'clean',
    // The reason is written for the customer when a file is rejected.
    rejectionReason: own && row.status === 'rejected' ? (row.review_note || null) : null,
    eventId: row.event_id || null,
    eventName: row.event_name || null,
    contractId: row.contract_id || null,
    createdAt: toIso(row.created_at) || null,
    sharedAt: own ? null : (toIso(row.shared_at) || null),
  };
}

function toAdminDto(row, views = [], adminNames = new Map()) {
  const customerViews = views.filter((v) => v.viewer_type === 'customer');
  const viewTimes = customerViews
    .map((v) => new Date(toIso(v.viewed_at)).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  return {
    id: row.id,
    name: row.original_name,
    sizeBytes: Number(row.size_bytes) || 0,
    mimeType: row.mime_type,
    sha256: row.sha256,
    uploaderType: row.uploader_type,
    uploaderName: row.uploader_type === 'admin' ? (adminNames.get(row.uploader_id) || null) : null,
    status: row.status,
    reviewedAt: toIso(row.reviewed_at) || null,
    reviewNote: row.review_note || null,
    shared: isShared(row),
    sharedAt: toIso(row.shared_at) || null,
    unsharedAt: toIso(row.unshared_at) || null,
    eventId: row.event_id || null,
    eventName: row.event_name || null,
    projectId: row.project_id || null,
    contractId: row.contract_id || null,
    contractNumber: row.contract_number || null,
    createdAt: toIso(row.created_at) || null,
    customerViewCount: viewTimes.length,
    customerFirstViewedAt: viewTimes.length ? new Date(viewTimes[0]).toISOString() : null,
    customerLastViewedAt: viewTimes.length ? new Date(viewTimes[viewTimes.length - 1]).toISOString() : null,
  };
}

function baseQuery() {
  return db('customer_documents')
    .leftJoin('events', 'events.id', 'customer_documents.event_id')
    .select('customer_documents.*', 'events.event_name as event_name');
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** What the customer may see: own uploads, plus clean documents shared with them. */
function customerVisibleQuery(customerId) {
  return baseQuery()
    .where('customer_documents.customer_account_id', customerId)
    .whereNull('customer_documents.deleted_at')
    .andWhere((q) => {
      q.where('customer_documents.uploader_type', 'customer')
        .orWhere((q2) => {
          q2.whereNotNull('customer_documents.shared_at')
            .whereNull('customer_documents.unshared_at')
            .where('customer_documents.status', 'clean');
        });
    });
}

async function listForCustomer(customerId, { eventId = null } = {}) {
  const q = customerVisibleQuery(customerId).orderBy('customer_documents.id', 'desc');
  if (eventId) q.where('customer_documents.event_id', eventId);
  return (await q).map(toCustomerDto);
}

async function getForCustomer(customerId, documentId) {
  return customerVisibleQuery(customerId).where('customer_documents.id', documentId).first();
}

async function listForAdmin(customerId) {
  const rows = await baseQuery()
    .leftJoin('contracts', 'contracts.id', 'customer_documents.contract_id')
    .select('contracts.contract_number as contract_number')
    .where('customer_documents.customer_account_id', customerId)
    .whereNull('customer_documents.deleted_at')
    .orderBy('customer_documents.id', 'desc');
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const views = await db('customer_document_views')
    .whereIn('document_id', ids)
    .select('document_id', 'viewer_type', 'viewed_at');
  const adminIds = [...new Set(rows.filter((r) => r.uploader_type === 'admin' && r.uploader_id).map((r) => r.uploader_id))];
  const adminNames = new Map();
  if (adminIds.length > 0) {
    const admins = await db('admin_users').whereIn('id', adminIds).select('id', 'username');
    for (const a of admins) adminNames.set(a.id, a.username);
  }
  return rows.map((r) => toAdminDto(r, views.filter((v) => v.document_id === r.id), adminNames));
}

async function getForAdmin(customerId, documentId) {
  const row = await db('customer_documents')
    .where({ id: documentId, customer_account_id: customerId })
    .whereNull('deleted_at')
    .first();
  if (!row) throw new NotFoundError('Document');
  return row;
}

/** Pending / rejected counts for System Health. */
async function getReviewCounts() {
  const rows = await db('customer_documents')
    .whereNull('deleted_at')
    .whereIn('status', ['pending', 'rejected'])
    .groupBy('status')
    .select('status')
    .count({ c: '*' });
  const counts = { pending: 0, rejected: 0 };
  for (const r of rows) counts[r.status] = Number(r.c) || 0;
  return counts;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Store an uploaded file. `file` is the multer temp file; the caller removes
 * it afterwards. `actor` is the activity-log actor.
 */
async function createDocument({ customerId, uploaderType, uploaderId, file, links, share = false, admin = null, actor }) {
  const resolved = await resolveLinks(customerId, links || {}, { admin });
  const size = await assertPdf(file.path);
  const sha256 = await sha256OfFile(file.path);
  const verdict = await documentScanService.scanFile(file.path);
  if (verdict === 'rejected') {
    await logActivity('customer_document_scan_rejected', { customerId, uploaderType }, null, actor);
    throw new AppError('The file did not pass the security check', 422, 'DOCUMENT_REJECTED_BY_SCAN');
  }
  // With no scanner registered an admin upload is vouched for by the admin
  // who uploaded it; a customer upload waits for review.
  const status = verdict === 'clean' || uploaderType === 'admin' ? 'clean' : 'pending';
  const now = new Date().toISOString();

  const key = `${STORAGE_PREFIX}/${customerId}/${crypto.randomUUID()}.pdf`;
  const storage = getStorage();
  await storage.putFromFile(key, file.path);

  let id;
  try {
    const inserted = await db('customer_documents').insert({
      customer_account_id: customerId,
      event_id: resolved.eventId,
      project_id: resolved.projectId,
      contract_id: resolved.contractId,
      uploader_type: uploaderType,
      uploader_id: uploaderId || null,
      original_name: cleanDisplayName(file.originalname),
      storage_key: key,
      mime_type: 'application/pdf',
      size_bytes: size,
      sha256,
      status,
      reviewed_at: status === 'clean' ? now : null,
      reviewed_by_admin_id: status === 'clean' && uploaderType === 'admin' ? uploaderId : null,
      shared_at: uploaderType === 'admin' && share ? now : null,
      created_at: now,
      updated_at: now,
    }).returning('id');
    id = typeof inserted[0] === 'object' && inserted[0] !== null ? inserted[0].id : inserted[0];
  } catch (err) {
    await storage.delete(key).catch(() => {});
    throw err;
  }

  await logActivity('customer_document_uploaded',
    { documentId: id, customerId, uploaderType, sizeBytes: size, status },
    resolved.eventId, actor);
  return db('customer_documents').where({ id }).first();
}

async function setShared(customerId, documentId, shared, admin) {
  const row = await getForAdmin(customerId, documentId);
  if (shared && row.status !== 'clean') {
    throw new AppError('Mark the document clean before sharing it', 409, 'DOCUMENT_NOT_CLEAN');
  }
  const now = new Date().toISOString();
  await db('customer_documents').where({ id: row.id }).update(shared
    ? { shared_at: now, unshared_at: null, updated_at: now }
    : { unshared_at: now, updated_at: now });
  await logActivity(shared ? 'customer_document_shared' : 'customer_document_unshared',
    { documentId: row.id, customerId }, row.event_id, { type: 'admin', id: admin.id, name: admin.username || 'admin' });
}

async function review(customerId, documentId, { status, note }, admin) {
  if (!['clean', 'rejected'].includes(status)) throw new ValidationError('status must be clean or rejected');
  const row = await getForAdmin(customerId, documentId);
  const now = new Date().toISOString();
  const update = {
    status,
    reviewed_at: now,
    reviewed_by_admin_id: admin.id,
    review_note: note ? String(note).slice(0, 500) : null,
    updated_at: now,
  };
  // A rejected file is never left shared.
  if (status === 'rejected' && isShared(row)) update.unshared_at = now;
  await db('customer_documents').where({ id: row.id }).update(update);
  await logActivity('customer_document_reviewed',
    { documentId: row.id, customerId, status }, row.event_id, { type: 'admin', id: admin.id, name: admin.username || 'admin' });
}

async function updateLinks(customerId, documentId, links, admin) {
  const row = await getForAdmin(customerId, documentId);
  const resolved = await resolveLinks(customerId, links, { admin });
  await db('customer_documents').where({ id: row.id }).update({
    event_id: resolved.eventId,
    project_id: resolved.projectId,
    contract_id: resolved.contractId,
    updated_at: new Date().toISOString(),
  });
  await logActivity('customer_document_linked',
    { documentId: row.id, customerId, ...resolved }, resolved.eventId, { type: 'admin', id: admin.id, name: admin.username || 'admin' });
}

async function softDelete(customerId, documentId, admin) {
  const row = await getForAdmin(customerId, documentId);
  const now = new Date().toISOString();
  await db('customer_documents').where({ id: row.id }).update({
    deleted_at: now,
    unshared_at: row.unshared_at || (row.shared_at ? now : null),
    updated_at: now,
  });
  await logActivity('customer_document_deleted',
    { documentId: row.id, customerId }, row.event_id, { type: 'admin', id: admin.id, name: admin.username || 'admin' });
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/**
 * Open the stored bytes. On local storage the resolved path is checked to sit
 * inside business-docs/customer-documents before it is opened, so a bad row
 * can't turn a download into a read of some other file.
 */
async function openStream(row) {
  if (row.purged_at) throw new AppError('This document is no longer available', 410, 'DOCUMENT_PURGED');
  assertStorageKey(row.storage_key);
  const storage = getStorage();
  if (storage.kind() === 'local') {
    const abs = storage.resolveLocalPath(row.storage_key);
    const safe = assertPathInside(abs, [path.join(getStoragePath(), STORAGE_PREFIX)]);
    return fs.createReadStream(safe);
  }
  return storage.get(row.storage_key);
}

async function recordView(documentId, viewerType, viewerId) {
  await db('customer_document_views').insert({
    document_id: documentId,
    viewer_type: viewerType,
    viewer_id: viewerId || null,
    viewed_at: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Erasure and retention
// ---------------------------------------------------------------------------

/**
 * Customer erasure (customerAccountsService.eraseCustomer). Runs inside the
 * erase transaction. Documents linked to a contract are kept — they are part
 * of the contractual record — but unshared. Every other document is deleted;
 * the returned keys are purged once the transaction has committed.
 */
async function markErasedForCustomer(customerId, trx) {
  const now = new Date().toISOString();
  const doomed = await trx('customer_documents')
    .where({ customer_account_id: customerId })
    .whereNull('purged_at')
    .whereNull('contract_id')
    .select('id', 'storage_key');
  if (doomed.length > 0) {
    await trx('customer_documents').whereIn('id', doomed.map((d) => d.id)).update({
      deleted_at: now,
      unshared_at: now,
      original_name: 'erased.pdf',
      updated_at: now,
    });
  }
  await trx('customer_documents')
    .where({ customer_account_id: customerId })
    .whereNotNull('contract_id')
    .whereNotNull('shared_at')
    .whereNull('unshared_at')
    .update({ unshared_at: now, updated_at: now });
  return doomed;
}

/** Delete the bytes of the given rows and stamp purged_at. Best effort per file. */
async function purgeFiles(rows) {
  const storage = getStorage();
  for (const r of rows) {
    try {
      assertStorageKey(r.storage_key);
      await storage.delete(r.storage_key);
      await db('customer_documents').where({ id: r.id }).update({ purged_at: new Date().toISOString() });
    } catch (err) {
      logger.warn('Could not remove a customer document file', { documentId: r.id, error: err.message });
    }
  }
}

module.exports = {
  STORAGE_PREFIX,
  getLimits,
  getRetentionDays,
  getUsageBytes,
  parseOptionalId,
  listForCustomer,
  getForCustomer,
  listForAdmin,
  getForAdmin,
  getReviewCounts,
  createDocument,
  setShared,
  review,
  updateLinks,
  softDelete,
  openStream,
  recordView,
  markErasedForCustomer,
  purgeFiles,
  toCustomerDto,
  // exported for tests
  _internal: { cleanDisplayName, assertPdf, assertStorageKey },
};
