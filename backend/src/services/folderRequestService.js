/**
 * Folder requests (issue 1786).
 *
 * A role without `folders.manage` (the Team Photographer preset) may upload
 * but not create folders. When its upload names a folder that does not exist
 * yet, the folder becomes a request and the photos land in the closest
 * existing parent right away, visible as usual, marked with
 * `photos.pending_folder_request_id`.
 *
 *   approve → the folder path is created (or merged into an existing folder
 *             the admin picks) and the request's photos move in — only the
 *             ones still sitting in the fallback folder, so a photo an admin
 *             moved by hand in the meantime stays where it was put.
 *   reject  → the photos stay in the parent; the marker is cleared.
 *
 * At most one open request per (event, path): a second upload into the same
 * missing folder joins it (partial unique index from migration 265).
 */

const { db } = require('../database/db');
const { livePhotos } = require('../utils/photoVisibility');
const { isUniqueViolation } = require('../utils/dbErrors');
const { toUtcIso } = require('../utils/queueTimestamps');
const tree = require('./folderTreeService');

async function countOpenRequests(eventId, conn = db) {
  const row = await conn('folder_requests').where({ event_id: eventId, status: 'pending' }).count('id as count').first();
  return Number(row?.count) || 0;
}

async function openRequest(eventId, segments, fallbackFolderId, adminId, conn = db) {
  const pathKey = tree.pathKey(segments);
  const existing = await conn('folder_requests').where({ event_id: eventId, path: pathKey, status: 'pending' }).first('id');
  if (existing) return Number(existing.id);
  // Joining an open request above is always allowed; a NEW one counts
  // against the per-event cap (tree.FOLDER_LIMITS).
  const limit = tree.FOLDER_LIMITS.MAX_OPEN_REQUESTS_PER_EVENT;
  if ((await countOpenRequests(eventId, conn)) >= limit) {
    throw new tree.FolderError(
      `This gallery has reached its limit of ${limit} open folder requests; approve or reject some first`,
      409,
      'FOLDER_REQUEST_LIMIT_REACHED',
      { limit },
    );
  }
  try {
    const inserted = await conn('folder_requests').insert({
      event_id: eventId,
      path: pathKey,
      fallback_folder_id: fallbackFolderId == null ? null : Number(fallbackFolderId),
      requested_by: adminId || null,
      status: 'pending',
      created_at: new Date().toISOString(),
    }).returning('id');
    return Number(inserted[0]?.id ?? inserted[0]);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const row = await conn('folder_requests').where({ event_id: eventId, path: pathKey, status: 'pending' }).first('id');
    if (!row) throw err;
    return Number(row.id);
  }
}

