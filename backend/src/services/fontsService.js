const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');

/**
 * Filesystem-driven font scanner.
 *
 * Scans two locations for self-hosted webfonts and merges the results:
 *
 *   1. backend/assets/fonts/  — bundled defaults shipped with the repo
 *      and baked into the Docker image. Visitors get a working font
 *      picker out of the box, no external CDN, no GDPR exposure.
 *
 *   2. STORAGE_PATH/fonts/    — optional runtime additions. Admins drop
 *      a folder here (via Docker volume / SFTP) and the family appears
 *      in the picker after the cache TTL expires or the backend restarts.
 *      User additions WIN over bundled defaults of the same family name —
 *      this lets a deployment override e.g. with extra weights or a newer
 *      version without forking the repo.
 *
 * Folder layout in either location:
 *
 *   <Family-Name>/<weight>.woff2
 *   <Family-Name>/meta.json    (optional)
 *
 *   - Folder name → display family with hyphens replaced by spaces:
 *       "Playfair-Display" → "Playfair Display"
 *   - Weight files must be named "<integer>.woff2" (e.g. 400.woff2).
 *     Other names are ignored, family entry still includes its other weights.
 *   - Optional meta.json: { "generic": "sans-serif" | "serif" | "cursive" | "monospace" }
 *     Tells the picker which CSS generic family to use as a fallback when
 *     building the font-family string. Defaults to "sans-serif" if absent
 *     or invalid. Avoids hardcoding family-name → generic lookups in the
 *     frontend, so any new family folder works without code changes.
 *
 * Result is cached in memory for FONTS_CACHE_TTL_MS so frequent
 * /api/public/fonts hits don't hit disk per request. New folders dropped
 * into a mount become visible after the TTL or on backend restart.
 *
 * Pattern mirrors backend/src/services/uploadSettings.js.
 */

const FONTS_CACHE_TTL_MS = 30_000;
const VALID_GENERICS = new Set(['sans-serif', 'serif', 'cursive', 'monospace']);
const DEFAULT_GENERIC = 'sans-serif';

let cachedFonts = null;
let fontsCacheExpiresAt = 0;

function getBundledFontsRoot() {
  // Test seam: the unit test suite points this at an isolated temp dir so it
  // can populate fixtures without polluting the real backend/assets tree.
  if (process.env.PICPEAK_BUNDLED_FONTS_ROOT) {
    return process.env.PICPEAK_BUNDLED_FONTS_ROOT;
  }
  // backend/src/services/fontsService.js → backend/assets/fonts
  return path.resolve(__dirname, '../../assets/fonts');
}

function getUserFontsRoot() {
  const storagePath = process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');
  return path.join(storagePath, 'fonts');
}

function familyDisplayName(folderName) {
  return folderName.replace(/-/g, ' ');
}

/**
 * Try to read meta.json from the family folder. Returns the validated
 * generic class or DEFAULT_GENERIC. Missing file → silent default.
 * Unreadable / malformed / invalid value → warning + default.
 */
async function readFamilyMeta(folderAbs, folderName) {
  const metaPath = path.join(folderAbs, 'meta.json');
  let raw;
  try {
    raw = await fs.readFile(metaPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return DEFAULT_GENERIC;
    logger.warn(`[fonts] Could not read meta.json for ${folderName}: ${err.message}`);
    return DEFAULT_GENERIC;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn(`[fonts] meta.json for ${folderName} is not valid JSON: ${err.message}`);
    return DEFAULT_GENERIC;
  }

  const generic = parsed && typeof parsed.generic === 'string' ? parsed.generic : null;
  if (generic && VALID_GENERICS.has(generic)) {
    return generic;
  }
  if (generic) {
    logger.warn(
      `[fonts] meta.json for ${folderName} has invalid generic "${generic}"; ` +
      `expected one of ${Array.from(VALID_GENERICS).join(', ')}. Falling back to ${DEFAULT_GENERIC}.`
    );
  }
  return DEFAULT_GENERIC;
}

/**
 * Read one family folder and return { family, weights, generic } or null
 * if the folder has no usable .woff2 files.
 */
async function readFamilyFolder(rootAbs, folderName) {
  const folderAbs = path.join(rootAbs, folderName);
  let entries;
  try {
    entries = await fs.readdir(folderAbs, { withFileTypes: true });
  } catch (err) {
    logger.warn(`[fonts] Could not read family folder ${folderName} in ${rootAbs}: ${err.message}`);
    return null;
  }

  const weights = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith('.woff2')) continue;
    const stem = entry.name.slice(0, -'.woff2'.length);
    if (!/^\d+$/.test(stem)) continue; // ignore non-numeric weight names
    const weight = parseInt(stem, 10);
    if (weight < 1 || weight > 1000) continue;
    weights.push(weight);
  }

  if (weights.length === 0) {
    logger.warn(`[fonts] Skipping ${folderName} in ${rootAbs}: no usable <weight>.woff2 files`);
    return null;
  }

  weights.sort((a, b) => a - b);
  const generic = await readFamilyMeta(folderAbs, folderName);
  return { family: familyDisplayName(folderName), weights, generic };
}

/**
 * Scan one root directory and return its families as a Map keyed by
 * lowercased family name (for case-insensitive de-dup against the other
 * root). Missing directory → empty Map (not an error).
 */
async function scanRoot(rootAbs) {
  let entries;
  try {
    entries = await fs.readdir(rootAbs, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return new Map();
    }
    throw err;
  }

  const result = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;

    const family = await readFamilyFolder(rootAbs, entry.name);
    if (!family) continue;

    const lc = family.family.toLowerCase();
    if (result.has(lc)) {
      logger.warn(
        `[fonts] Duplicate family ${family.family} within ${rootAbs}; ` +
        'keeping the first encountered folder'
      );
      continue;
    }
    result.set(lc, family);
  }

  return result;
}

/**
 * List all available font families (bundled + user additions, merged).
 * Cached for FONTS_CACHE_TTL_MS.
 *
 * @returns {Promise<Array<{ family: string, weights: number[], generic: string }>>}
 */
async function listFonts() {
  if (Date.now() < fontsCacheExpiresAt && cachedFonts !== null) {
    return cachedFonts;
  }

  const bundled = await scanRoot(getBundledFontsRoot());
  const userAdded = await scanRoot(getUserFontsRoot());

  // User additions override bundled families of the same name.
  const merged = new Map(bundled);
  for (const [lc, family] of userAdded) {
    if (merged.has(lc)) {
      logger.info(
        `[fonts] User-supplied ${family.family} overrides bundled default`
      );
    }
    merged.set(lc, family);
  }

  const families = Array.from(merged.values()).sort((a, b) =>
    a.family.localeCompare(b.family)
  );

  cachedFonts = families;
  fontsCacheExpiresAt = Date.now() + FONTS_CACHE_TTL_MS;
  return cachedFonts;
}

function clearFontsCache() {
  cachedFonts = null;
  fontsCacheExpiresAt = 0;
}

module.exports = {
  listFonts,
  clearFontsCache,
  getBundledFontsRoot,
  getUserFontsRoot
};
