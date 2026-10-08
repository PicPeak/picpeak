/**
 * Worker pool for browser-playable video copies (issue 1430, item 8).
 *
 * A near-copy of faceQueue.js, for the same reason that one is a near-copy
 * of backgroundProcessor.js: the claim semantics, the janitor and the
 * tunable shape are identical, and a shared queue framework would make all
 * three harder to read. What differs is what a worker does with a claimed
 * row (videoRenditionService.renderWebCopy) and what gates it: the
 * `general_video_web_rendition` setting, re-read every tick so an admin
 * switching it off stops the workers without a restart. Rows left 'pending'
 * stay queued and resume when it is switched on again.
 *
 * One worker by default. A transcode keeps a core busy for the length of the
 * clip and this project's floor is a 2 GB VPS that is also serving galleries.
 *
 * Tunables (env, all optional):
 *   VIDEO_RENDITION_CONCURRENCY        default 1
 *   VIDEO_RENDITION_POLL_MS            default 5000
 *   VIDEO_RENDITION_STUCK_TIMEOUT_MS   default 7200000 (2 hours; a long clip
 *                                      on a slow host can take most of it)
 *   VIDEO_RENDITION_DISABLED           default false ('true' to opt out, e.g. CI)
 */

const { db } = require('../database/db');
const logger = require('../utils/logger');
const { createInterruptibleSleep } = require('../utils/interruptibleSleep');
const { isEnabled, renderWebCopy } = require('./videoRenditionService');
const mediaAttempts = require('./mediaAttemptService');
const { isTransient } = require('./imageResourcePolicy');

const RETRY_BACKOFF_MS = 60000;

const POLL_INTERVAL_MS = parseInt(process.env.VIDEO_RENDITION_POLL_MS || '5000', 10);
const CONCURRENCY = Math.min(8, Math.max(1, parseInt(process.env.VIDEO_RENDITION_CONCURRENCY || '1', 10) || 1));
const STUCK_TIMEOUT_MS = parseInt(process.env.VIDEO_RENDITION_STUCK_TIMEOUT_MS || '7200000', 10);
const JANITOR_INTERVAL_MS = 60 * 1000;

let running = false;
let workerHandles = [];
let janitorHandle = null;

let waits = null;
let stopping = null;
const sleep = (ms) => waits.sleep(ms);

/**
 * Atomically claim the oldest pending video. Returns the row or null.
 * SKIP LOCKED on Postgres so multiple pods race cleanly, a status-guarded
 * UPDATE on SQLite. Timestamps as ISO strings (CLAUDE.md).
 */
async function claimNext() {
  const outcome = await mediaAttempts.claimNext('web');
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
      claimed = await claimNext();
    } catch (e) {
      logger.warn(`videoRenditionQueue[${workerIdx}]: claim error`, { error: e.message });
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (!claimed) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    try {
      await mediaAttempts.execute(claimed, 'web', () => renderWebCopy(claimed.id));
    } catch (err) {
      if (err.code === 'MEDIA_SUPERSEDED') continue;
      // Guarded on this worker's attempt id and source: a delete, a
      // replacement or the janitor meanwhile has already moved the row on,
      // possibly into another worker's hands.
      const mine = { id: claimed.id, web_status: 'processing', web_attempt_id: claimed.web_attempt_id,
        path: claimed.path, filename: claimed.filename };
      const attempts = Number(claimed.web_attempts || 0);
      // A shutdown is not an attempt; "not now" is one, and is tried again
      // after a growing pause. Only a verdict on the video is a failure.
      const paused = !running && /_CANCELLED$/.test(err.code || '');
      const requeue = paused || (isTransient(err) && attempts < mediaAttempts.MAX_ATTEMPTS);
      logger[requeue ? 'warn' : 'error'](`videoRenditionQueue[${workerIdx}]: video ${claimed.id} ${requeue ? `requeued (${err.code})` : 'failed'}`, {
        error: err.message,
      });
      try {
        await db('photos').where(mine).update(requeue ? {
          web_status: 'pending',
          web_started_at: null,
          ...(paused ? { web_attempts: Math.max(0, attempts - 1), web_retry_at: null }
            : { web_retry_at: new Date(Date.now() + RETRY_BACKOFF_MS * attempts).toISOString() }),
        } : {
          web_status: 'failed',
          web_started_at: null,
          web_error: String(err.message || err).split('\n')[0].slice(0, 1000),
        });
      } catch (updateErr) {
        logger.error(`videoRenditionQueue[${workerIdx}]: failed to record the outcome of video ${claimed.id}`, {
          error: updateErr.message,
        });
      }
    }
  }
}

async function janitorLoop() {
  while (running) {
    try {
      const cutoff = new Date(Date.now() - STUCK_TIMEOUT_MS).toISOString();
      const reset = await mediaAttempts.recover('web', cutoff);
      if (reset > 0) {
        logger.warn(`videoRenditionQueue: janitor reset ${reset} stuck video(s) from 'processing' to 'pending'`);
      }
    } catch (e) {
      logger.warn('videoRenditionQueue: janitor error', { error: e.message });
    }
    await sleep(JANITOR_INTERVAL_MS);
  }
}

function start() {
  if (running || stopping) return;
  if (process.env.VIDEO_RENDITION_DISABLED === 'true') {
    logger.info('videoRenditionQueue: disabled via VIDEO_RENDITION_DISABLED');
    return;
  }

  waits = createInterruptibleSleep();
  require('./mediaProcessService').start();
  running = true;
  workerHandles = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    workerHandles.push(
      workerLoop(i).catch((e) =>
        logger.error(`videoRenditionQueue[${i}]: crashed`, { error: e.message, stack: e.stack })
      )
    );
  }
  janitorHandle = janitorLoop().catch((e) =>
    logger.error('videoRenditionQueue: janitor crashed', { error: e.message, stack: e.stack })
  );

  logger.info(
    `videoRenditionQueue: started ${CONCURRENCY} worker(s), poll=${POLL_INTERVAL_MS}ms, stuck=${STUCK_TIMEOUT_MS}ms ` +
    '(idle until general_video_web_rendition is enabled)'
  );
}

function stop() {
  if (stopping) return stopping;
  if (!running) return Promise.resolve();
  running = false;
  mediaAttempts.cancel('web');
  // Interrupt idle waits only; a transcode in flight finishes first.
  waits.cancel();
  stopping = Promise.all([...workerHandles, janitorHandle].filter(Boolean)).then(() => mediaAttempts.assertDrained('web')).finally(() => {
    workerHandles = [];
    janitorHandle = null;
    waits = null;
    stopping = null;
  });
  return stopping;
}

module.exports = { start, stop, claimNext };
