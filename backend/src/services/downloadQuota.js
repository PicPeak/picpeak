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

const { db } = require('../database/db');
const logger = require('../utils/logger');

const INSERT_CHUNK = 200; // 4 bound values per row, under SQLite's 999.

const MAX_LIMIT = 2147483647; // events.download_limit is a signed 32-bit int.

// A pending grant settles when its response ends. One whose process died
// first never will, so after this long it stops counting and is swept. Far
// longer than any download: a live one expiring would free a slot early.
const PENDING_TTL_MS = 24 * 3600 * 1000;
const pendingCutoff = () => new Date(Date.now() - PENDING_TTL_MS).toISOString();

// Delivered, or pending and recent enough that its download may still be live.
function whereLive(query) {
  const cutoff = pendingCutoff();
  return query.where((q) => q
    .where('event_download_grants.pending_holders', 0)
    .orWhere('event_download_grants.granted_at', '>=', cutoff));
}

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
 * The limit as it stands now. The request may have loaded the event before
 * an admin set one, so an unlimited snapshot is read again; a limited one is
 * re-read under the lock where it matters (grantDownloads).
 */
async function currentDownloadLimit(event) {
  const limit = downloadLimitOf(event);
  if (limit || !event || !event.id) return limit;
  return downloadLimitOf(await db('events').where({ id: event.id }).first('download_limit'));
}

/**
 * Photo ids already granted for this event. Joined to photos so a grant for a
 * photo that has since been deleted neither counts nor shows up: SQLite does
 * not run the ON DELETE CASCADE.
 */
async function grantedPhotoIds(eventId, photoIds = null, conn = db, { deliveredOnly = false } = {}) {
  let query = whereLive(conn('event_download_grants')
    .join('photos', 'photos.id', 'event_download_grants.photo_id')
    .where('event_download_grants.event_id', eventId)
    .where('photos.event_id', eventId));
  // A pending row belongs to a download still in flight: counted, not yet
  // handed over.
  if (deliveredOnly) query = query.where('event_download_grants.pending_holders', 0);
  if (photoIds) {
    if (photoIds.length === 0) return new Set();
    query = query.whereIn('event_download_grants.photo_id', photoIds);
  }
  const rows = await query.select('event_download_grants.photo_id');
  return new Set(rows.map((r) => Number(r.photo_id)));
}

