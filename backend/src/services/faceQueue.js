/**
 * Background face-detection worker pool (#1074).
 *
 * Deliberately a near-copy of backgroundProcessor.js rather than a shared
 * abstraction: the two differ in exactly one behaviour (below), and inventing
 * a generic queue framework to save forty lines would make both harder to
 * read. Claim semantics, the janitor and the tunable shape are identical, so
 * anyone who understands one understands the other.
 *
 * THE ONE DIFFERENCE — a sidecar that is unreachable puts the photo back to
 * 'pending' with backoff, never 'failed'. Turning the ML container off for a
 * week must not require a manual re-scan afterwards. Only a 4xx (a genuinely
 * unprocessable image) marks a row failed.
 *
 * Nothing here starts unless the `faces` feature flag is on. That matters
 * more than usual because FACE_ML_URL now has a working default, so "is the
 * variable set" is no longer a signal — without the flag check, every install
 * would poll a hostname that does not resolve.
 *
 * Tunables (env, all optional):
 *   FACE_PROCESSOR_CONCURRENCY        default 1. Face scanning shares a host
 *                                     with Sharp; 1 is the safe default on
 *                                     the 2GB VPS class this project supports.
 *   FACE_PROCESSOR_POLL_MS            default 2000
 *   FACE_PROCESSOR_STUCK_TIMEOUT_MS   default 600000 (10 minutes)
 *   FACE_PROCESSOR_DISABLED           default false ('true' to opt out, e.g. CI)
 */

const { db } = require('../database/db');
const logger = require('../utils/logger');
const { processPhotoFaces } = require('./faceProcessor');
const { SidecarUnavailableError } = require('./faceClient');
const { TransientSourceError } = require('./faceProcessor');
const { isFeatureEnabled, isEnabledForEvent } = require('./faceSettings');

const POLL_INTERVAL_MS = parseInt(process.env.FACE_PROCESSOR_POLL_MS || '2000', 10);
const CONCURRENCY = Math.max(1, parseInt(process.env.FACE_PROCESSOR_CONCURRENCY || '1', 10));
const STUCK_TIMEOUT_MS = parseInt(process.env.FACE_PROCESSOR_STUCK_TIMEOUT_MS || '600000', 10);
const JANITOR_INTERVAL_MS = 60 * 1000;

// Backoff after the sidecar goes away. Without it a down sidecar turns into a
// hot loop: claim, fail, release, claim again, thousands of times a minute.
const UNAVAILABLE_BACKOFF_MS = parseInt(process.env.FACE_PROCESSOR_BACKOFF_MS || '30000', 10);

// A dropped mount hits every photo in the event, so the raw message would
// repeat once per claim. Rate-limited the same way faceClient limits its own
// unavailable line, and for the same reason: one warning per outage, not one
// per photo.
// How long an event whose storage is unreachable is left alone. Distinct from
// the janitor's stuck timeout on purpose: the janitor exists to rescue rows a
// crashed worker abandoned, and reusing it here meant that every sweep handed
// the whole dead gallery back to the worker, which then walked all of it again
// — one slow stat per photo against a mount that may be hard-mounted — before
// reaching any healthy event.
const SOURCE_BACKOFF_MS = parseInt(process.env.FACE_SOURCE_BACKOFF_MS || '300000', 10);

// eventId -> epoch ms before which this event's photos are not worth claiming.
// In-memory on purpose: a restart should retry immediately, since a restart is
// usually what follows fixing the mount.
const deferredEvents = new Map();

function deferEvent(eventId) {
  if (eventId == null) return;
  deferredEvents.set(eventId, Date.now() + SOURCE_BACKOFF_MS);
}

/** Event ids still inside their backoff window; also prunes expired entries. */
function currentlyDeferredEventIds() {
  const now = Date.now();
  for (const [id, until] of deferredEvents) {
    if (until <= now) deferredEvents.delete(id);
  }
  return [...deferredEvents.keys()];
}

/**
 * Exclude only the rows the outage actually affects.
 *
 * A reference event can hold managed uploads alongside its imported external
 * ones, and those live in local storage that is fine. Excluding the whole
 * event id would leave them unscanned for as long as external rows keep
 * renewing the cooldown — which, during a real outage, is indefinitely.
 */
