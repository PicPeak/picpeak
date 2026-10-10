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
 */

const { db } = require('../database/db');
const logger = require('../utils/logger');
const { ownsEvent } = require('../middleware/ownership');
const { roleHasPermission } = require('../middleware/permissions');
const { parseBooleanInput } = require('../utils/parsers');
const { accountCreditFields } = require('./photoCredit');

const MODERATION_STATUSES = ['pending', 'rejected'];
const MAX_MODERATION_IDS = 500;

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

/**
 * Approve or reject photos of one event. Only rows under review move:
 * approving publishes them, rejecting keeps them hidden.
 *
 * @returns {Promise<{updated: number, photoIds: number[]}>} rows changed, and
 *   which, for the activity log
 */
async function moderatePhotos(eventId, photoIds, action) {
  const rows = db('photos')
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
  const rows = await db('photos')
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
  mayReviewUploads,
  holdsForReview,
  adminUploadColumns,
  moderatePhotos,
  moderationCounts,
};
