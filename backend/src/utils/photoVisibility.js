/**
 * Shared hidden-photo access control.
 *
 * PicPeak photos carry a `visibility` column: 'visible' (or NULL, for
 * pre-migration rows) is shown to everyone; 'hidden' is client-only. A
 * gallery viewer's `req.accessLevel` is 'client' for a PIN-client login and
 * something else ('guest'/'slideshow'/…) for an ordinary guest.
 *
 * The main photo-list query and the single-photo download/view routes each
 * enforced this inline, but several bulk/secure paths (download-all,
 * download-selected, protected-image view, signed-URL mint, secure-token
 * mint, secure-download) shipped without it — letting ordinary guests reach
 * hidden/client-only photos. These helpers centralise the rule so every
 * sink applies exactly the same predicate.
 *
 * A photo under review (moderation_status 'pending' or 'rejected', migration
 * 269) is a contributor upload the event owner has not published yet. It is
 * stored hidden, and kept from clients as well: no gallery viewer sees it.
 *
 * A photo in the trash (deleted_at set, migration 294) is shown to nobody,
 * admins included, outside the trash dialog: livePhotos() is how every reader
 * that shows, counts or hands out photos opens the table. A bare
 * db('photos') is for code that must see trashed rows too (what owns a file,
 * hard deletes, storage, backups, erasure), and
 * __tests__/photoTrashReaders.test.js keeps the list of those.
 *
 * A curated selection (issue 2356, migration 361): an external source can
 * name a selection folder, and every photo of the source outside it carries
 * selection_hidden. The ordinary link, the QR code, the slideshow and every
 * other guest path show the selection only; the full link (a session with
 * fullView), the client login and the admin see everything. The viewer
 * argument of the helpers below is either an accessLevel string or
 * { accessLevel, fullView }; a plain string never sees past the selection,
 * so a caller that does not pass fullView fails closed.
 * __tests__/utils/photoSelectionReaders.test.js keeps hand-written visibility
 * checks out of the code base.
 */

/**
 * The `photos` table without the trash. `alias` for `photos as p`.
 */
function livePhotos(conn, alias = 'photos') {
  return conn(alias === 'photos' ? 'photos' : `photos as ${alias}`).whereNull(`${alias}.deleted_at`);
}

/** Inner join to the photos that are not in the trash; for knex's .modify(). */
function joinLivePhotos(query, left, right) {
  query.join('photos', function () {
    this.on(left, right).onNull('photos.deleted_at');
  });
}

/** The same as a left join: a trashed photo counts as no photo. */
function leftJoinLivePhotos(query, left, right) {
  query.leftJoin('photos', function () {
    this.on(left, right).onNull('photos.deleted_at');
  });
}

function viewerParts(viewer) {
  if (viewer && typeof viewer === 'object') {
    return { accessLevel: viewer.accessLevel, fullView: viewer.fullView === true };
  }
  return { accessLevel: viewer, fullView: false };
}

// PIN-clients see hidden photos; everyone else does not.
function canSeeHiddenPhotos(viewer) {
  return viewerParts(viewer).accessLevel === 'client';
}

/**
 * Does this viewer see photos outside the selection (issue 2356)? The client
 * login and a full-link session do; everyone else sees the selection only.
 */
function seesWholeSource(viewer) {
  const { accessLevel, fullView } = viewerParts(viewer);
  return accessLevel === 'client' || (fullView && accessLevel !== 'slideshow');
}

/**
 * The viewer of a gallery request, for the helpers here: its access level
 * and whether its session came from the full link (middleware/gallery.js).
 */
function viewerOf(req) {
  return { accessLevel: req?.accessLevel, fullView: req?.galleryFullView === true };
}

/** Leave out the photos outside the selection (issue 2356). */
function whereInSelection(query, column = 'photos.selection_hidden') {
  return query.where(function () {
    this.where(column, false).orWhereNull(column);
  });
}

/**
 * For a query on a table that names photos by id only (photo_feedback, ...)
 * and never joins them: leaves out the rows of photos in the trash.
 */
function wherePhotoLive(query, photoIdColumn) {
  query.whereNotExists(function () {
    this.select(1).from('photos').whereRaw('?? = ??', ['photos.id', photoIdColumn]).whereNotNull('photos.deleted_at');
  });
}