function applySourceBackoff(query, excludeEventIds) {
  if (!excludeEventIds.length) return query;
  return query.whereNot(function () {
    this.whereIn('event_id', excludeEventIds)
      .whereIn('source_origin', ['external', 'reference']);
  });
}

const SOURCE_LOG_INTERVAL_MS = 5 * 60 * 1000;
let lastUnreachableLogAt = 0;
function logUnreachableSource(message) {
  const now = Date.now();
  if (now - lastUnreachableLogAt < SOURCE_LOG_INTERVAL_MS) return;
  lastUnreachableLogAt = now;
  logger.warn(
    `faceQueue: ${message}. Photos stay queued and will be retried — check the `
    + 'external media mount. Further identical warnings are suppressed for 5 minutes.'
  );
}

/**
 * Events that have had a photo scanned since their last consolidation pass
 * (#1107).
 *
 * There is no "scan finished" event to hook: the queue is per-photo, and a
 * backfill is just a lot of independent claims. So a worker that finds nothing
 * left to claim asks whether the events it touched have actually drained, and
 * consolidates the ones that have — greedy assignment leaves "Anna in daylight"
 * and "Anna at the party" as two clusters whose centroids have since converged,
 * and until now nothing looked unless an admin pressed "Re-group people".
 *
 * In-memory, like `deferredEvents`: a restart loses at most a consolidation
 * pass, and the next scan of that event schedules another one.
 */
const touchedEvents = new Set();

// A consolidation that fails keeps its place so a transient database error
// does not cost the gallery its pass — but the worker goes idle every
// POLL_INTERVAL_MS, so retrying immediately would hot-loop a permanently
// broken event and emit a warning every couple of seconds. Same shape as
// `deferredEvents` above: back it off, then try again.
const CONSOLIDATE_RETRY_MS = parseInt(process.env.FACE_CONSOLIDATE_RETRY_MS || '60000', 10);
const consolidationRetryAt = new Map();

// eventId -> how many workers are currently inside processPhotoFaces for it.
//
// `face_status` alone cannot answer "is anyone still working on this event":
// the photo is committed 'done' inside the transaction, and auto-categorisation
// then runs before the call returns. During that window the row looks drained
// to every other worker. Counting the callers closes it.
const inFlightByEvent = new Map();

function markInFlight(eventId, delta) {
  if (eventId == null) return;
  const next = (inFlightByEvent.get(eventId) || 0) + delta;
  if (next > 0) inFlightByEvent.set(eventId, next);
  else inFlightByEvent.delete(eventId);
}

/**
 * Consolidate every touched event that has genuinely drained.
 *
 * "A worker went idle" is not the same as "the scan is done" — with
 * FACE_PROCESSOR_CONCURRENCY > 1 the others may still be working, and photos
 * released back to `pending` by a down sidecar are still owed. So the drain is
 * tested directly against the queue rather than inferred, and an event that is
 * still busy simply stays in the set for the next idle tick.
 *
 * Across multiple pods two workers can consolidate the same event at once.
 * That is safe rather than coordinated: `mergePeople` is transactional, and a
 * pair whose source was already absorbed merges nothing.
 */
