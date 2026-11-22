/**
 * Multilingual gallery texts (issue 2550).
 *
 * The existing columns stay the default-language text. content_translations
 * (migration 373) holds the hand-written texts for other languages, keyed by
 * gallery, so a shared global category can carry its own translated name in
 * every gallery. Texts are plain text all the way through, as the columns they
 * translate: trimmed, stripped of control characters, capped like the
 * original field, and rendered as text nodes by the gallery.
 */
const { db } = require('../database/db');
const { hasColumnCached } = require('../utils/schemaCache');
const { parseBooleanInput } = require('../utils/parsers');

/** The UI locales; a gallery text can only be in one the visitor can choose. */
const TEXT_LANGUAGES = ['en', 'de', 'es', 'fr', 'nl', 'pt', 'ru', 'sl'];
const TEXT_LANGUAGE_MODES = ['off', 'visitor', 'bilingual'];

/**
 * Translatable fields per entity and their caps, the same as the original
 * fields: events.event_name (create validation, 255), photo_categories.name
 * (100), the chapter texts (migration 369). welcome_message is a TEXT column
 * with no cap of its own; 10 000 characters bounds a row.
 */
const TRANSLATABLE_FIELDS = {
  event: { event_name: 255, welcome_message: 10000 },
  category: { name: 100 },
  chapter: { heading: 100, subheading: 200, location: 120 },
};

/** Fields whose text keeps its line breaks (rendered with pre-line). */
const MULTILINE_FIELDS = new Set(['event:welcome_message']);

const MAX_ITEMS_PER_SAVE = 500;

const translationsReady = () => hasColumnCached('content_translations', 'text');

class TranslationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** The gallery's mode and languages; anything unknown reads as off / null. */
function languageSettingsOf(event) {
  const mode = event && TEXT_LANGUAGE_MODES.includes(event.text_language_mode) ? event.text_language_mode : 'off';
  const lang = (value) => (TEXT_LANGUAGES.includes(value) ? value : null);
  return {
    text_language_mode: mode,
    text_primary_language: lang(event && event.text_primary_language),
    text_secondary_language: lang(event && event.text_secondary_language),
  };
}

/** One text as stored: NFC, trimmed, no control characters, capped; null when empty. */
function cleanTranslation(entityType, field, value) {
  if (value === null || value === undefined) return null;
  const max = TRANSLATABLE_FIELDS[entityType][field];
  const multiline = MULTILINE_FIELDS.has(`${entityType}:${field}`);
  let text = String(value).normalize('NFC');
  // eslint-disable-next-line no-control-regex
  text = multiline ? text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    : text.replace(/[\u0000-\u001f\u007f]+/g, ' ');
  text = text.trim();
  return text === '' ? null : text.slice(0, max);
}

/**
 * Validates one requested change. Throws TranslationError naming the first
 * problem. Returns the normalised item; text null means "remove".
 */
function validateItem(item, index) {
  const where = `items[${index}]`;
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TranslationError(`${where} must be an object`);
  const { entity_type: entityType, field, language } = item;
  const fields = Object.prototype.hasOwnProperty.call(TRANSLATABLE_FIELDS, entityType) ? TRANSLATABLE_FIELDS[entityType] : null;
  if (!fields) throw new TranslationError(`${where}.entity_type must be one of ${Object.keys(TRANSLATABLE_FIELDS).join(', ')}`);
  if (!Object.prototype.hasOwnProperty.call(fields, field)) {
    throw new TranslationError(`${where}.field must be one of ${Object.keys(fields).join(', ')} for ${entityType}`);
  }
  if (!TEXT_LANGUAGES.includes(language)) throw new TranslationError(`${where}.language must be one of ${TEXT_LANGUAGES.join(', ')}`);
  const entityId = Number(item.entity_id);
  if (!Number.isSafeInteger(entityId) || entityId < 1) throw new TranslationError(`${where}.entity_id must be a positive integer`);
  if (item.text !== null && item.text !== undefined && typeof item.text !== 'string') {
    throw new TranslationError(`${where}.text must be text or null`);
  }
  if (typeof item.text === 'string' && item.text.trim().length > fields[field]) {
    throw new TranslationError(`${where}.text must be at most ${fields[field]} characters`);
  }
  return { entity_type: entityType, entity_id: entityId, field, language, text: cleanTranslation(entityType, field, item.text) };
}

/** Category ids among `ids` that this event may translate: its own and the shared globals. */
async function categoriesOfEvent(eventId, ids, conn = db) {
  if (ids.length === 0) return new Set();
  const rows = await conn('photo_categories').whereIn('id', ids).select('id', 'event_id', 'is_global');
  return new Set(rows
    .filter((row) => parseBooleanInput(row.is_global, false) || Number(row.event_id) === Number(eventId))
    .map((row) => Number(row.id)));
}

/**
 * Writes a batch of translations for one event in one transaction: a text
 * upserts the row, an empty one removes it. Every item names an entity of
 * this event (the event itself, or a category it may use); anything else is
 * refused before anything is written.
 */
