/**
 * Photo credits (#1561): a name on a photo, from one of three sources.
 *
 *   guest   the name the guest gave in the upload dialog
 *   exif    Artist, then XMP dc:creator, then Copyright, read from the file
 *   manual  the admin's correction — never overwritten by ingest or backfill
 *
 * Every ingest path goes through resolveCredit(), so the precedence lives in
 * one place:
 *
 *   1. a guest upload credits the guest's name and nothing else. EXIF is not
 *      read for guest uploads: phone metadata is not maintained and would only
 *      put "iPhone owner" style noise on the photo;
 *   2. an admin upload or an import credits the EXIF name, when there is one;
 *   3. otherwise no credit.
 *
 * `manual` is never produced here. It is written only by the admin edit, and
 * every later writer (the upload worker, the backfill) fences on
 * `credit_source IS NULL`, so a correction cannot be undone by a re-read.
 *
 * EXIF strings are as untrusted as a guest's input — anything can write them —
 * so they go through the same sanitiser, once, at ingest.
 */

const path = require('path');
const exifr = require('exifr');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { sanitizeName } = require('../utils/personName');

const CREDIT_SOURCES = Object.freeze(['guest', 'exif', 'manual']);
const GUEST_NAME_MODES = Object.freeze(['off', 'optional', 'required']);
// Filter value for "photos without a credit". Not a name anyone can have:
// creditName() refuses it on every write path.
const CREDIT_NONE = '__none__';

// A credit name. The sanitiser keeps underscores, so the filter token itself
// has to be refused here or a photo could be credited to "__none__".
function creditName(raw) {
  const name = sanitizeName(raw);
  return name === CREDIT_NONE ? '' : name;
}

function guestNameModeOf(event) {
  const mode = event && event.guest_name_mode;
  return GUEST_NAME_MODES.includes(mode) ? mode : 'off';
}

// exifr hands XMP text back as a string, an array (rdf:Seq / rdf:Bag) or a
// language alternative object ({ lang, value }), depending on the writer.
function xmpText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(xmpText).filter(Boolean).join(', ');
  }
  if (typeof value === 'object') {
    if (typeof value.value === 'string') return value.value;
    return Object.values(value).map(xmpText).filter(Boolean).join(', ');
  }
  return String(value);
}

// A Copyright field is a notice, not a name: "© 2026 Anna Example. All rights
// reserved." The name is what is left once the notice around it is removed.
function nameFromCopyright(value) {
  return String(value || '')
    .replace(/all rights reserved\.?/ig, '')
    .replace(/^\s*(?:©|\(c\)|copyright)\s*/i, '')
    .replace(/^\s*(?:©|\(c\))\s*/i, '')
    .replace(/^\s*\d{4}(?:\s*[-–]\s*\d{4})?\s*[,.]?\s*/, '')
    .replace(/[\s,.;]+$/, '')
    .trim();
}

/**
 * The credit a set of parsed EXIF/XMP fields carries, or null.
 * Exported for the tests and for callers that already parsed the file.
 */
function creditFromMetadata(meta) {
  if (!meta) return null;
  const candidates = [
    xmpText(meta.Artist),
    xmpText(meta.creator),
    nameFromCopyright(xmpText(meta.Copyright)),
  ];
  for (const candidate of candidates) {
    const name = creditName(candidate);
    if (name) return name;
  }
  return null;
}

/**
 * Read the credit out of an image file. Never throws: a file without
 * metadata, or one exifr cannot parse, simply has no credit.
 */
async function extractExifCredit(filePath) {
  try {
    const meta = await exifr.parse(filePath, {
      tiff: true,
      ifd0: true,
      exif: false,
      gps: false,
      interop: false,
      ifd1: false,
      xmp: true,
      iptc: false,
      icc: false,
      jfif: false,
      ihdr: false,
    });
    return creditFromMetadata(meta);
  } catch (error) {
    logger.debug(`Could not read EXIF credit from ${path.basename(String(filePath))}: ${error.message}`);
    return null;
  }
}

/**
 * The credit columns for a guest upload. `guest` is req.guest (or null for a
 * guest who left the optional name empty).
 */
function guestCreditFields(guest) {
  const name = guest ? creditName(guest.name) : '';
  if (!guest || !name) return {};
  return { credit_name: name, credit_source: 'guest', uploader_guest_id: guest.id };
}

/**
 * The credit columns for a new photo row, whichever path it came in on.
 *
 *   resolveCredit({ guest })              guest upload
 *   resolveCredit({ localPath })          admin upload / import, file on disk
 *   resolveCredit({ localPath, isVideo }) videos carry no credit here
 *
 * `uploadedBy: 'guest'` without a guest (the optional name left empty) still
 * skips EXIF — the rule is about who uploaded, not whether they gave a name.
 */
