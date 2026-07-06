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
const { processPhoto } = require('./photoProcessor');

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
const STUCK_TIMEOUT_MS = parseInt(process.env.UPLOAD_PROCESSOR_STUCK_TIMEOUT_MS || '600000', 10);
const JANITOR_INTERVAL_MS = 60 * 1000;

let running = false;
let workerHandles = [];
let janitorHandle = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  if (isPostgres()) {
    return db.transaction(async (trx) => {
      const row = await trx('photos')
        .where('processing_status', 'pending')
        .orderBy('id', 'asc')
        .forUpdate()
        .skipLocked()
        .first();
      if (!row) return null;
      await trx('photos').where('id', row.id).update({
        processing_status: 'processing',
        processing_started_at: new Date(),
      });
      return row;
    });
  }

  // SQLite path — no SKIP LOCKED, but the UPDATE-with-guard ensures
  // exactly one worker wins per row.
  return db.transaction(async (trx) => {
    const row = await trx('photos')
      .where('processing_status', 'pending')
      .orderBy('id', 'asc')
      .first();
    if (!row) return null;
    const updated = await trx('photos')
      .where({ id: row.id, processing_status: 'pending' })
      .update({
        processing_status: 'processing',
        processing_started_at: new Date(),
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
      logger.error(`backgroundProcessor[${workerIdx}]: photo ${claimed.id} failed`, {
        error: err.message,
        stack: err.stack,
      });
      try {
        await db('photos').where({ id: claimed.id }).update({
          processing_status: 'failed',
          processing_error: String(err.message || err).slice(0, 1000),
        });
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
      const cutoff = new Date(Date.now() - STUCK_TIMEOUT_MS);
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
  if (running) return;
  if (process.env.UPLOAD_PROCESSOR_DISABLED === 'true') {
    logger.info('backgroundProcessor: disabled via UPLOAD_PROCESSOR_DISABLED');
    return;
  }

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

async function stop() {
  if (!running) return;
  running = false;
  await Promise.all([...workerHandles, janitorHandle].filter(Boolean));
  workerHandles = [];
  janitorHandle = null;
}

module.exports = { start, stop, claimNextPhoto };
