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

/** The category a photo is shown in: its folder, else its filter category, else the root. */
function groupOf(row) {
  if (row.folder_id) return `f${row.folder_id}`;
  if (row.category_id) return `c${row.category_id}`;
  return 'root';
}

/**
 * The highlighted photo ids among `rows` ({ id, folder_id, category_id,
 * highlight_pin, rating }). Pure, so the tests can run it without a database.
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
 * gallery's mode is off and for the slideshow, which draws no tiles.
 */
async function highlightIdsForEvent(event, { accessLevel, fullView = false } = {}) {
  const settings = highlightSettingsOf(event);
  if (settings.mode === 'off' || accessLevel === 'slideshow') return new Set();

  let query = wherePhotoProcessed(livePhotos(db).where('photos.event_id', event.id));
  query = applyPhotoVisibilityFilter(query, { accessLevel, fullView });
  const columns = ['photos.id', 'photos.folder_id', 'photos.category_id', 'photos.highlight_pin'];
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
  pinOf,
  selectHighlights,
};
