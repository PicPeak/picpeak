/**
 * Regenerates renditions written before derived images were stripped of the
 * source's EXIF (issue 2096).
 *
 * Until PR 2080 every thumbnail, preview and hero kept the original's GPS
 * position, camera make and copyright. New renditions are clean; the ones
 * already in storage are not, and nothing rewrites them on its own. Each
 * photo row carries photos.rendition_version (migration 311): 0 for rows that
 * predate the fix, RENDITION_VERSION for rows whose renditions are clean.
 *
 * One background pass per boot, after a short delay:
 *   1. the public OG covers first: the hero photo of every gallery that opted
 *      into a link-preview image. Its thumbnail is the only rendition anyone
 *      can fetch without the gallery password. handleGalleryOgCover also
 *      refreshes a cover on its first request (refreshCover), so a crawler
 *      never gets an old one while the pass has not reached it.
 *   2. every other live photo of a gallery that is not archived, by id.
 *
 * Per photo it rebuilds what exists through the ordinary rendition code
 * (ensureThumbnail / ensurePreviewImage / ensureHeroImage, as the admin
 * "Regenerate thumbnails" action does), drops the responsive tiers so they are
 * cut again on demand, deletes a superseded key no row uses any more, and only
 * then raises the row's version. Originals and the pre-generated watermark
 * copies are not touched; the watermark copies were always stripped.
 *
 * Resumable: a row is marked when its renditions are done, so a restart picks
 * up the rows still at 0. A row that fails stays at 0 and is retried on the
 * next boot. Trashed photos are skipped and keep 0, so a restore from the
 * trash is cleaned on the next boot.
 *
 * One runner across replicas: the pass holds the maintenance_jobs claim
 * (`rendition_exif_refresh`) with the usual lease. A replica that finds it
 * taken waits and tries again until the holder is done.
 *
 * Low priority: one photo at a time, a pause between photos, and while the
 * upload pipeline has photos waiting or in flight the pass waits for it (up to
 * YIELD_MAX_MS per photo, so a stuck pending row cannot stop it for good).
 *
 * Tunables (env, all optional):
 *   RENDITION_REFRESH_DISABLED     'true' to skip the pass (e.g. CI)
 *   RENDITION_REFRESH_DELAY_MS     default 30000, wait after boot
 *   RENDITION_REFRESH_PAUSE_MS     default 200, pause between photos
 */

const { db } = require('../database/db');
const logger = require('../utils/logger');
const { livePhotos, wherePhotoProcessed } = require('../utils/photoVisibility');
const { createInterruptibleSleep } = require('../utils/interruptibleSleep');
const { sameStorageKey } = require('../utils/storageKey');
const maintenanceJobs = require('./maintenanceJobState');
const { isPresentationRenditionKey } = require('./galleryAssetPolicy');

// 1: thumbnails, previews and heroes carry no source EXIF (issue 2096).
const RENDITION_VERSION = 1;
const JOB_NAME = 'rendition_exif_refresh';

