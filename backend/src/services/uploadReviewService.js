/**
 * Review of team members' uploads (issue 743, migration 269).
 *
 * With `events.review_contributor_uploads` on, a photo uploaded by an admin
 * who reaches the event only through an assignment (a contributor, see
 * ownership.ownsEvent) is stored hidden with moderation_status 'pending'. The
 * owner approves it (visible, no longer under review) or rejects it (stays
 * hidden as 'rejected', can still be approved or deleted later). Visibility
 * routes leave photos under review alone; this is the only way out.
 *
 * A role holding photos.review (a project lead) reviews too, on every gallery
 * it reaches, and its own uploads are not held.
 *
 * Guest uploads (issue 1733): with `events.moderate_guest_uploads` on, every
 * upload through the gallery's own upload route is held the same way and
 * leaves review through the same route. The bell hears of the ones waiting.
 */

const { db, logActivity } = require('../database/db');
const { livePhotos } = require('../utils/photoVisibility');
const logger = require('../utils/logger');
const { ownsEvent } = require('../middleware/ownership');
const { roleHasPermission } = require('../middleware/permissions');
const { parseBooleanInput } = require('../utils/parsers');
const { accountCreditFields } = require('./photoCredit');

const MODERATION_STATUSES = ['pending', 'rejected'];
const MAX_MODERATION_IDS = 500;
const GUEST_UPLOADS_PENDING_TYPE = 'guest_uploads_pending_review';
// pg_advisory_xact_lock class for one event's guest upload bell entry.
const GUEST_UPLOADS_PENDING_LOCK = 1076;

/**
 * Whether `admin` approves and rejects uploads on `event`, which it is known
 * to reach: its owner with photos.edit, or any holder of photos.review.
 */
async function mayReviewUploads(admin, event) {
  if (await roleHasPermission(admin?.roleName, 'photos.review')) return true;
  return ownsEvent(admin, event) && roleHasPermission(admin?.roleName, 'photos.edit');
}

/** Whether an upload by `admin` to `event` waits for review. */
async function holdsForReview(admin, event) {
  if (!parseBooleanInput(event?.review_contributor_uploads, false) || ownsEvent(admin, event)) return false;
  return !(await roleHasPermission(admin?.roleName, 'photos.review'));
}

/**
 * The photo columns an admin upload is inserted with: which account ran it,
 * that account's credit name as the no-EXIF fallback, and, for a contributor
 * under review, hidden + pending.
 */
async function adminUploadColumns(admin, event) {
  return {
    uploaded_by_admin_id: admin.id,
    ...(await accountCreditFields(admin.id)),
    ...(await holdsForReview(admin, event) ? { visibility: 'hidden', moderation_status: 'pending' } : {}),
  };
}

/** Whether an upload through the gallery's upload route waits for review. */
function holdsGuestUploads(event) {
  return parseBooleanInput(event?.moderate_guest_uploads, false);
}

/**
 * Tell the bell that `count` guest uploads wait for review. The gallery sends
 * one file per request, so an unread entry for the event grows instead of a
 * new one being written per photo; it comes back for an admin who had cleared
 * it, as the API download summary does (apiDownloadNotifications).
 *
 * A grown entry takes the time of the newest upload: the bell orders by
 * created_at and loads one page, so an entry left at its first upload would
 * stay behind whatever came since. db.fn.now() writes the shape the column
 * default does, which is what keeps SQLite's text order intact.
 *
 * Lookup and write share one transaction per event: on PostgreSQL behind an
 * advisory lock, on SQLite because it runs one transaction at a time. So
 * parallel uploads, on one replica or several, neither open two entries nor
 * lose each other's count. An advisory lock, not the event's row lock:
 * deleting an admin removes their dismissals and then touches the events they
 * created (created_by SET NULL), the reverse of the order here, and the two
 * would deadlock. Best effort: the upload never fails on it.
 */