async function countGrants(eventId, conn = db) {
  const row = await whereLive(conn('event_download_grants')
    .join('photos', 'photos.id', 'event_download_grants.photo_id')
    .where('event_download_grants.event_id', eventId)
    .where('photos.event_id', eventId))
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
 * { ok: true, newIds, held } — newIds being the photos this call counted for
 * the first time — or { ok: false, limit, used, remaining }. Admin previews
 * and unlimited events are a no-op.
 *
 * `reserve` is for a download that grants before it knows whether its bytes
 * will go out (every route does: the grant has to land before the first
 * byte). Its rows stay pending, holding their slot, until settleWhenDone
 * records what was delivered and gives back the rest. A pending row another
 * download reserved is joined rather than taken over, so the slot is only
 * given back once no download that could still deliver it holds it. Without
 * `reserve` the grant is delivered at once.
 */
async function grantDownloads(event, photoIds, { isAdminPreview = false, reserve = false } = {}) {
  if (isAdminPreview) return { ok: true, newIds: [] };
  const ids = uniqueIds(photoIds);
  if (ids.length === 0) return { ok: true, newIds: [] };
  // No byte has gone out yet, so a limit set since the event was loaded counts.
  if (!(await currentDownloadLimit(event))) return { ok: true, newIds: [] };

  return db.transaction(async (trx) => {
    // SQLite runs one write transaction at a time; Postgres needs the row lock.
    if (trx.client.config.client === 'pg') {
      await trx('events').where({ id: event.id }).forUpdate().first();
    }
    // The limit is re-read under the lock: an admin raising or lowering it
    // between the request's event load and here must be honoured.
    const current = await trx('events').where({ id: event.id }).first('id', 'download_limit');
    if (!downloadLimitOf(current)) return { ok: true, newIds: [] };

    // Pending grants whose download never settled (the process died) no
    // longer count; clear them so the rows below can take their place.
    await trx('event_download_grants')
      .where('event_id', event.id)
      .where('pending_holders', '>', 0)
      .where('granted_at', '<', pendingCutoff())
      .del();

    const result = await evaluate(current, ids, trx);
    if (!result.ok) return result;

    const fresh = new Set(result.newIds);
    const reused = ids.filter((id) => !fresh.has(id));
    const joined = [];
    for (let i = 0; i < reused.length; i += INSERT_CHUNK) {
      const chunk = trx('event_download_grants')
        .where('event_id', event.id)
        .whereIn('photo_id', reused.slice(i, i + INSERT_CHUNK))
        .where('pending_holders', '>', 0);
      if (reserve) {
        const rows = await chunk.clone().select('photo_id');
        joined.push(...rows.map((r) => Number(r.photo_id)));
        // Joining restarts the clock: this download is live.
        await chunk.update({
          pending_holders: trx.raw('pending_holders + 1'),
          granted_at: new Date().toISOString(),
        });
      } else {
        await chunk.update({ pending_holders: 0 });
      }
    }

    const grantedAt = new Date().toISOString();
    for (let i = 0; i < result.newIds.length; i += INSERT_CHUNK) {
      const rows = result.newIds.slice(i, i + INSERT_CHUNK).map((photoId) => ({
        event_id: event.id,
        photo_id: photoId,
        guest_id: null,
        granted_at: grantedAt,
        pending_holders: reserve ? 1 : 0,
      }));
      await trx('event_download_grants').insert(rows).onConflict(['event_id', 'photo_id']).ignore();
    }
    // The rows this download holds, by row id: an admin reset deletes them,
    // and a later download may reserve the same photo in a new row, which
    // this one's release must not touch.
    const held = reserve ? [...result.newIds, ...joined] : [];
    const heldRows = [];
    for (let i = 0; i < held.length; i += INSERT_CHUNK) {
      const rows = await trx('event_download_grants')
        .where('event_id', event.id)
        .whereIn('photo_id', held.slice(i, i + INSERT_CHUNK))
        .select('id', 'photo_id');
      heldRows.push(...rows.map((r) => ({ id: Number(r.id), photoId: Number(r.photo_id) })));
    }
    return {
      ok: true,
      newIds: result.newIds,
      held,
      heldRows,
    };
  });
}

/**
 * The end of a reserved download (issue 1560). What it delivered becomes a
 * delivered grant — recreated if the slot was given back in the meantime,
 * because the photo did go out. For what it held and did not deliver (a
 * missing source, a cancelled download) it lets go: the slot is given back
 * when it was the last holder, and a row some other download has delivered
 * meanwhile is left alone.
 *
 * Under the same event lock as grantDownloads.
 */
async function settleReservation(eventId, quota, deliveredIds) {
  if (!quota || !Array.isArray(quota.held)) return;
  const delivered = uniqueIds(deliveredIds);
  const deliveredSet = new Set(delivered);
  const released = (quota.heldRows || [])
    .filter((row) => !deliveredSet.has(row.photoId))
    .map((row) => row.id);
  if (delivered.length === 0 && released.length === 0) return;
  await db.transaction(async (trx) => {
    const isPg = trx.client.config.client === 'pg';
    if (isPg) {
      await trx('events').where({ id: eventId }).forUpdate().first();
    }
    const grantedAt = new Date().toISOString();
    for (let i = 0; i < delivered.length; i += INSERT_CHUNK) {
      // A photo deleted since it shipped has nothing left to count, and on
      // PostgreSQL its grant would fail the foreign key and roll back the
      // whole settlement. Held against deletion until this commits.
      const surviving = trx('photos')
        .where('event_id', eventId)
        .whereIn('id', delivered.slice(i, i + INSERT_CHUNK));
      if (isPg) surviving.forShare();
      const photoIds = (await surviving.pluck('id')).map(Number);
      if (photoIds.length === 0) continue;
      const rows = photoIds.map((photoId) => ({
        event_id: eventId,
        photo_id: photoId,
        guest_id: null,
        granted_at: grantedAt,
        pending_holders: 0,
      }));
      await trx('event_download_grants').insert(rows)
        .onConflict(['event_id', 'photo_id']).merge(['pending_holders']);
    }
    for (let i = 0; i < released.length; i += INSERT_CHUNK) {
      const chunk = released.slice(i, i + INSERT_CHUNK);
      await trx('event_download_grants')
        .where({ event_id: eventId, pending_holders: 1 })
        .whereIn('id', chunk)
        .del();
      await trx('event_download_grants')
        .where('event_id', eventId)
        .where('pending_holders', '>', 1)
        .whereIn('id', chunk)
        .decrement('pending_holders', 1);
    }
  });
}

/**
 * Settle a reserved grant once the response is over, with whatever
 * `deliveredIds()` then reports. Handles a response that closed before this
 * was registered — a guest who gave up while the grant was being recorded.
 */
function settleWhenDone(res, eventId, quota, deliveredIds) {
  if (!quota || !Array.isArray(quota.held)) return;
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    settleReservation(eventId, quota, deliveredIds()).catch((err) => logger.warn('Could not settle download grants', {
      eventId, error: err.message,
    }));
  };
  res.once('close', settle);
  if (res.destroyed || res.closed) settle();
}

/**
 * For a single response carrying `photoIds` whole: delivered once its body
 * started going out with a success status. An error before the first byte
 * gives the slots back; a transfer cut off midway does not, since the bytes
 * that went out cannot be taken back.
 */
function responseDelivered(res, photoIds) {
  return () => (res.headersSent && res.statusCode < 400 ? photoIds : []);
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
  currentDownloadLimit,
  grantedPhotoIds,
  getQuota,
  checkDownloads,
  grantDownloads,
  downloadLimitError,
  resetGrants,
  settleReservation,
  settleWhenDone,
  responseDelivered,
  isOriginalWithheld,
};
