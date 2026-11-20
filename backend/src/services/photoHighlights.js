/**
 * Highlights (issue 2549): which photos the gallery layouts draw as a larger
 * tile. Only the tile size follows from this; the photo order never does.
 *
 * Per gallery (migration 370):
 *  - mode 'off' (default): no highlights, every layout renders as before.
 *  - mode 'manual': the photos the photographer pinned (photos.highlight_pin).
 *  - mode 'rating': the pins, plus photos whose admin star rating
 *    (photo_admin_marks.rating, the highest any admin gave) reaches the
 *    gallery's threshold.
 *
 * A pin always wins: pinned on is a highlight, pinned off never is, in either
 * mode. Pins are not capped, because the photographer chose each one. The
 * automatic picks are: at most one in eight photos per category, counting
 * the pins of that category against the same budget. Within the budget the
 * highest rating goes first, then the photo uploaded first (lowest id), so
 * the result does not depend on the viewer's sort, filter or page.
 *
 * Computed when the photo list is served, over every photo the viewer may
 * see (not just the page), so it only changes when the photographer changes
 * a pin, a rating or the photos themselves; it never moves while a guest
 * scrolls. Guests only ever receive the resulting boolean.
 */

const { db } = require('../database/db');
const { applyPhotoVisibilityFilter, livePhotos, wherePhotoProcessed } = require('../utils/photoVisibility');

const HIGHLIGHT_MODES = ['off', 'manual', 'rating'];
const DEFAULT_THRESHOLD = 4;
/** At most one automatic highlight per this many photos of a category. */
const PHOTOS_PER_HIGHLIGHT = 8;

/**
 * The computed set per gallery and viewer kind, so paging through a large
 * gallery does not rescan (and in 'rating' mode re-aggregate) every photo on
 * each page request. Keyed by event id + mode + threshold + the visibility
 * inputs; the entry holds the promise, so concurrent page requests share one
 * query. Cleared for the event when a pin, an admin rating or the gallery's
 * highlight settings change on this process. Another replica keeps its entry
 * until the TTL runs out, so a change there shows up within the TTL: fine
 * for a tile size. Uploads, deletes and visibility changes ride the TTL too.
 */
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 1000;
const highlightCache = new Map();

function cacheKey(eventId, { mode, threshold }, accessLevel, fullView) {
  return `${eventId}:${mode}:${threshold}:${accessLevel || ''}:${fullView ? 1 : 0}`;
}

/** Drop every cached highlight set of this event (all modes and viewers). */
function invalidateHighlightCache(eventId) {
  const prefix = `${Number(eventId)}:`;
  for (const key of highlightCache.keys()) {
    if (key.startsWith(prefix)) highlightCache.delete(key);
  }
}

function pruneHighlightCache(now) {
  for (const [key, entry] of highlightCache) {
    if (entry.expiresAt <= now) highlightCache.delete(key);
  }
  // Still full of live entries: drop the oldest (Map keeps insertion order).
  while (highlightCache.size >= CACHE_MAX_ENTRIES) {
    highlightCache.delete(highlightCache.keys().next().value);
  }
}

function highlightSettingsOf(event) {
  const mode = HIGHLIGHT_MODES.includes(event?.highlights_mode) ? event.highlights_mode : 'off';
  const raw = Number(event?.highlights_threshold);
  const threshold = Number.isInteger(raw) && raw >= 1 && raw <= 5 ? raw : DEFAULT_THRESHOLD;
  return { mode, threshold };
}

/** A stored pin as true, false or null (SQLite stores 0/1). */
function pinOf(value) {
  if (value === null || value === undefined) return null;
  return value === true || value === 1 || value === '1' || value === 'true';
}

/**
 * The category a photo is shown in: its folder, else its filter category, else
 * the root. A row from before migration 265 (or restored from an older backup)
 * can carry its folder in category_id; the gallery shows it in that folder
 * (galleryQueryService's legacyFolderId), so it counts against that folder.
 */
