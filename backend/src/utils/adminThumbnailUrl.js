'use strict';

/**
 * The admin thumbnail URL of a photo, versioned by what changes the image.
 *
 * GET /admin/photos/:eventId/thumbnail/:photoId caches for an hour, and a
 * rebuilt poster lands under the same storage key, so the URL has to change
 * with the image: the placeholder note (otherwise the browser kept the cached
 * placeholder after a successful Retry, issue 1430, item 6) and the frame an
 * admin picked (issue 2263, item 4), and a photo's focal point, which its
 * crop follows (issue 2377). The route answers `no-store` when `v` does not
 * match, so a stale URL never caches the current image.
 *
 * Every admin payload that hands out a thumbnail URL builds it here, from a
 * row carrying `processing_error`, `poster_offset_seconds` and the focal
 * point (issue 2276).
 */
const { focalQuery } = require('./focalPoint');

/** The `v` the thumbnail route expects for this photo ('' for none). */
function adminThumbnailVersion(photo) {
  return [
    photo.processing_error ? 'note' : null,
    photo.poster_offset_seconds != null ? `p${photo.poster_offset_seconds}` : null,
    focalQuery(photo) ? focalQuery(photo).replace('fp=', 'f') : null,
  ].filter(Boolean).join('-');
}

/** `/admin/photos/:eventId/thumbnail/:photoId`, with `?v=` when versioned. */
function adminThumbnailUrl(eventId, photo) {
  const version = adminThumbnailVersion(photo);
  return `/admin/photos/${eventId}/thumbnail/${photo.id}${version ? `?v=${version}` : ''}`;
}

/** The photos columns adminThumbnailVersion reads. */
const ADMIN_THUMBNAIL_COLUMNS = ['photos.processing_error', 'photos.poster_offset_seconds', 'photos.focal_x', 'photos.focal_y'];

module.exports = { adminThumbnailVersion, adminThumbnailUrl, ADMIN_THUMBNAIL_COLUMNS };
