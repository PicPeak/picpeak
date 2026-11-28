const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');
const { getStorage } = require('./storage');
const { fileVersion } = require('../utils/fontVersion');

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
// Where uploads live in storage (STORAGE_PATH/fonts on a local disk).
const FONTS_PREFIX = 'fonts';
const FONT_TYPES = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf' };
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
 * A family from its folder's files ({ name, version }): { family, weights,
 * generic, formats, versions, source }, or null without a usable weight file.
 */
function familyFromFiles(folderName, files, generic, source, where) {
  const formats = {};
  const versions = {};
  for (const { name, version } of files) {
    const match = /^(\d+)\.(woff2|woff|ttf)$/i.exec(name);
    if (!match) continue; // ignore non-numeric weight names and other files
    const weight = parseInt(match[1], 10);
    if (weight < 1 || weight > 1000) continue;
    const format = match[2].toLowerCase();
    if (!formats[weight] || FONT_FORMATS.indexOf(format) < FONT_FORMATS.indexOf(formats[weight])) {
      formats[weight] = format;
      versions[weight] = version;
    }
  }
  const weights = Object.keys(formats).map(Number);

  if (weights.length === 0) {
    logger.warn(`[fonts] Skipping ${folderName} in ${where}: no usable <weight>.woff2 files`);
    return null;
  }

  weights.sort((a, b) => a - b);
  return { family: familyDisplayName(folderName), weights, generic, formats, versions, source };
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
  const files = await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
    const st = await fs.stat(path.join(folderAbs, entry.name)).catch(() => null);
    return { name: entry.name, version: st ? fileVersion(st.mtimeMs, st.size) : '' };
  }));
  const family = familyFromFiles(folderName, files, DEFAULT_GENERIC, source, rootAbs);
  return family ? { ...family, generic: await readFamilyMeta(folderAbs, folderName) } : null;
}

/**
 * The uploaded families as the object store holds them (S3: every replica
 * sees the same), keyed like scanRoot's result.
 */
