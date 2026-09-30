/**
 * SQL for "this photos row is a video".
 *
 * media_type alone is not enough. The file watcher and the legacy archive
 * restore store the MIME type but never media_type, so their videos sit in the
 * table as 'image' (see adminArchives.js and archiveService.js). The JS side
 * already checks both columns (imageProcessor.isVideoPhoto); this is the same
 * rule for queries.
 *
 * COALESCE on both columns keeps the expression two-valued, so `NOT (...)`
 * selects the photos instead of dropping every row whose mime_type is NULL.
 */
const IS_VIDEO_SQL = '(COALESCE(photos.media_type, \'\') = \'video\' OR COALESCE(photos.mime_type, \'\') LIKE \'video/%\')';

const IS_PHOTO_SQL = `NOT ${IS_VIDEO_SQL}`;

/** Aggregate columns: how many of the selected rows are videos, and their total runtime in seconds. */
const VIDEO_COUNT_SQL = `SUM(CASE WHEN ${IS_VIDEO_SQL} THEN 1 ELSE 0 END)`;
const VIDEO_DURATION_SQL = `SUM(CASE WHEN ${IS_VIDEO_SQL} THEN COALESCE(photos.duration, 0) ELSE 0 END)`;

module.exports = { IS_VIDEO_SQL, IS_PHOTO_SQL, VIDEO_COUNT_SQL, VIDEO_DURATION_SQL };
