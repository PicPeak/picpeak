/**
 * Worker pool for adaptive streaming ladders (issue 1733, D4).
 *
 * The same queue as videoRenditionQueue.js, on the same claim, attempt and
 * janitor code (mediaAttemptService, kind 'hls'), so two replicas never
 * transcode the same video and a row whose worker died goes back to
 * 'pending'. What differs:
 *
 *   - gated on `general_video_adaptive_streaming`, re-read every tick. Off
 *     means nothing is queued and nothing is claimed.
 *   - rows are queued here, not at every ingest path: an idle worker marks
 *     the videos nobody has looked at yet (one UPDATE, at most once a
 *     minute), so an upload, an import and a restored archive all arrive
 *     the same way.
 *   - uploads go first: while a photo or video is still being processed, no
 *     ladder is started.
 *
 * ffmpeg runs in the runner's transcode lane, so a ladder and a web copy
 * share VIDEO_RENDITION_CONCURRENCY (default 1) between them.
 *
 * Tunables (env, all optional):
 *   VIDEO_HLS_CONCURRENCY        default 1
 *   VIDEO_HLS_POLL_MS            default 5000
 *   VIDEO_HLS_STUCK_TIMEOUT_MS   default 7200000 (2 hours)
 *   VIDEO_HLS_DISABLED           default false ('true' to opt out, e.g. CI)
 */

const { db } = require('../database/db');
const logger = require('../utils/logger');
const { createInterruptibleSleep } = require('../utils/interruptibleSleep');
const { isEnabled, queuePending, renderLadder } = require('./videoHlsService');
const mediaAttempts = require('./mediaAttemptService');
const { isTransient } = require('./imageResourcePolicy');
const { livePhotos } = require('../utils/photoVisibility');

const RETRY_BACKOFF_MS = 60000;
const QUEUE_INTERVAL_MS = 60000;

const POLL_INTERVAL_MS = parseInt(process.env.VIDEO_HLS_POLL_MS || '5000', 10);
const CONCURRENCY = Math.min(8, Math.max(1, parseInt(process.env.VIDEO_HLS_CONCURRENCY || '1', 10) || 1));
const STUCK_TIMEOUT_MS = parseInt(process.env.VIDEO_HLS_STUCK_TIMEOUT_MS || '7200000', 10);
const JANITOR_INTERVAL_MS = 60 * 1000;

let running = false;
let workerHandles = [];
let janitorHandle = null;
let lastQueuedAt = 0;

let waits = null;
let stopping = null;
const sleep = (ms) => waits.sleep(ms);

/**
 * Whether an upload is still waiting for, or in, the photo queue. Live photos
 * only: the photo queue does not claim a trashed row, so one left pending
 * would hold every ladder back until it is purged.
 */
async function uploadsBusy() {
  return !!(await livePhotos(db).whereIn('processing_status', ['pending', 'processing']).first('id'));
}

/** Atomically claim the oldest pending video. Returns the row or null. */
async function claimNext() {
  const outcome = await mediaAttempts.claimNext('hls');
  // A video that used up its attempts was recorded as failed by the claim.
  return outcome?.exhausted ? null : outcome;
}

async function workerLoop(workerIdx) {
  while (running) {
    if (!(await isEnabled())) {
      await sleep(POLL_INTERVAL_MS * 5);
      continue;
    }
    if (!running) break;

    let claimed;
    try {
      if (await uploadsBusy()) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      claimed = await claimNext();
      if (!claimed && Date.now() - lastQueuedAt >= QUEUE_INTERVAL_MS) {
        lastQueuedAt = Date.now();
        if (await queuePending() > 0) continue;
      }
    } catch (e) {
      logger.warn(`videoHlsQueue[${workerIdx}]: claim error`, { error: e.message });
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (!claimed) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    try {
      await mediaAttempts.execute(claimed, 'hls', () => renderLadder(claimed.id));
    } catch (err) {
      if (err.code === 'MEDIA_SUPERSEDED') continue;
      // Guarded on this worker's attempt id and source, as in the web copy
      // queue: a delete, a replacement or the janitor has already moved the
      // row on. Only hls_* columns are written: a failed ladder never
      // changes how the video is shown, it plays the way it did before.
      const mine = { id: claimed.id, hls_status: 'processing', hls_attempt_id: claimed.hls_attempt_id,
        path: claimed.path, filename: claimed.filename };
      const attempts = Number(claimed.hls_attempts || 0);
      const paused = !running && /_CANCELLED$/.test(err.code || '');
      const requeue = paused || (isTransient(err) && attempts < mediaAttempts.MAX_ATTEMPTS);
      logger[requeue ? 'warn' : 'error'](`videoHlsQueue[${workerIdx}]: video ${claimed.id} ${requeue ? `requeued (${err.code})` : 'failed'}`, {
        error: err.message,
      });
      try {
        await db('photos').where(mine).update(requeue ? {
          hls_status: 'pending',
          hls_started_at: null,
          ...(paused ? { hls_attempts: Math.max(0, attempts - 1), hls_retry_at: null }
            : { hls_retry_at: new Date(Date.now() + RETRY_BACKOFF_MS * attempts).toISOString() }),
        } : {
          hls_status: 'failed',
          hls_started_at: null,
          hls_error: String(err.message || err).split('\n')[0].slice(0, 1000),
        });
      } catch (updateErr) {
        logger.error(`videoHlsQueue[${workerIdx}]: failed to record the outcome of video ${claimed.id}`, {
          error: updateErr.message,
        });
      }
    }
  }
}

async function janitorLoop() {
  while (running) {
    try {
      if (await isEnabled()) {
        const cutoff = new Date(Date.now() - STUCK_TIMEOUT_MS).toISOString();
        const reset = await mediaAttempts.recover('hls', cutoff);
        if (reset > 0) {
          logger.warn(`videoHlsQueue: janitor reset ${reset} stuck video(s) from 'processing' to 'pending'`);
        }
      }
    } catch (e) {
      logger.warn('videoHlsQueue: janitor error', { error: e.message });
    }
    await sleep(JANITOR_INTERVAL_MS);
  }
}

function start() {
  if (running || stopping) return;
  if (process.env.VIDEO_HLS_DISABLED === 'true') {
    logger.info('videoHlsQueue: disabled via VIDEO_HLS_DISABLED');
    return;
  }

  waits = createInterruptibleSleep();
  require('./mediaProcessService').start();
  running = true;
  lastQueuedAt = 0;
  workerHandles = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    workerHandles.push(
      workerLoop(i).catch((e) =>
        logger.error(`videoHlsQueue[${i}]: crashed`, { error: e.message, stack: e.stack })
      )
    );
  }
  janitorHandle = janitorLoop().catch((e) =>
    logger.error('videoHlsQueue: janitor crashed', { error: e.message, stack: e.stack })
  );

  logger.info(
    `videoHlsQueue: started ${CONCURRENCY} worker(s), poll=${POLL_INTERVAL_MS}ms, stuck=${STUCK_TIMEOUT_MS}ms ` +
    '(idle until general_video_adaptive_streaming is enabled)'
  );
}

function stop() {
  if (stopping) return stopping;
  if (!running) return Promise.resolve();
  running = false;
  mediaAttempts.cancel('hls');
  // Interrupt idle waits only; a transcode in flight is cancelled above.
  waits.cancel();
  stopping = Promise.all([...workerHandles, janitorHandle].filter(Boolean)).then(() => mediaAttempts.assertDrained('hls')).finally(() => {
    workerHandles = [];
    janitorHandle = null;
    waits = null;
    stopping = null;
  });
  return stopping;
}

module.exports = { start, stop, claimNext };
