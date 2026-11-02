/**
 * Named favourite lists per guest per gallery (issue 2303, migration 339).
 *
 * A guest's favourites (feedback_type 'favorite') sit in their default list
 * (photo_feedback.favorite_list_id NULL) or in one of the extra lists they
 * named here. A list belongs to one viewer by the rule that finds their
 * feedback rows: the registered guest by guest_id, anyone else by the
 * anonymous browser identity (selectionSubmissions.scopeToViewer). Only while
 * the gallery's allow_favorite_lists is on; the routes check that.
 *
 * Every write runs under the viewer's lock (selectionSubmissions
 * .withViewerLock), the one a favourite write takes: a list deleted while a
 * favourite is being saved into it either goes first, and the save finds no
 * list, or goes after, and takes the new favourite with it. A finished
 * selection freezes the lists along with the favourites.
 */

const { db } = require('../database/db');
const selectionSubmissions = require('./selectionSubmissions');
const { applyPhotoVisibilityFilter, joinLivePhotos, wherePhotoProcessed } = require('../utils/photoVisibility');

// Extra lists per guest per gallery, the default list not counted.
const MAX_LISTS_PER_GUEST = 20;
const NAME_MAX_LENGTH = 60;
// What a data export calls the default list. The guest sees it under its
// translated label ("Saved"); a spreadsheet column needs one stable word.
const DEFAULT_LIST_EXPORT_NAME = 'Default';

function scopeToViewer(query, { guestId, guestIdentifier }, table = null) {
  const column = (name) => (table ? `${table}.${name}` : name);
  return guestId
    ? query.where(column('guest_id'), guestId)
    : query.where(column('guest_identifier'), guestIdentifier);
}

/**
 * The name as stored: trimmed, inner whitespace collapsed, control characters
 * dropped. Returns null for a name that is empty or too long afterwards.
 */
function normalizeName(raw) {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name || name.length > NAME_MAX_LENGTH) return null;
  return name;
}

const foldName = (name) => String(name || '').toLocaleLowerCase();

