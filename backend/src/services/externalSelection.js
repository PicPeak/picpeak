/**
 * The curated selection inside an external source (issue 2356).
 *
 * events.selection_path names a folder inside the event's source, relative to
 * it ("gallery" for <source>/gallery). Every photo of the source outside that
 * folder carries photos.selection_hidden: the ordinary link, its QR code and
 * the slideshow show the selection only, while the full link, the client
 * login and the admin see every photo (utils/photoVisibility.js).
 *
 * The flag is written in three places, all through selectionHiddenFor():
 * the importer for each new row, the importer for a row it moves to a new
 * path, and recomputeSelection() after a pass and after a selection change.
 * Photos without a source path (uploads into the gallery) are always in the
 * selection.
 */

const path = require('path');
const fs = require('fs').promises;
const { db } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const { normalizeSourcePath, storedBinding, ExternalMediaAccessError } = require('./externalMediaAccess');

/**
 * The selection folder as a prefix of photos.external_relpath (which is
 * relative to EXTERNAL_MEDIA_ROOT), with a trailing slash; null when the
 * event has no source or no selection.
 */
function selectionPrefix(event) {
  const source = storedBinding(event);
  if (source === null || !event?.selection_path) return null;
  let selection;
  try {
    selection = normalizeSourcePath(event.selection_path);
  } catch (_) {
    return null;
  }
  if (!selection) return null;
  return `${source}/${selection}/`;
}

/** Is a photo at this root-relative path outside the selection? */
function selectionHiddenFor(prefix, relpath) {
  if (!prefix || !relpath) return false;
  return !String(relpath).split(path.sep).join('/').startsWith(prefix);
}

/**
 * Rewrite selection_hidden for every photo of the event from its path and the
 * event's current selection. Returns how many rows changed.
 *
 * The prefix is compared with substr(), not LIKE: SQLite's LIKE ignores ASCII
 * case, so "shoot/Gallery/" would count as inside "shoot/gallery/" here while
 * the importer (selectionHiddenFor, a case-sensitive startsWith) hides it.
 * substr() counts characters on both engines, as [...prefix] does.
 */
async function recomputeSelection(eventId, conn = db, { selectionPath } = {}) {
  // One transaction, the event row locked on PostgreSQL (SQLite runs one
  // writer at a time): a pass computed for an older selection cannot finish
  // after a newer one and leave its flags behind. With selectionPath the
  // selection is saved in the same transaction.
  if (!conn.isTransaction) {
    const changed = await conn.transaction((trx) => recomputeSelection(eventId, trx, { selectionPath }));
    // A prebuilt "download all" archive holds what the ordinary link showed
    // when it was built; once the flags move it is stale. invalidate() also
    // drops a build still running.
    if (changed > 0) require('./downloadZipService').invalidate(eventId);
    return changed;
  }
  const lock = conn('events').where({ id: eventId });
  if (conn.client.config.client === 'pg') lock.forUpdate();
  if (!(await lock.first('id'))) return 0;
  if (selectionPath !== undefined) {
    await conn('events').where({ id: eventId }).update({ selection_path: selectionPath });
  }
  const event = await conn('events').where({ id: eventId })
    .first('id', 'source_mode', 'external_path', 'selection_path');
  const prefix = selectionPrefix(event);
  const photos = () => conn('photos').where({ event_id: eventId });
  if (!prefix) {
    return photos().where('selection_hidden', formatBoolean(true))
      .update({ selection_hidden: formatBoolean(false) });
  }
  const startsWithPrefix = ['substr(external_relpath, 1, ?) = ?', [[...prefix].length, prefix]];
  let changed = await photos().where('selection_hidden', formatBoolean(true))
    .where((q) => q.whereNull('external_relpath').orWhereRaw(...startsWithPrefix))
    .update({ selection_hidden: formatBoolean(false) });
  changed += await photos().where('selection_hidden', formatBoolean(false))
    .whereNotNull('external_relpath')
    .whereNot((q) => q.whereRaw(...startsWithPrefix))
    .update({ selection_hidden: formatBoolean(true) });
  return changed;
}

/**
 * Check a selection folder an admin entered: a folder inside the event's
 * source that exists on the mount. Returns the normalised value, or null to
 * clear the selection.
 */
async function validateSelectionPath(event, value) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const source = storedBinding(event);
  if (source === null) {
    throw new ExternalMediaAccessError('A selection folder needs an external photo source', 400);
  }
  const selection = normalizeSourcePath(value);
  if (!selection) throw new ExternalMediaAccessError('Invalid selection folder', 400);
  const { getExternalMediaRoot } = require('./externalMediaService');
  const root = getExternalMediaRoot();
  const target = path.join(root, source, selection);
  const real = await fs.realpath(target).catch(() => null);
  const realRoot = await fs.realpath(root).catch(() => root);
  const stat = real ? await fs.stat(real).catch(() => null) : null;
  if (!stat || !stat.isDirectory() || !(real === realRoot || real.startsWith(realRoot + path.sep))) {
    throw new ExternalMediaAccessError('The selection folder does not exist in the photo source', 400);
  }
  return selection;
}

module.exports = { selectionPrefix, selectionHiddenFor, recomputeSelection, validateSelectionPath };
