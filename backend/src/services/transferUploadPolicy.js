/**
 * transferUploadPolicy — what PicTransfer accepts, and how it hands it back (#1544).
 *
 * Gallery photo uploads go through `validateFileType` in fileSecurityUtils,
 * which gates the extension against a built-in registry of types the media
 * pipeline can actually decode (sharp / ffmpeg / exiftool). That is the right
 * rule there and the wrong rule here: a transfer file is never decoded, only
 * stored and handed back as bytes, so the registry has no business deciding
 * whether a client may send a `.psd`.
 *
 * It also got the existing behaviour wrong. Migration 170 seeded `image/tiff`
 * and `application/zip` as allowed, but neither has a registry entry, so
 * `validateFileType` rejected both — on a stock install a client could not
 * upload a ZIP through the very feature meant to replace a file-transfer
 * service.
 *
 * So transfers get their own, admin-editable policy:
 *
 *   transfer_upload_accept_all    boolean. Skip the type check entirely.
 *   transfer_upload_allowed_types [{ mime, extensions: [] }]
 *   transfer_upload_allowed_mime  legacy (pre-257) flat MIME list, read as a
 *                                 fallback so an instance that never ran the
 *                                 new settings UI keeps its behaviour.
 *
 * Accepting arbitrary bytes is only defensible because nothing downstream ever
 * opens them. That guarantee lives in `attachmentHeaders()` below and in the
 * opaque storage keys from `opaqueStoredName()` — see the comments there before
 * changing either.
 */

const path = require('path');

const { getAppSetting } = require('../utils/appSettings');
const { buildContentDisposition } = require('../utils/filenameSanitizer');
const { ALLOWED_IMAGE_TYPES } = require('../utils/fileSecurityUtils');

const DEFAULT_ALLOWED_MIME = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'image/tiff', 'application/pdf', 'application/zip', 'application/x-zip-compressed',
];

// Every camera RAW type, as MIME -> extensions.
//
// Read off the upload registry rather than written out again. This is a
// lookup, not the gate the docblock above refuses: nothing here decides what a
// transfer may contain. It only supplies the extensions for a type the admin
// has already listed, and RAW is the set where that matters most, because the
// browser sends no MIME for these at all.
const RAW_MIME_EXTENSIONS = Object.fromEntries(
  Object.entries(ALLOWED_IMAGE_TYPES)
    .filter(([, config]) => config.raw)
    .map(([mime, config]) => [mime, config.extensions])
);

// Mirrors migration 257's table. Used only to give a legacy flat MIME list
// sensible extensions when `transfer_upload_allowed_types` is missing.
const LEGACY_MIME_EXTENSIONS = {
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
  'image/gif': ['.gif'],
  'image/tiff': ['.tif', '.tiff'],
  'image/svg+xml': ['.svg'],
  'image/heic': ['.heic'],
  'image/heif': ['.heif'],
  ...RAW_MIME_EXTENSIONS,
  'application/pdf': ['.pdf'],
  'application/zip': ['.zip'],
  // What Chrome and Firefox on Windows actually send for a .zip.
  'application/x-zip-compressed': ['.zip'],
  'video/mp4': ['.mp4', '.m4v'],
  'video/quicktime': ['.mov'],
  'video/webm': ['.webm'],
  'video/x-msvideo': ['.avi'],
};

/**
 * The only Content-Types a transfer download is ever allowed to echo back.
 * Everything else — including everything an "accept all" instance takes in —
 * goes out as `application/octet-stream`.
 *
 * The bar for membership is "a browser rendering this inline cannot execute
 * script or reach back into the origin". That rules out text/html, image/svg+xml
 * (script in SVG), application/xml (XSLT), application/pdf (JS in PDF) and every
 * text/* type. PDFs are common in transfers and still excluded on purpose: they
 * are delivered as a download, which is what the recipient wanted anyway.
 */
const SAFE_ECHO_MIME = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'video/mp4', 'video/webm',
  'audio/mpeg', 'audio/ogg',
  'application/zip',
]);

function normalizeMime(value) {
  return String(value || '').trim().toLowerCase().split(';')[0].trim();
}

function normalizeExtension(value) {
  const ext = String(value || '').trim().toLowerCase();
  if (!ext) return '';
  return ext.startsWith('.') ? ext : `.${ext}`;
}

/**
 * Coerce whatever is in the setting into `[{ mime, extensions: [] }]`.
 * Tolerates the legacy flat `['image/png', …]` shape so a half-migrated
 * instance, or an admin who pasted a plain list, still gets a usable policy.
 */
function normalizeAllowedTypes(raw) {
  if (!Array.isArray(raw)) return [];
  const byMime = new Map();
  for (const entry of raw) {
    let mime;
    let extensions;
    if (typeof entry === 'string') {
      mime = normalizeMime(entry);
      extensions = LEGACY_MIME_EXTENSIONS[mime] || [];
    } else if (entry && typeof entry === 'object') {
      mime = normalizeMime(entry.mime);
      extensions = Array.isArray(entry.extensions) ? entry.extensions : [];
    } else {
      continue;
    }
    if (!mime || !mime.includes('/')) continue;
    const exts = [...new Set(extensions.map(normalizeExtension).filter(Boolean))];
    if (byMime.has(mime)) {
      const existing = byMime.get(mime);
      existing.extensions = [...new Set([...existing.extensions, ...exts])];
    } else {
      byMime.set(mime, { mime, extensions: exts });
    }
  }
  return [...byMime.values()];
}

/**
 * Load the effective upload policy. Reads the new keys, falls back to the
 * pre-257 flat MIME list, and finally to the seeded defaults.
 */
