/**
 * What PicPeak actually occupies on this machine (#1164).
 *
 * The dashboard's "Storage used" tile summed photos.size_bytes, which is the
 * catalogued size of the ORIGINALS — a number with no relationship to the disk
 * PicPeak runs on:
 *
 *   - in reference mode the originals are never copied. Those bytes are on the
 *     NAS. The reporter's tile read ~80 GB against 21 GB of real local usage.
 *   - duplicate rows counted the same file twice (#1162).
 *   - it ignored everything PicPeak genuinely does write: thumbnails, previews,
 *     hero renditions, and the per-event download cache — an 11.8 GB
 *     `.download-cache/all.zip` sat outside the figure entirely.
 *
 * So the one number an admin reaches for when asking "am I running out of
 * disk" pointed away from the answer and omitted exactly the things filling
 * the disk. This walks the storage root instead and reports what is there.
 *
 * Walking rather than summing DB columns is deliberate: thumbnail/preview/hero
 * rows record a key, never a byte count, and orphans (a deleted event's
 * leftovers, an interrupted import's thumbnails) are real bytes on a real
 * disk. A `du` is the only honest answer, and the only one that notices what
 * PicPeak has forgotten about.
 *
 * Cached, because it is one stat per file. On a large install that is seconds,
 * and the dashboard is polled.
 */

const path = require('path');
const fsp = require('fs').promises;
const logger = require('../utils/logger');
const { getStoragePath } = require('../config/storage');

const TTL_MS = 5 * 60 * 1000;

let cache = null;

/**
 * Which line of the breakdown a path belongs to.
 *
 * The names are the ones the writers actually use — `heroes` from
 * imageProcessor, `watermarks` from watermarkService, and so on — rather than
 * the ones the layout docs imply. Getting one wrong is not a crash, it is a
 * silent 30 MB in "other", which is the least useful place for it to land.
 *
 * `.download-cache` is the case that needs the explicit check: it lives INSIDE
 * an event directory, so the naive rule files an 11.8 GB zip as photography —
 * and it is the one bucket that is pure disposable cache, which makes it the
 * one an admin most wants to see on its own.
 *
 * `externalMedia` earns a line for the opposite reason. EXTERNAL_MEDIA_ROOT
 * usually points at a mount somewhere else entirely and never appears here at
 * all, but its dev/compose fallback is `<storage>/external-media`. Where that
 * applies the bytes ARE on this disk and belong in the total — just not
 * conflated with the artefacts PicPeak generates.
 */
function categorize(relPath) {
  const segments = relPath.split(path.sep);
  if (segments.includes('.download-cache')) return 'downloadCache';
  switch (segments[0]) {
  case 'thumbnails': return 'thumbnails';
  case 'previews': return 'previews';
  case 'heroes': return 'heroes';
  case 'watermarks': return 'watermarks';
  case 'uploads': return 'uploads';
  case 'temp': return 'temp';
  case 'business-docs': return 'businessDocs';
  case 'external-media': return 'externalMedia';
  case 'events':
    return segments[1] === 'archived' ? 'archives' : 'originals';
  default:
    return 'other';
  }
}

const EMPTY_BREAKDOWN = () => ({
  originals: 0,
  archives: 0,
  thumbnails: 0,
  previews: 0,
  heroes: 0,
  watermarks: 0,
  uploads: 0,
  businessDocs: 0,
  downloadCache: 0,
  externalMedia: 0,
  temp: 0,
  other: 0,
});

async function walk(absDir, relDir, acc) {
  let entries;
  try {
    entries = await fsp.readdir(absDir, { withFileTypes: true });
  } catch (err) {
    // A directory that is not there yet (a fresh install has no /previews) is
    // not an error. Anything else is worth knowing about but must not abort
    // the measurement — a partial number beats no number, and `partial` says
    // so to the caller.
    if (err.code !== 'ENOENT') {
      acc.partial = true;
      logger.debug?.(`localStorageUsage: skipped ${absDir}: ${err.message}`);
    }
    return;
  }

  for (const entry of entries) {
    const abs = path.join(absDir, entry.name);
    const rel = relDir ? path.join(relDir, entry.name) : entry.name;
    // Symlinks are not followed: a link into the external media mount would
    // otherwise add the NAS to the local total, which is the exact confusion
    // this replaces.
    if (entry.isDirectory()) {
      await walk(abs, rel, acc);
    } else if (entry.isFile()) {
      try {
        const stats = await fsp.stat(abs);
        acc.total += stats.size;
        acc.files += 1;
        acc.breakdown[categorize(rel)] += stats.size;
      } catch (err) {
        // Raced with a delete, most likely. Nothing to add.
        if (err.code !== 'ENOENT') acc.partial = true;
      }
    }
  }
}

/**
 * @param {{ force?: boolean }} [opts] force skips the TTL cache.
 * @returns {Promise<{total:number, files:number, breakdown:object, partial:boolean, measuredAt:string, root:string}>}
 */
async function measureLocalStorageUsage(opts = {}) {
  const now = Date.now();
  if (!opts.force && cache && now - cache.at < TTL_MS) return cache.value;

  const root = getStoragePath();
  const acc = { total: 0, files: 0, breakdown: EMPTY_BREAKDOWN(), partial: false };
  await walk(root, '', acc);

  const value = {
    total: acc.total,
    files: acc.files,
    breakdown: acc.breakdown,
    partial: acc.partial,
    measuredAt: new Date().toISOString(),
    root,
  };
  cache = { at: now, value };
  return value;
}

/** Test seam — the TTL cache would otherwise outlive a temp storage root. */
function resetLocalStorageUsageCache() {
  cache = null;
}

module.exports = {
  measureLocalStorageUsage,
  resetLocalStorageUsageCache,
};
