/**
 * Background scene-tagging workers (issue 1733).
 *
 * A near-copy of faceQueue.js, for the reason that one is a near-copy of
 * backgroundProcessor.js: same claim, same janitor, same tunable shape, and
 * the same rule that an unreachable sidecar returns the photo to 'pending'
 * with a backoff instead of failing it. Only a 4xx (an image the sidecar
 * cannot read) marks a row failed.
 *
 * It reads its own columns and runs in its own loop, so it never holds up an
 * upload or the face queue. Nothing is claimed while the `autoTagging`
 * feature flag is off.
 *
 * Tunables (env, all optional):
 *   TAG_PROCESSOR_CONCURRENCY        default 1
 *   TAG_PROCESSOR_POLL_MS            default 2000
 *   TAG_PROCESSOR_STUCK_TIMEOUT_MS   default 600000 (10 minutes)
 *   TAG_PROCESSOR_BACKOFF_MS         default 30000
 *   TAG_PROCESSOR_DISABLED           default false ('true' to opt out)
 */

const crypto = require('crypto');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { createInterruptibleSleep } = require('../utils/interruptibleSleep');
const { processPhotoTags, claimGuard, TagSourceUnreachableError } = require('./tagProcessor');
const { SidecarUnavailableError } = require('./faceClient');
const { isStorageUnavailableError } = require('./storage/storageErrors');
const { isTransient } = require('./imageResourcePolicy');
const { formatBoolean } = require('../utils/dbCompat');
const { livePhotos } = require('../utils/photoVisibility');
const { isFeatureEnabled } = require('./tagSettings');

const POLL_INTERVAL_MS = parseInt(process.env.TAG_PROCESSOR_POLL_MS || '2000', 10);
const CONCURRENCY = Math.max(1, parseInt(process.env.TAG_PROCESSOR_CONCURRENCY || '1', 10));
const STUCK_TIMEOUT_MS = parseInt(process.env.TAG_PROCESSOR_STUCK_TIMEOUT_MS || '600000', 10);
const UNAVAILABLE_BACKOFF_MS = parseInt(process.env.TAG_PROCESSOR_BACKOFF_MS || '30000', 10);
const JANITOR_INTERVAL_MS = 60 * 1000;

let running = false;
let workerHandles = [];
let janitorHandle = null;
let waits = null;
let stopping = null;
const sleep = (ms) => waits.sleep(ms);

function isPostgres() {
  const c = db.client.config.client;
  return c === 'pg' || (typeof c === 'string' && c.includes('postgres'));
}

/**
 * Atomically claim the oldest pending photo. SKIP LOCKED on Postgres so
 * several pods race cleanly, a status-guarded UPDATE on SQLite.
 *
 * Every claim gets its own id, and everything this worker writes afterwards
 * is guarded on it. 'processing' alone says only that somebody holds the
 * row: after a replacement or a janitor reset that can be a newer claim,
 * and a late answer for the old picture must not land on it.
 */
async function claimNextPhoto() {
  return db.transaction(async (trx) => {
    // Live photos only: a photo in the trash (issue 1733) waits for its restore.
    const query = livePhotos(trx).where('tag_status', 'pending')
      // An archived gallery keeps its photo rows and its switch, but its
      // thumbnails are gone and its originals are inside the archive: a claim
      // could only fail. The rows stay 'pending' and resume on restore.
      .whereNotIn('event_id', trx('events').where('is_archived', formatBoolean(true)).select('id'))
      .orderBy('id', 'asc');
    if (isPostgres()) query.forUpdate().skipLocked();
    const row = await query.first();
    if (!row) return null;
    const attemptId = crypto.randomUUID();
    const updated = await trx('photos')
      .where({ id: row.id, tag_status: 'pending' })
      .update({ tag_status: 'processing', tag_started_at: new Date().toISOString(), tag_attempt_id: attemptId });
    return updated > 0 ? { ...row, tag_status: 'processing', tag_attempt_id: attemptId } : null;
  });
}

// Guarded on this worker's claim: a photo deleted, reset or claimed again
// while the request was in flight must not come back as 'pending'.
function releaseToPending(claimed) {
  return claimGuard(claimed)
    .update({ tag_status: 'pending', tag_started_at: null, tag_attempt_id: null });
}

