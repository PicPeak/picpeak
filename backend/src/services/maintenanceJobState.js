/**
 * Shared run state for the photo maintenance sweeps (#1181).
 *
 * These jobs used to keep `{ isRunning, lastResult }` in a module-level
 * variable. That is invisible to every other replica, so on a multi-replica
 * install the status endpoint answers from whichever process the poll happens
 * to reach and a second POST can start a duplicate pass over the whole
 * library. Moving the state into the database makes both the claim and the
 * reporting shared.
 *
 * The claim is a conditional UPDATE whose affected-row count is the answer —
 * the same shape backgroundProcessor uses to hand a photo to exactly one
 * worker (backgroundProcessor.js:110-116). Two replicas issuing it
 * concurrently cannot both match: the row is locked for the duration of each
 * UPDATE, so the loser sees is_running already true and gets 0 rows back.
 *
 * A lease that can be taken over needs fencing, which is what claim_token is
 * for. Taking over a stale claim does not stop the old runner — it is a
 * process nobody can signal, quite possibly still walking the library. So
 * every write it attempts carries the token it was issued:
 *
 *   - heartbeat() reports whether the renewal landed. It returns false once
 *     the claim has moved on, and the run loops treat that as "stop".
 *   - release() only clears the row if the token still matches, so a
 *     superseded runner finishing late cannot clear the new owner's flag or
 *     overwrite its result.
 *
 * Without both of those, a takeover produces two live runners and the loser
 * ends up stomping the winner's state on its way out.
 *
 * Timestamps are written as ISO strings rather than Date objects. Production
 * stores Dates fine, but inside jest the sqlite3 binding turns them into the
 * literal string "[object Object]" (see CLAUDE.md), which would silently break
 * every staleness comparison in the tests. ISO-8601 also compares correctly
 * under SQLite's lexicographic text ordering, so the `<` below means the same
 * thing on both engines.
 */

const os = require('os');
const crypto = require('crypto');
const { db } = require('../database/db');
const logger = require('../utils/logger');

const JOB_DIMENSION_REPAIR = 'photo_dimension_repair';
const JOB_CAPTURE_DATE_BACKFILL = 'photo_capture_date_backfill';
const JOB_ORIENTATION_BACKFILL = 'photo_orientation_backfill';

// How long a run may go without renewing its lease before another replica is
// allowed to take it over. Generous on purpose: these jobs walk the whole
// library and a single slow original on a stalled NAS mount can block the loop
// for a while. The cost of being too eager is a duplicate pass; the cost of
// being too patient is a button that stays disabled after a crash.
const DEFAULT_STALE_MS = 15 * 60 * 1000;

// How often a running job renews. Time-based, and comfortably inside the stale
// window: tying renewal to a photo counter meant a job whose photos were slow
// — a stalled mount, a handful of very large originals — could be declared
// abandoned while it was still working.
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

const OWNER = `${os.hostname()}:${process.pid}`;

const nowIso = () => new Date().toISOString();
const cutoffIso = (staleAfterMs) => new Date(Date.now() - staleAfterMs).toISOString();

/**
 * Try to become the one runner of `jobName`.
 *
 * Returns a claim token on success, or null when another replica holds it and
 * is still renewing — the caller should answer 409. The token must be passed
 * to every subsequent heartbeat/release for this run.
 */
async function claim(jobName, { staleAfterMs = DEFAULT_STALE_MS } = {}) {
  const stamp = nowIso();
  const cutoff = cutoffIso(staleAfterMs);
  const token = crypto.randomBytes(16).toString('hex');

  const claimed = await db('maintenance_jobs')
    .where({ job_name: jobName })
    .where(function () {
      // Free, or held by a run that has stopped renewing. heartbeat_at is
      // always written by the claim below, so a running job cannot have a null
      // heartbeat — no third case to handle here.
      this.where('is_running', false).orWhere('heartbeat_at', '<', cutoff);
    })
    .update({
      is_running: true,
      started_at: stamp,
      heartbeat_at: stamp,
      finished_at: null,
      owner: OWNER,
      claim_token: token,
    });

  return claimed > 0 ? token : null;
}

/**
 * Renew the lease.
 *
 * Returns false when this run no longer owns the claim — it was declared stale
 * and taken over. The caller must stop working at that point: the new owner is
 * already walking the same rows, and two runners writing is exactly what the
 * lock exists to prevent.
 */
async function heartbeat(jobName, token) {
  try {
    const renewed = await db('maintenance_jobs')
      .where({ job_name: jobName, is_running: true, claim_token: token })
      .update({ heartbeat_at: nowIso() });
    return renewed > 0;
  } catch (err) {
    // A failed renewal query is not proof the claim is gone, and aborting a
    // long sweep over one transient database blip is the worse trade. Say the
    // claim still holds; if it really has moved on, the next renewal says so.
    logger.warn(`maintenanceJobState: heartbeat failed for ${jobName}: ${err.message}`);
    return true;
  }
}

/**
 * Give up the claim.
 *
 * Scoped to the token, so a runner that was superseded while it was working
 * cannot clear the new owner's flag or overwrite its result on the way out.
 * Returns false when the claim had already moved on.
 *
 * `result` is stored as the job's last outcome. Pass null (the "nothing to do"
 * and error paths) to release without overwriting what the previous real run
 * reported.
 */
async function release(jobName, token, result = null) {
  const update = { is_running: false, finished_at: nowIso() };
  if (result !== null && result !== undefined) {
    update.last_result = JSON.stringify(result);
  }
  const released = await db('maintenance_jobs')
    .where({ job_name: jobName, claim_token: token })
    .update(update);
  return released > 0;
}

/**
 * Current state, in the shape the status endpoints hand to the frontend.
 *
 * A run whose lease has gone stale is reported as not running: the owning
 * replica is gone, nothing is going to release the claim, and the operator
 * needs the button back. The next claim() takes the row over on the same
 * condition, so the two agree.
 */
async function read(jobName, { staleAfterMs = DEFAULT_STALE_MS } = {}) {
  const row = await db('maintenance_jobs').where({ job_name: jobName }).first();
  if (!row) return { isRunning: false, lastResult: null };

  const alive = row.heartbeat_at && new Date(row.heartbeat_at).getTime() > Date.now() - staleAfterMs;

  let lastResult = null;
  if (row.last_result) {
    try {
      lastResult = JSON.parse(row.last_result);
    } catch (err) {
      // Never let a malformed row take the status endpoint down with it.
      logger.warn(`maintenanceJobState: unreadable last_result for ${jobName}: ${err.message}`);
    }
  }

  return { isRunning: Boolean(row.is_running) && Boolean(alive), lastResult };
}

module.exports = {
  claim,
  heartbeat,
  release,
  read,
  JOB_DIMENSION_REPAIR,
  JOB_CAPTURE_DATE_BACKFILL,
  JOB_ORIENTATION_BACKFILL,
  DEFAULT_STALE_MS,
  HEARTBEAT_INTERVAL_MS,
};
