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

const { db } = require('../database/db');
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

/**
 * Queue photos that just became complete, if tagging is on for the gallery.
 *
 * The switch is read here, AFTER the caller committed the finished rows,
 * and that order is what makes this safe against the backfill of a gallery
 * being switched on at the same moment: either this read already sees the
 * switch on, or the switch is written after it and the backfill that
 * follows finds the finished row. A switch read before processing began
 * (the `event` an upload started with) misses both.
 *
 * Only rows never queued: a status somebody else set is theirs.
 */
async function enqueueFinishedPhotos(eventId, photoIds) {
  if (!photoIds.length || !(await isFeatureEnabled())) return 0;
  const event = await db('events').where({ id: eventId }).first('auto_tagging_enabled');
  if (!isSwitchedOnForEvent(event)) return 0;
  let queued = 0;
  for (let i = 0; i < photoIds.length; i += 500) {
    queued += await db('photos')
      .whereIn('id', photoIds.slice(i, i + 500))
      .whereNull('tag_status')
      .update({ tag_status: 'pending' });
  }
  return queued;
}

module.exports = {
  FLAG_KEY, isFeatureEnabled, isSwitchedOnForEvent, isEnabledForEvent, enqueueFinishedPhotos,
};
