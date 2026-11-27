const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');

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
// Formats a family's weight files may come in, best first: a weight with
// several keeps the first. Uploads (issue 2618) take any of them.
const FONT_FORMATS = ['woff2', 'woff', 'ttf'];
const UPLOAD_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];
const FAMILY_NAME = /^[A-Za-z0-9]+(?: [A-Za-z0-9]+)*$/;
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
async function readFamilyFolder(rootAbs, folderName, source) {
  const folderAbs = path.join(rootAbs, folderName);
  let entries;
  try {
    entries = await fs.readdir(folderAbs, { withFileTypes: true });
  } catch (err) {
    logger.warn(`[fonts] Could not read family folder ${folderName} in ${rootAbs}: ${err.message}`);
    return null;
  }

  const formats = {};
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = /^(\d+)\.(woff2|woff|ttf)$/i.exec(entry.name);
    if (!match) continue; // ignore non-numeric weight names and other files
    const weight = parseInt(match[1], 10);
    if (weight < 1 || weight > 1000) continue;
    const format = match[2].toLowerCase();
    if (!formats[weight] || FONT_FORMATS.indexOf(format) < FONT_FORMATS.indexOf(formats[weight])) formats[weight] = format;
  }
  const weights = Object.keys(formats).map(Number);

  if (weights.length === 0) {
    logger.warn(`[fonts] Skipping ${folderName} in ${rootAbs}: no usable <weight>.woff2 files`);
    return null;
  }

  weights.sort((a, b) => a - b);
  const generic = await readFamilyMeta(folderAbs, folderName);
  return { family: familyDisplayName(folderName), weights, generic, formats, source };
}

/**
 * Scan one root directory and return its families as a Map keyed by
 * lowercased family name (for case-insensitive de-dup against the other
 * root). Missing directory → empty Map (not an error).
 */
async function scanRoot(rootAbs, source) {
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

    const family = await readFamilyFolder(rootAbs, entry.name, source);
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

  const bundled = await scanRoot(getBundledFontsRoot(), 'bundled');
  const userAdded = await scanRoot(getUserFontsRoot(), 'uploaded');

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

/** The font format a file's first bytes prove ('woff2', 'woff', 'ttf'), or null. */
function fontFormatOf(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  const tag = buffer.subarray(0, 4);
  if (tag.toString('latin1') === 'wOF2') return 'woff2';
  if (tag.toString('latin1') === 'wOFF') return 'woff';
  if (tag.equals(Buffer.from([0x00, 0x01, 0x00, 0x00])) || tag.toString('latin1') === 'true') return 'ttf';
  return null;
}

function fontError(message, code) {
  return new AppError(message, 400, code);
}

/**
 * Store an uploaded font weight (Settings › Branding) as
 * STORAGE_PATH/fonts/<Family-Name>/<weight>.<format>, the layout listFonts
 * reads, so the galleries and the website both offer it. A file of the same
 * weight in another format is replaced.
 */
async function saveUploadedFont({ family, weight, generic, buffer }) {
  const format = fontFormatOf(buffer);
  if (!format) throw fontError('Upload a WOFF2, WOFF or TTF font', 'FONT_TYPE');
  const name = typeof family === 'string' ? family.trim().replace(/\s+/g, ' ') : '';
  if (!FAMILY_NAME.test(name) || name.length > 60) throw fontError('Name the font with letters, digits and spaces', 'FONT_NAME');
  if (!UPLOAD_WEIGHTS.includes(Number(weight))) throw fontError('Pick a weight from 100 to 900', 'FONT_WEIGHT');
  const folder = path.join(getUserFontsRoot(), name.replace(/ /g, '-'));
  await fs.mkdir(folder, { recursive: true });
  for (const other of FONT_FORMATS) {
    // eslint-disable-next-line no-await-in-loop -- three names at most
    if (other !== format) await fs.rm(path.join(folder, `${Number(weight)}.${other}`), { force: true });
  }
  await fs.writeFile(path.join(folder, `${Number(weight)}.${format}`), buffer);
  if (VALID_GENERICS.has(generic)) await fs.writeFile(path.join(folder, 'meta.json'), JSON.stringify({ generic }));
  clearFontsCache();
  return { family: name, weight: Number(weight), format };
}

/** Remove an uploaded family; a bundled one cannot be. Returns whether one was removed. */
async function deleteUploadedFamily(family) {
  const name = typeof family === 'string' ? family.trim() : '';
  if (!FAMILY_NAME.test(name)) return false;
  const folder = path.join(getUserFontsRoot(), name.replace(/ /g, '-'));
  try {
    await fs.access(folder);
  } catch {
    return false;
  }
  await fs.rm(folder, { recursive: true, force: true });
  clearFontsCache();
  return true;
}

module.exports = {
  listFonts,
  clearFontsCache,
  fontFormatOf,
  saveUploadedFont,
  deleteUploadedFamily,
  getBundledFontsRoot,
  getUserFontsRoot
};
