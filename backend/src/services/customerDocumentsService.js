/**
 * customerDocumentsService — documents exchanged between the studio and a
 * customer in the portal (#1444, migration 225).
 *
 * Rules the routes rely on (every read here is scoped by customer_account_id;
 * the routes never look a document up by id alone):
 *
 *  - Uploads are one of the formats the install accepts (documentFormats:
 *    PDF by default; docx, xlsx, odt, ods, txt, csv once an admin opts in).
 *    The content decides, by a format-specific check (assertContent); an
 *    encrypted file is refused because nothing can inspect it.
 *  - Customer uploads start `pending` and stay unavailable for download until
 *    an admin marks them clean or rejects them (decision #24b). Admin uploads
 *    are recorded clean by the uploading admin, unless a registered scanner
 *    says otherwise.
 *  - A customer sees their own uploads (any status) and documents shared with
 *    them that are clean. They can download only clean ones.
 *  - Unsharing and deleting take effect on the next request. Delete is soft;
 *    the retention sweep removes the bytes later and keeps the row.
 *  - Bytes live under business-docs/customer-documents/<customer>/<uuid>.<ext>,
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
const { validatePdf } = require('../utils/pdfValidation');
const { toIso } = require('../utils/dateNormalize');
const { AppError, NotFoundError, ValidationError } = require('../utils/errors');
const { filterOwnedEventIds, ownedProjectIds } = require('../middleware/ownership');
const documentScanService = require('./documentScanService');
const documentFormats = require('./documentFormats');
const { validateOffice } = require('../utils/officeValidation');
const { inspectText } = require('../utils/officeInspect');
const customerDocumentRequestsService = require('./customerDocumentRequestsService');
const logger = require('../utils/logger');

const STORAGE_PREFIX = 'business-docs/customer-documents';
const STORAGE_KEY_RE = new RegExp(
  `^business-docs/customer-documents/\\d+/[0-9a-f-]{36}\\.(${documentFormats.ALL_FORMATS.join('|')})$`,
);
const MB = 1024 * 1024;
// A signed contract, a scanned appendix — generous, and far below what the
// inspector's own budgets would let through anyway.
const MAX_DOCUMENT_PAGES = 300;

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
async function getUsageBytes(customerId, conn = db) {
  const row = await conn('customer_documents')
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

/**
 * Display name: the uploaded basename without control characters or path
 * separators, rebuilt as `<clean base>.<registry extension>` — whatever
 * extension the upload carried, the one the format registry gives is what
 * the name ends in.
 */
function cleanDisplayName(originalName, format = 'pdf') {
  const ext = documentFormats.isFormat(format) ? documentFormats.FORMATS[format].ext : '.pdf';
  let base = path.basename(String(originalName || ''))
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/[/\\]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .replace(/\.[A-Za-z0-9]+$/, '')
    .trim();
  if (!base) base = 'document';
  if (base.length + ext.length > 200) base = base.slice(0, 200 - ext.length);
  return `${base}${ext}`;
}

