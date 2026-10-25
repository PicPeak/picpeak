/** Pure metadata selection; storage, timestamp interpretation and review belong to callers. */
const STRATEGY_VERSION = 'timestamp-coverage-v1';

/**
 * Suggest chronologically distributed photos without reading image pixels.
 *
 * @param {Array<{id: string, captureTimeMs?: number|null, mustUse?: boolean, excluded?: boolean}>} photos
 *   IDs are stable strings. Times must already be comparable epoch milliseconds;
 *   use null for absent/ambiguous clock information. No date strings are parsed.
 *   Array order supplies the fallback when any eligible time is missing.
 * @param {{count?: number}} options A target of 1–100; fewer eligible photos is valid.
 * @returns {{photoIds: string[], report: object}} Suggestions only, never an approval.
 */
function selectTimestampPhotos(photos, { count = 80 } = {}) {
  if (!Array.isArray(photos)) throw new TypeError('Photos must be an array');
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new RangeError('Photo count must be an integer between 1 and 100');
  }

  const unique = new Map();
  for (const photo of photos) {
    if (!photo || typeof photo !== 'object' || typeof photo.id !== 'string' || !photo.id.trim()) {
      throw new TypeError('Each photo needs a non-empty string ID');
    }
    for (const field of ['mustUse', 'excluded']) {
      if (photo[field] !== undefined && typeof photo[field] !== 'boolean') {
        throw new TypeError(`${field} must be a boolean`);
      }
    }
    const time = photo.captureTimeMs ?? null;
    if (time !== null && (!Number.isSafeInteger(time) || Math.abs(time) > 8.64e15)) {
      throw new TypeError('Capture times must be comparable epoch milliseconds or null');
    }
    const normalized = { id: photo.id, time, mustUse: photo.mustUse ?? false, excluded: photo.excluded ?? false };
    const previous = unique.get(photo.id);
    if (previous && (previous.time !== time || previous.mustUse !== normalized.mustUse || previous.excluded !== normalized.excluded)) {
      throw new TypeError('Duplicate photo IDs have conflicting metadata');
    }
    unique.set(photo.id, normalized);
  }

  const eligible = [...unique.values()].filter(photo => !photo.excluded);
  const missingTimes = eligible.filter(photo => photo.time === null).length;
  const target = Math.min(count, eligible.length);
  const mustUseCount = eligible.filter(photo => photo.mustUse).length;
  if (mustUseCount > target) throw new RangeError('Must-use photos exceed the requested count');

  let fallbackReason = missingTimes ? 'missing_capture_times' : null;
  if (!fallbackReason && eligible.length > 1 && eligible.every(photo => photo.time === eligible[0].time)) {
    fallbackReason = 'identical_capture_times';
  }
  if (!fallbackReason) {
    eligible.sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  const positions = eligible.map((photo, index) => fallbackReason ? index : photo.time);
  const picked = new Set();
  eligible.forEach((photo, index) => { if (photo.mustUse) picked.add(index); });

  if (target === 1 && !picked.size) {
    const midpoint = positions[0] / 2 + positions[positions.length - 1] / 2;
    let best = 0;
    for (let index = 1; index < positions.length; index += 1) {
      if (Math.abs(positions[index] - midpoint) < Math.abs(positions[best] - midpoint)) best = index;
    }
    picked.add(best);
  }
  for (const index of [0, eligible.length - 1]) {
    if (picked.size < target) picked.add(index);
  }

  // Cache nearest distances: O(n * target) rather than rescanning every chosen set.
  const timeDistance = positions.map(position => Math.min(...[...picked].map(index => Math.abs(position - positions[index]))));
  const orderDistance = positions.map((_, index) => Math.min(...[...picked].map(chosen => Math.abs(index - chosen))));
  while (picked.size < target) {
    let best = -1;
    for (let index = 0; index < eligible.length; index += 1) {
      if (picked.has(index)) continue;
      if (best < 0 || timeDistance[index] > timeDistance[best] ||
          (timeDistance[index] === timeDistance[best] && orderDistance[index] > orderDistance[best])) best = index;
    }
    picked.add(best);
    for (let index = 0; index < eligible.length; index += 1) {
      timeDistance[index] = Math.min(timeDistance[index], Math.abs(positions[index] - positions[best]));
      orderDistance[index] = Math.min(orderDistance[index], Math.abs(index - best));
    }
  }

  return {
    photoIds: eligible.filter((_, index) => picked.has(index)).map(photo => photo.id),
    report: {
      strategy: STRATEGY_VERSION,
      inputCount: photos.length,
      uniqueCount: unique.size,
      eligibleCount: eligible.length,
      selectedCount: picked.size,
      requestedCount: count,
      mustUseCount,
      excludedCount: unique.size - eligible.length,
      missingCaptureTimes: missingTimes,
      sampling: fallbackReason || !eligible.length ? 'photo_order' : 'capture_time',
      fallbackReason
    }
  };
}

module.exports = { selectTimestampPhotos, STRATEGY_VERSION };
