/**
 * The per-event photo cap (events.photo_cap).
 *
 * Only the admin batch upload enforced it, so guest uploads and the admin
 * chunked upload could grow an event past the limit its photographer set.
 * insertPhotoWithinCap counts and inserts in one transaction that holds the
 * event row, so concurrent uploads cannot all pass the check and overshoot
 * together.
 */

const { db } = require('../database/db');

/** The event's cap as a positive integer, or null when it has none. */
function photoCapOf(event) {
  const cap = parseInt(event && event.photo_cap, 10);
  return Number.isInteger(cap) && cap > 0 ? cap : null;
}

async function countEventPhotos(eventId, conn = db) {
  const row = await conn('photos').where({ event_id: eventId }).count('id as count').first();
  return parseInt(row && row.count, 10) || 0;
}

async function isPhotoCapReached(event) {
  const cap = photoCapOf(event);
  if (!cap) return false;
  return (await countEventPhotos(event.id)) >= cap;
}

function photoCapError(cap) {
  return {
    error: `This gallery has reached its limit of ${cap} photos.`,
    code: 'PHOTO_CAP_REACHED',
    limit: cap,
  };
}

/**
 * Insert a photo row unless the event already holds `cap` photos. Returns the
 * insert result, or null when the cap is reached. Without a cap it is a plain
 * insert.
 */
async function insertPhotoWithinCap(row, cap) {
  if (!cap) return db('photos').insert(row).returning('id');
  return db.transaction(async (trx) => {
    // SQLite runs one write transaction at a time; Postgres needs the row lock.
    if (trx.client.config.client === 'pg') {
      await trx('events').where({ id: row.event_id }).forUpdate().first();
    }
    if ((await countEventPhotos(row.event_id, trx)) >= cap) return null;
    return trx('photos').insert(row).returning('id');
  });
}

module.exports = {
  photoCapOf,
  countEventPhotos,
  isPhotoCapReached,
  photoCapError,
  insertPhotoWithinCap,
};
