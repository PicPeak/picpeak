/**
 * Background photo-processing worker pool.
 *
 * Polls `photos.processing_status = 'pending'`, atomically claims one
 * row per worker, hands it to `photoProcessor.processPhoto(photoId)`,
 * and marks the row 'complete' or 'failed' depending on outcome. A
 * janitor loop resets rows stuck in 'processing' for too long (worker
 * died, pod restarted, etc.).
 *
 * Concurrency model: N independent worker loops per backend instance.
 * Multi-pod safe via:
 *   - Postgres: SELECT ... FOR UPDATE SKIP LOCKED — pods race for rows,
 *     only one wins, the others move on.
 *   - SQLite:   SELECT then UPDATE-with-status-guard — second writer
 *     loses the guard and tries again (single-pod typical; the guard
 *     is enough for the rare two-process case during dev).
 *
 * Tunables (env, all optional):
 *   UPLOAD_PROCESSOR_CONCURRENCY        default 2 on hosts with ≥3GB RAM,
 *                                       1 on smaller hosts (auto-detected
 *                                       via os.totalmem() with one-shot
 *                                       warning, #628). Always honoured
 *                                       when set explicitly.
 *   UPLOAD_PROCESSOR_POLL_MS            default 1000
 *   UPLOAD_PROCESSOR_STUCK_TIMEOUT_MS   default 600000  (10 minutes)
 *   UPLOAD_PROCESSOR_DISABLED           default false   (set 'true' to opt out, e.g. in CI)
 */

const os = require('os');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { createInterruptibleSleep } = require('../utils/interruptibleSleep');
const { processPhoto } = require('./photoProcessor');
const imageAdmission = require('./imageWorkAdmission');
const mediaAdmission = require('./mediaWorkAdmission');
const mediaAttempts = require('./mediaAttemptService');

const POLL_INTERVAL_MS = parseInt(process.env.UPLOAD_PROCESSOR_POLL_MS || '1000', 10);

// Keep the existing host-aware default for worker-loop scheduling. Actual
// native admission is enforced separately by the shared cgroup/host-memory
// pool, hard child limits and durable decoded-work reservations.
function pickDefaultConcurrency() {
  if (process.env.UPLOAD_PROCESSOR_CONCURRENCY !== undefined) {
    return parseInt(process.env.UPLOAD_PROCESSOR_CONCURRENCY, 10);
  }
  const totalRamGB = os.totalmem() / (1024 ** 3);
  if (totalRamGB < 3) {
    logger.warn?.(
      `[backgroundProcessor] Detected ${totalRamGB.toFixed(1)}GB total RAM (< 3GB threshold). ` +
      'Defaulting UPLOAD_PROCESSOR_CONCURRENCY to 1 to avoid OOM on heavy upload batches. ' +
      'Set UPLOAD_PROCESSOR_CONCURRENCY=2 (or higher) explicitly to override.',
    );
    return 1;
  }
  return 2;
}

const CONCURRENCY = Math.min(8, Math.max(1, pickDefaultConcurrency() || 1));
const STUCK_TIMEOUT_MS = Math.max(600000, parseInt(process.env.UPLOAD_PROCESSOR_STUCK_TIMEOUT_MS || '600000', 10) || 600000);
const JANITOR_INTERVAL_MS = 60 * 1000;

let running = false;
let workerHandles = [];
let janitorHandle = null;

let waits = null;
let stopping = null;
const sleep = ms => waits.sleep(ms);

/**
 * Atomically claim the oldest pending photo. Returns the row or null.
 * The claimed row's processing_status is now 'processing' and
 * processing_started_at is set so the janitor can recover it.
 */
async function claimNextPhoto() {
  return mediaAttempts.claimNext('photo');
}

