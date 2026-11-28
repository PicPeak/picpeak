/**
 * Download filename resolution for the
 * `general_use_original_filenames_for_downloads` setting (#493).
 *
 * Two responsibilities:
 *   - Cache the boolean setting so per-download reads don't hit the DB.
 *   - Map photos → display filenames (sanitized + dedup'd for zip entries).
 *
 * Storage paths are NOT touched: callers still locate files via
 * `resolvePhotoStorageKey` / `resolvePhotoFilePath`. Only the user-visible
 * download/zip-entry name changes when the setting is on.
 */

const path = require('path');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { photoWallClock, toServerWallClock } = require('../utils/dateNormalize');
const {
  sanitizeForZipEntry,
  uniquifyZipNames,
} = require('../utils/filenameSanitizer');

const SETTING_KEY = 'general_use_original_filenames_for_downloads';
const CACHE_TTL_MS = 60_000;

let cached = null;        // boolean | null
let cachedAt = 0;

function clearCache() {
  cached = null;
  cachedAt = 0;
}

/**
 * Read the toggle. Cached for CACHE_TTL_MS to keep per-download reads cheap.
 * Falls back to `false` (current behaviour) on any error.
 */
async function getUseOriginalFilenames() {
  const now = Date.now();
  if (cached !== null && now - cachedAt < CACHE_TTL_MS) {
    return cached;
  }

  try {
    const row = await db('app_settings')
      .where('setting_key', SETTING_KEY)
      .first();

    let value = false;
    if (row && row.setting_value !== null && row.setting_value !== undefined) {
      const raw = row.setting_value;
      if (typeof raw === 'boolean') {
        value = raw;
      } else if (typeof raw === 'string') {
        // setting_value is JSON-stringified on write (see adminSettings PUT /general).
        try {
          value = JSON.parse(raw) === true;
        } catch {
          value = raw === 'true';
        }
      } else {
        value = Boolean(raw);
      }
    }

    cached = value;
    cachedAt = now;
    return value;
  } catch (err) {
    logger.warn('downloadFilenameService.getUseOriginalFilenames error', { error: err.message });
    return cached === null ? false : cached;
  }
}

/**
 * Pick the raw (unsanitised) filename to use for a single photo, given the
 * toggle state. Falls back to `photo.filename` whenever the original is missing
 * (legacy uploads before migration 062, or external-mode rows where it was
 * never populated).
 */
function pickRawDownloadName(photo, useOriginal) {
  if (useOriginal && photo && photo.original_filename) {
    return photo.original_filename;
  }
  return (photo && photo.filename) || `photo-${photo && photo.id}.jpg`;
}

/**
 * Build a list of unique, zip-safe entry names for an ordered list of photos.
 *
 * @param {Array} photos – photos in zip order
 * @param {boolean} useOriginal – toggle state
 * @returns {string[]} – same length as `photos`, with `_1` / `_2` suffixes on
 *   any duplicates (deterministic across runs because order is preserved)
 */
function getZipEntryNames(photos, useOriginal) {
  const raw = photos.map((p) => sanitizeForZipEntry(pickRawDownloadName(p, useOriginal)));
  return uniquifyZipNames(raw);
}

/**
 * Where a photo sits inside a gallery archive: under `Individual Photos/` or
 * `Collages/` when the archive holds both types, at the top otherwise. The
 * streamed download-all and the prebuilt archive serve the same URL, so they
 * must lay the zip out alike.
 */
function zipEntryPath(photo, entryName, hasMultipleTypes) {
  if (!hasMultipleTypes) return entryName;
  return path.join(photo.type === 'individual' ? 'Individual Photos' : 'Collages', entryName);
}

/**
 * The date a photo's zip entry carries, so an unpacked archive sorts by shot
 * time (issue 2617). A zip entry's time has no zone and unzip tools show it as
 * stored, so it is the wall clock the camera showed, as the admin list shows
 * it (photoWallClock), else the upload time in the server's zone.
 * archiver writes a Date's UTC fields, so that wall clock goes in as UTC.
 * undefined when the row has neither, which leaves the date to archiver: the
 * moment an appended stream or buffer is added, the mtime of a file it reads
 * from disk itself.
 */
function zipEntryDate(photo) {
  const wall = photoWallClock(photo) || toServerWallClock(photo.uploaded_at);
  return wall ? new Date(`${wall}Z`) : undefined;
}

module.exports = {
  SETTING_KEY,
  clearCache,
  getUseOriginalFilenames,
  pickRawDownloadName,
  getZipEntryNames,
  zipEntryPath,
  zipEntryDate,
};
