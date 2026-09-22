/**
 * The per-event download limit (events.download_limit, issue 1560).
 *
 * The quota counts distinct photos: a photo is used up the first time any
 * download path grants it, and downloading it again, in a zip or at another
 * resolution, is free. Grants are recorded in event_download_grants.
 *
 * grantDownloads is all-or-nothing and runs before the first byte goes out.
 * It counts and inserts in one transaction that holds the event row, the same
 * way photoCap.insertPhotoWithinCap does, so two requests at 9/10 cannot both
 * pass. Nothing inside the transaction may touch `db` directly: on SQLite that
 * waits for the connection the transaction itself holds.
 */

const crypto = require('crypto');
const { db } = require('../database/db');

const INSERT_CHUNK = 200; // 4 bound values per row, under SQLite's 999.

const MAX_LIMIT = 2147483647; // events.download_limit is a signed 32-bit int.

/** A stored or submitted limit as a positive integer, or null for unlimited. */
function normaliseDownloadLimit(value) {
  const limit = Number(value);
  return Number.isInteger(limit) && limit > 0 && limit <= MAX_LIMIT ? limit : null;
}

/** The event's limit as a positive integer, or null when downloads are unlimited. */
function downloadLimitOf(event) {
  return normaliseDownloadLimit(event && event.download_limit);
}

/**
 * Photo ids already granted for this event. Joined to photos so a grant for a
 * photo that has since been deleted neither counts nor shows up: SQLite does
 * not run the ON DELETE CASCADE.
 */
async function grantedPhotoIds(eventId, photoIds = null, conn = db, { deliveredOnly = false } = {}) {
  let query = conn('event_download_grants')
    .join('photos', 'photos.id', 'event_download_grants.photo_id')
    .where('event_download_grants.event_id', eventId)
    .where('photos.event_id', eventId);
  // A reserved row belongs to a zip still streaming: counted, not yet handed over.
  if (deliveredOnly) query = query.whereNull('event_download_grants.reservation');
  if (photoIds) {
    if (photoIds.length === 0) return new Set();
    query = query.whereIn('event_download_grants.photo_id', photoIds);
  }
  const rows = await query.select('event_download_grants.photo_id');
  return new Set(rows.map((r) => Number(r.photo_id)));
}

async function countGrants(eventId, conn = db) {
  const row = await conn('event_download_grants')
    .join('photos', 'photos.id', 'event_download_grants.photo_id')
    .where('event_download_grants.event_id', eventId)
    .where('photos.event_id', eventId)
    .count('event_download_grants.id as count')
    .first();
  return parseInt(row && row.count, 10) || 0;
}

/** { limit, used, remaining } for a limited event, null when it is unlimited. */
async function getQuota(event, conn = db) {
  const limit = downloadLimitOf(event);
  if (!limit) return null;
  const used = await countGrants(event.id, conn);
  return { limit, used, remaining: Math.max(0, limit - used) };
}

function uniqueIds(photoIds) {
  return [...new Set((photoIds || []).map(Number).filter(Number.isInteger))];
}

async function evaluate(event, ids, conn) {
  const quota = await getQuota(event, conn);
  const granted = await grantedPhotoIds(event.id, ids, conn);
  const newIds = ids.filter((id) => !granted.has(id));
  return { ...quota, newIds, ok: newIds.length <= quota.remaining };
}

/**
 * Would this request fit, without recording anything? Used where the grant
 * happens later, when the bytes are actually handed over (download jobs).
 */
async function checkDownloads(event, photoIds, { isAdminPreview = false } = {}) {
  if (isAdminPreview || !downloadLimitOf(event)) return { ok: true };
  const result = await evaluate(event, uniqueIds(photoIds), db);
  return result.ok ? { ok: true } : result;
}

/**
 * Grant every photo in `photoIds`, or none of them. Returns
 * { ok: true, newIds, reservation } — newIds being the photos this call
 * counted for the first time — or { ok: false, limit, used, remaining }.
 * Admin previews and unlimited events are a no-op.
 *
 * `reserve` is for a zip that grants its whole set before streaming: its new
 * rows are tagged with a reservation id, and when the response ends
 * settleReservation keeps what it shipped and gives back the rest. A
 * single-shot download that finds a reserved row delivers the photo now, so
 * it clears the tag and the zip can no longer take that slot back. Another
 * zip leaves the tag alone: it has not delivered anything yet either.
 */