async function notifyGuestUploadsPending(event, count) {
  try {
    await db.transaction(async (trx) => {
      const pg = trx.client.config.client === 'pg';
      if (pg) await trx.raw('SELECT pg_advisory_xact_lock(?, ?)', [GUEST_UPLOADS_PENDING_LOCK, Number(event.id)]);
      const lookup = trx('activity_logs')
        .where({ activity_type: GUEST_UPLOADS_PENDING_TYPE, event_id: event.id })
        .whereNull('read_at')
        .orderBy('id', 'desc');
      // Marking read and deleting the event do not take the lock above. An
      // entry one of them holds is passed over, not waited for: waiting would
      // leave this transaction holding the row once it turns out read, and
      // the insert below then waits on the event a deletion has locked while
      // that deletion waits on the row. NO KEY UPDATE, so a Clear all, which
      // only references the row, does not make it look taken.
      if (pg) lookup.forNoKeyUpdate().skipLocked();
      const open = await lookup.first('id', trx.raw('CAST(metadata AS TEXT) AS metadata_text'));
      if (open) {
        let metadata = {};
        try { metadata = JSON.parse(open.metadata_text) || {}; } catch { /* written by logActivity, so JSON */ }
        const grown = await trx('activity_logs')
          .where({ id: open.id })
          .whereNull('read_at')
          .update({
            metadata: JSON.stringify({ ...metadata, count: (Number(metadata.count) || 0) + count }),
            created_at: trx.fn.now(),
          });
        if (grown) {
          await trx('notification_dismissals').where({ activity_log_id: open.id }).del();
          return;
        }
      }
      await logActivity(GUEST_UPLOADS_PENDING_TYPE, { count, eventName: event.event_name }, event.id, { type: 'guest' }, trx);
    });
  } catch (e) {
    logger.warn(`upload review: guest upload notification failed for event ${event.id}`, { error: e.message });
  }
}

/**
 * Approve or reject photos of one event. Only rows under review move:
 * approving publishes them, rejecting keeps them hidden.
 *
 * @returns {Promise<{updated: number, photoIds: number[]}>} rows changed, and
 *   which, for the activity log
 */
async function moderatePhotos(eventId, photoIds, action) {
  const rows = livePhotos(db)
    .where('event_id', eventId)
    .whereIn('id', photoIds)
    .whereNotNull('moderation_status');
  if (action === 'approve') {
    const approving = await rows.clone()
      .select('id', 'filename', 'original_filename', 'size_bytes', 'processing_status');
    const updated = await rows.update({ visibility: 'visible', moderation_status: null });
    if (updated > 0) await announceApproved(eventId, approving);
    return { updated, photoIds: approving.map((p) => Number(p.id)) };
  }
  rows.whereNot('moderation_status', 'rejected');
  const rejecting = (await rows.clone().pluck('id')).map(Number);
  const updated = await rows.update({ moderation_status: 'rejected' });
  return { updated, photoIds: rejecting };
}

/**
 * photo.uploaded for the photos an approval published: an upload held for
 * review did not fire it, so an integration mirroring the gallery hears of
 * it now. A photo still processing fires from the worker when it completes
 * (photoProcessor reads the status again then). Best effort, like every
 * other photo.uploaded.
 */
async function announceApproved(eventId, photos) {
  const done = photos.filter((p) => !p.processing_status || p.processing_status === 'complete');
  if (done.length === 0) return;
  try {
    const webhookService = require('./webhookService');
    const event = await db('events').where({ id: eventId }).first('id', 'slug', 'event_name');
    for (const photo of done) {
      // eslint-disable-next-line no-await-in-loop
      await webhookService.fire('photo.uploaded', {
        event: { id: event.id, slug: event.slug, event_name: event.event_name },
        photo: {
          id: photo.id,
          filename: photo.filename,
          original_filename: photo.original_filename,
          size_bytes: photo.size_bytes,
        },
      });
    }
  } catch (e) {
    logger.warn(`upload review: photo.uploaded after approval failed for event ${eventId}`, { error: e.message });
  }
}

/** Photos of an event under review, by status, for the grid's banner. */
async function moderationCounts(eventId) {
  const rows = await livePhotos(db)
    .where('event_id', eventId)
    .whereNotNull('moderation_status')
    .groupBy('moderation_status')
    .select('moderation_status')
    .count('id as count');
  const counts = { pending: 0, rejected: 0 };
  for (const row of rows) {
    if (MODERATION_STATUSES.includes(row.moderation_status)) counts[row.moderation_status] = Number(row.count) || 0;
  }
  return counts;
}

module.exports = {
  MODERATION_STATUSES,
  MAX_MODERATION_IDS,
  holdsGuestUploads,
  notifyGuestUploadsPending,
  mayReviewUploads,
  holdsForReview,
  adminUploadColumns,
  moderatePhotos,
  moderationCounts,
};