async function getTransferUploadPolicy() {
  const acceptAllRaw = await getAppSetting('transfer_upload_accept_all', false);
  const acceptAll = acceptAllRaw === true || acceptAllRaw === 'true' || acceptAllRaw === 1;

  // An ABSENT key and a key holding an empty list mean different things, and
  // collapsing them re-permits types the admin removed. `!length` is true for
  // both, so the fallback chain walks presence, not emptiness:
  //   key absent            → try the legacy key, then the seeded defaults
  //   key present but empty → allow nothing (fail closed)
  // The settings route refuses to write an empty list, so reaching the second
  // case means someone edited the row by hand — and silently handing them
  // jpeg/png/pdf/zip back would be the opposite of what they asked for.
  const rawTypes = await getAppSetting('transfer_upload_allowed_types', null);
  let allowedTypes;
  if (Array.isArray(rawTypes)) {
    allowedTypes = normalizeAllowedTypes(rawTypes);
  } else {
    const legacy = await getAppSetting('transfer_upload_allowed_mime', null);
    allowedTypes = Array.isArray(legacy)
      ? normalizeAllowedTypes(legacy)
      : normalizeAllowedTypes(DEFAULT_ALLOWED_MIME);
    // A legacy key that is present but unparseable is still a configured
    // intent we cannot read; fall back rather than accept nothing, because
    // pre-257 instances never had a way to express "allow nothing".
    if (!allowedTypes.length && !Array.isArray(legacy)) {
      allowedTypes = normalizeAllowedTypes(DEFAULT_ALLOWED_MIME);
    }
  }

  const maxSizeMb = Number(await getAppSetting('transfer_max_upload_size_mb', 50)) || 50;

  return { acceptAll, allowedTypes, maxSizeMb };
}

/**
 * Is this file acceptable under `policy`?
 *
 * **A listed extension is a match on its own, before the MIME is consulted.**
 * The browser's `file.type` is a guess and a platform-specific one: Chrome and
 * Firefox on Windows label a `.zip` `application/x-zip-compressed`, and `.dng`,
 * `.psd` and `.heic` routinely arrive as `application/octet-stream` or with no
 * type at all. Looking the entry up by MIME first meant an allowlist that named
 * `.zip` still refused a Windows client's ZIP — the exact failure this policy
 * exists to end. The extension is what the admin actually typed into Settings,
 * so it is what we trust.
 *
 * MIME is still consulted second, for the type an admin listed WITHOUT any
 * extension: adding `application/vnd.….wordprocessingml.document` and no
 * `.docx` means "allow this type", and inventing an extension rule we cannot
 * verify would silently reject exactly the file they wanted.
 *
 * What this does NOT do is let a listed MIME drag in an unlisted extension:
 * a `payload.html` labelled `image/png` still fails, because `.html` is on no
 * entry and `image/png`'s entry does name extensions.
 *
 * Note this is a policy check, not a safety check — nothing downstream trusts
 * either the name or the MIME. See `attachmentHeaders()`.
 */
function validateTransferFileType(filename, mimetype, policy) {
  if (!policy) return false;
  if (policy.acceptAll) return true;

  const types = policy.allowedTypes || [];
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (ext && types.some((t) => t.extensions.includes(ext))) return true;

  // No listed extension matched. The only remaining way in is a type the admin
  // listed with no extensions at all, identified by the (untrusted) MIME.
  const entry = types.find((t) => t.mime === normalizeMime(mimetype));
  return Boolean(entry) && entry.extensions.length === 0;
}

/** Flat MIME list for the public upload page's `accept` attribute. */
function allowedMimeList(policy) {
  return (policy.allowedTypes || []).map((t) => t.mime);
}

/** Flat extension list, for the client-side filter and the "allowed: …" hint. */
function allowedExtensionList(policy) {
  return [...new Set((policy.allowedTypes || []).flatMap((t) => t.extensions))].sort();
}

/**
 * Storage name for a file a client (or the admin) hands us.
 *
 * The client's extension is deliberately NOT kept: nothing in PicPeak reads
 * these bytes back by name, and dropping it means no stored object can ever end
 * in `.html`, `.svg`, `.js` or `.php` — so a future static mount, a misconfigured
 * nginx `location`, or an S3 bucket someone makes public cannot turn a transfer
 * into hosted content. The real filename lives in the DB row and is what the
 * recipient sees on download.
 */
function opaqueStoredName(random) {
  return `${random}.bin`;
}

/**
 * Headers for every transfer download — single file, ZIP, and the admin's
 * download of a client upload.
 *
 * `Content-Type` is the client-supplied MIME only when it is on the safe-echo
 * list; anything else (and everything on an accept-all instance) goes out as
 * `application/octet-stream`. The client's label is recorded in the DB, never
 * trusted here.
 *
 * `sandbox` in the CSP is what stops a rendered document reaching its origin at
 * all, and the empty `default-src` stops it loading anything; together with
 * `nosniff` and the attachment disposition, a stored file cannot become a page
 * on the PicPeak origin even if a browser is talked into rendering it.
 */
function attachmentHeaders(filename, mimetype) {
  const mime = normalizeMime(mimetype);
  return {
    'Content-Type': SAFE_ECHO_MIME.has(mime) ? mime : 'application/octet-stream',
    'Content-Disposition': buildContentDisposition(filename),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'default-src \'none\'; sandbox',
  };
}

/** Apply `attachmentHeaders` to a response. */
function setAttachmentHeaders(res, filename, mimetype) {
  const headers = attachmentHeaders(filename, mimetype);
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
}

module.exports = {
  DEFAULT_ALLOWED_MIME,
  SAFE_ECHO_MIME,
  normalizeAllowedTypes,
  getTransferUploadPolicy,
  validateTransferFileType,
  allowedMimeList,
  allowedExtensionList,
  opaqueStoredName,
  attachmentHeaders,
  setAttachmentHeaders,
};
