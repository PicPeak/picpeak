/**
 * documentFormats — the file types customer documents may have (#1444,
 * plan slice 7).
 *
 * The allowlist is fixed here — pdf, docx, xlsx, odt, ods, txt, csv (the
 * maintainer's decision of 2026-09-19) — and the setting
 * `customer_documents_allowed_formats` (default ["pdf"], migration 244)
 * picks which of them an install accepts, so an upgrade changes nothing
 * until the admin opts in. Deliberately absent: legacy OLE formats (doc,
 * xls, ppt — nothing here can inspect them safely), macro-enabled formats
 * (docm, xlsm), images, archives, HTML and SVG.
 *
 * One entry per format:
 *   ext            the one extension that selects it (the LAST extension of
 *                  the uploaded name decides; `contract.pdf.exe` is an .exe)
 *   declaredTypes  MIME types a browser may declare for it. Only a first
 *                  filter: some platforms send octet-stream or nothing.
 *   contentType    what a download is served as — always from here, never
 *                  from the upload
 *   inspect        the content check that decides
 *
 * A note on docx/xlsx: the office check refuses every relationship with
 * TargetMode="External", as the plan decided (remote-template injection).
 * That includes ordinary hyperlinks to websites, so a Word file with a link
 * in it is refused and has to be saved as PDF instead.
 */

const { getAppSetting } = require('../utils/appSettings');

const LENIENT = ['application/octet-stream', ''];

const FORMATS = {
  pdf: {
    ext: '.pdf',
    declaredTypes: new Set(['application/pdf', 'application/x-pdf', ...LENIENT]),
    contentType: 'application/pdf',
  },
  docx: {
    ext: '.docx',
    declaredTypes: new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip', ...LENIENT]),
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  xlsx: {
    ext: '.xlsx',
    declaredTypes: new Set(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip', ...LENIENT]),
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  odt: {
    ext: '.odt',
    declaredTypes: new Set(['application/vnd.oasis.opendocument.text', 'application/zip', ...LENIENT]),
    contentType: 'application/vnd.oasis.opendocument.text',
  },
  ods: {
    ext: '.ods',
    declaredTypes: new Set(['application/vnd.oasis.opendocument.spreadsheet', 'application/zip', ...LENIENT]),
    contentType: 'application/vnd.oasis.opendocument.spreadsheet',
  },
  txt: {
    ext: '.txt',
    declaredTypes: new Set(['text/plain', ...LENIENT]),
    contentType: 'text/plain; charset=utf-8',
  },
  csv: {
    ext: '.csv',
    // Windows browsers declare CSV as an Excel type.
    declaredTypes: new Set(['text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel', ...LENIENT]),
    contentType: 'text/csv; charset=utf-8',
  },
};

const ALL_FORMATS = Object.keys(FORMATS);
const DEFAULT_ALLOWED = ['pdf'];

/** The formats this install accepts: the setting, filtered to the allowlist. */
async function getAllowedFormats() {
  const raw = await getAppSetting('customer_documents_allowed_formats', DEFAULT_ALLOWED);
  const list = Array.isArray(raw) ? raw : String(raw || '').split(',');
  const allowed = [...new Set(list.map((f) => String(f).trim().toLowerCase()))].filter((f) => FORMATS[f]);
  return allowed.length > 0 ? allowed : DEFAULT_ALLOWED;
}

/** The format an uploaded name selects by its last extension, or null. */
function formatForName(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
  if (!m) return null;
  const key = m[1].toLowerCase();
  return FORMATS[key] ? key : null;
}

/** The format of a stored document, from its generated storage key. */
function formatForStorageKey(key) {
  return formatForName(key);
}

/** Download content type — from the registry, never from the upload. */
function contentTypeFor(format) {
  return (FORMATS[format] || FORMATS.pdf).contentType;
}

module.exports = {
  FORMATS,
  ALL_FORMATS,
  DEFAULT_ALLOWED,
  getAllowedFormats,
  formatForName,
  formatForStorageKey,
  contentTypeFor,
};
