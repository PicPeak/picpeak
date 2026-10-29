/**
 * Duplicate detection by content hash (issue 1733, C2).
 *
 * An upload is hashed while it is still a local temp file, and the hash is
 * stored on its photo row (photos.content_sha256, migration 290). Only
 * byte-identical files match, and only within one gallery: a match across
 * galleries would tell one owner what another one holds.
 */

const crypto = require('crypto');
const fs = require('fs');
const { db } = require('../database/db');
const { livePhotos } = require('../utils/photoVisibility');
const { toIso } = require('../utils/dateNormalize');

/** Hex SHA-256 of a local file, streamed. */
async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * The oldest photo of this gallery with these bytes, or undefined. A photo in
 * the trash is not in the gallery: the same file can be uploaded again, and a
 * restore then puts a second copy next to it.
 */
function findDuplicate(eventId, contentSha256) {
  return livePhotos(db)
    .where({ event_id: eventId, content_sha256: contentSha256 })
    .orderBy('id')
    .first('id', 'filename', 'original_filename');
}

/** The name an uploader recognises the existing photo by. */
const duplicateName = (photo) => photo.original_filename || photo.filename;

/** Groups per page of the duplicates view, and the most one request may ask for. */
const DEFAULT_GROUP_LIMIT = 50;
const MAX_GROUP_LIMIT = 100;

const uploadedMs = (photo) => {
  const ms = Date.parse(toIso(photo.uploaded_at) || '');
  return Number.isFinite(ms) ? ms : Infinity;
};
/** Oldest upload first; the id breaks ties and orders rows without a date. */
const byUpload = (a, b) => (uploadedMs(a) - uploadedMs(b)) || (a.id - b.id);

/**
 * The duplicates view (issue 2194): groups of photos in this gallery that
 * share a hash, a page at a time, the group whose first photo came first
 * leading. Rows without a hash and photos in the trash take no part. The
 * grouping reads photos_content_sha256_idx (event_id, content_sha256), so it
 * costs the gallery's hashed rows, not the table.
 *
 * Returns { groups: [{ content_sha256, photos }], total_groups, total_photos }
 * with each group's photos oldest upload first; `columns` are read per photo.
 */
async function listDuplicateGroups(eventId, { limit = DEFAULT_GROUP_LIMIT, offset = 0, columns = [] } = {}) {
  const grouped = () => livePhotos(db)
    .where('event_id', eventId)
    .whereNotNull('content_sha256')
    .groupBy('content_sha256')
    .havingRaw('COUNT(*) > 1');

  const totals = await db
    .from(grouped().select('content_sha256').count('* as copies').as('dup_groups'))
    .count('* as groups')
    .sum('copies as photos')
    .first();

  const page = await grouped()
    .select('content_sha256')
    .orderByRaw('MIN(id)')
    .limit(limit)
    .offset(offset);
  const hashes = page.map((row) => row.content_sha256);

  const rows = hashes.length === 0 ? [] : await livePhotos(db)
    .where('event_id', eventId)
    .whereIn('content_sha256', hashes)
    .select('id', 'uploaded_at', 'content_sha256', ...columns);

  const byHash = new Map(hashes.map((hash) => [hash, []]));
  for (const row of rows) byHash.get(row.content_sha256).push(row);
  return {
    // A group a concurrent delete shrank to one photo between the two reads
    // is no group any more.
    groups: hashes
      .map((hash) => ({ content_sha256: hash, photos: byHash.get(hash).sort(byUpload) }))
      .filter((group) => group.photos.length > 1),
    total_groups: Number(totals?.groups) || 0,
    total_photos: Number(totals?.photos) || 0,
  };
}

/**
 * The other photos of this gallery with the same bytes as `keep`, for "keep
 * one, move the rest to the trash". Empty when `keep` is not a live, hashed
 * photo of the gallery.
 */
async function duplicatesOf(eventId, keep, conn = db) {
  if (!keep?.content_sha256 || String(keep.event_id) !== String(eventId) || keep.deleted_at) return [];
  return livePhotos(conn)
    .where({ event_id: eventId, content_sha256: keep.content_sha256 })
    .whereNot('id', keep.id)
    .orderBy('id');
}

module.exports = {
  sha256File, findDuplicate, duplicateName, listDuplicateGroups, duplicatesOf,
  DEFAULT_GROUP_LIMIT, MAX_GROUP_LIMIT,
};
