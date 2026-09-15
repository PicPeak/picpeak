'use strict';

/**
 * Contract content (#1445): the per-locale texts a clause carries.
 *
 * Every text a template or contract stores itself (a block override, a
 * free-text section, the intro and outro) is a JSON locale map
 * `{ en, de, ru, pt, nl, fr }`. Library blocks keep their per-locale
 * columns; these helpers turn both into the same shape and pick the text
 * for a document's language (that locale, then English, then German — the
 * fallback the renderer always used).
 */

const { AppError } = require('../../utils/errors');

const LOCALES = ['en', 'de', 'ru', 'pt', 'nl', 'fr'];
const BLOCK_BODY_COLUMNS = {
  en: 'body_text', de: 'body_text_de', ru: 'body_text_ru', pt: 'body_text_pt', nl: 'body_text_nl', fr: 'body_text_fr',
};
const INCLUSION_SNAPSHOT_COLUMNS = {
  en: 'body_text_snapshot',
  de: 'body_text_de_snapshot',
  ru: 'body_text_ru_snapshot',
  pt: 'body_text_pt_snapshot',
  nl: 'body_text_nl_snapshot',
  fr: 'body_text_fr_snapshot',
};
const MAX_TEXT = 20000;

/** A locale map from stored JSON text or an object; empty values dropped. */
function parseLocaleMap(value) {
  if (value == null || value === '') return {};
  let src = value;
  if (typeof value === 'string') {
    try { src = JSON.parse(value); } catch (_) { return {}; }
  }
  if (!src || typeof src !== 'object' || Array.isArray(src)) return {};
  const out = {};
  for (const locale of LOCALES) {
    if (typeof src[locale] === 'string' && src[locale].trim()) out[locale] = src[locale];
  }
  return out;
}

/** Validate a locale map sent by an admin. Returns the clean map (possibly empty). */
function sanitizeLocaleMap(value, field) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(`${field} must be an object of texts by language`, 400, 'CONTRACT_TEXT_INVALID');
  }
  const out = {};
  for (const [locale, text] of Object.entries(value)) {
    if (!LOCALES.includes(locale)) {
      throw new AppError(`${field}: unknown language "${locale}"`, 400, 'CONTRACT_TEXT_INVALID');
    }
    if (text == null || text === '') continue;
    if (typeof text !== 'string') throw new AppError(`${field} must be text`, 400, 'CONTRACT_TEXT_INVALID');
    if (text.length > MAX_TEXT) {
      throw new AppError(`${field} is limited to ${MAX_TEXT} characters per language`, 400, 'CONTRACT_TEXT_INVALID');
    }
    if (text.trim()) out[locale] = text;
  }
  return out;
}

/** Stored JSON for a locale map, or null when it's empty. */
function serializeLocaleMap(map) {
  const clean = parseLocaleMap(map);
  return Object.keys(clean).length ? JSON.stringify(clean) : null;
}

/** A library block's bodies as a locale map. `prefix` reads joined columns (e.g. "block_"). */
function blockBodies(row, prefix = '') {
  const out = {};
  for (const locale of LOCALES) {
    const text = row[`${prefix}${BLOCK_BODY_COLUMNS[locale]}`];
    if (typeof text === 'string' && text.trim()) out[locale] = text;
  }
  return out;
}

/** An inclusion row's frozen bodies as a locale map. */
function inclusionSnapshot(row) {
  const out = {};
  for (const locale of LOCALES) {
    const text = row[INCLUSION_SNAPSHOT_COLUMNS[locale]];
    if (typeof text === 'string' && text.trim()) out[locale] = text;
  }
  return out;
}

/** Inclusion columns that freeze a locale map. */
function snapshotColumns(map) {
  const out = {};
  for (const locale of LOCALES) out[INCLUSION_SNAPSHOT_COLUMNS[locale]] = (map && map[locale]) || null;
  return out;
}

/** Overlay an override on a base map, locale by locale. */
function mergeLocaleMaps(base, override) {
  return { ...parseLocaleMap(base), ...parseLocaleMap(override) };
}

/** The text for a language: that locale, then English, then German. */
function pickLocale(map, locale) {
  const clean = parseLocaleMap(map);
  return clean[locale] || clean.en || clean.de || '';
}

module.exports = {
  LOCALES,
  BLOCK_BODY_COLUMNS,
  INCLUSION_SNAPSHOT_COLUMNS,
  parseLocaleMap,
  sanitizeLocaleMap,
  serializeLocaleMap,
  blockBodies,
  inclusionSnapshot,
  snapshotColumns,
  mergeLocaleMaps,
  pickLocale,
};
