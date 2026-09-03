/**
 * Content-Type for a served photo row. Invariant: the header is ALWAYS
 * image/* or video/*, never the stored value verbatim.
 *
 * photos.mime_type is client-influenced: the chunked-upload path used to
 * store whatever MIME the browser (or a crafted request) declared, and the
 * S3 auto-importer stores whatever mime-types derives. Echoing it inline
 * under the app origin turned a JPEG/HTML polyglot with mime_type text/html
 * into stored HTML injection for every gallery guest. The admin photo route
 * (#908 + external review) already resolved this properly; this is that
 * logic, shared so every serving route applies the same rule.
 *
 *  - Images ignore the stored value unless it is a header-safe raster type:
 *    migration 039 backfilled image/jpeg onto every legacy row (PNGs
 *    included), so the extension is the more trustworthy signal, normalised
 *    via the shared map, jpeg fallback when unknown. The scriptable svg /
 *    *+xml family is never honoured.
 *  - Videos prefer a stored video/ type, then the extension map (.mov ->
 *    video/quicktime, .webm -> video/webm, ...), then video/mp4.
 *  - Full-token validation, not a prefix check: header-invalid characters
 *    (video/mp4\r\nX: y) would make setHeader throw -- a permanent 500 for
 *    that photo instead of a safe fallback.
 */
const path = require('path');
const { EXTENSION_TO_MIME } = require('../services/uploadSettings');

function resolvePhotoContentType(photo) {
  const ext = path.extname(photo?.filename || '').slice(1).toLowerCase();
  // Own-property lookup: a client-controlled filename ending in .constructor
  // / .__proto__ would otherwise return an inherited Object.prototype member.
  const extMime = Object.prototype.hasOwnProperty.call(EXTENSION_TO_MIME, ext)
    ? EXTENSION_TO_MIME[ext]
    : null;
  const stored = typeof photo?.mime_type === 'string' ? photo.mime_type : '';
  const storedVideoMime = /^video\/[\w.+-]+$/.test(stored) ? stored : null;
  const storedImageMime =
    /^image\/[\w.+-]+$/.test(stored) && !/^image\/svg|xml/i.test(stored)
      ? stored
      : null;
  const isVideo = photo?.media_type === 'video' ||
    Boolean(storedVideoMime) ||
    Boolean(extMime && extMime.startsWith('video/'));

  return isVideo
    ? storedVideoMime || (extMime && extMime.startsWith('video/') ? extMime : null) || 'video/mp4'
    : (extMime && extMime.startsWith('image/') ? extMime : null) || storedImageMime || 'image/jpeg';
}

module.exports = { resolvePhotoContentType };