async function drainConsolidation() {
  if (!touchedEvents.size) return;

  for (const eventId of [...touchedEvents]) {
    const retryAt = consolidationRetryAt.get(eventId);
    if (retryAt && Date.now() < retryAt) continue;

    try {
      const outstanding = await db('photos')
        .where({ event_id: eventId })
        .whereIn('face_status', ['pending', 'processing'])
        .count({ c: '*' })
        .first();

      if (Number(outstanding?.c ?? 0) > 0) continue;

      // A worker may still be inside processPhotoFaces for this event: the
      // photo is committed 'done' before auto-categorisation runs, so the row
      // stops counting as outstanding while the call is still going. Without
      // this, an idle worker consolidates and records its count, the busy one
      // then re-marks the event, and the next pass overwrites the real number
      // with zero — losing exactly the report this feature exists to give.
      if ((inFlightByEvent.get(eventId) || 0) > 0) continue;

      // Detection may have been switched off mid-drain, after an earlier
      // photo already marked this event. Merging someone's clusters just
      // after they turned the feature off is not a thing to do quietly.
      const event = await db('events').where({ id: eventId }).first();
      if (!(await isEnabledForEvent(event))) {
        touchedEvents.delete(eventId);
        consolidationRetryAt.delete(eventId);
        continue;
      }

      // Required here rather than at module load, matching faceProcessor's
      // call into faceAutoCategories: the binding stays late, which keeps the
      // seam this is tested through honest.
      const { consolidate } = require('./faceClustering');
      const merged = await consolidate(eventId);
      // Dropped only once it has actually run. Removing it first meant a
      // transient database error lost the pass entirely — no retry until the
      // gallery happened to be scanned again.
      touchedEvents.delete(eventId);
      consolidationRetryAt.delete(eventId);
      if (merged.length) {
        logger.info(
          `faceQueue: scan of event ${eventId} drained — consolidated ${merged.length} look-alike pair(s)`
        );
      }
    } catch (e) {
      // Never let a consolidation failure stop the queue. The event keeps its
      // place so a transient error is retried, but not before the backoff —
      // otherwise a permanently failing event warns on every idle tick.
      consolidationRetryAt.set(eventId, Date.now() + CONSOLIDATE_RETRY_MS);
      logger.warn(
        `faceQueue: consolidation failed for event ${eventId}, retrying in `
        + `${Math.round(CONSOLIDATE_RETRY_MS / 1000)}s`,
        { error: e.message }
      );
    }
  }
}

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
 * Same two-path approach as backgroundProcessor: SKIP LOCKED on Postgres so
 * multiple pods race cleanly, a status-guarded UPDATE on SQLite.
 */
async function claimNextPhoto(excludeEventIds = []) {
  if (isPostgres()) {
    return db.transaction(async (trx) => {
      const row = await trx('photos')
        .where('face_status', 'pending')
        .modify((q) => applySourceBackoff(q, excludeEventIds))
        .orderBy('id', 'asc')
        .forUpdate()
        .skipLocked()
        .first();
      if (!row) return null;
      await trx('photos').where('id', row.id).update({
        face_status: 'processing',
        face_started_at: new Date().toISOString(),
      });
      return row;
    });
  }

  return db.transaction(async (trx) => {
    const row = await trx('photos')
      .where('face_status', 'pending')
      .modify((q) => applySourceBackoff(q, excludeEventIds))
      .orderBy('id', 'asc')
      .first();
    if (!row) return null;
    const updated = await trx('photos')
      .where({ id: row.id, face_status: 'pending' })
      .update({
        face_status: 'processing',
        face_started_at: new Date().toISOString(),
      });
    return updated > 0 ? row : null;
  });
}

async function releaseToPending(photoId) {
  // Guarded on 'processing' — the state THIS worker put the row in. If the
  // event was purged while the sidecar request was in flight, purgeEvent has
  // already set face_status to NULL, and an unconditional update would put it
  // back to 'pending' and rescan it: biometric rows reappearing after the
  // purge endpoint reported success. Same reasoning as the commit guard in
  // faceProcessor; the retry path needed it too.
  await db('photos')
    .where({ id: photoId, face_status: 'processing' })
    .update({ face_status: 'pending', face_started_at: null });
}

