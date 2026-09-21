'use strict';

/**
 * Contract attachments (#1445): a library of immutable PDFs — terms and
 * conditions, privacy notices, appendices — that templates and contracts
 * include. Each is merged into the contract PDF (between the body and the
 * signature page) or delivered as a separate file.
 *
 * A file is stored once, under business-docs/attachments/<sha256>.pdf, and
 * never changed; uploading the same bytes again finds the existing entry.
 * Every upload is checked by content first (utils/pdfValidation): a real
 * PDF, not encrypted, without scripts, actions, forms or embedded files,
 * within the size and page caps. A contract records each attachment's
 * sha256 when it's added, and sending refuses a file whose bytes no longer
 * match.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, logActivity } = require('../../database/db');
const { AppError } = require('../../utils/errors');
const { isUniqueViolation } = require('../../utils/dbErrors');
const { ensureInt } = require('../../utils/numericHelpers');
const { getStoragePath } = require('../../config/storage');
const { assertPathInside } = require('../../utils/safePath');
const { validatePdf } = require('../../utils/pdfValidation');
const { insertBeforeLastPage } = require('../pdf/merge');
const { auditedInsert, auditedDelete } = require('../accountingHistory');

const FOLDER = path.join('business-docs', 'attachments');
const DELIVERIES = ['merged', 'separate'];
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PAGES = 100;
const MAX_PER_DOCUMENT = 20;

const truthy = (v) => v === true || v === 1 || v === '1';
const insertedId = (rows) => (typeof rows[0] === 'object' ? rows[0].id : rows[0]);
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

async function audit(type, meta, adminId) {
  try {
    await logActivity(type, meta, null, `admin:${adminId}`);
  } catch (_) { /* non-fatal */ }
}

function toApi(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || null,
    originalName: row.original_name || null,
    sha256: row.sha256,
    bytes: Number(row.bytes),
    pages: Number(row.page_count),
    isActive: truthy(row.is_active),
    createdAt: row.created_at,
  };
}

/** A template-version or contract attachment, joined with its library row. */
function inclusionToApi(row) {
  return {
    attachmentId: row.attachment_id,
    position: Number(row.position),
    delivery: row.delivery,
    name: row.name,
    pages: Number(row.page_count),
    bytes: Number(row.bytes),
    sha256: row.inclusion_sha256 || row.sha256,
    isActive: truthy(row.is_active),
  };
}

function attachmentsRoot() {
  return path.join(getStoragePath(), FOLDER);
}

/** A stored attachment's bytes — read from inside the attachments folder only. */
function readStoredFile(row) {
  const absolute = assertPathInside(path.join(getStoragePath(), row.storage_key), [attachmentsRoot()]);
  return { absolute, buffer: fs.readFileSync(absolute) };
}

function changed(name) {
  return new AppError(
    `The attachment "${name}" no longer matches the file that was added. Remove it and add it again.`,
    409,
    'ATTACHMENT_CHANGED',
  );
}

// ---------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------

async function listAttachments() {
  const rows = await db('document_attachments').orderBy('name', 'asc').orderBy('id', 'asc');
  return rows.map(toApi);
}

async function getAttachmentRow(id) {
  const row = await db('document_attachments').where({ id }).first();
  if (!row) throw new AppError('Attachment not found', 404, 'ATTACHMENT_NOT_FOUND');
  return row;
}

/**
 * Check and store an uploaded PDF. Returns `{ attachment, existing }` —
 * `existing` when the same bytes were already in the library (an archived
 * entry comes back into use).
 */