/** An open request of this event, else null. */
async function findOpenRequest(eventId, requestId, conn = db) {
  const id = Number(requestId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return conn('folder_requests').where({ id, event_id: eventId, status: 'pending' }).first() || null;
}

async function listRequests(eventId, { status = 'pending' } = {}, conn = db) {
  const rows = await conn('folder_requests')
    .leftJoin('admin_users', 'admin_users.id', 'folder_requests.requested_by')
    .where('folder_requests.event_id', eventId)
    .modify((q) => { if (status) q.where('folder_requests.status', status); })
    .orderBy('folder_requests.path', 'asc')
    .select('folder_requests.*', 'admin_users.username as requested_by_name');
  if (rows.length === 0) return [];
  const counts = await livePhotos(conn)
    .whereIn('pending_folder_request_id', rows.map((r) => r.id))
    .groupBy('pending_folder_request_id')
    .select('pending_folder_request_id')
    .count('id as count');
  const countBy = new Map(counts.map((c) => [Number(c.pending_folder_request_id), Number(c.count)]));
  return rows.map((r) => ({
    id: Number(r.id),
    path: r.path,
    segments: String(r.path).split('/'),
    fallback_folder_id: r.fallback_folder_id == null ? null : Number(r.fallback_folder_id),
    requested_by_name: r.requested_by_name || null,
    status: r.status,
    // SQLite's DB-clock default is zone-less UTC (issue 1815).
    created_at: toUtcIso(r.created_at),
    photo_count: countBy.get(Number(r.id)) || 0,
  }));
}

/**
 * Decide an open request, claimed in the UPDATE: of an approve and a reject
 * racing each other exactly one changes the row, the other gets a 404 —
 * a read-then-write would let both "win" under READ COMMITTED.
 */
async function claimRequest(eventId, requestId, status, adminId, trx) {
  const request = await findOpenRequest(eventId, requestId, trx);
  if (!request) throw new tree.FolderError('Folder request not found', 404, 'FOLDER_REQUEST_NOT_FOUND');
  const changed = await trx('folder_requests')
    .where({ id: request.id, status: 'pending' })
    .update({ status, decided_by: adminId || null, decided_at: new Date().toISOString() });
  if (!changed) throw new tree.FolderError('Folder request not found', 404, 'FOLDER_REQUEST_NOT_FOUND');
  return request;
}

/**
 * Photos whose upload resolved against a request that was decided before
 * they were inserted (a chunked upload can outlive the decision): apply the
 * decision to them, so none stays parked on a closed request.
 */
async function settleLateArrivals(eventId, requestId) {
  const request = await db('folder_requests').where({ id: requestId, event_id: eventId }).first();
  if (!request || request.status === 'pending') return 0;
  const fallback = request.fallback_folder_id == null ? null : Number(request.fallback_folder_id);
  const update = request.status === 'approved' && request.approved_folder_id
    ? { folder_id: Number(request.approved_folder_id), pending_folder_request_id: null }
    : { pending_folder_request_id: null };
  return db('photos')
    .where({ event_id: eventId, pending_folder_request_id: request.id })
    .modify((q) => {
      if (update.folder_id) { if (fallback == null) q.whereNull('folder_id'); else q.where('folder_id', fallback); }
    })
    .update(update);
}

/**
 * Approve: create the requested path (or use `targetFolderId`, an existing
 * folder the admin merges it into), then move the request's photos that are
 * still in the fallback folder. Returns { folderId, moved }.
 */
async function approveRequest(eventId, requestId, adminId, { targetFolderId } = {}) {
  return db.transaction(async (trx) => {
    const request = await claimRequest(eventId, requestId, 'approved', adminId, trx);

    let folderId;
    if (targetFolderId != null) {
      const target = await tree.findEventFolder(eventId, targetFolderId, trx);
      if (!target) throw new tree.FolderError('Target folder not found', 404, 'FOLDER_NOT_FOUND');
      folderId = Number(target.id);
    } else {
      ({ folderId } = await tree.ensurePath(eventId, String(request.path).split('/'), { canCreate: true, conn: trx }));
    }

    const fallback = request.fallback_folder_id == null ? null : Number(request.fallback_folder_id);
    const moved = await trx('photos')
      .where({ event_id: eventId, pending_folder_request_id: request.id })
      .modify((q) => { if (fallback == null) q.whereNull('folder_id'); else q.where('folder_id', fallback); })
      .update({ folder_id: folderId, pending_folder_request_id: null });
    await trx('photos').where({ event_id: eventId, pending_folder_request_id: request.id })
      .update({ pending_folder_request_id: null });
    await trx('folder_requests').where('id', request.id).update({ approved_folder_id: folderId });
    return { folderId, moved, path: request.path };
  });
}

async function rejectRequest(eventId, requestId, adminId) {
  return db.transaction(async (trx) => {
    const request = await claimRequest(eventId, requestId, 'rejected', adminId, trx);
    await trx('photos').where({ event_id: eventId, pending_folder_request_id: request.id })
      .update({ pending_folder_request_id: null });
    return { path: request.path };
  });
}

module.exports = { countOpenRequests, openRequest, findOpenRequest, listRequests, approveRequest, rejectRequest, settleLateArrivals };