const BATCH = 100;
const PROGRESS_EVERY = 500;
const RETRY_CLAIM_MS = 10 * 60 * 1000;
const YIELD_POLL_MS = 15 * 1000;
const YIELD_MAX_MS = 5 * 60 * 1000;
const COVER_RETRY_MS = 10 * 60 * 1000;
const intEnv = (name, fallback) => {
  const value = parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

// What the rendition helpers need to resolve a source and name its outputs;
// the same columns the admin regenerate actions select, plus the hero's.
const PHOTO_COLUMNS = [
  'id', 'event_id', 'path', 'media_type', 'mime_type', 'processing_status',
  'thumbnail_path', 'preview_path', 'hero_path', 'hero_anchor',
  'source_origin', 'external_relpath', 'filename', 'size_bytes', 'source_mtime_ms', 'source_filename',
  'rendition_version',
];

const needsRefresh = (photo) => photo != null && photo.rendition_version != null
  && Number(photo.rendition_version) < RENDITION_VERSION;

const isVideo = (photo) => photo.media_type === 'video' || String(photo.mime_type || '').startsWith('video/');

/**
 * Live, processed photos below the current version in galleries whose
 * renditions exist (an archived gallery's went with the archive).
 */
function candidates() {
  return wherePhotoProcessed(livePhotos(db))
    .join('events', 'photos.event_id', 'events.id')
    .where('photos.rendition_version', '<', RENDITION_VERSION)
    .where(function () {
      this.where('events.is_archived', false).orWhereNull('events.is_archived');
    });
}

const selectPhoto = (query) => query.select(PHOTO_COLUMNS.map((column) => `photos.${column}`));

const RENDITION_KIND = { thumbnail_path: 'thumbnail', preview_path: 'preview', hero_path: 'hero' };

/**
 * Delete a rendition key this photo no longer points at, unless another row
 * (trashed rows included: they are restorable) still uses it. On local
 * storage the key usually stays the same and the new file replaced the old
 * one; on S3 a managed source renders from a temp copy and the key moves.
 *
 * Only a key in that rendition's own namespace is ever deleted. A legacy row
 * can point its rendition column at the original (or anything else); the
 * column is no authority to delete that file, and this runs unattended.
 */
async function dropSuperseded(photo, column, oldKey, newKey) {
  if (!oldKey || !newKey || sameStorageKey(oldKey, newKey)) return;
  if (!isPresentationRenditionKey(oldKey, RENDITION_KIND[column])) return;
  try {
    const shared = await db('photos')
      .where(function () {
        this.where('thumbnail_path', oldKey).orWhere('preview_path', oldKey).orWhere('hero_path', oldKey);
      })
      .first('id');
    if (shared) return;
    await require('./storage').getStorage().delete(oldKey);
  } catch (err) {
    // Losing the old object is untidy, not a failed refresh.
    logger.warn(`Rendition refresh: could not remove superseded ${column} ${oldKey} of photo ${photo.id}: ${err.message}`);
  }
}

/**
 * Rebuild the stored renditions of one photo. True when every rendition it
 * had was regenerated (or it had none); false leaves the row for a later pass.
 */
async function refreshPhoto(photo) {
  // A video's thumbnail is an ffmpeg poster frame; it never carried the
  // source's EXIF, and videos have no preview or hero rendition.
  if (isVideo(photo)) return true;

  const imageProcessor = require('./imageProcessor');

  // Tiers are a cache recorded nowhere, cut again from the source on demand.
  await imageProcessor.deleteThumbnailTiers(photo);
  await imageProcessor.deletePreviewTiers(photo);

  if (photo.thumbnail_path) {
    // Nulled so the validity check does not keep the old file, forced so a
    // lazy generation already in flight is not adopted (as adminThumbnails).
    const key = await imageProcessor.ensureThumbnail({ ...photo, thumbnail_path: null }, { force: true });
    if (!key) return false;
    await dropSuperseded(photo, 'thumbnail_path', photo.thumbnail_path, key);
  }
  if (photo.preview_path) {
    const key = await imageProcessor.ensurePreviewImage({ ...photo, preview_path: null }, { force: true });
    if (!key) return false;
    await dropSuperseded(photo, 'preview_path', photo.preview_path, key);
  }
  if (photo.hero_path) {
    // No anchor: cut at the gallery's current focal point, as a request would.
    const key = await imageProcessor.ensureHeroImage({ ...photo, hero_path: null });
    if (!key) return false;
    await dropSuperseded(photo, 'hero_path', photo.hero_path, key);
  }
  return true;
}

async function markRefreshed(photoId) {
  await db('photos')
    .where({ id: photoId })
    .where('rendition_version', '<', RENDITION_VERSION)
    .update({ rendition_version: RENDITION_VERSION });
}

/** Refresh and mark one photo; false (logged) when it has to wait for a later pass. */
async function refreshAndMark(photo) {
  try {
    if (!(await refreshPhoto(photo))) {
      logger.warn(`Rendition refresh: photo ${photo.id} could not be regenerated; it is retried on the next pass`);
      return false;
    }
    await markRefreshed(photo.id);
    return true;
  } catch (err) {
    logger.warn(`Rendition refresh: photo ${photo.id} failed: ${err.message}`);
    return false;
  }
}

// OG cover refreshes in this process: one flight per photo, and a failed one
// is not retried on every crawler hit.
const coverFlights = new Map();
const coverFailures = new Map();

/**
 * Make sure the public OG cover photo has clean renditions before it is
 * served. True when it is clean (already, or now); false when it could not
 * be regenerated, in which case the caller must not serve the old file.
 */
async function refreshCover(photo) {
  if (!needsRefresh(photo)) return true;
  const failedAt = coverFailures.get(photo.id);
  if (failedAt && Date.now() - failedAt < COVER_RETRY_MS) return false;
  let flight = coverFlights.get(photo.id);
  if (!flight) {
    flight = (async () => {
      const row = await selectPhoto(livePhotos(db).where('photos.id', photo.id)).first();
      if (!row || !needsRefresh(row)) return true;
      return refreshAndMark(row);
    })().then((ok) => {
      if (ok) coverFailures.delete(photo.id); else coverFailures.set(photo.id, Date.now());
      return ok;
    }, (err) => {
      logger.warn(`Rendition refresh: OG cover photo ${photo.id} failed: ${err.message}`);
      coverFailures.set(photo.id, Date.now());
      return false;
    }).finally(() => coverFlights.delete(photo.id));
    coverFlights.set(photo.id, flight);
  }
  return flight;
}

let running = false;
let loop = null;
let waits = null;

/** Wait while the upload pipeline has work, bounded so the pass still moves. */
async function yieldToUploads(active, sleep) {
  const started = Date.now();
  while (active() && Date.now() - started < YIELD_MAX_MS) {
    const busy = await db('photos').whereIn('processing_status', ['pending', 'processing']).first('id');
    if (!busy) return;
    await sleep(YIELD_POLL_MS);
  }
}

/**
 * One pass while holding the claim. Returns 'busy' when another replica holds
 * it, otherwise the counts. `active` and `sleep` default to the started
 * service's; a caller running a pass on its own (the tests) passes its own.
 */
async function runPass({ active = () => running, sleep = (ms) => waits.sleep(ms) } = {}) {
  await maintenanceJobs.ensure(JOB_NAME);
  const token = await maintenanceJobs.claim(JOB_NAME);
  if (!token) return 'busy';
  const lease = maintenanceJobs.startLeaseKeeper(JOB_NAME, token);
  const counts = { refreshed: 0, failed: 0 };
  let lost = false;
  const pause = intEnv('RENDITION_REFRESH_PAUSE_MS', 200);

  const work = async (photo) => {
    await yieldToUploads(active, sleep);
    if (!active()) return false;
    if (lease.lost()) { lost = true; return false; }
    if (await refreshAndMark(photo)) counts.refreshed++; else counts.failed++;
    const done = counts.refreshed + counts.failed;
    if (done % PROGRESS_EVERY === 0) {
      logger.info(`Rendition refresh: ${counts.refreshed} photos cleaned, ${counts.failed} failed so far`);
    }
    if (pause) await sleep(pause);
    return true;
  };

  try {
    const pending = Number((await candidates().count('photos.id as count').first()).count);
    if (pending === 0) {
      await maintenanceJobs.release(JOB_NAME, token);
      return counts;
    }
    logger.info(`Rendition refresh: ${pending} photos have renditions from before EXIF stripping; regenerating them in the background`);

    // 1. Public OG covers.
    const covers = await selectPhoto(candidates()
      .where('events.og_image_share_enabled', true)
      .whereRaw('?? = ??', ['events.hero_photo_id', 'photos.id'])
      .orderBy('photos.id'));
    for (const photo of covers) {
      if (!(await work(photo))) break;
    }

    // 2. Everything else, by id. A failed row stays below the version, so the
    //    cursor (not the version) moves the walk past it.
    let lastId = 0;
    while (active() && !lost) {
      const batch = await selectPhoto(candidates().where('photos.id', '>', lastId).orderBy('photos.id').limit(BATCH));
      if (batch.length === 0) break;
      for (const photo of batch) {
        lastId = photo.id;
        if (!(await work(photo))) break;
      }
    }

    if (lost) {
      logger.warn(`Rendition refresh stopped: claim taken over after ${counts.refreshed} cleaned, ${counts.failed} failed`);
      return counts;
    }
    if (!active()) {
      // Shutdown: the rows still at 0 are picked up on the next boot.
      await maintenanceJobs.release(JOB_NAME, token);
      logger.info(`Rendition refresh paused for shutdown after ${counts.refreshed} cleaned, ${counts.failed} failed`);
      return counts;
    }
    await maintenanceJobs.release(JOB_NAME, token, counts);
    logger.info(`Rendition refresh complete: ${counts.refreshed} photos cleaned, ${counts.failed} failed (retried on the next start)`);
    return counts;
  } catch (err) {
    await maintenanceJobs.release(JOB_NAME, token, { ...counts, error: err.message }).catch(() => {});
    throw err;
  } finally {
    lease.stop();
  }
}

async function runLoop() {
  await waits.sleep(intEnv('RENDITION_REFRESH_DELAY_MS', 30000));
  while (running) {
    let outcome;
    try {
      outcome = await runPass();
    } catch (err) {
      logger.error('Rendition refresh aborted; it runs again on the next start', { error: err.message });
      return;
    }
    if (outcome !== 'busy') return;
    // Another replica holds the claim. Try again later: if it finishes, the
    // pass finds nothing left; if it died, its lease goes stale and is taken.
    await waits.sleep(RETRY_CLAIM_MS);
  }
}

function start() {
  // Also while a stopped loop is still finishing its photo: a second loop
  // would read the same `running` flag and both would walk the library.
  if (loop) return;
  if (process.env.RENDITION_REFRESH_DISABLED === 'true') {
    logger.info('Rendition refresh: disabled via RENDITION_REFRESH_DISABLED');
    return;
  }
  running = true;
  waits = createInterruptibleSleep();
  const current = runLoop()
    .catch((err) => logger.error('Rendition refresh crashed', { error: err.message, stack: err.stack }))
    .finally(() => {
      if (loop === current) {
        loop = null;
        running = false;
      }
    });
  loop = current;
}

/** Stops after the photo in flight; the pass resumes on the next start. */
function stop() {
  if (!loop) return Promise.resolve();
  running = false;
  waits.cancel();
  return loop;
}

/** Progress for the admin status endpoint. */
async function status() {
  const counts = await wherePhotoProcessed(livePhotos(db))
    .join('events', 'photos.event_id', 'events.id')
    .where(function () {
      this.where('events.is_archived', false).orWhereNull('events.is_archived');
    })
    .count('photos.id as total')
    .count({ pending: db.raw('CASE WHEN photos.rendition_version < ? THEN 1 END', [RENDITION_VERSION]) })
    .first();
  const state = await maintenanceJobs.read(JOB_NAME);
  const total = Number(counts.total);
  const pending = Number(counts.pending);
  return {
    total,
    refreshed: total - pending,
    pending,
    isRunning: state.isRunning,
    lastResult: state.lastResult,
    finishedAt: state.finishedAt,
  };
}

module.exports = {
  RENDITION_VERSION,
  JOB_NAME,
  needsRefresh,
  refreshPhoto,
  refreshCover,
  runPass,
  start,
  stop,
  status,
};
