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

const POLL_INTERVAL_MS = parseInt(process.env.VIDEO_RENDITION_POLL_MS || '5000', 10);
const CONCURRENCY = Math.max(1, parseInt(process.env.VIDEO_RENDITION_CONCURRENCY || '1', 10));
const STUCK_TIMEOUT_MS = parseInt(process.env.VIDEO_RENDITION_STUCK_TIMEOUT_MS || '7200000', 10);
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
 * Atomically claim the oldest pending video. Returns the row or null.
 * SKIP LOCKED on Postgres so multiple pods race cleanly, a status-guarded
 * UPDATE on SQLite. Timestamps as ISO strings (CLAUDE.md).
 */
async function claimNext() {
  if (isPostgres()) {
    return db.transaction(async (trx) => {
      const row = await trx('photos')
        .where('web_status', 'pending')
        .orderBy('id', 'asc')
        .forUpdate()
        .skipLocked()
        .first();
      if (!row) return null;
      await trx('photos').where('id', row.id).update({
        web_status: 'processing',
        web_started_at: new Date().toISOString(),
      });
      return row;
    });
  }

  return db.transaction(async (trx) => {
    const row = await trx('photos')
      .where('web_status', 'pending')
      .orderBy('id', 'asc')
      .first();
    if (!row) return null;
    const updated = await trx('photos')
      .where({ id: row.id, web_status: 'pending' })
      .update({
        web_status: 'processing',
        web_started_at: new Date().toISOString(),
      });
    return updated > 0 ? row : null;
  });
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
      await renderWebCopy(claimed.id);
    } catch (err) {
      logger.error(`videoRenditionQueue[${workerIdx}]: video ${claimed.id} failed`, {
        error: err.message,
      });
      try {
        // Guarded on 'processing', the state this worker put the row in: a
        // delete or a replacement meanwhile has already moved it on.
        await db('photos').where({ id: claimed.id, web_status: 'processing' }).update({
          web_status: 'failed',
          web_started_at: null,
          web_error: String(err.message || err).split('\n')[0].slice(0, 1000),
        });
      } catch (updateErr) {
        logger.error(`videoRenditionQueue[${workerIdx}]: failed to mark video ${claimed.id} as failed`, {
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
      const reset = await db('photos')
        .where('web_status', 'processing')
        .where('web_started_at', '<', cutoff)
        .update({ web_status: 'pending', web_started_at: null });
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
  // Interrupt idle waits only; a transcode in flight finishes first.
  waits.cancel();
  stopping = Promise.all([...workerHandles, janitorHandle].filter(Boolean)).finally(() => {
    workerHandles = [];
    janitorHandle = null;
    waits = null;
    stopping = null;
  });
  return stopping;
}

module.exports = { start, stop, claimNext };