async function resolveCredit({ guest = null, uploadedBy = null, localPath = null, isVideo = false } = {}) {
  if (guest || uploadedBy === 'guest') return guestCreditFields(guest);
  if (!localPath || isVideo) return {};
  const name = await extractExifCredit(localPath);
  return name ? { credit_name: name, credit_source: 'exif' } : {};
}

/**
 * Whether a later, automatic writer (the upload worker, the EXIF backfill)
 * may still fill in this row's credit.
 */
function creditOpenForExif(photo) {
  return !photo.credit_source && photo.uploaded_by !== 'guest';
}

/**
 * The columns for an admin correction. A string sets the name, null or an
 * empty string clears it — both as `manual`, so neither the upload worker nor
 * the EXIF backfill puts a name back on a photo the admin cleared.
 *
 * Returns null for a value that is neither (the route answers 400).
 */
function manualCreditFields(raw) {
  if (raw === null || raw === undefined) return { credit_name: null, credit_source: 'manual' };
  if (typeof raw !== 'string') return null;
  const name = creditName(raw);
  return { credit_name: name || null, credit_source: 'manual' };
}

/**
 * Erasure: a removed guest's name must not outlive them on the photos they
 * uploaded. The photos stay (they belong to the gallery); the credit and the
 * link to the removed identity go. Only `guest` credits are touched — an admin
 * who has since set a manual credit on the photo made a decision of their own.
 *
 * Returns the number of photos cleared.
 */
async function clearGuestCredits(guestIds, trx = db) {
  const ids = (Array.isArray(guestIds) ? guestIds : [guestIds]).map(Number).filter(Number.isFinite);
  if (ids.length === 0) return 0;
  const cleared = await trx('photos')
    .whereIn('uploader_guest_id', ids)
    .where('credit_source', 'guest')
    .update({ credit_name: null, credit_source: null, uploader_guest_id: null });
  // A manual credit keeps its text, but the link to the removed identity goes.
  // Not a guest credit: one inserted since the update above must keep its
  // link, so settleGuestCredit can still find and clear it.
  await trx('photos')
    .whereIn('uploader_guest_id', ids)
    .where((q) => q.whereNull('credit_source').orWhereNot('credit_source', 'guest'))
    .update({ uploader_guest_id: null });
  return cleared;
}

/**
 * An upload captures its credit before the file arrives, which can take
 * minutes. A guest erased in that window has already had clearGuestCredits
 * run, so the row inserted afterwards would carry the erased name. Called
 * after the insert: erasure marks the guest deleted before it clears, so
 * either this sees the deletion or the clear sees this row.
 */
async function settleGuestCredit(photoId, credit) {
  const guestId = credit && Number(credit.uploader_guest_id);
  if (!photoId || !Number.isFinite(guestId)) return;
  // Never fails the upload: the photo row is already in, and the caller's
  // cleanup would take the file away from under it.
  try {
    const guest = await db('gallery_guests').where({ id: guestId }).first('is_deleted');
    const gone = !guest || guest.is_deleted === true || Number(guest.is_deleted) === 1;
    if (!gone) return;
    await db('photos')
      .where({ id: photoId, uploader_guest_id: guestId, credit_source: 'guest' })
      .update({ credit_name: null, credit_source: null, uploader_guest_id: null });
    await db('photos')
      .where({ id: photoId, uploader_guest_id: guestId })
      .update({ uploader_guest_id: null });
  } catch (error) {
    logger.warn('Could not re-check the uploader of a new photo', { photoId, guestId, error: error.message });
  }
}

/**
 * A guest merge (#1210) folds duplicates into one identity. Their uploads
 * follow, and take the survivor's name so the "By" filter lists one person.
 */
async function reassignGuestCredits(fromGuestIds, toGuest, trx = db) {
  const ids = (Array.isArray(fromGuestIds) ? fromGuestIds : [fromGuestIds]).map(Number).filter(Number.isFinite);
  if (ids.length === 0 || !toGuest) return 0;
  const name = creditName(toGuest.name);
  // Guest credits first, while they can still be told apart by their ids.
  if (name) {
    await trx('photos')
      .whereIn('uploader_guest_id', ids)
      .where('credit_source', 'guest')
      .update({ credit_name: name });
  }
  return trx('photos')
    .whereIn('uploader_guest_id', ids)
    .update({ uploader_guest_id: toGuest.id });
}

module.exports = {
  clearGuestCredits,
  settleGuestCredit,
  reassignGuestCredits,
  CREDIT_SOURCES,
  CREDIT_NONE,
  GUEST_NAME_MODES,
  guestNameModeOf,
  creditFromMetadata,
  extractExifCredit,
  guestCreditFields,
  manualCreditFields,
  resolveCredit,
  creditOpenForExif,
  nameFromCopyright,
};