/**
 * Run one claimed photo to its next state.
 *
 * Returns 'retry' when the sidecar or the storage backend could not be
 * reached (the row is 'pending' again and the caller backs off), 'parked'
 * when the image worker said "not now" while rebuilding the thumbnail or
 * the photo's external source is not mounted, and
 * otherwise the photo's outcome: done | skipped | failed | requeued.
 */
async function runClaimed(claimed) {
  try {
    const outcome = await processPhotoTags(claimed);
    return outcome.status;
  } catch (err) {
    // Either failure stops every photo alike and says nothing about this one.
    if (err instanceof SidecarUnavailableError || isStorageUnavailableError(err)) {
      await releaseToPending(claimed).catch(() => {});
      return 'retry';
    }

    // The image worker being busy or timing out is no verdict on the photo
    // either, but it can be this photo's alone. Released, the oldest-first
    // claim would take the same row again after every pause and never reach
    // the next one, so it stays 'processing' and the janitor returns it
    // after TAG_PROCESSOR_STUCK_TIMEOUT_MS (what faceQueue does for a source
    // it cannot reach).
    // An external source that is not mounted is parked the same way.
    if (isTransient(err) || err instanceof TagSourceUnreachableError) {
      logger.warn(`tagQueue: photo ${claimed.id} deferred (${err.code || err.message})`);
      return 'parked';
    }

    logger.error(`tagQueue: photo ${claimed.id} failed`, { error: err.message });
    await claimGuard(claimed)
      .update({
        tag_status: 'failed',
        tag_started_at: null,
        tag_attempt_id: null,
        tag_error: String(err.message || err).slice(0, 1000),
      })
      .catch((updateErr) => logger.error(`tagQueue: could not mark photo ${claimed.id} failed`, {
        error: updateErr.message,
      }));
    return 'failed';
  }
}

/** Return rows a dead worker left in 'processing'. */
async function resetStuck() {
  const cutoff = new Date(Date.now() - STUCK_TIMEOUT_MS).toISOString();
  return db('photos')
    .where('tag_status', 'processing')
    .where('tag_started_at', '<', cutoff)
    .update({ tag_status: 'pending', tag_started_at: null, tag_attempt_id: null });
}

async function workerLoop(workerIdx) {
  while (running) {
    // Re-checked every tick: switching the flag off stops the workers
    // without a restart.
    if (!(await isFeatureEnabled())) {
      await sleep(POLL_INTERVAL_MS * 5);
      continue;
    }
    if (!running) break;

    let claimed;
    try {
      claimed = await claimNextPhoto();
    } catch (e) {
      logger.warn(`tagQueue[${workerIdx}]: claim error`, { error: e.message });
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    if (!claimed) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Without the backoff a down sidecar is a hot loop: claim, fail,
    // release, claim again.
    if ((await runClaimed(claimed)) === 'retry') await sleep(UNAVAILABLE_BACKOFF_MS);
  }
}

async function janitorLoop() {
  while (running) {
    try {
      const reset = await resetStuck();
      if (reset > 0) {
        logger.warn(`tagQueue: janitor reset ${reset} stuck photo(s) from 'processing' to 'pending'`);
      }
    } catch (e) {
      logger.warn('tagQueue: janitor error', { error: e.message });
    }
    await sleep(JANITOR_INTERVAL_MS);
  }
}

function start() {
  if (running || stopping) return;
  if (process.env.TAG_PROCESSOR_DISABLED === 'true') {
    logger.info('tagQueue: disabled via TAG_PROCESSOR_DISABLED');
    return;
  }

  waits = createInterruptibleSleep();
  running = true;
  workerHandles = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    workerHandles.push(
      workerLoop(i).catch((e) => logger.error(`tagQueue[${i}]: crashed`, { error: e.message, stack: e.stack }))
    );
  }
  janitorHandle = janitorLoop().catch((e) => logger.error('tagQueue: janitor crashed', { error: e.message, stack: e.stack }));

  logger.info(
    `tagQueue: started ${CONCURRENCY} worker(s), poll=${POLL_INTERVAL_MS}ms `
    + '(idle until the `autoTagging` feature flag is enabled)'
  );
}

function stop() {
  if (stopping) return stopping;
  if (!running) return Promise.resolve();
  running = false;
  waits.cancel();
  stopping = Promise.all([...workerHandles, janitorHandle].filter(Boolean)).finally(() => {
    workerHandles = [];
    janitorHandle = null;
    waits = null;
    stopping = null;
  });
  return stopping;
}

module.exports = { start, stop, claimNextPhoto, runClaimed, resetStuck };