async function workerLoop(workerIdx) {
  while (running) {
    let claimed;
    try {
      claimed = await claimNextPhoto();
    } catch (e) {
      logger.warn(`backgroundProcessor[${workerIdx}]: claim error`, { error: e.message });
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (!claimed) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    try {
      await mediaAttempts.execute(claimed, 'photo', () => processPhoto(claimed.id));
      // A completed photo must not become retryable because capacity cleanup
      // failed. Retaining its charge is conservative; reprocessing is not.
      const row = await db('photos').where({ id: claimed.id, processing_attempt_id: claimed.processing_attempt_id }).first();
      if (row && !['pending', 'processing'].includes(row.web_status)) await Promise.all([imageAdmission.finish(claimed.id), mediaAdmission.finish(claimed.id)]).catch(error => {
        logger.warn('Completed image work charge retained', { photoId: claimed.id, error: error.message });
      });
    } catch (err) {
      logger.error(`backgroundProcessor[${workerIdx}]: photo ${claimed.id} failed`, {
        error: err.message,
        stack: err.stack,
      });
      try {
        if (!(await db('media_process_attempts').where({ id: claimed.processing_attempt_id, state: 'terminated' }).first())) continue;
        const paused = !running && /_CANCELLED$/.test(err.code || '');
        const updated = await db('photos').where({ id: claimed.id, processing_attempt_id: claimed.processing_attempt_id,
          processing_status: 'processing', path: claimed.path, filename: claimed.filename }).update({
          processing_status: paused ? 'pending' : 'failed',
          ...(paused ? { processing_attempts: Math.max(0, Number(claimed.processing_attempts) - 1), processing_started_at: null } : {}),
          processing_error: String(err.message || err).slice(0, 1000),
        });
        if (updated && !paused) await Promise.all([imageAdmission.finish(claimed.id), mediaAdmission.finish(claimed.id)]);
      } catch (updateErr) {
        logger.error(`backgroundProcessor[${workerIdx}]: failed to mark photo ${claimed.id} as failed`, {
          error: updateErr.message,
        });
      }
    }
  }
}

async function janitorLoop() {
  while (running) {
    try {
      // Written as ISO above, compared as ISO here: on SQLite the column is
      // whatever text or number the writer bound, and a Date bound inside
      // Jest arrives as "[object Object]" (CLAUDE.md), so both sides use the
      // same string shape. A row still holding the old numeric shape from a
      // process that died mid-flight sorts below any text and is reset too,
      // which is the right outcome for it.
      const cutoff = new Date(Date.now() - STUCK_TIMEOUT_MS).toISOString();
      // An interrupted writer is retried at most once. Do not release its
      // decoded reservation on age alone: a live child may still hold it.
      const reset = await mediaAttempts.recover('photo', cutoff);
      if (reset > 0) {
        logger.warn(
          `backgroundProcessor: janitor reset ${reset} stuck photo(s) from 'processing' to 'pending'`
        );
      }
    } catch (e) {
      logger.warn('backgroundProcessor: janitor error', { error: e.message });
    }
    await sleep(JANITOR_INTERVAL_MS);
  }
}

function start() {
  if (running || stopping) return;
  if (process.env.UPLOAD_PROCESSOR_DISABLED === 'true') {
    logger.info('backgroundProcessor: disabled via UPLOAD_PROCESSOR_DISABLED');
    return;
  }

  waits = createInterruptibleSleep();
  require('./mediaProcessService').start();
  running = true;
  workerHandles = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    workerHandles.push(
      workerLoop(i).catch((e) =>
        logger.error(`backgroundProcessor[${i}]: crashed`, { error: e.message, stack: e.stack })
      )
    );
  }
  janitorHandle = janitorLoop().catch((e) =>
    logger.error('backgroundProcessor: janitor crashed', { error: e.message, stack: e.stack })
  );

  logger.info(
    `backgroundProcessor: started ${CONCURRENCY} worker(s), poll=${POLL_INTERVAL_MS}ms, stuck=${STUCK_TIMEOUT_MS}ms`
  );
}

function stop() {
  if (stopping) return stopping;
  if (!running) return Promise.resolve();
  running = false;
  mediaAttempts.cancel('photo');
  // Interrupt idle/backoff waits only. Claims, processing and janitor work
  // already in flight still drain before the database can be closed.
  waits.cancel();
  stopping = Promise.all([...workerHandles, janitorHandle].filter(Boolean)).then(() => mediaAttempts.assertDrained('photo')).finally(() => {
    workerHandles = [];
    janitorHandle = null;
    waits = null;
    stopping = null;
  });
  return stopping;
}

module.exports = { start, stop, claimNextPhoto };
