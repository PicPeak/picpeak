/**
 * Colour labels (#1044): the fixed, curated colour set clients mark photos
 * with while proofing. Guests pick ONE per photo (changeable), exactly like
 * the emoji reactions in constants/reactions.js.
 *
 * The set is Lightroom's, deliberately: keeping the same five colours means a
 * client's selection can round-trip into the photographer's catalogue through
 * the XMP `xmp:Label` field (services/xmpGenerator.js) with no remapping.
 *
 * Mirrored in frontend/src/services/feedback.service.ts (COLOR_LABELS and the
 * keymaps) — update both together.
 */

/** Canonical stored values. Lowercase; the XMP layer capitalises. */
const COLOR_LABELS = ['red', 'yellow', 'green', 'blue', 'purple'];

/**
 * Lightroom / XMP spelling for each label. `xmp:Label` is a free-text field,
 * but Lightroom only lights up its colour swatch for these exact strings.
 */
const COLOR_LABEL_TO_XMP = {
  red: 'Red',
  yellow: 'Yellow',
  green: 'Green',
  blue: 'Blue',
  purple: 'Purple',
};

/**
 * Tie-break order when several guests labelled the same photo differently and
 * the export has to pick one. Green first: in the proofing workflow this
 * feature exists for, green is "1st choice" — the pick that must survive.
 */
const COLOR_LABEL_PRIORITY = ['green', 'yellow', 'red', 'blue', 'purple'];

/**
 * Lightbox keyboard schemes. Both are data, not code, so the gallery lightbox,
 * the admin viewer and the settings preview can never drift.
 *
 * - 'colors'    the scheme requested in discussion #1027: three keys, no
 *               Lightroom knowledge needed. 1 = 1st choice, 2 = 2nd choice,
 *               3 = rejected.
 * - 'lightroom' Lightroom's own defaults: 1-5 set the star rating, 6-9 set
 *               red/yellow/green/blue. Lightroom has no default shortcut for
 *               purple, and neither do we — it stays click-only.
 *
 * In both schemes pressing the same key again clears the value, and '0'
 * clears (the rating in 'lightroom', the colour in 'colors').
 */
const KEYBIND_SCHEMES = {
  colors: {
    colors: { 1: 'green', 2: 'yellow', 3: 'red' },
    ratings: {},
  },
  lightroom: {
    colors: { 6: 'red', 7: 'yellow', 8: 'green', 9: 'blue' },
    ratings: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 },
  },
};

function isValidColorLabel(value) {
  return COLOR_LABELS.includes(value);
}

/**
 * Pick the single colour that represents a photo when several guests have
 * labelled it — most-labelled wins, ties broken by COLOR_LABEL_PRIORITY.
 *
 * @param {Object} counts - e.g. { green: 2, red: 1 }
 * @returns {string|null}
 */
function dominantColorLabel(counts) {
  if (!counts) return null;
  let best = null;
  let bestCount = 0;
  for (const color of COLOR_LABEL_PRIORITY) {
    const count = Number(counts[color]) || 0;
    if (count > bestCount) {
      best = color;
      bestCount = count;
    }
  }
  return best;
}

module.exports = {
  COLOR_LABELS,
  COLOR_LABEL_TO_XMP,
  COLOR_LABEL_PRIORITY,
  KEYBIND_SCHEMES,
  isValidColorLabel,
  dominantColorLabel,
};
