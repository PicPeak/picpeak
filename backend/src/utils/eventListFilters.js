/**
 * Filters the admin events list (routes/adminEvents/crud.js GET /) and the
 * dashboard (routes/adminDashboard.js) share, so the two surfaces count the
 * same rows.
 */
const { formatBoolean, whereTimestamp } = require('./dbCompat');

/**
 * access_logs actions that count as a download: singles AND zips (#895), one
 * row per download event.
 */
const DOWNLOAD_ACTIONS = Object.freeze(['download', 'download_all', 'download_all_presigned', 'download_selected']);

/** The same list for raw SQL, `action IN (${DOWNLOAD_ACTIONS_SQL})`. Built from the constant above only. */
const DOWNLOAD_ACTIONS_SQL = DOWNLOAD_ACTIONS.map((action) => `'${action}'`).join(', ');

/** An active gallery: live, not archived, not paused. For `query.modify(whereActiveEvent)`. */
function whereActiveEvent(query) {
  return query
    .where('is_active', formatBoolean(true))
    .where('is_archived', formatBoolean(false))
    .where('temporarily_disabled', formatBoolean(false));
}

/**
 * A live, unarchived gallery that expires after `now` and no later than
 * `until`. Paused galleries are NOT excluded here: the events list adds
 * `temporarily_disabled = false` itself, the dashboard tile does not.
 * whereTimestamp: ISO-string binds compared the extend path's epoch-ms rows
 * lexicographically on SQLite (issue 1733).
 */
function whereExpiringEvent(query, until, now) {
  return query
    .where('is_active', formatBoolean(true))
    .where('is_archived', formatBoolean(false))
    .modify(whereTimestamp, 'expires_at', '<=', until)
    .modify(whereTimestamp, 'expires_at', '>', now);
}

module.exports = { DOWNLOAD_ACTIONS, DOWNLOAD_ACTIONS_SQL, whereActiveEvent, whereExpiringEvent };
