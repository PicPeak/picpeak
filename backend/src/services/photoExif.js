/**
 * Camera details read from EXIF (issue 1733, D1).
 *
 * An allow-list, not a filter: exifr is asked for these seven tags and
 * nothing else, and the result is rebuilt field by field, so GPS, serial
 * numbers, owner and artist names or the software tag can never reach
 * photos.exif_json. The same rebuild runs again when a stored value is read
 * for a response.
 *
 * A leaf module (exifr and the logger only), like photoCredit.js, so a test
 * that mocks imageProcessor keeps working.
 */

const path = require('path');
const exifr = require('exifr');
const logger = require('../utils/logger');

const EXIF_TAGS = ['Make', 'Model', 'LensModel', 'FocalLength', 'FNumber', 'ExposureTime', 'ISO'];
const MAX_TEXT_LENGTH = 100;

function cleanText(value) {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, MAX_TEXT_LENGTH).trim() : null;
}

function cleanNumber(value, max, decimals) {
  // Some bodies write ISO as a pair; the first entry is the one in use.
  const n = Array.isArray(value) ? value[0] : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > max) return null;
  return Number(n.toFixed(decimals)) || null;
}

/**
 * The stored shape. Every key is optional; a field that is missing or out of
 * range is left out. Accepts raw exifr output and an already normalised
 * object alike.
 */
function normalizeExif(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  const put = (key, value) => { if (value !== null) out[key] = value; };
  put('make', cleanText(src.Make ?? src.make));
  put('model', cleanText(src.Model ?? src.model));
  put('lens', cleanText(src.LensModel ?? src.lens));
  put('focal_length', cleanNumber(src.FocalLength ?? src.focal_length, 10000, 1));
  put('aperture', cleanNumber(src.FNumber ?? src.aperture, 1000, 2));
  // Seconds. The lightbox prints the reciprocal (1/3200 s), so the value
  // keeps enough decimals for that to round back to the camera's setting:
  // at six, 1/3200 s was stored as 0.000313 and shown as 1/3195 s.
  put('exposure_time', cleanNumber(src.ExposureTime ?? src.exposure_time, 86400, 12));
  put('iso', cleanNumber(src.ISO ?? src.iso, 100000000, 0));
  return out;
}

/**
 * Read the camera details of an image file.
 *
 * {} for a file that carries none or that exifr cannot parse (several RAW
 * containers): that is a final answer and is stored, so the backfill does
 * not read the file again. null only when the file could not be read at all,
 * which leaves the column NULL for a later run. Never throws.
 */
async function extractPhotoExif(filePath) {
  try {
    return normalizeExif(await exifr.parse(filePath, { pick: EXIF_TAGS }));
  } catch (error) {
    logger.debug(`Could not read EXIF details from ${path.basename(String(filePath))}: ${error.message}`);
    return error && error.code ? null : {};
  }
}

/** The exif_json column for an ingest path; no column when the file could not be read. */
async function exifColumn(filePath) {
  const exif = await extractPhotoExif(filePath);
  return exif ? { exif_json: JSON.stringify(exif) } : {};
}

/** A stored exif_json as the object a response carries, or null when empty. */
function parseStoredExif(value) {
  if (!value) return null;
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { return null; }
  }
  const exif = normalizeExif(parsed);
  return Object.keys(exif).length ? exif : null;
}

module.exports = { extractPhotoExif, exifColumn, normalizeExif, parseStoredExif };
