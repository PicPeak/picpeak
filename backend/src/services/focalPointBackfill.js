/**
 * Gives the photos already in the library a focal point (issue 2377).
 *
 * Every thumbnail cut since migration 348 detects where the subject is; the
 * photos from before keep the centre crop until something rebuilds their
 * thumbnail. photos.focal_checked (migration 349) is 0 for those. One
 * background pass per boot cuts each one again through the ordinary rebuild
 * (ensureThumbnail with `redetect`): from the faces the face scan found where
 * there are any, from sharp's guess otherwise. The rebuild records the point
 * with its crop and drops the old tiers; a point set by hand is kept, and
 * such a photo is only marked. An admin's "Detect again" for a gallery
 * (adminPhotos) sets its photos back to 0 and asks for a pass now
 * (requestPass).
 *
 * Resumable: a row is marked once it is done, so a restart picks up the rest.
 * A row whose rebuild fails stays at 0 and is tried again on the next boot.
 * Videos have no point and are marked as they come. Trashed photos and
 * archived galleries are left for later, as the rendition refresh does.
 *
 * One runner across replicas (the maintenance_jobs claim
 * `focal_point_backfill`), one photo at a time with a pause between, and it
 * waits while the upload pipeline has work, like renditionRefresh.
 *
 * Tunables (env, all optional):
 *   FOCAL_BACKFILL_DISABLED   'true' to skip the boot pass (a gallery's Detect again still runs)
 *   FOCAL_BACKFILL_DELAY_MS   default 60000, wait after boot
 *   FOCAL_BACKFILL_PAUSE_MS   default 200, pause between photos
 */

const { db } = require('../database/db');
const loadGovernor = require('./loadGovernor');
const logger = require('../utils/logger');
const { livePhotos, wherePhotoProcessed } = require('../utils/photoVisibility');
const { createInterruptibleSleep } = require('../utils/interruptibleSleep');
const maintenanceJobs = require('./maintenanceJobState');

