/**
 * Face-recognition settings and the feature gate (#1074).
 *
 * One module owns the answer to "is this feature on?", because the answer has
 * three independent parts and getting any of them wrong is either a privacy
 * problem or a log-spam problem:
 *
 *   1. The `faces` feature flag (global, default OFF).
 *   2. `FACE_ML_URL` — which now has a DEFAULT (the compose service name),
 *      so its presence proves nothing. This is exactly why the flag is the
 *      gate: if the URL were the gate, every install would try to reach a
 *      hostname that doesn't resolve.
 *   3. The per-event `face_recognition_enabled` toggle.
 *
 * Nothing may contact the sidecar unless (1) is true. `isFeatureEnabled()` is
 * the only correct way to ask.
 */

const { db } = require('../database/db');
const {
  isFeatureEnabled: isFlagEnabled,
  invalidateFeatureFlagCache,
} = require('../middleware/requireFeatureFlag');
const logger = require('../utils/logger');

// Canonical flag key. Must match the entry in adminFeatureFlags KNOWN_FLAGS
// and the FeatureKey union on the frontend.
const FLAG_KEY = 'faces';

/**
 * Is this the all-in-one single-container image (#1042 / PR #1068)?
 *
 * Face recognition is BLOCKED there, on performance grounds. The AIO image
 * runs the backend, the frontend, SQLite and every background worker inside
 * one container sized for "one photographer plus guests browsing" — it has no
 * Redis and SQLite gives it a single writer. Face detection would add a
 * second image-processing pipeline competing with Sharp for the same CPU and
 * RAM, on top of an ML sidecar the image does not contain and cannot start.
 *
 * Enabling it there would not fail loudly; it would just make the whole
 * install slow and appear broken, which is the worst shape for a deployment
 * aimed at people who want one container and no decisions.
 *
 * Detected from an explicit marker rather than inferred from SERVE_FRONTEND
 * or a SQLite path: plenty of legitimate multi-container setups serve the
 * frontend from the backend or run SQLite, and none of them should lose the
 * feature by accident.
 */
function isSingleContainerImage() {
  const v = String(process.env.PICPEAK_SINGLE_CONTAINER || '').toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

const DEFAULTS = {
  // Measured on a real gallery, not just on LFW pairs — see migration 177
  // for why those two disagree and why cluster purity wins.
  face_match_threshold: 0.60,
  face_min_cluster_size: 3,
  face_quality_min_score: 0.7,
  face_quality_min_px: 40,
  face_auto_categorize_enabled: false,
};

const SETTING_KEYS = Object.keys(DEFAULTS);

function parseSetting(raw, fallback) {
  if (raw === undefined || raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    // Pre-JSON rows (and plain strings written by hand) — coerce by the
    // shape of the default so callers always get the type they expect.
    if (typeof fallback === 'number') {
      const n = Number(raw);
      return Number.isFinite(n) ? n : fallback;
    }
    if (typeof fallback === 'boolean') return raw === 'true' || raw === '1';
    return raw;
  }
}

/**
 * Is the `faces` feature flag on? This is THE gate — see the header.
 *
 * Delegates to the shared `feature_flags` reader (already cached, already
 * invalidated by PUT /admin/feature-flags) rather than keeping a second
 * cache that could disagree with the middleware guarding the same routes.
 */
async function isFeatureEnabled() {
  // Hard block on the all-in-one image, ahead of the flag. Even if the row
  // says true — restored from a backup taken on a full deployment, say — the
  // feature stays off here.
  if (isSingleContainerImage()) return false;

  try {
    return await isFlagEnabled(FLAG_KEY);
  } catch (e) {
    // A missing table (pre-migration install) means off, not a crash.
    logger.debug?.('faceSettings: feature flag read failed', { error: e.message });
    return false;
  }
}

/**
 * Effective sidecar URL. Callers must check isFeatureEnabled() first — this
 * always returns a string, because the default is a hostname rather than an
 * absence.
 */
function getSidecarUrl() {
  return (process.env.FACE_ML_URL || 'http://picpeak-ml:8000').replace(/\/+$/, '');
}

function getSidecarToken() {
  return process.env.FACE_ML_TOKEN || '';
}

/**
 * Clustering/quality thresholds, with defaults. Deliberately settings rather
 * than constants: no single threshold survives contact with every library.
 */
async function getThresholds() {
  const out = { ...DEFAULTS };
  try {
    const rows = await db('app_settings')
      .whereIn('setting_key', SETTING_KEYS)
      .select('setting_key', 'setting_value');
    for (const row of rows) {
      out[row.setting_key] = parseSetting(row.setting_value, DEFAULTS[row.setting_key]);
    }
  } catch (e) {
    logger.debug?.('faceSettings: threshold read failed, using defaults', { error: e.message });
  }
  return out;
}

/**
 * Is detection enabled for this specific event? Requires BOTH the global flag
 * and the per-event toggle — the "two deliberate actions" rule from #1074 §6.
 */
async function isEnabledForEvent(event) {
  if (!(await isFeatureEnabled())) return false;
  if (!event) return false;
  return event.face_recognition_enabled === true || event.face_recognition_enabled === 1;
}

/**
 * Do GUESTS of this event see the people strip? Separate from the above so a
 * photographer can use clustering as a private tool.
 *
 * Defaults to true when detection is on, because the column is nullable and
 * NULL means "not explicitly set" rather than "off" — matching the tri-state
 * convention used by show_watermark / show_qr.
 */
function areFacesVisibleToGuests(event) {
  if (!event) return false;
  return event.faces_visible_to_guests !== false && event.faces_visible_to_guests !== 0;
}

module.exports = {
  DEFAULTS,
  FLAG_KEY,
  isSingleContainerImage,
  isFeatureEnabled,
  invalidateFeatureFlagCache,
  getSidecarUrl,
  getSidecarToken,
  getThresholds,
  isEnabledForEvent,
  areFacesVisibleToGuests,
};