async function scanStore(storage) {
  const byFolder = new Map();
  for (const entry of await storage.list(`${FONTS_PREFIX}/`)) {
    const parts = String(entry.key).split('/');
    if (parts.length !== 3 || parts[0] !== FONTS_PREFIX || !parts[1] || parts[1].startsWith('.')) continue;
    if (!byFolder.has(parts[1])) byFolder.set(parts[1], []);
    byFolder.get(parts[1]).push({ name: parts[2], version: fileVersion(entry.mtime, entry.size) });
  }
  const result = new Map();
  for (const [folder, names] of byFolder) {
    let generic = DEFAULT_GENERIC;
    if (names.some((file) => file.name === 'meta.json')) {
      try {
        const chunks = [];
        // eslint-disable-next-line no-await-in-loop -- one small file per family
        for await (const chunk of await storage.get(`${FONTS_PREFIX}/${folder}/meta.json`)) chunks.push(Buffer.from(chunk));
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (parsed && VALID_GENERICS.has(parsed.generic)) generic = parsed.generic;
      } catch (err) {
        logger.warn(`[fonts] Could not read meta.json for ${folder}: ${err.message}`);
      }
    }
    const family = familyFromFiles(folder, names, generic, 'uploaded', 'the object store');
    if (family && !result.has(family.family.toLowerCase())) result.set(family.family.toLowerCase(), family);
  }
  return result;
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

/** Families from two places, one per name; `preferred` wins a weight both have. */
function mergeFamilies(other, preferred) {
  const merged = new Map(other);
  for (const [lc, family] of preferred) {
    const base = merged.get(lc);
    if (!base) {
      merged.set(lc, family);
      continue;
    }
    const formats = { ...base.formats, ...family.formats };
    merged.set(lc, {
      ...family,
      versions: { ...base.versions, ...family.versions },
      weights: Object.keys(formats).map(Number).sort((a, b) => a - b),
      formats,
      generic: family.generic !== DEFAULT_GENERIC ? family.generic : base.generic,
    });
  }
  return merged;
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
  // Uploads live where the storage adapter keeps files: on this disk, or in
  // the object store every replica shares. With the store, fonts placed on
  // this disk before (or by hand) still count: merged in, the store's file
  // first where both have a weight, as the /fonts mounts serve them.
  const storage = getStorage();
  const onDisk = await scanRoot(getUserFontsRoot(), 'uploaded');
  const userAdded = storage.kind() === 's3' ? mergeFamilies(onDisk, await scanStore(storage)) : onDisk;

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

/**
 * The folder an uploaded family already has, matched without regard to
 * letter case (on S3 or a case-sensitive disk "Studio-Serif" and
 * "studio-serif" would be two folders, one hidden by the de-duplication in
 * listFonts); the folder of the name as given when there is none.
 */
async function familyFolder(name) {
  const wanted = name.replace(/ /g, '-');
  const lc = wanted.toLowerCase();
  const folders = new Set();
  for (const entry of await getStorage().list(`${FONTS_PREFIX}/`)) {
    const parts = String(entry.key).split('/');
    if (parts.length === 3 && parts[1]) folders.add(parts[1]);
  }
  try {
    for (const entry of await fs.readdir(getUserFontsRoot(), { withFileTypes: true })) if (entry.isDirectory()) folders.add(entry.name);
  } catch { /* no fonts folder on this disk */ }
  return [...folders].sort().find((folder) => folder.toLowerCase() === lc) || wanted;
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
 * Store an uploaded font weight (Settings › Branding) through the storage
 * adapter as fonts/<Family-Name>/<weight>.<format> (on local storage:
 * STORAGE_PATH/fonts/..., the layout listFonts reads; on S3 in the bucket,
 * so every replica serves it), so the galleries and the website both offer
 * it. A file of the same weight in another format is replaced.
 */
async function saveUploadedFont({ family, weight, generic, buffer }) {
  const format = fontFormatOf(buffer);
  if (!format) throw fontError('Upload a WOFF2, WOFF or TTF font', 'FONT_TYPE');
  const name = typeof family === 'string' ? family.trim().replace(/\s+/g, ' ') : '';
  if (!FAMILY_NAME.test(name) || name.length > 60) throw fontError('Name the font with letters, digits and spaces', 'FONT_NAME');
  if (!UPLOAD_WEIGHTS.includes(Number(weight))) throw fontError('Pick a weight from 100 to 900', 'FONT_WEIGHT');
  const storage = getStorage();
  // Into the family's existing folder, whatever the letter case typed.
  const folderName = await familyFolder(name);
  const folder = `${FONTS_PREFIX}/${folderName}`;
  for (const other of FONT_FORMATS) {
    // eslint-disable-next-line no-await-in-loop -- three names at most
    if (other !== format) await storage.delete(`${folder}/${Number(weight)}.${other}`);
  }
  await storage.put(`${folder}/${Number(weight)}.${format}`, buffer, { contentType: FONT_TYPES[format] });
  if (VALID_GENERICS.has(generic)) await storage.put(`${folder}/meta.json`, Buffer.from(JSON.stringify({ generic })), { contentType: 'application/json' });
  // This replica's copy of the object-store file goes at once (others go by
  // the new version in the address).
  require('../middleware/fontReadThrough').forgetCachedFamily(folderName);
  clearFontsCache();
  return { family: familyDisplayName(folderName), weight: Number(weight), format };
}

/** Remove an uploaded family; a bundled one cannot be. Returns whether one was removed. */
async function deleteUploadedFamily(family) {
  const name = typeof family === 'string' ? family.trim() : '';
  if (!FAMILY_NAME.test(name)) return false;
  const storage = getStorage();
  const folderName = await familyFolder(name);
  const prefix = `${FONTS_PREFIX}/${folderName}/`;
  const entries = await storage.list(prefix);
  for (const entry of entries) await storage.delete(entry.key); // eslint-disable-line no-await-in-loop
  // On this disk too: with the object store, fonts placed here before are
  // listed beside the stored ones (listFonts) and removed the same way.
  const folder = path.join(getUserFontsRoot(), folderName);
  const onDisk = await fs.stat(folder).then((st) => st.isDirectory()).catch(() => false);
  if (onDisk) await fs.rm(folder, { recursive: true, force: true });
  if (!entries.length && !onDisk) return false;
  require('../middleware/fontReadThrough').forgetCachedFamily(folderName);
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
