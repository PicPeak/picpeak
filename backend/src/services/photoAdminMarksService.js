/**
 * The photographer's own stars and colour labels (#1044 follow-up).
 *
 * Deliberately separate from photo_feedback — see the migration-181 header for
 * why. Nothing in here is ever read by a guest-facing route: admin marks show
 * on admin surfaces and in exports, and the client's proofing view never sees
 * what the photographer thought.
 */

const { db } = require('../database/db');
const logger = require('../utils/logger');
const { isValidColorLabel } = require('../constants/colorLabels');

/**
 * A mark the caller got wrong, as opposed to something that went wrong.
 *
 * Carries a `code` so the route can map it to a 400 without matching on the
 * message text — message-matching couples the status code to this file's copy,
 * and a reworded string would silently turn a 400 into a 500.
 */
const INVALID_MARK = 'INVALID_MARK';
function invalidMark(message) {
  return Object.assign(new Error(message), { code: INVALID_MARK });
}

/**
 * Set, change or clear an admin's mark on one photo.
 *
 * `rating` and `colorLabel` are tri-state: `undefined` leaves that half of the
 * mark alone, `null` clears it, a value sets it. That is what lets the
 * lightbox's colour keys and star keys write independently without each
 * wiping the other.
 *
 * @param {number} eventId
 * @param {number} photoId
 * @param {number} adminId
 * @param {{rating?: number|null, colorLabel?: string|null}} mark
 * @returns {Promise<{rating: number|null, color_label: string|null}|null>}
 *          the resulting mark, or null when it was cleared entirely
 */
async function setMark(eventId, photoId, adminId, { rating, colorLabel } = {}) {
  if (rating !== undefined && rating !== null) {
    const asInt = Number(rating);
    if (!Number.isInteger(asInt) || asInt < 1 || asInt > 5) {
      throw invalidMark('Rating must be between 1 and 5');
    }
  }
  if (colorLabel !== undefined && colorLabel !== null && !isValidColorLabel(colorLabel)) {
    throw invalidMark('Invalid color label');
  }

  /**
   * Write ONLY the halves this call was asked about, onto the row as it
   * stands right now.
   *
   * The obvious version — recompute both halves from a pre-read and write the
   * pair — loses a concurrent write: press 4 then 9 on a photo that already
   * has a mark and both calls read the old row, both write {rating,
   * color_label}, and the second silently clobbers the first with its stale
   * value. Not writing the untouched column at all means there is nothing to
   * lose, and no race machinery is needed to achieve it.
   */
  const applyToRow = async (row) => {
    const now = new Date().toISOString();
    const patch = { updated_at: now };
    if (rating !== undefined) patch.rating = rating === null ? null : Number(rating);
    if (colorLabel !== undefined) patch.color_label = colorLabel;

    await db('photo_admin_marks').where('id', row.id).update(patch);

    // A mark with neither half left is deleted, not kept as an empty row — an
    // empty row would still count as "marked" to anything testing existence.
    //
    // The emptiness test is a predicate ON the delete rather than a re-read
    // followed by a delete: a concurrent call that just filled a half back in
    // must not have its value dropped by our stale view of the row.
    const removed = await db('photo_admin_marks')
      .where('id', row.id)
      .whereNull('rating')
      .whereNull('color_label')
      .delete();
    if (removed) return null;

    const after = await db('photo_admin_marks').where('id', row.id).first();
    if (!after) return null;
    return { rating: after.rating ?? null, color_label: after.color_label ?? null };
  };

  const existing = await db('photo_admin_marks')
    .where({ photo_id: photoId, admin_id: adminId })
    .first();

  if (existing) return applyToRow(existing);

  // No row yet, so there is nothing for a clear-only call to clear.
  const fresh = {
    rating: rating === undefined || rating === null ? null : Number(rating),
    color_label: colorLabel === undefined || colorLabel === null ? null : colorLabel,
  };
  if (fresh.rating === null && fresh.color_label === null) return null;

  const now = new Date().toISOString();
  try {
    await db('photo_admin_marks').insert({
      photo_id: photoId,
      event_id: eventId,
      admin_id: adminId,
      ...fresh,
      created_at: now,
      updated_at: now,
    });
  } catch (error) {
    // The read above and this insert are not atomic, and a triage pass fires
    // them back to back — press 4 then 9 on an UNMARKED photo and both
    // requests can find no row and both try to insert. The unique index stops
    // the duplicate, which would otherwise surface as a 500 and a lost
    // keystroke; converge onto the row the winner created, through the same
    // write-only-what-you-addressed path as any other update.
    const raced = await db('photo_admin_marks')
      .where({ photo_id: photoId, admin_id: adminId })
      .first();
    if (!raced) throw error;
    return applyToRow(raced);
  }

  return fresh;
}

/**
 * One admin's marks across an event, keyed by photo id. Optionally narrowed to
 * the ids on the current page.
 *
 * @returns {Promise<Object>} { [photoId]: { rating, color_label } }
 */
async function getEventMarks(eventId, adminId, photoIds = null) {
  try {
    const query = db('photo_admin_marks')
      .where({ event_id: eventId, admin_id: adminId })
      .select('photo_id', 'rating', 'color_label');

    if (Array.isArray(photoIds)) {
      if (photoIds.length === 0) return {};
      query.whereIn('photo_id', photoIds);
    }

    const rows = await query;
    const byPhoto = {};
    for (const row of rows) {
      byPhoto[row.photo_id] = {
        rating: row.rating ?? null,
        color_label: row.color_label ?? null,
      };
    }
    return byPhoto;
  } catch (error) {
    logger.error('Error reading admin photo marks:', error);
    return {};
  }
}

/**
 * Per-colour photo counts for one admin's marks — drives the counts on the
 * "My marks" filter chips.
 */
async function getEventMarkColorCounts(eventId, adminId) {
  try {
    const rows = await db('photo_admin_marks')
      .where({ event_id: eventId, admin_id: adminId })
      .whereNotNull('color_label')
      .groupBy('color_label')
      .select('color_label')
      .count('id as count');

    const counts = {};
    for (const row of rows) {
      counts[row.color_label] = parseInt(row.count, 10) || 0;
    }
    return counts;
  } catch (error) {
    logger.error('Error counting admin photo marks:', error);
    return {};
  }
}

module.exports = { setMark, getEventMarks, getEventMarkColorCounts, INVALID_MARK };