async function grantDownloads(event, photoIds, { isAdminPreview = false, reserve = false } = {}) {
  if (isAdminPreview || !downloadLimitOf(event)) return { ok: true, newIds: [] };
  const ids = uniqueIds(photoIds);
  if (ids.length === 0) return { ok: true, newIds: [] };
  const reservation = reserve ? crypto.randomUUID() : null;

  return db.transaction(async (trx) => {
    // SQLite runs one write transaction at a time; Postgres needs the row lock.
    if (trx.client.config.client === 'pg') {
      await trx('events').where({ id: event.id }).forUpdate().first();
    }
    // The limit is re-read under the lock: an admin raising or lowering it
    // between the request's event load and here must be honoured.
    const current = await trx('events').where({ id: event.id }).first('id', 'download_limit');
    if (!downloadLimitOf(current)) return { ok: true, newIds: [] };

    const result = await evaluate(current, ids, trx);
    if (!result.ok) return result;

    const fresh = new Set(result.newIds);
    const reused = reserve ? [] : ids.filter((id) => !fresh.has(id));
    for (let i = 0; i < reused.length; i += INSERT_CHUNK) {
      await trx('event_download_grants')
        .where('event_id', event.id)
        .whereIn('photo_id', reused.slice(i, i + INSERT_CHUNK))
        .whereNotNull('reservation')
        .update({ reservation: null });
    }

    const grantedAt = new Date().toISOString();
    for (let i = 0; i < result.newIds.length; i += INSERT_CHUNK) {
      const rows = result.newIds.slice(i, i + INSERT_CHUNK).map((photoId) => ({
        event_id: event.id,
        photo_id: photoId,
        guest_id: null,
        granted_at: grantedAt,
        reservation,
      }));
      await trx('event_download_grants').insert(rows).onConflict(['event_id', 'photo_id']).ignore();
    }
    return { ok: true, newIds: result.newIds, reservation };
  });
}

/**
 * End of a zip that granted with `reserve` (issue 1560). What it shipped
 * becomes a delivered grant — recreated if an overlapping zip gave the slot
 * back in the meantime, because the photo did go out. What it counted for the
 * first time and never shipped (a missing source, a cancelled download) is
 * given back, but only while the row still carries this zip's reservation: a
 * single download that delivered the photo meanwhile cleared it.
 *
 * Under the same event lock as grantDownloads.
 */
async function settleReservation(eventId, quota, shippedIds) {
  if (!quota || !quota.reservation) return;
  const shipped = uniqueIds(shippedIds);
  const unshipped = undeliveredGrants(quota, shipped);
  if (shipped.length === 0 && unshipped.length === 0) return;
  await db.transaction(async (trx) => {
    if (trx.client.config.client === 'pg') {
      await trx('events').where({ id: eventId }).forUpdate().first();
    }
    const grantedAt = new Date().toISOString();
    for (let i = 0; i < shipped.length; i += INSERT_CHUNK) {
      const rows = shipped.slice(i, i + INSERT_CHUNK).map((photoId) => ({
        event_id: eventId,
        photo_id: photoId,
        guest_id: null,
        granted_at: grantedAt,
        reservation: null,
      }));
      await trx('event_download_grants').insert(rows)
        .onConflict(['event_id', 'photo_id']).merge(['reservation']);
    }
    for (let i = 0; i < unshipped.length; i += INSERT_CHUNK) {
      await trx('event_download_grants')
        .where({ event_id: eventId, reservation: quota.reservation })
        .whereIn('photo_id', unshipped.slice(i, i + INSERT_CHUNK))
        .del();
    }
  });
}

/** The undelivered part of a grant: counted by this request, never appended. */
function undeliveredGrants(quota, deliveredIds) {
  if (!quota || !Array.isArray(quota.newIds) || quota.newIds.length === 0) return [];
  const delivered = new Set((deliveredIds || []).map(Number));
  return quota.newIds.filter((id) => !delivered.has(Number(id)));
}

/** The response body every download path sends when the limit refuses a request. */
function downloadLimitError(result) {
  return {
    error: 'Download limit reached. Please contact your photographer for more downloads.',
    code: 'DOWNLOAD_LIMIT_REACHED',
    limit: result.limit,
    used: result.used,
    remaining: result.remaining,
  };
}

/** Clear every grant for an event, freeing its whole quota. */
async function resetGrants(eventId) {
  return db('event_download_grants').where('event_id', eventId).del();
}

/**
 * Whether the lightbox original of this photo is withheld from the requester.
 * While a limit applies, guests only get the preview tier: the original is a
 * full-resolution copy a long-press away, which would make the limit
 * cosmetic. A photo already granted was downloaded anyway, and admin previews
 * are exempt.
 */
async function isOriginalWithheld(event, photo, { isAdminPreview = false } = {}) {
  if (isAdminPreview || !downloadLimitOf(event)) return false;
  // Delivered grants only: a zip still streaming may yet give the slot back.
  const granted = await grantedPhotoIds(event.id, [Number(photo.id)], db, { deliveredOnly: true });
  return !granted.has(Number(photo.id));
}

module.exports = {
  normaliseDownloadLimit,
  downloadLimitOf,
  grantedPhotoIds,
  getQuota,
  checkDownloads,
  grantDownloads,
  downloadLimitError,
  resetGrants,
  settleReservation,
  undeliveredGrants,
  isOriginalWithheld,
};
