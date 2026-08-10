/**
 * Download resolutions (#858) — global defaults + per-event cascade.
 *
 * Two things live here:
 *
 *   getDownloadGlobals()          Cached read of the download_* app_settings.
 *   resolveEventDownloadPolicy()  Folds an event row over those globals into
 *                                 the policy the download routes actually act
 *                                 on: which size is handed out by default, and
 *                                 which sizes (if any) a guest may pick from.
 *
 * Cascade rule: the per-event columns are NULLABLE and NULL means inherit,
 * matching the tri-state `show_watermark` / `show_qr` convention. Same TTL +
 * invalidate-on-write shape as slideshowGlobals — the gallery photo list and
 * every download hit this, so it must not fan out into N settings reads.
 */

const { getAppSetting } = require('./appSettings');

const TTL_MS = 5000;
let cache = null; // { at, val }

const ORIGINAL = 'original';

// Mirrors migration 173's seed. Used when the setting row is missing entirely
// (fresh install mid-migration, or an admin who deleted the row).
const FALLBACK_PRESETS = [
  { label: 'Large', width: 3000, height: 2000 },
  { label: 'Medium', width: 1500, height: 1000 },
  { label: 'Small', width: 800, height: 600 },
];

/** `{width, height}` → the canonical `'3000x2000'` id used on the wire. */
function resolutionId(preset) {
  return `${preset.width}x${preset.height}`;
}

/**
 * Parse a resolution id back into dimensions. Returns null for 'original',
 * anything malformed, or non-positive/absurd values — callers treat null as
 * "serve the original bytes", which is the safe direction: a bad id can only
 * ever cost fidelity, never leak a larger image than intended.
 */
function parseResolution(id) {
  if (!id || id === ORIGINAL) return null;
  const m = /^(\d{1,5})x(\d{1,5})$/.exec(String(id));
  if (!m) return null;
  const width = parseInt(m[1], 10);
  const height = parseInt(m[2], 10);
  if (!width || !height) return null;
  return { width, height };
}

function normalisePresets(raw) {
  const list = Array.isArray(raw) ? raw : FALLBACK_PRESETS;
  const seen = new Set();
  const out = [];
  for (const p of list) {
    const width = parseInt(p?.width, 10);
    const height = parseInt(p?.height, 10);
    if (!width || !height || width < 1 || height < 1) continue;
    const id = `${width}x${height}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: String(p.label || id), width, height });
  }
  // Largest first — the picker reads top-down from best quality.
  out.sort((a, b) => (b.width * b.height) - (a.width * a.height));
  return out;
}

async function getDownloadGlobals() {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.val;

  const [standard, pickerEnabled, allowOriginal, presets] = await Promise.all([
    getAppSetting('download_standard_resolution', ORIGINAL),
    getAppSetting('download_resolution_picker_enabled', false),
    getAppSetting('download_allow_original', false),
    getAppSetting('download_resolutions', FALLBACK_PRESETS),
  ]);

  const val = {
    standard_resolution: typeof standard === 'string' && standard ? standard : ORIGINAL,
    picker_enabled: pickerEnabled === true,
    allow_original: allowOriginal === true,
    resolutions: normalisePresets(presets),
  };
  cache = { at: now, val };
  return val;
}

/** Clear the cache — call after any write to a download_* global. */
function invalidateDownloadGlobals() {
  cache = null;
}

/** NULL/undefined = inherit the global; an explicit value wins. */
function inherit(eventValue, globalValue) {
  if (eventValue === null || eventValue === undefined) return globalValue;
  return eventValue === true || eventValue === 1;
}

/**
 * The effective download policy for one event.
 *
 * Returns:
 *   standard      resolution id handed out by every ordinary download
 *   standardBox   {width,height} or null when standard is 'original'
 *   pickerEnabled whether the guest-facing modal is offered at all
 *   choices       what the modal may offer, largest first
 *
 * `choices` is capped at the standard: a photographer who sets the standard to
 * 1500x1000 is saying "this gallery hands out 1500px", so the picker must not
 * quietly hand back something larger. 'Original' re-enters only when the admin
 * explicitly allows it.
 */
async function resolveEventDownloadPolicy(event) {
  const globals = await getDownloadGlobals();

  const standard = (event && event.download_standard_resolution)
    || globals.standard_resolution
    || ORIGINAL;
  const standardBox = parseResolution(standard);

  const pickerEnabled = inherit(
    event ? event.download_resolution_picker_enabled : null,
    globals.picker_enabled
  );
  const allowOriginal = inherit(
    event ? event.download_allow_original : null,
    globals.allow_original
  );

  // Never offer a size above the standard, bounding EACH dimension rather
  // than the pixel area: with mixed aspect ratios an area comparison lets
  // e.g. 2000x700 (1.4MP) through under a 1500x1000 (1.5MP) standard, and the
  // guest then gets a 2000px-wide rendition despite the stated 1500px cap.
  // When the standard IS original, every preset qualifies.
  const choices = globals.resolutions.filter((r) => !standardBox
    || (r.width <= standardBox.width && r.height <= standardBox.height));

  if (allowOriginal && standardBox) {
    // The standard is capped but the admin opted into full-res downloads.
    choices.unshift({ id: ORIGINAL, label: 'Original', width: null, height: null });
  } else if (!standardBox) {
    // Standard is already original — it heads the list regardless, otherwise
    // the picker couldn't offer what the plain download button already gives.
    choices.unshift({ id: ORIGINAL, label: 'Original', width: null, height: null });
  }

  return { standard, standardBox, pickerEnabled, allowOriginal, choices };
}

/**
 * Validate a guest-supplied resolution id against the event's policy.
 * Returns the resolution id to actually use, or null when the request is not
 * permitted — routes turn null into a 400 rather than silently downgrading,
 * so a broken client is visible instead of quietly serving the wrong size.
 */
function pickRequestedResolution(policy, requested) {
  if (!requested) return policy.standard;
  if (!policy.pickerEnabled) return null;
  const match = policy.choices.find((c) => c.id === requested);
  return match ? match.id : null;
}

module.exports = {
  ORIGINAL,
  getDownloadGlobals,
  invalidateDownloadGlobals,
  resolveEventDownloadPolicy,
  pickRequestedResolution,
  parseResolution,
  resolutionId,
};