async function saveTranslations(eventId, rawItems) {
  if (!(await translationsReady())) throw new TranslationError('Translations are not available until the database is migrated', 503);
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw new TranslationError('items must be a non-empty array');
  if (rawItems.length > MAX_ITEMS_PER_SAVE) throw new TranslationError(`At most ${MAX_ITEMS_PER_SAVE} items per request`);
  const items = rawItems.map(validateItem);
  const id = Number(eventId);

  for (const [index, item] of items.entries()) {
    if (item.entity_type === 'event' && item.entity_id !== id) {
      throw new TranslationError(`items[${index}].entity_id must be this event`, 404);
    }
  }
  const categoryIds = [...new Set(items.filter((item) => item.entity_type !== 'event').map((item) => item.entity_id))];
  const allowed = await categoriesOfEvent(id, categoryIds);
  for (const [index, item] of items.entries()) {
    if (item.entity_type !== 'event' && !allowed.has(item.entity_id)) {
      throw new TranslationError(`items[${index}]: category not found in this gallery`, 404);
    }
  }

  const now = new Date().toISOString();
  await db.transaction(async (trx) => {
    for (const item of items) {
      const key = {
        event_id: id, entity_type: item.entity_type, entity_id: item.entity_id, field: item.field, language: item.language,
      };
      if (item.text === null) {
        await trx('content_translations').where(key).del();
      } else {
        await trx('content_translations')
          .insert({ ...key, text: item.text, created_at: now, updated_at: now })
          .onConflict(['event_id', 'entity_type', 'entity_id', 'field', 'language'])
          .merge({ text: item.text, updated_at: now });
      }
    }
  });
  return items;
}

/** Every translation row of one event, oldest first. Empty before migration 373. */
async function translationRowsForEvent(eventId, conn = db) {
  if (!(await translationsReady())) return [];
  const rows = await conn('content_translations')
    .where('event_id', Number(eventId))
    .orderBy('id')
    .select('entity_type', 'entity_id', 'field', 'language', 'text');
  return Array.from(rows, (row) => ({ ...row, entity_id: Number(row.entity_id) }));
}

/**
 * The translations of one event grouped for the public gallery:
 *   event:    { event_name: { de: '…' }, welcome_message: { … } }
 *   category: Map(category id → { name: { … } })
 *   chapter:  Map(category id → { heading: { … }, subheading, location })
 * Only fields the entity type allows come through, whatever a row says.
 */
function groupTranslations(rows) {
  const out = { event: {}, category: new Map(), chapter: new Map() };
  for (const row of rows) {
    const fields = TRANSLATABLE_FIELDS[row.entity_type];
    if (!fields || !Object.prototype.hasOwnProperty.call(fields, row.field) || !TEXT_LANGUAGES.includes(row.language)) continue;
    let target;
    if (row.entity_type === 'event') {
      target = out.event;
    } else {
      const map = out[row.entity_type];
      if (!map.has(row.entity_id)) map.set(row.entity_id, {});
      target = map.get(row.entity_id);
    }
    if (!target[row.field]) target[row.field] = {};
    target[row.field][row.language] = row.text;
  }
  return out;
}

/** The grouped translations a public payload carries; null while the gallery's mode is off. */
async function publicTranslationsFor(event) {
  if (languageSettingsOf(event).text_language_mode === 'off') return null;
  return groupTranslations(await translationRowsForEvent(event.id));
}

/**
 * Copies an event's translations onto a duplicate. `mapCategoryId` turns a
 * source category id into the copy's (null when the category stayed behind,
 * in which case its texts stay behind too). `skip` names 'entity_type:field'
 * pairs that stay behind.
 */
async function copyTranslations(sourceEventId, targetEventId, mapCategoryId, { skip = [] } = {}) {
  const rows = (await translationRowsForEvent(sourceEventId))
    .filter((row) => !skip.includes(`${row.entity_type}:${row.field}`));
  const now = new Date().toISOString();
  for (const row of rows) {
    let entityId = row.entity_id;
    if (row.entity_type === 'event') {
      if (entityId !== Number(sourceEventId)) continue;
      entityId = Number(targetEventId);
    } else {
      entityId = await mapCategoryId(entityId);
      if (entityId === null || entityId === undefined) continue;
    }
    await db('content_translations').insert({
      event_id: Number(targetEventId), entity_type: row.entity_type, entity_id: Number(entityId),
      field: row.field, language: row.language, text: row.text, created_at: now, updated_at: now,
    }).onConflict(['event_id', 'entity_type', 'entity_id', 'field', 'language']).ignore();
  }
}

/** Removes the texts of a deleted category in every gallery (SQLite leaves cascades inert). */
async function deleteCategoryTranslations(conn, categoryId) {
  if (!(await conn.schema.hasTable('content_translations'))) return;
  await conn('content_translations').whereIn('entity_type', ['category', 'chapter']).where('entity_id', Number(categoryId)).del();
}

module.exports = {
  TEXT_LANGUAGES,
  TEXT_LANGUAGE_MODES,
  TRANSLATABLE_FIELDS,
  MAX_ITEMS_PER_SAVE,
  TranslationError,
  languageSettingsOf,
  cleanTranslation,
  saveTranslations,
  translationRowsForEvent,
  groupTranslations,
  publicTranslationsFor,
  copyTranslations,
  deleteCategoryTranslations,
};