async function storeAttachment(buffer, { name, description, originalName } = {}, adminId) {
  const label = String(name || originalName || '').trim().replace(/\.pdf$/i, '').slice(0, 255);
  if (!label) throw new AppError('An attachment needs a name', 400, 'ATTACHMENT_INVALID');
  const info = await validatePdf(buffer, { maxBytes: MAX_BYTES, maxPages: MAX_PAGES });
  // What is stored is what was checked, not the upload: see pdfValidation.js.
  const checked = info.normalised;

  const storageKey = path.join(FOLDER, `${info.sha256}.pdf`);
  const absolute = path.join(getStoragePath(), storageKey);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  // Named by content: a file already at this name holds exactly these bytes.
  // Written whenever it is absent, so re-uploading the same PDF repairs a
  // row whose file is gone (a database-only restore, say) instead of
  // returning a library entry that can't be downloaded or merged.
  if (!fs.existsSync(absolute)) {
    const temp = `${absolute}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, checked);
    fs.renameSync(temp, absolute);
  }

  const existing = await db('document_attachments').where({ sha256: info.sha256 }).first();
  if (existing) {
    if (!truthy(existing.is_active)) {
      await db('document_attachments').where({ id: existing.id }).update({ is_active: true, updated_at: new Date() });
    }
    return { attachment: toApi({ ...existing, is_active: true }), existing: true };
  }

  const now = new Date();
  let id;
  try {
    id = insertedId(await db('document_attachments').insert({
      name: label,
      description: description ? String(description).trim().slice(0, 2000) || null : null,
      original_name: originalName ? String(originalName).slice(0, 255) : null,
      storage_key: storageKey,
      sha256: info.sha256,
      bytes: info.bytes,
      page_count: info.pages,
      uploaded_by_admin_id: adminId || null,
      is_active: true,
      created_at: now,
      updated_at: now,
    }).returning('id'));
  } catch (err) {
    // The same file uploaded twice at once: the unique sha256 let one in.
    if (!isUniqueViolation(err)) throw err;
    const winner = await db('document_attachments').where({ sha256: info.sha256 }).first();
    return { attachment: toApi(winner), existing: true };
  }
  await audit('document_attachment_uploaded', { attachmentId: id, sha256: info.sha256 }, adminId);
  return { attachment: toApi(await getAttachmentRow(id)), existing: false };
}

async function setAttachmentActive(id, active, adminId) {
  await getAttachmentRow(id);
  await db('document_attachments').where({ id }).update({ is_active: active, updated_at: new Date() });
  await audit(active ? 'document_attachment_restored' : 'document_attachment_archived', { attachmentId: id }, adminId);
  return toApi(await getAttachmentRow(id));
}

/** A library file for download, checked against its recorded sha256. */
async function openLibraryAttachment(id) {
  const row = await getAttachmentRow(id);
  const { buffer } = readStoredFile(row);
  if (sha256(buffer) !== row.sha256) throw changed(row.name);
  return { name: row.name, buffer };
}

// ---------------------------------------------------------------------
// Attachment lists (template versions and contracts)
// ---------------------------------------------------------------------

/** Validate an editor's attachment list into rows with positions 1..n. */
async function sanitizeAttachmentList(list, conn) {
  if (!Array.isArray(list)) throw new AppError('attachments must be a list', 400, 'ATTACHMENT_INVALID');
  if (list.length > MAX_PER_DOCUMENT) {
    throw new AppError(`At most ${MAX_PER_DOCUMENT} attachments`, 400, 'ATTACHMENT_INVALID');
  }
  const ids = list.map((entry) => ensureInt(entry && entry.attachmentId));
  if (new Set(ids).size !== ids.length) {
    throw new AppError('Each attachment can be included once', 400, 'ATTACHMENT_INVALID');
  }
  const rows = ids.length ? await conn('document_attachments').whereIn('id', ids) : [];
  const byId = new Map(rows.map((row) => [Number(row.id), row]));
  return list.map((entry, index) => {
    const row = byId.get(ids[index]);
    if (!row) throw new AppError(`Attachment ${index + 1}: not found`, 400, 'ATTACHMENT_INVALID');
    const delivery = entry.delivery || 'merged';
    if (!DELIVERIES.includes(delivery)) throw new AppError(`Attachment ${index + 1}: unknown delivery`, 400, 'ATTACHMENT_INVALID');
    return { attachment_id: row.id, position: index + 1, delivery, sha256: row.sha256 };
  });
}

function loadVersionAttachments(versionId, conn = db) {
  return conn('contract_template_version_attachments as va')
    .join('document_attachments as a', 'a.id', 'va.attachment_id')
    .where('va.version_id', versionId)
    .orderBy('va.position', 'asc')
    .select('va.attachment_id', 'va.position', 'va.delivery', 'a.name', 'a.page_count', 'a.bytes',
      'a.sha256', 'a.is_active', 'a.storage_key');
}

async function writeVersionAttachments(trx, versionId, rows) {
  await trx('contract_template_version_attachments').where({ version_id: versionId }).del();
  if (!rows.length) return;
  const now = new Date();
  await trx('contract_template_version_attachments').insert(rows.map((row) => ({
    version_id: versionId, attachment_id: row.attachment_id, position: row.position, delivery: row.delivery, created_at: now,
  })));
}

async function copyVersionAttachments(trx, fromVersionId, toVersionId) {
  const rows = await trx('contract_template_version_attachments').where({ version_id: fromVersionId }).orderBy('position');
  if (!rows.length) return;
  const now = new Date();
  await trx('contract_template_version_attachments').insert(rows.map((row) => ({
    version_id: toVersionId, attachment_id: row.attachment_id, position: row.position, delivery: row.delivery, created_at: now,
  })));
}

function loadContractAttachments(contractId, conn = db) {
  return conn('contract_attachment_inclusions as ci')
    .join('document_attachments as a', 'a.id', 'ci.attachment_id')
    .where('ci.contract_id', contractId)
    .orderBy('ci.position', 'asc')
    .select('ci.attachment_id', 'ci.position', 'ci.delivery', 'ci.sha256 as inclusion_sha256', 'a.name',
      'a.page_count', 'a.bytes', 'a.sha256', 'a.is_active', 'a.storage_key');
}

/** Copy a template version's attachments onto a new contract (the caller's transaction). */
async function seedContractAttachments(trx, contractId, versionId, history = { source: 'contract.template.seed' }) {
  const rows = await trx('contract_template_version_attachments as va')
    .join('document_attachments as a', 'a.id', 'va.attachment_id')
    .where('va.version_id', versionId)
    .orderBy('va.position')
    .select('va.attachment_id', 'va.position', 'va.delivery', 'a.sha256');
  if (!rows.length) return;
  const now = new Date();
  await auditedInsert(trx, 'contract_attachment_inclusions', rows.map((row) => ({
    contract_id: contractId, attachment_id: row.attachment_id, position: row.position, delivery: row.delivery,
    sha256: row.sha256, created_at: now, updated_at: now,
  })), history);
}

/** Replace a draft contract's attachments (the caller's transaction). */
async function writeContractAttachments(trx, contractId, list, history = { source: 'contract.attachments' }) {
  const rows = await sanitizeAttachmentList(list, trx);
  // An archived attachment the contract already has stays; a new one can't be added.
  const previous = new Set((await trx('contract_attachment_inclusions').where({ contract_id: contractId }))
    .map((row) => Number(row.attachment_id)));
  const added = rows.filter((row) => !previous.has(Number(row.attachment_id))).map((row) => row.attachment_id);
  if (added.length) {
    const archived = await trx('document_attachments').whereIn('id', added).andWhere({ is_active: false }).first();
    if (archived) throw new AppError(`"${archived.name}" is archived in the attachment library`, 400, 'ATTACHMENT_INVALID');
  }
  await auditedDelete(trx, 'contract_attachment_inclusions', { contract_id: contractId }, history);
  if (!rows.length) return;
  const now = new Date();
  await auditedInsert(trx, 'contract_attachment_inclusions', rows.map((row) => ({
    contract_id: contractId, ...row, created_at: now, updated_at: now,
  })), history);
}

// ---------------------------------------------------------------------
// Sending and delivery
// ---------------------------------------------------------------------

/**
 * The PDF a contract goes out as, and what's delivered next to it. Merged
 * attachments go between the body and the signature page (which stays
 * last); every file must still match the sha256 the contract recorded.
 * Returns the bytes, the manifest stored with the generated document, and
 * the separate files.
 */
/**
 * How many pages the merged attachments add before the signature page.
 * Known before the render, so the page numbers can count them (the footer is
 * drawn by PDFKit, which never sees the merged document).
 */
async function mergedPageCount(contractId) {
  const rows = await loadContractAttachments(contractId);
  return rows.filter((row) => row.delivery === 'merged')
    .reduce((sum, row) => sum + Number(row.page_count || 0), 0);
}

async function buildSendable(contract, contractBuffer, { slots = [] } = {}) {
  const rows = await loadContractAttachments(contract.id);
  // Signature slots (#1445) sit on the contract's last page; merged
  // attachments go before it, so each slot moves down by their pages.
  const insertedPages = rows.filter((row) => row.delivery === 'merged')
    .reduce((sum, row) => sum + Number(row.page_count), 0);
  const placed = slots.map((slot) => ({
    key: slot.key, role: slot.role, label: slot.label, page: slot.pageIndex + 1 + insertedPages,
    x: slot.x, y: slot.y, width: slot.width, height: slot.height, captionY: slot.captionY,
  }));
  if (!rows.length) {
    return {
      buffer: contractBuffer,
      manifest: placed.length ? { attachments: [], signaturePage: placed[0].page, slots: placed } : null,
      separate: [],
    };
  }
  const files = rows.map((row) => {
    const { absolute, buffer } = readStoredFile(row);
    if (sha256(buffer) !== row.inclusion_sha256) throw changed(row.name);
    return { row, absolute, buffer };
  });
  const merged = files.filter((file) => file.row.delivery === 'merged');
  const result = await insertBeforeLastPage(contractBuffer, merged.map((file) => file.buffer), {
    title: contract.contract_number,
    // Fixed, not "now": the same contract and the same attachments have to
    // merge into the same bytes, or the recorded sha256 depends on the clock.
    createdAt: contract.issue_date || contract.created_at || 0,
  });
  const manifest = {
    attachments: files.map((file) => {
      const range = file.row.delivery === 'merged' ? result.ranges[merged.indexOf(file)] : null;
      return {
        attachmentId: file.row.attachment_id,
        name: file.row.name,
        sha256: file.row.inclusion_sha256,
        delivery: file.row.delivery,
        pages: Number(file.row.page_count),
        ...(range ? { firstPage: range.start + 1 } : {}),
      };
    }),
    // 1-based; the signature page is always the last one. With nothing
    // merged the merger returns the document untouched and reports no last
    // page, so the slots — which know which page they were placed on — are
    // the fallback. Otherwise a contract whose attachments all go out as
    // separate files recorded a manifest that could not say where its own
    // signatures are.
    signaturePage: result.lastPageIndex == null
      ? (placed.length ? placed[0].page : null)
      : result.lastPageIndex + 1,
    ...(placed.length ? { slots: placed } : {}),
  };
  return {
    buffer: result.buffer,
    manifest,
    separate: files
      .filter((file) => file.row.delivery === 'separate')
      .map((file) => ({ name: file.row.name, path: file.absolute, sha256: file.row.inclusion_sha256 })),
  };
}

/** One of a contract's attachments, for the customer or admin to download. */
async function openContractAttachment(contractId, attachmentId) {
  const row = await db('contract_attachment_inclusions as ci')
    .join('document_attachments as a', 'a.id', 'ci.attachment_id')
    .where({ 'ci.contract_id': contractId, 'ci.attachment_id': attachmentId })
    .select('ci.attachment_id', 'ci.sha256 as inclusion_sha256', 'a.name', 'a.storage_key')
    .first();
  if (!row) throw new AppError('Attachment not found', 404, 'ATTACHMENT_NOT_FOUND');
  const { buffer } = readStoredFile(row);
  if (sha256(buffer) !== row.inclusion_sha256) throw changed(row.name);
  return { name: row.name, buffer };
}

/** A file name safe for a download or an email attachment. */
function downloadName(name) {
  const base = String(name || 'attachment').replace(/[\\/:*?"<>|\r\n]+/g, '-').trim().slice(0, 120) || 'attachment';
  return `${base}.pdf`;
}

module.exports = {
  mergedPageCount,
  DELIVERIES,
  MAX_BYTES,
  listAttachments,
  getAttachmentRow,
  storeAttachment,
  archiveAttachment: (id, adminId) => setAttachmentActive(id, false, adminId),
  restoreAttachment: (id, adminId) => setAttachmentActive(id, true, adminId),
  openLibraryAttachment,
  readStoredFile,
  sanitizeAttachmentList,
  loadVersionAttachments,
  writeVersionAttachments,
  copyVersionAttachments,
  loadContractAttachments,
  seedContractAttachments,
  writeContractAttachments,
  buildSendable,
  openContractAttachment,
  inclusionToApi,
  downloadName,
};
