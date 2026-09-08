const path = require('path');
const { ALLOWED_IMAGE_TYPES } = require('./fileSecurityUtils');

/**
 * Which files sharp cannot decode, and which ones a browser cannot either.
 *
 * A leaf module on purpose. This is data and two predicates, no sharp and no
 * database, so a route can ask the question without pulling in the image
 * pipeline — and, just as importantly, without breaking every test that mocks
 * imageProcessor down to the two functions it happens to use.
 */

// Camera RAW / DNG formats. Sharp's bundled libvips has no raw loader, so these
// can't be fed to sharp() directly — instead we extract the full-resolution JPEG
// preview that every RAW file embeds (via exiftool) and process THAT. Gated
// strictly by extension, so nothing here runs for ordinary jpg/png/webp photos.
const RAW_EXTENSIONS = new Set([
  'dng', 'cr2', 'cr3', 'nef', 'nrw', 'arw', 'sr2', 'srf',
  'raf', 'rw2', 'orf', 'pef', 'srw', 'raw', '3fr', 'dcr', 'kdc'
]);

function isRawFilename(name) {
  if (!name || typeof name !== 'string') return false;
  const ext = path.extname(name).toLowerCase().replace(/^\./, '');
  return RAW_EXTENSIONS.has(ext);
}

/**
 * Formats whose ORIGINAL bytes a browser can't render in an <img>: HEIC/HEIF
 * and every camera RAW. For these the viewer must be served the generated JPEG
 * preview instead of the original, otherwise it shows a broken image, so both
 * the guest gallery and the admin listing point at the preview for them
 * whatever the lightbox_preview_enabled toggle says.
 *
 * Detection is by MIME first, extension as a fallback, because browsers report
 * these MIMEs inconsistently and often not at all.
 *
 * Both sets are derived. They used to be written out by hand in gallery.js and
 * went stale the moment the RAW set grew past DNG: an .arw would upload, get a
 * thumbnail, and then show a broken image the moment anyone opened it.
 *
 * EXPERIMENTAL: whether a preview actually renders still depends on the backend
 * being able to decode the source — HEVC-in-HEIC on the prod image, exiftool
 * for RAW. See #821.
 */
const NON_DISPLAYABLE_ORIGINAL_EXT = new Set([...RAW_EXTENSIONS, 'heic', 'heif']);
const NON_DISPLAYABLE_ORIGINAL_MIME = new Set([
  'image/heic',
  'image/heif',
  ...Object.entries(ALLOWED_IMAGE_TYPES)
    .filter(([, config]) => config.raw)
    .map(([mimeType]) => mimeType),
]);

function originalNeedsPreview(photo) {
  const mime = (photo.mime_type || '').toLowerCase();
  if (NON_DISPLAYABLE_ORIGINAL_MIME.has(mime)) return true;
  const name = photo.original_filename || photo.filename || '';
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  return NON_DISPLAYABLE_ORIGINAL_EXT.has(ext);
}

module.exports = {
  RAW_EXTENSIONS,
  isRawFilename,
  originalNeedsPreview,
};
