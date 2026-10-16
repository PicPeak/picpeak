/**
 * Scene tags as a gallery viewer sees them (issue 1733).
 *
 * Kept apart from tagProcessor so the guest photo list does not load the
 * image pipeline to read two small queries.
 */

const { db } = require('../database/db');
const { applyPhotoVisibilityFilter, joinLivePhotos } = require('../utils/photoVisibility');

/**
 * photo id -> tag keys, best score first. The caller only reads the ids it
 * is already showing, so this cannot widen what a viewer sees.
 *
 * `photoIds` is the page being sent (at most 250 ids): without it every page
 * of a large gallery would read and sort the tags of the whole event. Left
 * out, for the unpaginated list, it is every tagged photo of the event.
 */
async function getTagKeysByPhoto(eventId, photoIds = null) {
  if (photoIds && photoIds.length === 0) return new Map();
  const query = db('photo_tags').where({ event_id: eventId });
  if (photoIds) query.whereIn('photo_id', photoIds);
  const rows = await query
    .orderBy([{ column: 'score', order: 'desc' }, { column: 'tag', order: 'asc' }])
    .select('photo_id', 'tag');
  const byPhoto = new Map();
  for (const row of rows) {
    const id = Number(row.photo_id);
    if (!byPhoto.has(id)) byPhoto.set(id, []);
    byPhoto.get(id).push(row.tag);
  }
  return byPhoto;
}

/**
 * The tags in use in a gallery with their photo counts, most used first.
 *
 * Counted over the same photos the list shows this viewer: finished
 * processing and passing the visibility filter. A tag that only occurs on
 * hidden photos must not reach a guest, not even as a name.
 */
async function getEventTagCounts(eventId, accessLevel) {
  const query = db('photo_tags')
    .modify(joinLivePhotos, 'photos.id', 'photo_tags.photo_id')
    .where('photo_tags.event_id', eventId)
    .where('photos.event_id', eventId)
    .where(function () {
      this.where('photos.processing_status', 'complete').orWhereNull('photos.processing_status');
    })
    .whereNull('photos.unavailable_reason');
  const rows = await applyPhotoVisibilityFilter(query, accessLevel)
    .groupBy('photo_tags.tag')
    .select('photo_tags.tag as key')
    .count({ count: '*' });
  return rows
    // PostgreSQL returns the count as a string.
    .map((row) => ({ key: row.key, count: Number(row.count) }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

module.exports = { getTagKeysByPhoto, getEventTagCounts };
