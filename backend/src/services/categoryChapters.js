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
const { livePhotos } = require('../utils/photoVisibility');

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

/** A stored captured_at as a Date: pg gives a Date, SQLite ms (number or digit string) or ISO text. */
function storedDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(/^\d+$/.test(String(value)) ? Number(value) : value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 'HH:MM' of a stored captured_at: the camera clock as read in the server's zone (issue 2305). */
function wallTimeOf(value) {
  const date = storedDate(value);
  if (!date) return null;
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * Suggested chapter time per category: the earliest captured_at among the
 * event's live photos filed in it. Map category id -> 'HH:MM'.
 */
async function suggestedChapterTimes(eventId) {
  const rows = await livePhotos(db)
    .where('event_id', Number(eventId))
    .whereNotNull('category_id')
    .whereNotNull('captured_at')
    .groupBy('category_id')
    .select('category_id as id')
    .min('captured_at as first');
  const times = new Map();
  for (const row of rows) {
    const time = wallTimeOf(row.first);
    if (time) times.set(Number(row.id), time);
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