async function workerLoop(workerIdx) {
  while (running) {
    // Re-checked every tick, not once at startup: an admin turning the flag
    // off must stop the workers without a restart.
    if (!(await isFeatureEnabled())) {
      await sleep(POLL_INTERVAL_MS * 5);
      continue;
    }

    let claimed;
    try {
      claimed = await claimNextPhoto(currentlyDeferredEventIds());
    } catch (e) {
      logger.warn(`faceQueue[${workerIdx}]: claim error`, { error: e.message });
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (!claimed) {
      // Nothing left to claim is the only signal this queue has that a scan
      // may have finished. Cheap when idle: no-ops unless work happened.
      await drainConsolidation();
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    markInFlight(claimed.event_id, +1);
    try {
      const outcome = await processPhotoFaces(claimed.id);
      // Only a photo that actually went through detection can have moved this
      // event's clusters. 'skipped' covers videos, a purge that raced the
      // scan, and — the one that matters — detection being switched OFF
      // mid-drain: consolidating there would merge clusters moments after the
      // admin turned the feature off. 'failed' produced no faces either.
      //
      // A photo containing no faces still reports 'done', so an event whose
      // photos are all empty still gets its (harmless) pass.
      if (outcome?.status === 'done' && claimed.event_id != null) {
        touchedEvents.add(claimed.event_id);
      }
    } catch (err) {
      // The sidecar being down stops EVERY photo, so returning this one to
      // 'pending' and backing off costs nothing — there is no other work to
      // get on with.
      if (err instanceof SidecarUnavailableError) {
        // Retry, don't fail. faceClient already rate-limits the log line.
        await releaseToPending(claimed.id).catch(() => {});
        await sleep(UNAVAILABLE_BACKOFF_MS);
        continue;
      }

      // An unreachable source is per-EVENT, not global: other events are
      // still perfectly scannable. Releasing to 'pending' here would be a
      // trap — claimNextPhoto orders by id ascending, so the single default
      // worker would reclaim this same row after every backoff and never
      // reach any higher id. One dead mount would stall face scanning for
      // the whole install.
      //
      // So leave it parked in 'processing' with its face_started_at intact.
      // The worker moves straight on to the next claimable row, and the
      // janitor returns this one to 'pending' once it passes
      // STUCK_TIMEOUT_MS — which is exactly the "try again later" this
      // needs, using machinery that already exists.
      if (err instanceof TransientSourceError) {
        // Back the whole EVENT off, not just this row. Its siblings are on the
        // same storage and would each cost another failed preview attempt —
        // which also logs — before landing here again.
        deferEvent(err.eventId);
        logUnreachableSource(err.message);
        continue;
      }

      logger.error(`faceQueue[${workerIdx}]: photo ${claimed.id} failed`, {
        error: err.message,
        stack: err.stack,
      });
      try {
        await db('photos').where({ id: claimed.id }).update({
          face_status: 'failed',
          face_started_at: null,
          face_error: String(err.message || err).slice(0, 1000),
        });
      } catch (updateErr) {
        logger.error(`faceQueue[${workerIdx}]: failed to mark photo ${claimed.id} as failed`, {
          error: updateErr.message,
        });
      }
    } finally {
      // In a finally because the catch above returns to the loop via
      // `continue` on two paths — a leaked count would block this event's
      // consolidation for the lifetime of the process.
      markInFlight(claimed.event_id, -1);
    }
  }
}

async function janitorLoop() {
  while (running) {
    try {
      const cutoff = new Date(Date.now() - STUCK_TIMEOUT_MS).toISOString();
      const reset = await db('photos')
        .where('face_status', 'processing')
        .where('face_started_at', '<', cutoff)
        .update({ face_status: 'pending', face_started_at: null });
      if (reset > 0) {
        logger.warn(`faceQueue: janitor reset ${reset} stuck photo(s) from 'processing' to 'pending'`);
      }
    } catch (e) {
      logger.warn('faceQueue: janitor error', { error: e.message });
    }
    await sleep(JANITOR_INTERVAL_MS);
  }
}

function start() {
  if (running) return;
  if (process.env.FACE_PROCESSOR_DISABLED === 'true') {
    logger.info('faceQueue: disabled via FACE_PROCESSOR_DISABLED');
    return;
  }

  running = true;
  workerHandles = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    workerHandles.push(
      workerLoop(i).catch((e) =>
        logger.error(`faceQueue[${i}]: crashed`, { error: e.message, stack: e.stack })
      )
    );
  }
  janitorHandle = janitorLoop().catch((e) =>
    logger.error('faceQueue: janitor crashed', { error: e.message, stack: e.stack })
  );

  logger.info(
    `faceQueue: started ${CONCURRENCY} worker(s), poll=${POLL_INTERVAL_MS}ms, stuck=${STUCK_TIMEOUT_MS}ms ` +
    '(idle until the `faces` feature flag is enabled)'
  );
}

async function stop() {
  if (!running) return;
  running = false;
  await Promise.all([...workerHandles, janitorHandle].filter(Boolean));
  workerHandles = [];
  janitorHandle = null;
}

// drainConsolidation, touchedEvents and consolidationRetryAt are exported for
// the same reason claimNextPhoto is: the drain condition and its failure
// backoff are the subtle parts of #1107 and are worth pinning directly, rather
// than through a running worker loop.
module.exports = {
  start, stop, claimNextPhoto, drainConsolidation,
  touchedEvents, consolidationRetryAt, inFlightByEvent,
};
