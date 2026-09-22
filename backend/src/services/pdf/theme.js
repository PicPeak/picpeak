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
 * family — and the layout (#1445): left/right/bottom margins in mm within
 * bounds that keep a letter fitting a window envelope, the DIN address
 * window on or off, where the logo sits, and the body text size and line
 * height. The top margin is not configurable (the address window and the
 * issuer block set it), and a contract's signature page keeps its fixed
 * geometry whatever the margins are: signatures are stamped at those
 * coordinates. No free CSS, no URLs, no file paths.
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
// Millimetres. 20 mm left is the DIN 5008 binding edge.
const MARGIN_BOUNDS = Object.freeze({ left: [20, 30], right: [10, 25], bottom: [15, 30] });
const LOGO_POSITIONS = ['right', 'left', 'center'];
const LOGO_STACKS = ['above', 'inline'];
const BODY_SIZE = { min: 9, max: 12 };
const LINE_HEIGHT = { min: 1.2, max: 1.6 };

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
  // Null margins: the renderer's 40 pt on every side, as before.
  layout: Object.freeze({ margins: null, addressWindow: true }),
  logo: Object.freeze({ position: 'right', stack: 'above' }),
  bodySize: 10,
  // Null: PDFKit's natural line height, as before.
  lineHeight: null,
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

  if (src.layout && typeof src.layout === 'object') {
    const layout = {};
    if (src.layout.margins && typeof src.layout.margins === 'object') {
      const margins = {};
      for (const [side, [min, max]] of Object.entries(MARGIN_BOUNDS)) {
        const value = src.layout.margins[side];
        if (value == null || value === '') continue;
        const mm = Number(value);
        if (!Number.isFinite(mm) || mm < min || mm > max) {
          throw invalid(`The ${side} margin must be between ${min} and ${max} mm`);
        }
        margins[side] = Math.round(mm * 2) / 2;
      }
      if (Object.keys(margins).length) layout.margins = margins;
    }
    if (src.layout.addressWindow != null && src.layout.addressWindow !== '') {
      if (typeof src.layout.addressWindow !== 'boolean') throw invalid('The address window is on or off');
      layout.addressWindow = src.layout.addressWindow;
    }
    if (Object.keys(layout).length) out.layout = layout;
  }

  if (src.logo && typeof src.logo === 'object') {
    const logo = {};
    if (src.logo.position != null && src.logo.position !== '') {
      if (!LOGO_POSITIONS.includes(src.logo.position)) throw invalid('Unknown logo position');
      logo.position = src.logo.position;
    }
    if (src.logo.stack != null && src.logo.stack !== '') {
      if (!LOGO_STACKS.includes(src.logo.stack)) throw invalid('Unknown logo arrangement');
      logo.stack = src.logo.stack;
    }
    if (Object.keys(logo).length) out.logo = logo;
  }

  if (src.bodySize != null && src.bodySize !== '') {
    const size = Number(src.bodySize);
    if (!Number.isFinite(size) || size < BODY_SIZE.min || size > BODY_SIZE.max) {
      throw invalid(`The body text size must be between ${BODY_SIZE.min} and ${BODY_SIZE.max} pt`);
    }
    out.bodySize = Math.round(size * 2) / 2;
  }

  if (src.lineHeight != null && src.lineHeight !== '') {
    const height = Number(src.lineHeight);
    if (!Number.isFinite(height) || height < LINE_HEIGHT.min || height > LINE_HEIGHT.max) {
      throw invalid(`The line height must be between ${LINE_HEIGHT.min} and ${LINE_HEIGHT.max}`);
    }
    out.lineHeight = Math.round(height * 100) / 100;
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
    // Key by key, like the colours: a scope can set one margin and inherit the rest.
    layout: {
      margins: (() => {
        const margins = { ...((base.layout && base.layout.margins) || {}), ...((own.layout && own.layout.margins) || {}) };
        return Object.keys(margins).length ? margins : null;
      })(),
      addressWindow: first(own.layout && own.layout.addressWindow, base.layout && base.layout.addressWindow,
        BUILT_IN.layout.addressWindow),
    },
    logo: { ...BUILT_IN.logo, ...((base.logo) || {}), ...((own.logo) || {}) },
    bodySize: first(own.bodySize, base.bodySize, BUILT_IN.bodySize),
    lineHeight: first(own.lineHeight, base.lineHeight) ?? null,
  });
}

// ---------------------------------------------------------------------
// Readability warnings — shown, never enforced
// ---------------------------------------------------------------------

const MM_PER_PT = 25.4 / 72;
const PAGE_WIDTH_PT = 595.28;
const DEFAULT_MARGIN_PT = 40;
// Average advance of running text, in em. Helvetica and the bundled
// families sit around 0.5–0.55; the higher figure keeps the default layout
// (40 pt margins, 10 pt text) just inside the limit, as it has always been.
const AVERAGE_GLYPH_EM = 0.55;
const MAX_MEASURE = 95;

function luminance(hex) {
  const channel = (i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG contrast ratio of a colour against white paper. */
function contrastOnWhite(hex) {
  return 1.05 / (luminance(hex) + 0.05);
}

/** The width text runs across, in characters, for a resolved theme. */
function measure(theme) {
  const margins = (theme.layout && theme.layout.margins) || {};
  const left = margins.left != null ? margins.left / MM_PER_PT : DEFAULT_MARGIN_PT;
  const right = margins.right != null ? margins.right / MM_PER_PT : DEFAULT_MARGIN_PT;
  return (PAGE_WIDTH_PT - left - right) / (AVERAGE_GLYPH_EM * (theme.bodySize || 10));
}

/**
 * Readability warnings for a resolved theme: `[{ code, key?, value, limit }]`.
 * Text and muted colours below 4.5:1 against white, the accent below 3:1,
 * body text under 9.5 pt, a line height under 1.3, lines over ~95
 * characters. The theme card shows the same list; saving never refuses.
 */
function themeWarnings(theme) {
  const warnings = [];
  const round = (n) => Math.round(n * 10) / 10;
  for (const key of ['text', 'muted']) {
    const ratio = contrastOnWhite(theme.colors[key]);
    if (ratio < 4.5) warnings.push({ code: 'CONTRAST_LOW', key, value: round(ratio), limit: 4.5 });
  }
  const accent = contrastOnWhite(theme.colors.accent);
  if (accent < 3) warnings.push({ code: 'CONTRAST_LOW', key: 'accent', value: round(accent), limit: 3 });
  if ((theme.bodySize || 10) < 9.5) warnings.push({ code: 'BODY_SIZE_SMALL', value: theme.bodySize, limit: 9.5 });
  if (theme.lineHeight != null && theme.lineHeight < 1.3) {
    warnings.push({ code: 'LINE_HEIGHT_TIGHT', value: theme.lineHeight, limit: 1.3 });
  }
  const chars = measure(theme);
  if (chars > MAX_MEASURE) warnings.push({ code: 'LINE_TOO_LONG', value: Math.round(chars), limit: MAX_MEASURE });
  return warnings;
}

/** The theme a renderer uses when its caller passed none — the built-in look. */
function builtInTheme(scope) {
  return resolveTheme(scope, {}, null);
}

module.exports = {
  MARGIN_BOUNDS,
  LOGO_POSITIONS,
  LOGO_STACKS,
  BODY_SIZE,
  LINE_HEIGHT,
  themeWarnings,
  contrastOnWhite,
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
