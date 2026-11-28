/**
 * Chapter markers for categories (issue 2548).
 *
 * A marker belongs to one gallery: rows in event_category_chapters are keyed
 * by (event, category), so a shared global category can carry a different
 * time and place in every event (migration 369). Markers are plain text all
 * the way through: inputs are trimmed, stripped of control characters and
 * capped here, and the gallery renders them as text nodes.
 */
const { db } = require('../database/db');
const { hasColumnCached } = require('../utils/schemaCache');
const { livePhotos, wherePhotoProcessed, applyPhotoVisibilityFilter } = require('../utils/photoVisibility');
const { captureDateOrderSql } = require('../utils/captureDateSql');
const { photoWallClock } = require('../utils/dateNormalize');

const CHAPTER_STYLES = ['off', 'divider', 'hero'];

/** Text fields and their column caps (migration 369). */
const CHAPTER_TEXT_LIMITS = {
  chapter_heading: 100,
  chapter_subheading: 200,
  chapter_location: 120,
};
const CHAPTER_FIELDS = [...Object.keys(CHAPTER_TEXT_LIMITS), 'chapter_time'];
const CHAPTER_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const chaptersReady = () => hasColumnCached('event_category_chapters', 'chapter_heading');

/** A style the gallery knows; anything else (or a missing column) is 'off'. */
function chapterStyleOf(event) {
  const style = event && event.chapter_marker_style;
  return CHAPTER_STYLES.includes(style) ? style : 'off';
}

/** One text value as stored: trimmed, no control characters, capped; null when empty. */
function cleanText(value, max) {
  if (value === null || value === undefined) return null;
  // eslint-disable-next-line no-control-regex
  const text = String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
  return text === '' ? null : text;
}

/** The row values for a request body; only the fields it names. */
function chapterUpdateFrom(body) {
  const out = {};
  for (const [field, max] of Object.entries(CHAPTER_TEXT_LIMITS)) {
    if (Object.prototype.hasOwnProperty.call(body, field)) out[field] = cleanText(body[field], max);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'chapter_time')) {
    const time = cleanText(body.chapter_time, 5);
    out.chapter_time = time && CHAPTER_TIME_PATTERN.test(time) ? time : null;
  }
  return out;
}

/** The four fields of a row, nulls for a category without a marker. */
function chapterFieldsOf(row) {
  const out = {};
  for (const field of CHAPTER_FIELDS) out[field] = (row && row[field]) || null;
  return out;
}

/** Map of category id → chapter row for one event. Empty before migration 369. */
async function chapterRowsForEvent(eventId, conn = db) {
  if (!(await chaptersReady())) return new Map();
  const rows = await conn('event_category_chapters')
    .where('event_id', Number(eventId))
    .select('category_id', ...CHAPTER_FIELDS);
  return new Map(rows.map((row) => [Number(row.category_id), row]));
}

/**
 * 'HH:MM' of a photo's capture, on the wall clock the admin photo list shows
 * (photoWallClock): the camera's own where it was read, else, for photos read
 * before that column, the stored instant in the server's zone.
 */
function wallTimeOf(photo) {
  const wall = photoWallClock(photo);
  return wall ? wall.slice(11, 16) : null;
}

/**
 * Suggested chapter time per category: the time of the earliest capture
 * among the event's photos filed in it that an ordinary guest sees (processed,
 * visible, published, in the selection): the marker is public, so it must not
 * carry the time of a photo the gallery does not show. Map category id -> 'HH:MM'.
 * Earliest by the normalised capture date: on SQLite captured_at holds epoch
 * ms integers and ISO text side by side, and a plain MIN puts every integer
 * before every text value (captureDateSql.js).
 */
async function suggestedChapterTimes(eventId) {
  const visible = applyPhotoVisibilityFilter(wherePhotoProcessed(livePhotos(db)), 'guest');
  const ranked = visible
    .where('event_id', Number(eventId))
    .whereNotNull('category_id')
    .whereNotNull('captured_at')
    .select(
      'category_id', 'captured_at', 'captured_at_wall',
      db.raw(`ROW_NUMBER() OVER (PARTITION BY category_id ORDER BY ${captureDateOrderSql(db.client.config.client)}, id) as rn`)
    )
    .as('ranked');
  const rows = await db.from(ranked).where('rn', 1).select('category_id', 'captured_at', 'captured_at_wall');
  const times = new Map();
  for (const row of rows) {
    const time = wallTimeOf(row);
    if (time) times.set(Number(row.category_id), time);
  }
  return times;
}

/**
 * The marker the public gallery gets for one category, or undefined when the
 * category shows none (style off, or the guest-upload category: guest uploads
 * are not part of the storyline). Text only; the heading falls back to the
 * category name in the client.
 */
function publicChapterOf(category, row, event) {
  if (chapterStyleOf(event) === 'off') return undefined;
  if (event.upload_category_id != null && Number(event.upload_category_id) === Number(category.id)) return undefined;
  return {
    heading: (row && row.chapter_heading) || null,
    subheading: (row && row.chapter_subheading) || null,
    time: (row && row.chapter_time) || null,
    location: (row && row.chapter_location) || null,
  };
}

module.exports = {
  CHAPTER_STYLES,
  CHAPTER_TEXT_LIMITS,
  CHAPTER_FIELDS,
  CHAPTER_TIME_PATTERN,
  chapterStyleOf,
  chapterUpdateFrom,
  chapterFieldsOf,
  chapterRowsForEvent,
  suggestedChapterTimes,
  publicChapterOf,
  wallTimeOf,
};
