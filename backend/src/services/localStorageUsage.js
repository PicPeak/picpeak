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
 * The external media root is EXCLUDED, and that is the whole point rather than
 * a detail. Its compose default is `<storage>/external-media`, where the NAS is
 * bind-mounted — a plain directory, not a symlink — so walking it would add
 * every referenced original back into a figure that exists to leave them out,
 * and compare NAS bytes against statfs() of the local disk. That is the
 * over-count this replaces, reintroduced by the fix for it.
 *
 * Cached, because it is one stat per file. On a large install that is seconds,
 * and the dashboard is polled — and concurrent misses share one walk rather
 * than each starting their own.
 */

const path = require('path');
const fsp = require('fs').promises;
const logger = require('../utils/logger');
const { getStoragePath } = require('../config/storage');

const TTL_MS = 5 * 60 * 1000;

let cache = null;
// The walk in flight, if any. Two admins loading the dashboard, or the sidebar
// and the storage tab on one page, hit the same cold cache and would otherwise
// each stat every file on the disk.
let inFlight = null;

/**
 * The external media root, resolved, when it lies inside the storage root.
 * Returns null when it is elsewhere (the usual production case) or cannot be
 * resolved — nothing to exclude then.
 */
function nestedExternalRoot(storageRoot) {
  let externalRoot;
  try {
    externalRoot = require('./externalMediaService').getExternalMediaRoot();
  } catch (err) {
    return null;
  }
  if (!externalRoot) return null;
  const resolvedExternal = path.resolve(externalRoot);
  const resolvedStorage = path.resolve(storageRoot);
  if (resolvedExternal === resolvedStorage) return null;
  return resolvedExternal.startsWith(resolvedStorage + path.sep) ? resolvedExternal : null;
}

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
 * There is no external-media bucket: that subtree is not walked at all (see
 * nestedExternalRoot). Those bytes live on the media share, and counting them
 * is the exact over-count this measurement exists to end.
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
  temp: 0,
  other: 0,
});

async function walk(absDir, relDir, acc) {
  // The media share, bind-mounted under the storage root. Walking it would put
  // every referenced original back into a local-usage figure, and on a real
  // NAS the traversal alone would take far longer than the measurement is
  // worth.
  if (acc.excludeRoot && path.resolve(absDir) === acc.excludeRoot) {
    acc.excludedExternalRoot = acc.excludeRoot;
    return;
  }

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
  // Share a walk already underway rather than starting a second one.
  if (!opts.force && inFlight) return inFlight;

  inFlight = runMeasurement()
    .then((value) => { cache = { at: Date.now(), value }; return value; })
    .finally(() => { inFlight = null; });
  return inFlight;
}

async function runMeasurement() {

  const root = getStoragePath();
  const acc = {
    total: 0,
    files: 0,
    breakdown: EMPTY_BREAKDOWN(),
    partial: false,
    excludeRoot: nestedExternalRoot(root),
    excludedExternalRoot: null,
  };
  await walk(root, '', acc);

  return {
    total: acc.total,
    files: acc.files,
    breakdown: acc.breakdown,
    partial: acc.partial,
    // Set when the media share sits inside the storage root and was skipped,
    // so the UI can say why the figure is smaller than `du` would report.
    excludedExternalRoot: acc.excludedExternalRoot,
    measuredAt: new Date().toISOString(),
    root,
  };
}

/** Test seam — the TTL cache would otherwise outlive a temp storage root. */
function resetLocalStorageUsageCache() {
  cache = null;
  inFlight = null;
}

module.exports = {
  measureLocalStorageUsage,
  resetLocalStorageUsageCache,
};
