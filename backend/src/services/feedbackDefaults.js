/**
 * Global defaults for the per-event guest-feedback toggles (#1044).
 *
 * Before this module the creation defaults lived in four places that had
 * already drifted apart: the admin create route's destructuring defaults, the
 * v1 create route's hard-coded insert (which forgot `allow_reactions`
 * entirely), `feedbackService.getEventFeedbackSettings()`'s no-row fallback
 * and the migration column defaults. The same install answered "are comments
 * on by default?" differently depending on which code path created the event.
 *
 * Everything now resolves through FEEDBACK_TOGGLES:
 *
 *   app_settings row  ->  per-event column default  ->  the built-in fallback
 *
 * The `event_default_*` keys extend the family `event_default_require_password`
 * (#317) and `event_default_feedback_enabled` (#520) already established: they
 * are the value a NEW event starts from, not a retroactive master switch.
 * Flipping one never changes a gallery that already exists — a switch that
 * silently strips the rating stars off a gallery a client is mid-way through
 * proofing would be a different, much riskier feature.
 *
 * Adding a seventh feedback type means adding one row to FEEDBACK_TOGGLES
 * (plus its column in the migration and its UI) — no sweep across the create
 * routes.
 */

const { db } = require('../database/db');
const logger = require('../utils/logger');

/**
 * Every guest-feedback toggle, in the order the admin UI shows them.
 *
 * `fallback` is what applies when the admin has never touched the global
 * setting. These match the values the admin create route has shipped with, so
 * installs that never open Settings > Events keep creating events exactly as
 * they did before — except `allow_color_labels`, which is new in #1044 and
 * opt-in so no existing gallery grows a colour bar on upgrade.
 */
const FEEDBACK_TOGGLES = [
  { column: 'allow_ratings', settingKey: 'event_default_allow_ratings', fallback: true },
  { column: 'allow_likes', settingKey: 'event_default_allow_likes', fallback: true },
  { column: 'allow_favorites', settingKey: 'event_default_allow_favorites', fallback: true },
  { column: 'allow_comments', settingKey: 'event_default_allow_comments', fallback: true },
  { column: 'allow_reactions', settingKey: 'event_default_allow_reactions', fallback: true },
  { column: 'allow_color_labels', settingKey: 'event_default_allow_color_labels', fallback: false },
];

/** Non-boolean feedback defaults that follow the same global -> event flow. */
const KEYBIND_MODES = ['colors', 'lightroom'];
const DEFAULT_KEYBIND_MODE = 'colors';
const KEYBIND_MODE_SETTING_KEY = 'event_default_keybind_mode';

/** Every app_settings key this module owns — for the settings API surface. */
const FEEDBACK_DEFAULT_SETTING_KEYS = [
  ...FEEDBACK_TOGGLES.map((t) => t.settingKey),
  KEYBIND_MODE_SETTING_KEY,
];

/**
 * app_settings stores JSON-encoded values, but rows written by older code
 * paths (and by SQLite's looser typing) can arrive as raw strings. Accept
 * both, and return undefined for anything that isn't recognisably a boolean
 * so the caller falls back rather than persisting `null` into a NOT NULL-ish
 * boolean column.
 */
function parseBooleanSetting(rawValue) {
  let value = rawValue;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
      return undefined;
    }
  }
  if (typeof value === 'boolean') return value;
  // SQLite hands back 0/1 for booleans written through formatBoolean.
  if (value === 1 || value === 0) return value === 1;
  return undefined;
}

function parseKeybindModeSetting(rawValue) {
  let value = rawValue;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === 'string') value = parsed;
    } catch {
      /* keep raw */
    }
  }
  return KEYBIND_MODES.includes(value) ? value : undefined;
}

/**
 * Resolve the global feedback defaults in ONE query (mirrors
 * getBrandingDefaults' batched whereIn rather than firing seven `.first()`
 * calls on every event creation).
 *
 * Never throws: a settings-table hiccup must not fail event creation, so the
 * built-in fallbacks stand in.
 *
 * @returns {Promise<{allow_ratings: boolean, allow_likes: boolean,
 *   allow_favorites: boolean, allow_comments: boolean, allow_reactions: boolean,
 *   allow_color_labels: boolean, keybind_mode: string}>}
 */
async function resolveEventFeedbackDefaults() {
  const defaults = {};
  for (const toggle of FEEDBACK_TOGGLES) {
    defaults[toggle.column] = toggle.fallback;
  }
  defaults.keybind_mode = DEFAULT_KEYBIND_MODE;

  try {
    const rows = await db('app_settings')
      .whereIn('setting_key', FEEDBACK_DEFAULT_SETTING_KEYS)
      .select('setting_key', 'setting_value');

    const bySettingKey = new Map(rows.map((row) => [row.setting_key, row.setting_value]));

    for (const toggle of FEEDBACK_TOGGLES) {
      if (!bySettingKey.has(toggle.settingKey)) continue;
      const parsed = parseBooleanSetting(bySettingKey.get(toggle.settingKey));
      if (parsed !== undefined) defaults[toggle.column] = parsed;
    }

    if (bySettingKey.has(KEYBIND_MODE_SETTING_KEY)) {
      const parsed = parseKeybindModeSetting(bySettingKey.get(KEYBIND_MODE_SETTING_KEY));
      if (parsed !== undefined) defaults.keybind_mode = parsed;
    }
  } catch (error) {
    logger.error('Failed to read global feedback defaults, using built-ins', {
      error: error.message,
    });
  }

  return defaults;
}

/**
 * Merge an explicit request body over the resolved globals. A value the caller
 * actually sent always wins; `undefined` (the field was omitted) inherits.
 *
 * @param {Object} body - the create-request payload
 * @param {Object} globals - output of resolveEventFeedbackDefaults()
 */
function applyFeedbackDefaults(body = {}, globals) {
  const resolved = { ...globals };
  for (const toggle of FEEDBACK_TOGGLES) {
    if (body[toggle.column] !== undefined) {
      resolved[toggle.column] = body[toggle.column];
    }
  }
  if (KEYBIND_MODES.includes(body.keybind_mode)) {
    resolved.keybind_mode = body.keybind_mode;
  }
  return resolved;
}

module.exports = {
  FEEDBACK_TOGGLES,
  FEEDBACK_DEFAULT_SETTING_KEYS,
  KEYBIND_MODES,
  KEYBIND_MODE_SETTING_KEY,
  DEFAULT_KEYBIND_MODE,
  resolveEventFeedbackDefaults,
  applyFeedbackDefaults,
};
