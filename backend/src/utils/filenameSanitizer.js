const path = require('path');

/**
 * Sanitize a string to be used as a filename component
 * @param {string} str - The string to sanitize
 * @param {number} maxLength - Maximum length of the sanitized string
 * @returns {string} - Sanitized string
 */
function sanitizeFilename(str, maxLength = 50) {
  if (!str) return 'unnamed';
  
  // Convert to string and trim
  let sanitized = String(str).trim();
  
  // Replace spaces with underscores
  sanitized = sanitized.replace(/\s+/g, '_');
  
  // Remove special characters except hyphens, underscores, and dots
  sanitized = sanitized.replace(/[^a-zA-Z0-9_\-\.]/g, '');
  
  // Remove multiple consecutive underscores or hyphens
  sanitized = sanitized.replace(/[_\-]{2,}/g, '_');
  
  // Remove leading/trailing underscores or hyphens
  sanitized = sanitized.replace(/^[_\-]+|[_\-]+$/g, '');
  
  // Limit length
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength);
  }
  
  // If empty after sanitization, use default
  if (!sanitized) {
    sanitized = 'unnamed';
  }
  
  return sanitized;
}

/**
 * Generate a photo filename based on event name, category, and counter
 * @param {string} eventName - The event name
 * @param {string} categoryName - The category name
 * @param {number} counter - The photo counter
 * @param {string} extension - The file extension (including dot)
 * @returns {string} - Generated filename
 */
function generatePhotoFilename(eventName, categoryName, counter, extension) {
  const sanitizedEvent = sanitizeFilename(eventName, 30);
  const sanitizedCategory = sanitizeFilename(categoryName || 'uncategorized', 20);
  const paddedCounter = String(counter).padStart(4, '0');
  
  return `${sanitizedEvent}_${sanitizedCategory}_${paddedCounter}${extension}`;
}

/**
 * Strip characters that are unsafe inside a Content-Disposition `filename="..."`
 * token: CR/LF/NUL (header injection), backslashes, double-quotes, and other
 * control bytes. Returns an ASCII-only fallback name (non-ASCII bytes are
 * dropped — pair with `buildContentDisposition()` which also emits a
 * RFC 5987 `filename*=UTF-8''…` parameter so modern clients see unicode).
 *
 * Path separators are stripped so an `original_filename` like `../../etc/passwd`
 * can never be coaxed into a directory write on a client that honours paths.
 */
function sanitizeForContentDisposition(name) {
  if (!name) return 'download';

  let sanitized = String(name)
    // Header-breaking bytes
    .replace(/[\r\n\0]/g, '')
    // Other ASCII control characters (0x01–0x1F, 0x7F)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x01-\x1F\x7F]/g, '')
    // Path separators and quote chars that would close the quoted-string
    .replace(/[/\\"]/g, '_')
    .trim();

  // Strip any non-ASCII for the legacy `filename=` token. The `filename*=`
  // parameter carries the unicode form.
  // eslint-disable-next-line no-control-regex
  sanitized = sanitized.replace(/[^\x20-\x7E]/g, '_');

  // Collapse runs of underscores introduced by replacement.
  sanitized = sanitized.replace(/_{2,}/g, '_').replace(/^[_.]+|_+$/g, '');

  return sanitized || 'download';
}

/**
 * Build a full `Content-Disposition` header value with both an ASCII
 * fallback (`filename="…"`) and an RFC 5987 unicode form
 * (`filename*=UTF-8''…`). This is what RFC 6266 §4 recommends for any
 * filename that may contain non-ASCII bytes (which `photos.original_filename`
 * can, since it's the raw `multer.file.originalname`).
 */
function buildContentDisposition(name, disposition = 'attachment') {
  const safeName = name ? String(name) : 'download';
  const asciiFallback = sanitizeForContentDisposition(safeName);
  // RFC 5987: percent-encode every byte that isn't an attr-char. encodeURIComponent
  // is a superset of attr-char (it encodes `*'%` etc.) — close enough and
  // browser-compatible.
  const encoded = encodeURIComponent(safeName).replace(/['()]/g, escape);
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * Sanitize a string for use as a zip-entry name. Preserves spaces,
 * parentheses, and unicode (modern zip readers handle UTF-8 entry names),
 * but strips path-traversal sequences and platform-reserved characters so
 * extracting the zip can never escape its target directory.
 */
function sanitizeForZipEntry(name) {
  if (!name) return 'download';

  let sanitized = String(name)
    // Header-breaking bytes (shouldn't appear in zip but cheap defence)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]/g, '')
    // Normalise path separators to underscore so `evil/../passwd` becomes
    // `evil_.._passwd` instead of an actual subpath.
    .replace(/[/\\]/g, '_')
    // Strip leading dots so `..` can't become an upward reference.
    .replace(/^\.+/, '')
    .trim();

  return sanitized || 'download';
}

/**
 * Deterministically rename duplicate names by appending `_1`, `_2`, … before
 * the extension. Input order is preserved; the first occurrence keeps its
 * original name. Used when a bulk-download zip is built with original camera
 * filenames and two photos in the same event happen to share one (e.g. same
 * camera body across two shoot days).
 *
 * @param {string[]} names
 * @returns {string[]} new array of the same length, with collisions resolved
 */
function uniquifyZipNames(names) {
  const seen = new Map();
  const out = new Array(names.length);

  for (let i = 0; i < names.length; i += 1) {
    const original = names[i] || 'download';
    if (!seen.has(original)) {
      seen.set(original, 0);
      out[i] = original;
      continue;
    }

    // Find the next free `_N` suffix. We bump the stored counter so the
    // next collision picks the *next* number instead of starting from 1 again.
    let n = seen.get(original) + 1;
    const ext = path.extname(original);
    const stem = ext ? original.slice(0, -ext.length) : original;
    let candidate;
    do {
      candidate = `${stem}_${n}${ext}`;
      n += 1;
    } while (seen.has(candidate));
    seen.set(original, n - 1);
    seen.set(candidate, 0);
    out[i] = candidate;
  }

  return out;
}

module.exports = {
  sanitizeFilename,
  generatePhotoFilename,
  sanitizeForContentDisposition,
  buildContentDisposition,
  sanitizeForZipEntry,
  uniquifyZipNames,
};