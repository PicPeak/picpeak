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
const { isTransient } = require('./imageResourcePolicy');
// A photo is claimed at most this many times before it is recorded as failed:
// claims that ended in a transient image-worker refusal (busy, unavailable,
// deadline) and claims the janitor recovered from a process that died.
const MAX_ATTEMPTS = 5;
const RETRY_BACKOFF_MS = 15000;
const exhausted = { processing_status: 'failed', processing_error: `Image processing did not complete after ${MAX_ATTEMPTS} attempts` };

const POLL_INTERVAL_MS = parseInt(process.env.UPLOAD_PROCESSOR_POLL_MS || '1000', 10);

// Soft default: two worker loops × sharp.concurrency(2) means up to four
// libvips threads can decode full-resolution photos in parallel. Each decode
// holds the full uncompressed frame in RAM — a 24MP photo is ~96MB before
// resize. On a 2GB VPS (the documented but barely-viable minimum) one busy
// batch is enough to OOM-kill the backend and surface as 503s on thumbnails
// (#628). When the host reports < 3GB total memory AND the admin hasn't set
// an explicit override, drop the default to 1 and log a one-shot warning
// naming the override env var. Explicit env-var setters keep their value.
//
// os.totalmem() reports container memory under cgroup v2 (Docker / k8s) and
// host memory on bare metal — accurate enough for this decision in either
// deployment shape.
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

const CONCURRENCY = Math.max(1, pickDefaultConcurrency());
const STUCK_TIMEOUT_MS = Math.max(600000, parseInt(process.env.UPLOAD_PROCESSOR_STUCK_TIMEOUT_MS || '600000', 10) || 600000);
const JANITOR_INTERVAL_MS = 60 * 1000;

let running = false;
let workerHandles = [];
let janitorHandle = null;

let waits = null;
let stopping = null;
const sleep = ms => waits.sleep(ms);

function isPostgres() {
  const c = db.client.config.client;
  return c === 'pg' || (typeof c === 'string' && c.includes('postgres'));
}

/**
 * Atomically claim the oldest pending photo. Returns the row or null.
 * The claimed row's processing_status is now 'processing' and
 * processing_started_at is set so the janitor can recover it.
 */
async function claimNextPhoto() {
  const outcome = await claim();
  if (!outcome?.exhausted) return outcome;
  // Outside the claim transaction: SQLite has one connection.
  await releasePendingHold(outcome.exhausted);
  return null;
}

function releasePendingHold(photoId) {
  // A failed photo is no longer queued work: free its public-upload
  // pending hold (the lifetime charge for its original stays).
  return require('./publicUploadQuota').releasePending(photoId).catch((releaseErr) => {
    logger.warn(`backgroundProcessor: pending hold of photo ${photoId} not released`, { error: releaseErr.message });
  });
}

async function claim() {
  // A photo put back after a transient refusal is not due before its time.
  const due = (query) => query.whereNull('processing_retry_at').orWhere('processing_retry_at', '<=', new Date().toISOString());
  if (isPostgres()) {
    return db.transaction(async (trx) => {
      const row = await trx('photos')
        .where('processing_status', 'pending')
        .where(due)
        .orderBy('id', 'asc')
        .forUpdate()
        .skipLocked()
        .first();
      if (!row) return null;
      if (Number(row.processing_attempts || 0) >= MAX_ATTEMPTS) {
        await trx('photos').where('id', row.id).update(exhausted);
        return { exhausted: row.id };
      }
      await trx('photos').where('id', row.id).update({
        processing_status: 'processing',
        processing_started_at: new Date().toISOString(),
        processing_attempts: Number(row.processing_attempts || 0) + 1,
      });
      return row;
    });
  }

  // SQLite path — no SKIP LOCKED, but the UPDATE-with-guard ensures
  // exactly one worker wins per row.
  return db.transaction(async (trx) => {
    const row = await trx('photos')
      .where('processing_status', 'pending')
      .where(due)
      .orderBy('id', 'asc')
      .first();
    if (!row) return null;
    if (Number(row.processing_attempts || 0) >= MAX_ATTEMPTS) {
      const failed = await trx('photos').where({ id: row.id, processing_status: 'pending' }).update(exhausted);
      return failed > 0 ? { exhausted: row.id } : null;
    }
    const updated = await trx('photos')
      .where({ id: row.id, processing_status: 'pending' })
      .update({
        processing_status: 'processing',
        processing_started_at: new Date().toISOString(),
        processing_attempts: Number(row.processing_attempts || 0) + 1,
      });
    return updated > 0 ? row : null;
  });
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
      await processPhoto(claimed.id);
    } catch (err) {
      const attempts = Number(claimed.processing_attempts || 0) + 1;
      if (isTransient(err) && attempts < MAX_ATTEMPTS) {
        // "Not now" from the image worker says nothing about this photo: it
        // goes back to pending and is due again after a growing pause. Only
        // the last allowed attempt records the refusal as the failure.
        logger.warn(`backgroundProcessor[${workerIdx}]: photo ${claimed.id} requeued (${err.code}, attempt ${attempts} of ${MAX_ATTEMPTS})`, { error: err.message });
        try {
          await db('photos').where({ id: claimed.id, processing_status: 'processing' }).update({
            processing_status: 'pending',
            processing_started_at: null,
            processing_retry_at: new Date(Date.now() + RETRY_BACKOFF_MS * attempts).toISOString(),
          });
        } catch (updateErr) {
          // Left in 'processing': the janitor puts it back.
          logger.error(`backgroundProcessor[${workerIdx}]: failed to requeue photo ${claimed.id}`, { error: updateErr.message });
        }
        continue;
      }
      logger.error(`backgroundProcessor[${workerIdx}]: photo ${claimed.id} failed`, {
        error: err.message,
        stack: err.stack,
      });
      try {
        await db('photos').where({ id: claimed.id }).update({
          processing_status: 'failed',
          processing_error: String(err.message || err).slice(0, 1000),
        });
        await releasePendingHold(claimed.id);
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
      const reset = await db('photos')
        .where('processing_status', 'processing')
        .where('processing_started_at', '<', cutoff)
        .update({ processing_status: 'pending', processing_started_at: null });
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
  // Interrupt idle/backoff waits only. Claims, processing and janitor work
  // already in flight still drain before the database can be closed.
  waits.cancel();
  stopping = Promise.all([...workerHandles, janitorHandle].filter(Boolean)).finally(() => {
    workerHandles = [];
    janitorHandle = null;
    waits = null;
    stopping = null;
  });
  return stopping;
}

module.exports = { start, stop, claimNextPhoto };
