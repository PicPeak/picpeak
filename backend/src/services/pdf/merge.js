'use strict';

/**
 * Merge PDFs in a fixed order (#1445). pdf-lib only. The document
 * information and dates are set explicitly, so the same inputs in the same
 * order give the same bytes, and the page range each inserted part occupies
 * is returned.
 *
 * Inputs are expected to have passed utils/pdfValidation.validatePdf.
 */

const { PDFDocument } = require('pdf-lib');

function applyInfo(doc, info) {
  const at = info.createdAt ? new Date(info.createdAt) : new Date();
  doc.setCreationDate(at);
  doc.setModificationDate(at);
  doc.setProducer('picpeak');
  doc.setCreator('picpeak');
  if (info.title) doc.setTitle(String(info.title));
  if (info.author) doc.setAuthor(String(info.author));
}

async function appendAll(target, buffer) {
  const source = await PDFDocument.load(buffer, { updateMetadata: false });
  const pages = await target.copyPages(source, source.getPageIndices());
  const start = target.getPageCount();
  for (const page of pages) target.addPage(page);
  return { start, count: pages.length };
}

/**
 * Concatenate PDFs.
 * @returns {Promise<{ buffer: Buffer, ranges: Array<{ index: number, start: number, count: number }> }>}
 *          `start` is 0-based within the merged document.
 */
async function mergePdfs(parts, info = {}) {
  if (!Array.isArray(parts) || parts.length === 0) throw new Error('mergePdfs needs at least one PDF');
  const merged = await PDFDocument.create({ updateMetadata: false });
  const ranges = [];
  for (let index = 0; index < parts.length; index += 1) {
    ranges.push({ index, ...(await appendAll(merged, parts[index])) });
  }
  applyInfo(merged, info);
  const bytes = await merged.save({ useObjectStreams: false });
  return { buffer: Buffer.from(bytes), ranges };
}

/**
 * Insert PDFs before a document's last page. A contract's merged
 * attachments go between its body and its signature page: the signature
 * page stays last (signatures are stamped there), and the page numbers —
 * drawn before the merge — count the contract's own pages only.
 *
 * With nothing to insert the document is returned unchanged.
 * @returns {Promise<{ buffer: Buffer, ranges: Array<{ index: number, start: number, count: number }>, lastPageIndex: number|null }>}
 */
async function insertBeforeLastPage(documentBuffer, inserts, info = {}) {
  if (!Array.isArray(inserts) || inserts.length === 0) {
    return { buffer: documentBuffer, ranges: [], lastPageIndex: null };
  }
  const source = await PDFDocument.load(documentBuffer, { updateMetadata: false });
  const count = source.getPageCount();
  const merged = await PDFDocument.create({ updateMetadata: false });
  const head = await merged.copyPages(source, source.getPageIndices().slice(0, Math.max(0, count - 1)));
  for (const page of head) merged.addPage(page);
  const ranges = [];
  for (let index = 0; index < inserts.length; index += 1) {
    ranges.push({ index, ...(await appendAll(merged, inserts[index])) });
  }
  if (count > 0) {
    const [last] = await merged.copyPages(source, [count - 1]);
    merged.addPage(last);
  }
  applyInfo(merged, info);
  const bytes = await merged.save({ useObjectStreams: false });
  return { buffer: Buffer.from(bytes), ranges, lastPageIndex: merged.getPageCount() - 1 };
}

module.exports = { mergePdfs, insertBeforeLastPage };