function present(row, count = 0) {
  return {
    id: Number(row.id),
    name: row.name,
    count,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function ownLists(eventId, viewer, executor = db) {
  return scopeToViewer(executor('favorite_lists').where({ event_id: eventId }), viewer);
}

/** The viewer's list `listId` in this gallery, or null. */
async function findOwnList(eventId, viewer, listId, executor = db) {
  const id = Number(listId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return (await ownLists(eventId, viewer, executor).where({ id }).first()) || null;
}

/**
 * The viewer's lists with the number of photos in each, counted as the guest
 * sees them: hidden rows, photos in the trash, photos back in processing and
 * photos the viewer may not see are left out, as /my-feedback leaves them out.
 */
async function listForViewer(eventId, viewer, executor = db) {
  const lists = await ownLists(eventId, viewer, executor).orderBy('id', 'asc');
  const counts = await scopeToViewer(
    applyPhotoVisibilityFilter(
      wherePhotoProcessed(executor('photo_feedback')
        .modify(joinLivePhotos, 'photo_feedback.photo_id', 'photos.id')
        .where({
          'photo_feedback.event_id': eventId,
          'photo_feedback.feedback_type': 'favorite',
          'photo_feedback.is_hidden': false,
        })),
      viewer.accessLevel,
    ),
    viewer,
    'photo_feedback',
  )
    .groupBy('photo_feedback.favorite_list_id')
    .select('photo_feedback.favorite_list_id')
    .countDistinct('photo_feedback.photo_id as count');

  const byList = new Map(counts.map((row) => [row.favorite_list_id == null ? null : Number(row.favorite_list_id), Number(row.count) || 0]));
  return {
    default_count: byList.get(null) || 0,
    lists: lists.map((row) => present(row, byList.get(Number(row.id)) || 0)),
  };
}

/**
 * Run `work(trx)` under the viewer's lock, refused while their selection is
 * handed in. Returns `work`'s answer, or { locked } / { guest_missing }.
 */
async function underViewerLock(eventId, viewer, work) {
  return selectionSubmissions.withViewerLock(eventId, viewer, async (trx) => {
    if (await selectionSubmissions.guestGone(trx, viewer.guestId)) return { guest_missing: true };
    const lock = await selectionSubmissions.lockFor(eventId, 'favorite', viewer, trx);
    if (lock) return { locked: true, kind: lock.kind, submitted_at: lock.submitted_at };
    return work(trx);
  });
}

async function nameTaken(trx, eventId, viewer, name, exceptId = null) {
  const rows = await ownLists(eventId, viewer, trx).select('id', 'name');
  const folded = foldName(name);
  return rows.some((row) => foldName(row.name) === folded && Number(row.id) !== Number(exceptId));
}

/**
 * Create a list. Returns { list } or one of { invalid_name }, { name_taken },
 * { limit_reached }, { locked }, { guest_missing }.
 */
async function create(eventId, viewer, rawName) {
  const name = normalizeName(rawName);
  if (!name) return { invalid_name: true };
  return underViewerLock(eventId, viewer, async (trx) => {
    const row = await ownLists(eventId, viewer, trx).count('id as count').first();
    if ((Number(row?.count) || 0) >= MAX_LISTS_PER_GUEST) {
      return { limit_reached: true, limit: MAX_LISTS_PER_GUEST };
    }
    if (await nameTaken(trx, eventId, viewer, name)) return { name_taken: true };
    const now = new Date().toISOString();
    const inserted = await trx('favorite_lists').insert({
      event_id: eventId,
      guest_id: viewer.guestId || null,
      guest_identifier: viewer.guestIdentifier,
      name,
      created_at: now,
      updated_at: now,
    }).returning('id');
    const id = inserted[0]?.id ?? inserted[0];
    return { list: present(await trx('favorite_lists').where({ id }).first()) };
  });
}

/** Rename a list. Returns { list } or { not_found } / { invalid_name } / ... */
async function rename(eventId, viewer, listId, rawName) {
  const name = normalizeName(rawName);
  if (!name) return { invalid_name: true };
  return underViewerLock(eventId, viewer, async (trx) => {
    const list = await findOwnList(eventId, viewer, listId, trx);
    if (!list) return { not_found: true };
    if (await nameTaken(trx, eventId, viewer, name, list.id)) return { name_taken: true };
    await trx('favorite_lists').where({ id: list.id }).update({ name, updated_at: new Date().toISOString() });
    return { list: present(await trx('favorite_lists').where({ id: list.id }).first()) };
  });
}

/**
 * Delete a list and the favourites in it. Explicit on both engines: SQLite
 * does not enforce the cascade migration 339 declares. Returns
 * { removed, photo_ids } for the caller to recount, or { not_found } / ...
 */
async function remove(eventId, viewer, listId) {
  return underViewerLock(eventId, viewer, async (trx) => {
    const list = await findOwnList(eventId, viewer, listId, trx);
    if (!list) return { not_found: true };
    const rows = await trx('photo_feedback').where({ favorite_list_id: list.id }).select('photo_id');
    const removed = await trx('photo_feedback').where({ favorite_list_id: list.id }).del();
    await trx('favorite_lists').where({ id: list.id }).del();
    return { removed, photo_ids: [...new Set(rows.map((row) => row.photo_id))] };
  });
}

/** Mark a list as changed, for the admin's "last update". */
async function touch(listId, executor = db) {
  if (!listId) return;
  await executor('favorite_lists').where({ id: listId }).update({ updated_at: new Date().toISOString() });
}

/**
 * Guest merge (feedbackService.mergeGuestFeedback): the source guests' lists
 * move to the survivor, and a list whose name the survivor already has is
 * folded into that one, its favourites re-pointed. Before the caller dedupes
 * the favourites, so a photo in both same-named lists ends up once.
 */
async function mergeGuests(trx, survivor, sourceGuestIds) {
  if (!(await trx.schema.hasTable('favorite_lists'))) return;
  const lists = await trx('favorite_lists')
    .where({ event_id: survivor.event_id })
    .whereIn('guest_id', [survivor.id, ...sourceGuestIds])
    .orderBy('id', 'asc')
    .select('id', 'guest_id', 'name');
  // The survivor's own lists claim their names first.
  lists.sort((a, b) => (Number(a.guest_id) === Number(survivor.id) ? 0 : 1) - (Number(b.guest_id) === Number(survivor.id) ? 0 : 1)
    || Number(a.id) - Number(b.id));
  const byName = new Map();
  for (const list of lists) {
    const key = foldName(list.name);
    const target = byName.get(key);
    if (target) {
      await trx('photo_feedback').where({ favorite_list_id: list.id }).update({ favorite_list_id: target });
      await trx('favorite_lists').where({ id: list.id }).del();
      continue;
    }
    byName.set(key, list.id);
  }
  await trx('favorite_lists')
    .where({ event_id: survivor.event_id })
    .whereIn('guest_id', [survivor.id, ...sourceGuestIds])
    .update({ guest_id: survivor.id, guest_identifier: survivor.identifier });
}

/**
 * "Forget me" and guest deletion: the lists stay with the anonymised
 * favourites in them, detached from the person the way the favourites are
 * (feedbackService.anonymizeGuestFeedback keeps the rows, clears guest_id).
 */
async function anonymizeGuest(guestId, executor = db) {
  if (!(await executor.schema.hasTable('favorite_lists'))) return;
  await executor('favorite_lists').where({ guest_id: guestId }).update({ guest_id: null });
}

/**
 * Every list of a gallery by id, for the admin exports and the guest detail.
 */
async function namesForEvent(eventId, executor = db) {
  if (!(await executor.schema.hasTable('favorite_lists'))) return new Map();
  const rows = await executor('favorite_lists').where({ event_id: eventId }).select('id', 'name');
  return new Map(rows.map((row) => [Number(row.id), row.name]));
}

/** The export label of a favourite's list. */
function exportName(names, listId) {
  if (listId === null || listId === undefined) return DEFAULT_LIST_EXPORT_NAME;
  return names.get(Number(listId)) || DEFAULT_LIST_EXPORT_NAME;
}

module.exports = {
  MAX_LISTS_PER_GUEST,
  NAME_MAX_LENGTH,
  DEFAULT_LIST_EXPORT_NAME,
  normalizeName,
  findOwnList,
  listForViewer,
  create,
  rename,
  remove,
  touch,
  mergeGuests,
  anonymizeGuest,
  namesForEvent,
  exportName,
};