const JOB_NAME = 'focal_point_backfill';
const BATCH = 100;
const PROGRESS_EVERY = 500;
const RETRY_CLAIM_MS = 10 * 60 * 1000;
const YIELD_POLL_MS = 15 * 1000;
const YIELD_MAX_MS = 5 * 60 * 1000;
const intEnv = (name, fallback) => {
  const value = parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

const isVideo = (photo) => photo.media_type === 'video' || photo.type === 'video'
  || Boolean(photo.mime_type && photo.mime_type.startsWith('video/'));

function candidates() {
  return wherePhotoProcessed(livePhotos(db))
    .join('events', 'photos.event_id', 'events.id')
    .where('photos.focal_checked', 0)
    .where(function () {
      this.where('events.is_archived', false).orWhereNull('events.is_archived');
    });
}

async function markChecked(photoId) {
  await db('photos').where({ id: photoId }).update({ focal_checked: 1 });
}

/** Cut one photo around its detected point and mark it; false (logged) leaves it for the next boot. */
async function backfillPhoto(photo) {
  try {
    // A point set by hand stays: only marked (the rebuild would keep it too).
    if (!isVideo(photo) && photo.focal_source !== 'manual') {
      const key = await require('./imageProcessor').ensureThumbnail(photo, { force: true, focalPoint: { redetect: true } });
      if (!key) {
        logger.warn(`Focal point backfill: photo ${photo.id} could not be cut again; it is retried on the next pass`);
        return false;
      }
    }
    await markChecked(photo.id);
    return true;
  } catch (err) {
    logger.warn(`Focal point backfill: photo ${photo.id} failed: ${err.message}`);
    return false;
  }
}

let running = false;
let loop = null;
let waits = null;
let rerunRequested = false;

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
 * One pass while holding the claim: 'busy' when another replica holds it,
 * otherwise the counts. A caller running a pass on its own (the tests)
 * passes its own `active` and `sleep`.
 */
async function runPass({ active = () => running, sleep = (ms) => waits.sleep(ms) } = {}) {
  await maintenanceJobs.ensure(JOB_NAME);
  const token = await maintenanceJobs.claim(JOB_NAME);
  if (!token) return 'busy';
  const lease = maintenanceJobs.startLeaseKeeper(JOB_NAME, token);
  const counts = { done: 0, failed: 0 };
  const pause = intEnv('FOCAL_BACKFILL_PAUSE_MS', 200);
  let lost = false;

  try {
    const pending = Number((await candidates().count('photos.id as count').first()).count);
    if (pending === 0) {
      await maintenanceJobs.release(JOB_NAME, token);
      return counts;
    }
    logger.info(`Focal point backfill: ${pending} photos were cut before focal points; cutting them again in the background`);

    // By id; a failed row stays at 0, so the cursor moves the walk past it.
    let lastId = 0;
    while (active() && !lost) {
      const batch = await candidates().where('photos.id', '>', lastId).orderBy('photos.id').limit(BATCH).select('photos.*');
      if (batch.length === 0) break;
      for (const photo of batch) {
        lastId = photo.id;
        await yieldToUploads(active, sleep);
        if (!active()) break;
        if (lease.lost()) { lost = true; break; }
        if (await backfillPhoto(photo)) counts.done++; else counts.failed++;
        if ((counts.done + counts.failed) % PROGRESS_EVERY === 0) {
          logger.info(`Focal point backfill: ${counts.done} photos done, ${counts.failed} failed so far`);
        }
        const wait = Math.max(pause, loadGovernor.bulkDelayMs());
        if (wait) await sleep(wait);
      }
    }

    if (lost) {
      logger.warn(`Focal point backfill stopped: claim taken over after ${counts.done} done, ${counts.failed} failed`);
      return counts;
    }
    if (!active()) {
      await maintenanceJobs.release(JOB_NAME, token);
      logger.info(`Focal point backfill paused for shutdown after ${counts.done} done, ${counts.failed} failed`);
      return counts;
    }
    await maintenanceJobs.release(JOB_NAME, token, counts);
    logger.info(`Focal point backfill complete: ${counts.done} photos done, ${counts.failed} failed (retried on the next start)`);
    return counts;
  } catch (err) {
    await maintenanceJobs.release(JOB_NAME, token, { ...counts, error: err.message }).catch(() => {});
    throw err;
  } finally {
    lease.stop();
  }
}

async function runLoop(delayMs) {
  await waits.sleep(delayMs);
  while (running) {
    let outcome;
    try {
      outcome = await runPass();
    } catch (err) {
      logger.error('Focal point backfill aborted; it runs again on the next start', { error: err.message });
      return;
    }
    if (outcome !== 'busy') {
      // Rows queued while this pass ran may lie behind its cursor.
      if (!rerunRequested) return;
      rerunRequested = false;
      continue;
    }
    // Another replica holds the claim: if it finishes, the next try finds
    // nothing left; if it died, its lease goes stale and is taken.
    await waits.sleep(RETRY_CLAIM_MS);
  }
}

/** The boot pass. `requested`: an admin asked (requestPass), so no delay and no opt-out. */
function start({ requested = false } = {}) {
  if (loop) return;
  if (!requested && process.env.FOCAL_BACKFILL_DISABLED === 'true') {
    logger.info('Focal point backfill: disabled via FOCAL_BACKFILL_DISABLED');
    return;
  }
  running = true;
  waits = createInterruptibleSleep();
  const current = runLoop(requested ? 0 : intEnv('FOCAL_BACKFILL_DELAY_MS', 60000))
    .catch((err) => logger.error('Focal point backfill crashed', { error: err.message, stack: err.stack }))
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

/** Run a pass now: start the loop, or have the running one walk again when it is done. */
function requestPass() {
  if (!loop) start({ requested: true });
  else rerunRequested = true;
}

module.exports = { JOB_NAME, backfillPhoto, runPass, requestPass, start, stop };