function groupOf(row) {
  if (row.folder_id) return `f${row.folder_id}`;
  if (row.category_id && pinOf(row.category_is_folder) === true) return `f${row.category_id}`;
  if (row.category_id) return `c${row.category_id}`;
  return 'root';
}

/**
 * The highlighted photo ids among `rows` ({ id, folder_id, category_id,
 * category_is_folder, highlight_pin, rating }). Pure, so the tests can run it
 * without a database.
 */
function selectHighlights(rows, { mode, threshold }) {
  const ids = new Set();
  if (mode !== 'manual' && mode !== 'rating') return ids;

  const groups = new Map();
  for (const row of rows) {
    const key = groupOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  for (const members of groups.values()) {
    let pinned = 0;
    for (const row of members) {
      if (pinOf(row.highlight_pin) === true) {
        ids.add(Number(row.id));
        pinned += 1;
      }
    }
    if (mode !== 'rating') continue;

    const budget = Math.floor(members.length / PHOTOS_PER_HIGHLIGHT) - pinned;
    if (budget <= 0) continue;
    members
      .filter((row) => pinOf(row.highlight_pin) === null && Number(row.rating) >= threshold)
      .sort((a, b) => Number(b.rating) - Number(a.rating) || Number(a.id) - Number(b.id))
      .slice(0, budget)
      .forEach((row) => ids.add(Number(row.id)));
  }
  return ids;
}

/**
 * The highlighted photo ids of a gallery for one viewer. Empty while the
 * gallery's mode is off and for the slideshow, which draws no tiles. Served
 * from the cache above when fresh; the returned Set is shared, read it only.
 */
async function highlightIdsForEvent(event, { accessLevel, fullView = false } = {}) {
  const settings = highlightSettingsOf(event);
  if (settings.mode === 'off' || accessLevel === 'slideshow') return new Set();

  const key = cacheKey(Number(event.id), settings, accessLevel, fullView);
  const now = Date.now();
  const cached = highlightCache.get(key);
  if (cached && cached.expiresAt > now) return cached.promise;

  if (highlightCache.size >= CACHE_MAX_ENTRIES) pruneHighlightCache(now);
  const promise = computeHighlightIds(event, settings, { accessLevel, fullView });
  const entry = { promise, expiresAt: now + CACHE_TTL_MS };
  highlightCache.set(key, entry);
  // A failed lookup is not cached; the next request tries again.
  promise.catch(() => {
    if (highlightCache.get(key) === entry) highlightCache.delete(key);
  });
  return promise;
}

async function computeHighlightIds(event, settings, { accessLevel, fullView }) {
  let query = wherePhotoProcessed(livePhotos(db).where('photos.event_id', event.id));
  query = applyPhotoVisibilityFilter(query, { accessLevel, fullView });
  // Whether category_id names a folder: a legacy row's folder (see groupOf).
  query = query.leftJoin('photo_categories as highlight_category', 'highlight_category.id', 'photos.category_id');
  const columns = [
    'photos.id', 'photos.folder_id', 'photos.category_id', 'photos.highlight_pin',
    'highlight_category.is_folder as category_is_folder',
  ];
  if (settings.mode === 'rating') {
    // MAX over admins: PG answers it as a string for some drivers, hence
    // Number() in selectHighlights.
    const ratings = db('photo_admin_marks')
      .where('event_id', event.id)
      .whereNotNull('rating')
      .groupBy('photo_id')
      .select('photo_id')
      .max('rating as rating')
      .as('highlight_ratings');
    query = query.leftJoin(ratings, 'highlight_ratings.photo_id', 'photos.id');
    columns.push('highlight_ratings.rating');
  }
  const rows = await query.select(columns);
  return selectHighlights(Array.from(rows), settings);
}

module.exports = {
  HIGHLIGHT_MODES,
  DEFAULT_THRESHOLD,
  PHOTOS_PER_HIGHLIGHT,
  highlightSettingsOf,
  highlightIdsForEvent,
  invalidateHighlightCache,
  pinOf,
  selectHighlights,
};
