/**
 * Automatic scene tags (issue 1733): the feature gate.
 *
 * Two switches, both off by default, and nothing runs unless both are on:
 * the global `autoTagging` feature flag and the gallery's own
 * `auto_tagging_enabled`. Independent of face recognition and its consent:
 * a scene tag ("cake", "outdoor") says nothing about who is in a photo.
 *
 * Tagging runs in the same optional ML sidecar as face detection, so it is
 * unavailable on the all-in-one image for the same reason (see
 * faceSettings.isSingleContainerImage).
 */

const { isFeatureEnabled: isFlagEnabled } = require('../middleware/requireFeatureFlag');
const { isSingleContainerImage } = require('./faceSettings');
const logger = require('../utils/logger');

// Must match KNOWN_FLAGS in adminFeatureFlags and the frontend FeatureKey.
const FLAG_KEY = 'autoTagging';

async function isFeatureEnabled() {
  if (isSingleContainerImage()) return false;
  try {
    return await isFlagEnabled(FLAG_KEY);
  } catch (e) {
    // A missing table (pre-migration install) means off, not a crash.
    logger.debug?.('tagSettings: feature flag read failed', { error: e.message });
    return false;
  }
}

function isSwitchedOnForEvent(event) {
  return !!event && (event.auto_tagging_enabled === true || event.auto_tagging_enabled === 1);
}

/** Global flag AND the gallery's own switch. */
async function isEnabledForEvent(event) {
  if (!isSwitchedOnForEvent(event)) return false;
  return isFeatureEnabled();
}

module.exports = { FLAG_KEY, isFeatureEnabled, isSwitchedOnForEvent, isEnabledForEvent };