/**
 * Append the viewer's visibility filter to a knex `photos` query: clients
 * skip only the photos under review, everyone else sees visible photos. NULL
 * visibility is treated as visible (pre-migration default). The query must
 * reference the table as `photos` (all call sites do).
 */
function applyPhotoVisibilityFilter(query, viewer) {
  query.whereNull('photos.deleted_at');
  if (canSeeHiddenPhotos(viewer)) return query.whereNull('photos.moderation_status');
  if (!seesWholeSource(viewer)) whereInSelection(query);
  return whereGuestVisible(query);
}

/**
 * The photos a guest may see by their own visibility: 'visible', or NULL on a
 * pre-migration row. Not the selection; applyPhotoVisibilityFilter is the
 * whole rule.
 */
function whereGuestVisible(query, column = 'photos.visibility') {
  return query.where(function () {
    this.where(column, 'visible').orWhereNull(column);
  });
}

/**
 * Leave out photos the background worker has not finished (or failed on):
 * the original is stored, but the gallery does not show the photo yet. NULL
 * is a pre-async-migration row and counts as complete. The gallery list and
 * every bulk download share it, so an archive holds what the list shows.
 *
 * Nor a photo that cannot be served (unavailable_reason, migration 312): an
 * external photo whose file is gone from the share. The admin views keep it.
 */
function wherePhotoProcessed(query) {
  return query.where(function () {
    this.where('photos.processing_status', 'complete').orWhereNull('photos.processing_status');
  }).whereNull('photos.unavailable_reason');
}

/**
 * Leave out videos, by media type or MIME type (a video recognised by its
 * MIME type alone counts, as the frontend counts it). For the slideshow
 * (issue 2285): a video has no slideshow or preview tier and the kiosk may
 * not load /photo, so a video slide rendered broken for its whole duration.
 */
function whereNotVideo(query) {
  return query
    .where(function () {
      this.whereNull('photos.media_type').orWhereNot('photos.media_type', 'video');
    })
    .where(function () {
      this.whereNull('photos.mime_type').orWhereNot('photos.mime_type', 'like', 'video/%');
    });
}

/**
 * wherePhotoProcessed for a query on a table that names photos by id only
 * (photo_feedback, ...) and never joins them, in the shape of wherePhotoLive.
 */
function wherePhotoProcessedById(query, photoIdColumn) {
  query.whereNotExists(function () {
    this.select(1).from('photos').whereRaw('?? = ??', ['photos.id', photoIdColumn])
      .where(function () {
        this.where(function () {
          this.whereNotNull('photos.processing_status').whereNot('photos.processing_status', 'complete');
        }).orWhereNotNull('photos.unavailable_reason');
      });
  });
}

/**
 * Single-photo form of wherePhotoProcessed, for a row already read (with
 * unavailable_reason among its columns).
 */
function isPhotoProcessed(photo) {
  return (photo.processing_status == null || photo.processing_status === 'complete')
    && photo.unavailable_reason == null;
}

/**
 * Single-photo predicate: true when this photo must be blocked for a viewer
 * at the given access level. Mirrors the inline guards in gallery.js.
 */
function isPhotoHiddenFromViewer(photo, viewer) {
  if (!photo) return false;
  if (photo.deleted_at != null || photo.moderation_status != null) return true;
  if (!seesWholeSource(viewer)) {
    // A row read without the column cannot be judged; refusing it keeps a
    // narrowed select from showing a photo outside the selection.
    if (!Object.prototype.hasOwnProperty.call(photo, 'selection_hidden')) return true;
    if (photo.selection_hidden === true || photo.selection_hidden === 1) return true;
  }
  return photo.visibility === 'hidden' && !canSeeHiddenPhotos(viewer);
}

module.exports = {
  livePhotos,
  joinLivePhotos,
  leftJoinLivePhotos,
  wherePhotoLive,
  canSeeHiddenPhotos,
  seesWholeSource,
  viewerOf,
  whereInSelection,
  whereGuestVisible,
  applyPhotoVisibilityFilter,
  wherePhotoProcessed,
  wherePhotoProcessedById,
  whereNotVideo,
  isPhotoProcessed,
  isPhotoHiddenFromViewer,
};
