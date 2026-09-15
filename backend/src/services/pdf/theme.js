'use strict';

/**
 * PDF theme (#1445, PDF pass 2): the look quote, invoice and contract PDFs
 * share, and the tax report uses too.
 *
 * A document type's theme is resolved key by key from, in order:
 *   1. its own row in pdf_themes (`quote`, `invoice` or `contract`);
 *   2. the `default` row;
 *   3. the business profile's existing PDF settings (font family, folding
 *      marks), which keep working and stay editable where they were;
 *   4. the built-in values below — exactly what the renderer drew before
 *      themes existed, so an install that never edits the theme keeps its
 *      look.
 *
 * Settings are a small validated vocabulary: hex colours, a title size, a
 * footer mode, a page-number position, folding marks and a bundled font
 * family. No free CSS, no URLs, no file paths.
 */

const { AppError } = require('../../utils/errors');

const SCOPES = ['default', 'quote', 'invoice', 'contract'];
const COLOR_KEYS = ['text', 'muted', 'subtle', 'accent', 'rule'];
const FOOTER_MODES = ['address', 'custom', 'none'];
const PAGE_NUMBER_POSITIONS = ['bottom-right', 'bottom-center', 'none'];
const FOLDING_MARKS = ['none', 'half', 'third', 'both'];
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const FONT_FAMILY = /^[A-Za-z0-9_-]{1,64}$/;
const FOOTER_TEXT_MAX = 200;
const TITLE_SIZE = { min: 12, max: 32 };

// What every document drew before themes existed.
const BUILT_IN = Object.freeze({
  colors: Object.freeze({
    text: '#000000', // body text
    muted: '#666666', // reference lines under the title
    subtle: '#888888', // footer, page numbers
    accent: '#000000', // title and section headings
    rule: '#888888', // separator lines, folding marks
  }),
  titleSize: 20,
  footer: Object.freeze({ mode: 'address', text: '' }),
  pageNumbers: 'bottom-right',
});

// Where a document type differed from the above.
const BUILT_IN_BY_SCOPE = Object.freeze({
  default: Object.freeze({}),
  quote: Object.freeze({}),
  invoice: Object.freeze({}),
  // Contracts had an 18pt title and no footer or folding marks.
  contract: Object.freeze({ titleSize: 18, footer: Object.freeze({ mode: 'none', text: '' }), foldingMarks: 'none' }),
});

function invalid(message) {
  return new AppError(message, 400, 'PDF_THEME_INVALID');
}

/** A stored settings value (JSON text on both engines) as an object. */
function parseSettings(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

/**
 * Validate and normalise settings sent by the admin. Unknown keys are
 * dropped; an empty value clears that key (falls back to the next level).
 * `availableFamilies` is the list of bundled font families.
 */
function sanitizeThemeSettings(input, { availableFamilies = [] } = {}) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = {};

  if (src.colors && typeof src.colors === 'object') {
    const colors = {};
    for (const key of COLOR_KEYS) {
      const value = src.colors[key];
      if (value == null || value === '') continue;
      if (!HEX_COLOR.test(String(value))) throw invalid(`Colour "${key}" must be a #rrggbb value`);
      colors[key] = String(value).toLowerCase();
    }
    if (Object.keys(colors).length) out.colors = colors;
  }

  if (src.titleSize != null && src.titleSize !== '') {
    const size = Number(src.titleSize);
    if (!Number.isFinite(size) || size < TITLE_SIZE.min || size > TITLE_SIZE.max) {
      throw invalid(`The title size must be between ${TITLE_SIZE.min} and ${TITLE_SIZE.max} pt`);
    }
    out.titleSize = Math.round(size);
  }

  if (src.footer && typeof src.footer === 'object' && src.footer.mode != null && src.footer.mode !== '') {
    if (!FOOTER_MODES.includes(src.footer.mode)) throw invalid('Unknown footer mode');
    // One line: the footer is drawn without wrapping.
    const text = String(src.footer.text == null ? '' : src.footer.text).replace(/\s+/g, ' ').trim();
    if (text.length > FOOTER_TEXT_MAX) throw invalid(`The footer text is limited to ${FOOTER_TEXT_MAX} characters`);
    if (src.footer.mode === 'custom' && !text) throw invalid('A custom footer needs text');
    out.footer = { mode: src.footer.mode, text: src.footer.mode === 'custom' ? text : '' };
  }

  if (src.pageNumbers != null && src.pageNumbers !== '') {
    if (!PAGE_NUMBER_POSITIONS.includes(src.pageNumbers)) throw invalid('Unknown page-number position');
    out.pageNumbers = src.pageNumbers;
  }

  if (src.foldingMarks != null && src.foldingMarks !== '') {
    if (!FOLDING_MARKS.includes(src.foldingMarks)) throw invalid('Unknown folding-mark setting');
    out.foldingMarks = src.foldingMarks;
  }

  if (src.fontFamily != null && src.fontFamily !== '') {
    const family = String(src.fontFamily);
    if (!FONT_FAMILY.test(family) || !availableFamilies.includes(family)) {
      throw invalid('Pick one of the bundled font families');
    }
    out.fontFamily = family;
  }

  return out;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/**
 * The resolved theme for a scope. `rows` maps scope → parsed settings;
 * `profile` is the business_profile row (for its font family and folding
 * marks). Returns a frozen object.
 */
function resolveTheme(scope, rows = {}, profile = null) {
  const own = rows[scope] || {};
  const base = rows.default || {};
  const builtIn = BUILT_IN_BY_SCOPE[scope] || {};
  const first = (...values) => values.find((v) => v !== undefined && v !== null);
  return deepFreeze({
    scope,
    fontFamily: first(own.fontFamily, base.fontFamily, profile && profile.pdf_font_family) || null,
    colors: { ...BUILT_IN.colors, ...(base.colors || {}), ...(own.colors || {}) },
    titleSize: first(own.titleSize, base.titleSize, builtIn.titleSize, BUILT_IN.titleSize),
    footer: { ...first(own.footer, base.footer, builtIn.footer, BUILT_IN.footer) },
    pageNumbers: first(own.pageNumbers, base.pageNumbers, BUILT_IN.pageNumbers),
    foldingMarks: first(own.foldingMarks, base.foldingMarks, builtIn.foldingMarks,
      profile && profile.pdf_folding_marks, 'none'),
  });
}

/** The theme a renderer uses when its caller passed none — the built-in look. */
function builtInTheme(scope) {
  return resolveTheme(scope, {}, null);
}

module.exports = {
  SCOPES,
  COLOR_KEYS,
  FOOTER_MODES,
  PAGE_NUMBER_POSITIONS,
  FOLDING_MARKS,
  BUILT_IN,
  BUILT_IN_BY_SCOPE,
  parseSettings,
  sanitizeThemeSettings,
  resolveTheme,
  builtInTheme,
};