function parseOptionalId(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value);
  if (!/^\d{1,10}$/.test(s) || Number(s) < 1 || Number(s) > 2147483647) {
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

/**
 * Check the file's content, and refuse anything that isn't a plain PDF.
 *
 * This used to be a 20-byte magic check plus a string search for `/Encrypt`
 * near the end of the file — which sees neither a PDF carrying JavaScript or
 * a launch action, nor one that inflates into gigabytes, nor a `/Encrypt`
 * dictionary that sits anywhere else. Contract attachments were already
 * inspected properly (utils/pdfValidation: parsed in a worker with heap,
 * time, RSS and decompression budgets); customer uploads, which come from
 * outside the building, were checked less.
 *
 * Two deliberate differences from the attachment path:
 *
 *   - forms stay allowed. Customers upload *signed* contracts, and a signed
 *     PDF carries an AcroForm signature field. `pdfInspect` refuses actions
 *     that run, submit or import — `/SubmitForm`, `/ResetForm`, `/ImportData`
 *     — but not the presence of a form, so signature fields pass.
 *   - the ORIGINAL bytes are stored, not the `normalised` re-serialisation
 *     an attachment keeps. Re-writing the file would break the byte ranges a
 *     digital signature covers, and these documents are evidence.
 *
 * @returns {Promise<{ size: number, pages: number|null }>}
 */
async function assertPdf(localPath, { maxBytes = null } = {}) {
  const { size } = await fs.promises.stat(localPath);
  let info;
  try {
    info = await validatePdf(await fs.promises.readFile(localPath), {
      maxBytes: maxBytes || undefined,
      maxPages: MAX_DOCUMENT_PAGES,
    });
  } catch (err) {
    throw documentPdfError(err);
  }
  return { size, pages: info.pages == null ? null : Number(info.pages) };
}

/**
 * The inspector's refusals, in this route's own vocabulary. Its codes are
 * written for an admin attaching a document to a contract; these reach a
 * customer who is trying to upload a signed contract, and the portal has a
 * message for each.
 */
const PDF_ERROR_CODES = {
  PDF_NOT_A_PDF: ['The file is not a PDF', 'NOT_A_PDF'],
  PDF_ENCRYPTED: ['Password-protected PDFs cannot be uploaded', 'PDF_ENCRYPTED'],
  PDF_TOO_LARGE: [null, 'FILE_TOO_LARGE'],
  PDF_TOO_MANY_PAGES: [`A document may have at most ${MAX_DOCUMENT_PAGES} pages`, 'PDF_TOO_MANY_PAGES'],
  PDF_TOO_COMPLEX: [null, 'PDF_TOO_COMPLEX'],
  PDF_ACTIVE_CONTENT: [null, 'PDF_ACTIVE_CONTENT'],
};

function documentPdfError(err) {
  if (!(err instanceof AppError)) {
    throw new AppError('The file could not be checked', 400, 'NOT_A_PDF');
  }
  const mapped = PDF_ERROR_CODES[err.code];
  if (mapped) return new AppError(mapped[0] || err.message, err.statusCode || 400, mapped[1]);
  // Everything else the inspector refuses is active or embedded content:
  // JavaScript, a launch action, an embedded file, an XFA form.
  return new AppError(
    'This PDF contains active content (a script, an embedded file or a form action) and cannot be uploaded. '
    + 'Please print it to PDF and upload that file.',
    400, 'PDF_ACTIVE_CONTENT',
  );
}

/**
 * The content check for `format`, which decides. Each maps its refusals onto
 * the portal's {error, code} vocabulary.
 */
async function assertContent(localPath, format, { maxBytes = null } = {}) {
  if (format === 'pdf') return assertPdf(localPath, { maxBytes });
  const { size } = await fs.promises.stat(localPath);
  if (format === 'txt' || format === 'csv') {
    try {
      await inspectText(localPath, { maxBytes });
    } catch (err) {
      throw new AppError(err.message, 400, err.code || 'DOCUMENT_NOT_TEXT');
    }
    return { size, pages: null };
  }
  await validateOffice(localPath, format);
  return { size, pages: null };
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
    eventSlug: row.event_slug || null,
    contractId: row.contract_id || null,
    createdAt: toIso(row.created_at) || null,
    sharedAt: own ? null : (toIso(row.shared_at) || null),
    reviewedAt: own ? (toIso(row.reviewed_at) || null) : null,
    // Own uploads only, and not while part of a contract (softDeleteByCustomer).
    canDelete: own && !row.contract_id,
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
    // Rejected by the scanner (customerDocumentRescanService), not an admin's
    // own content/format call: the review endpoint refuses to flip this back
    // to clean, and the UI hides "Mark clean" for it.
    malwareFlagged: !!row.malware_flagged,
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
    .select('customer_documents.*', 'events.event_name as event_name', 'events.slug as event_slug');
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

/**
 * `eventId` narrows the list to one event: documents naming it, plus — when
 * given — documents linked to one of `contractIds` / `projectIds` (the
 * event's deal lineage). Always inside customerVisibleQuery, so the lineage
 * can only select among what the customer may see anyway.
 */
async function listForCustomer(customerId, { eventId = null, contractIds = [], projectIds = [] } = {}) {
  const q = customerVisibleQuery(customerId).orderBy('customer_documents.id', 'desc');
  if (eventId) {
    q.andWhere((w) => {
      w.where('customer_documents.event_id', eventId);
      if (contractIds.length > 0) w.orWhereIn('customer_documents.contract_id', contractIds);
      if (projectIds.length > 0) w.orWhereIn('customer_documents.project_id', projectIds);
    });
  }
  return (await q).map(toCustomerDto);
}

/** The raw rows behind listForCustomer, for the dashboard's "Recent". */
async function listVisibleRows(customerId) {
  return customerVisibleQuery(customerId).orderBy('customer_documents.id', 'desc');
}

async function getForCustomer(customerId, documentId) {
  return customerVisibleQuery(customerId).where('customer_documents.id', documentId).first();
}

/**
 * What one document id means to this customer, for the document page and the
 * download route (#1444). Unlike getForCustomer it also answers for rows the
 * customer can no longer see, so the page can say *why* — but only for rows
 * the customer did see once:
 *
 *   { state: 'visible', row }  own upload (any status) or a shared clean one
 *   { state: 'unshared' }      shared by the studio once, no longer
 *   { state: 'removed' }       deleted (or purged) own upload, or a deleted
 *                              document the studio had shared
 *   null                       everything else: another customer's id, an id
 *                              that doesn't exist, and a studio upload that
 *                              was never shared with them. The route answers
 *                              the same 404 for all three, so this is no
 *                              existence oracle.
 */
async function getStateForCustomer(customerId, documentId) {
  const row = await baseQuery()
    .where('customer_documents.customer_account_id', customerId)
    .where('customer_documents.id', documentId)
    .first();
  if (!row) return null;
  const own = row.uploader_type === 'customer';
  if (!own && !row.shared_at) return null;
  if (row.deleted_at || row.purged_at) return { state: 'removed' };
  if (own) return { state: 'visible', row };
  if (row.unshared_at || row.status !== 'clean') return { state: 'unshared' };
  return { state: 'visible', row };
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
  // System Health is opened during upgrades too, before migration 225 ran.
  if (!(await db.schema.hasTable('customer_documents'))) return { pending: 0, rejected: 0 };
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
async function createDocument({
  customerId, uploaderType, uploaderId, file, links, share = false, admin = null, actor,
  quotaBytes = null, maxUploadBytes = null, requestId = null,
}) {
  // An upload answering a document request (slice 10): the request must be
  // this customer's and still open — checked here to fail fast, and again,
  // conditionally, inside the write transaction.
  const request = requestId ? await customerDocumentRequestsService.getOpen(customerId, requestId) : null;
  const linkInput = { ...(links || {}) };
  // The request's own links win over what the upload names: the answer
  // belongs where the studio asked for it.
  if (request && request.event_id) linkInput.eventId = request.event_id;
  if (request && request.contract_id) linkInput.contractId = null;
  const resolved = await resolveLinks(customerId, linkInput, { admin });
  // The request's contract link carries over too, so the answer is part of
  // that contract (retention, contract lookup) like an upload naming it. Not
  // through resolveLinks: the studio may have asked against a contract still
  // in draft, which a customer could not name themselves.
  if (request && !resolved.contractId && request.contract_id) {
    const contract = await db('contracts')
      .where({ id: request.contract_id, customer_account_id: customerId })
      .first('id');
    if (contract) resolved.contractId = contract.id;
  }
  // The route's filter already chose the format from the name; checked again
  // here against the setting, so no caller can store a format the install
  // doesn't accept.
  const format = file.documentFormat || documentFormats.formatForName(file.originalname);
  if (!format || !(await documentFormats.getAllowedFormats()).includes(format)) {
    throw new AppError('This file type cannot be uploaded', 400, 'FORMAT_NOT_ALLOWED');
  }
  const { size } = await assertContent(file.path, format, { maxBytes: maxUploadBytes });
  const sha256 = await sha256OfFile(file.path);
  const verdict = await documentScanService.scanFile(file.path);
  if (verdict === 'rejected') {
    await logActivity('customer_document_scan_rejected', { customerId, uploaderType }, null, actor);
    throw new AppError('The file did not pass the security check', 422, 'DOCUMENT_REJECTED_BY_SCAN');
  }
  // With NO scanner registered an admin upload is vouched for by the admin
  // who uploaded it, and a customer upload waits for their review — the
  // admin's review is the gate that stands in for a scanner.
  //
  // Once a scanner IS registered it is the gate, for both. An admin upload
  // used to be stored `clean` whatever the scanner said, so a scanner that
  // was down, timed out or answered `pending` let an admin upload through
  // unscanned and shareable — the one case where a scanner would have been
  // doing something.
  const vouched = uploaderType === 'admin' && !documentScanService.hasScanner();
  const status = verdict === 'clean' || vouched ? 'clean' : 'pending';
  const now = new Date().toISOString();

  const key = `${STORAGE_PREFIX}/${customerId}/${crypto.randomUUID()}.${format}`;
  const storage = getStorage();
  await storage.putFromFile(key, file.path);

  let id;
  try {
    // The quota is counted and the row written in one transaction, with the
    // customer's row locked: the route's own check runs before the body has
    // arrived, so uploads landing together all measured the same "before"
    // and every one of them fitted.
    const inserted = await db.transaction(async (trx) => {
      if (quotaBytes != null && uploaderType === 'customer') {
        await trx('customer_accounts').where({ id: customerId }).forUpdate().first('id');
        if ((await getUsageBytes(customerId, trx)) + size > quotaBytes) {
          throw new AppError('This file would exceed your document storage.', 413, 'QUOTA_EXCEEDED');
        }
      }
      const rows = await trx('customer_documents').insert({
        customer_account_id: customerId,
        event_id: resolved.eventId,
        project_id: resolved.projectId,
        contract_id: resolved.contractId,
        uploader_type: uploaderType,
        uploader_id: uploaderId || null,
        original_name: cleanDisplayName(file.originalname, format),
        storage_key: key,
        mime_type: documentFormats.contentTypeFor(format).split(';')[0],
        size_bytes: size,
        sha256,
        status,
        reviewed_at: status === 'clean' ? now : null,
        scanned_at: verdict === 'clean' ? now : null,
        reviewed_by_admin_id: status === 'clean' && uploaderType === 'admin' ? uploaderId : null,
        // Only a clean document can be shared (setShared refuses anything
        // else), so a share asked for on an upload the scanner left pending
        // is not recorded: the admin shares it after marking it clean.
        shared_at: uploaderType === 'admin' && share && status === 'clean' ? now : null,
        created_at: now,
        updated_at: now,
      }).returning('id');
      const newId = typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0];
      if (request) await customerDocumentRequestsService.fulfilInTransaction(trx, customerId, request.id, newId);
      return newId;
    });
    id = inserted;
  } catch (err) {
    await storage.delete(key).catch(() => {});
    throw err;
  }

  await logActivity('customer_document_uploaded',
    { documentId: id, customerId, uploaderType, sizeBytes: size, status },
    resolved.eventId, actor);
  if (request) {
    await logActivity('customer_document_request_fulfilled',
      { requestId: request.id, documentId: id, customerId }, resolved.eventId, actor);
  }
  const row = await db('customer_documents').where({ id }).first();
  // Shared on the way in: a share like any other, so the timeline shows it.
  if (row.shared_at) {
    await logActivity('customer_document_shared', { documentId: id, customerId }, resolved.eventId, actor);
  }
  return row;
}

/**
 * Share or unshare. Resolves `{ row, changed }`: sharing a document that is
 * already shared (a second click, a retry) or unsharing one that isn't
 * shared changes nothing — no timestamp, no log row — so the caller sends
 * no second mail and fires no second workflow. The update is conditional,
 * so two clicks landing together still change it once.
 */
async function setShared(customerId, documentId, shared, admin) {
  const row = await getForAdmin(customerId, documentId);
  if (shared && row.status !== 'clean') {
    throw new AppError('Mark the document clean before sharing it', 409, 'DOCUMENT_NOT_CLEAN');
  }
  const now = new Date().toISOString();
  const q = db('customer_documents').where({ id: row.id });
  const changed = shared
    ? await q.andWhere((w) => w.whereNull('shared_at').orWhereNotNull('unshared_at'))
      .update({ shared_at: now, unshared_at: null, updated_at: now })
    : await q.whereNotNull('shared_at').whereNull('unshared_at')
      .update({ unshared_at: now, updated_at: now });
  if (changed > 0) {
    await logActivity(shared ? 'customer_document_shared' : 'customer_document_unshared',
      { documentId: row.id, customerId }, row.event_id, { type: 'admin', id: admin.id, name: admin.username || 'admin' });
  }
  return { row: await db('customer_documents').where({ id: row.id }).first(), changed: changed > 0 };
}

async function review(customerId, documentId, { status, note }, admin) {
  if (!['clean', 'rejected'].includes(status)) throw new ValidationError('status must be clean or rejected');
  const row = await getForAdmin(customerId, documentId);
  // A scanner's malware verdict, not an ordinary content/format rejection:
  // the normal review path may not un-reject it. Nothing in this codebase
  // has a more-privileged override for a single row (super_admin gates
  // whole-instance operations — backup restore, the raw DB dump — not a
  // per-document call), so this is a hard refusal rather than a gated one.
  // Only that verdict blocks review. A file still pending because the
  // scanner is down, timed out or is too large to send stays reviewable:
  // the admin's own judgment is the fallback for a missing verdict, as it is
  // on an install with no scanner at all (documented in .env.example).
  if (status === 'clean' && row.malware_flagged) {
    throw new AppError(
      'This file was flagged by the malware scanner and cannot be marked clean.',
      409, 'DOCUMENT_MALWARE_FLAGGED',
    );
  }
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
  // Accepted after all (a rejection reversed): the request it answered, if
  // still open and not answered by another upload since, is fulfilled again.
  if (status === 'clean') await customerDocumentRequestsService.restoreForDocument(row.id);
  await logActivity('customer_document_reviewed',
    { documentId: row.id, customerId, status }, row.event_id, { type: 'admin', id: admin.id, name: admin.username || 'admin' });
  return db('customer_documents').where({ id: row.id }).first();
}

/**
 * What follows a rejection, whoever made it — an admin's review or the
 * scanner's re-scan: a document request the file answered is open again
 * (the customer still owes it), and the customer is told about their own
 * upload. Call after the rejection is written. Resolves with what happened
 * to the mail ('queued' | 'skipped' | 'failed').
 */
async function afterRejection(row) {
  // Read again: accepted since (a review racing a re-scan), there is nothing
  // to follow up, and the reopen below re-checks it in its own write.
  const current = row && await db('customer_documents').where({ id: row.id }).first();
  if (!current || current.status !== 'rejected') return 'skipped';
  row = current;
  await customerDocumentRequestsService.reopenForDocument(row.id);
  // Required here: the notifications module reaches customerAccountsService,
  // which requires this one.
  return require('./customerDocumentNotifications').notifyRejected(row);
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

/**
 * A contract-linked document is part of a contractual record, so deleting it
 * is refused until it is unlinked (#1444).
 *
 * Erasure already keeps such a document — unshared and renamed — as evidence
 * (markErasedForCustomer), but a plain delete removed it and the retention
 * sweep then purged its bytes, which is the silent destruction of a
 * contractual record the issue rules out. Refusing makes the deliberate path
 * the only path: unlink from the contract, then delete.
 */
function assertNotContractLinked(row) {
  if (row.contract_id) {
    throw new AppError(
      'This document is linked to a contract. Unlink it from the contract before deleting it.',
      409, 'DOCUMENT_CONTRACT_LINKED',
    );
  }
}

async function softDelete(customerId, documentId, admin) {
  const row = await getForAdmin(customerId, documentId);
  assertNotContractLinked(row);
  const now = new Date().toISOString();
  await db('customer_documents').where({ id: row.id }).update({
    deleted_at: now,
    unshared_at: row.unshared_at || (row.shared_at ? now : null),
    updated_at: now,
  });
  await customerDocumentRequestsService.reopenForDocument(row.id);
  await logActivity('customer_document_deleted',
    { documentId: row.id, customerId }, row.event_id, { type: 'admin', id: admin.id, name: admin.username || 'admin' });
}

/**
 * A customer deleting their own upload (#1444). Only rows they uploaded and
 * haven't deleted qualify — a document the studio shared, another
 * customer's, or an unknown id is the same 404 the portal gives everywhere.
 * Pending, rejected and accepted uploads can all be deleted; a
 * contract-linked one cannot, like on the admin side. The quota frees at
 * once (it counts undeleted rows); the bytes go with the retention sweep.
 */
async function softDeleteByCustomer(customerId, documentId, actor) {
  const row = await db('customer_documents')
    .where({ id: documentId, customer_account_id: customerId, uploader_type: 'customer' })
    .whereNull('deleted_at')
    .first();
  if (!row) throw new AppError('Document not found', 404, 'DOCUMENT_NOT_FOUND');
  assertNotContractLinked(row);
  const now = new Date().toISOString();
  // contract_id and deleted_at asserted again: a link or a delete landing
  // between the read and this write wins.
  const changed = await db('customer_documents')
    .where({ id: row.id })
    .whereNull('deleted_at')
    .whereNull('contract_id')
    .update({ deleted_at: now, updated_at: now });
  if (changed === 0) {
    const current = await db('customer_documents').where({ id: row.id }).first('contract_id', 'deleted_at');
    if (current && current.contract_id && !current.deleted_at) assertNotContractLinked(current);
    throw new AppError('Document not found', 404, 'DOCUMENT_NOT_FOUND');
  }
  await customerDocumentRequestsService.reopenForDocument(row.id);
  await logActivity('customer_document_deleted',
    { documentId: row.id, customerId }, row.event_id, actor);
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
  // The replacement name keeps the file's own extension (erased.docx), taken
  // from the generated storage key.
  const erasedName = (row) => `erased.${documentFormats.formatForStorageKey(row.storage_key) || 'pdf'}`;
  for (const d of doomed) {
    await trx('customer_documents').where({ id: d.id }).update({
      deleted_at: now,
      unshared_at: now,
      updated_at: now,
    });
  }
  // Every row keeps only what the record needs. The name the customer gave
  // the file ("Scan_Anna_Muster_Pass.pdf") and the studio's review note
  // ("passport expired") are their data: erasure reaches them on documents
  // kept for a contract, on deleted ones, and on rows whose bytes a retention
  // sweep already purged. The bytes and the storage key stay where kept.
  const named = await trx('customer_documents')
    .where({ customer_account_id: customerId })
    .select('id', 'storage_key');
  for (const d of named) {
    await trx('customer_documents').where({ id: d.id }).update({
      original_name: erasedName(d),
      review_note: null,
      updated_at: now,
    });
  }
  await trx('customer_documents')
    .where({ customer_account_id: customerId })
    .whereNotNull('contract_id')
    .whereNotNull('shared_at')
    .whereNull('unshared_at')
    .update({ unshared_at: now, updated_at: now });
  // Document requests (migration 243) are the studio's notes about what it
  // asked this customer for — their data too, and no contractual record.
  await trx('customer_document_requests').where({ customer_account_id: customerId }).del();
  return doomed;
}

/**
 * Delete the bytes of the given rows and stamp purged_at. Best effort per file.
 *
 * The rows are a snapshot taken by the caller, so the stamp is claimed first
 * and only while the row is still unlinked from a contract: a link made since
 * the snapshot keeps the bytes. A failed delete releases the claim so the
 * next sweep tries again.
 */
async function purgeFiles(rows) {
  const storage = getStorage();
  for (const r of rows) {
    let claimed = false;
    try {
      assertStorageKey(r.storage_key);
      claimed = (await db('customer_documents')
        .where({ id: r.id })
        .whereNull('contract_id')
        .whereNull('purged_at')
        .update({ purged_at: new Date().toISOString() })) > 0;
      if (!claimed) continue;
      await storage.delete(r.storage_key);
    } catch (err) {
      if (claimed) {
        await db('customer_documents').where({ id: r.id }).update({ purged_at: null }).catch(() => {});
      }
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
  listVisibleRows,
  getForCustomer,
  getStateForCustomer,
  listForAdmin,
  getForAdmin,
  getReviewCounts,
  createDocument,
  setShared,
  review,
  afterRejection,
  updateLinks,
  softDelete,
  softDeleteByCustomer,
  openStream,
  recordView,
  markErasedForCustomer,
  purgeFiles,
  toCustomerDto,
  // exported for tests
  _internal: { cleanDisplayName, assertPdf, assertContent, assertStorageKey },
};
