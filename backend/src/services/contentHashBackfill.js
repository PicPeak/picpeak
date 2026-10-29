/**
 * Content-hash backfill (issue 2194).
 *
 * Every upload stores the SHA-256 of its original (photos.content_sha256,
 * migration 290) and the duplicate check on upload matches on it. Rows that
 * came in another way before their path hashed too (watch folder, external
 * media, S3 import) and every row from before 290 have none, so they never
 * match. This fills them.
 *
 * It reads every such original once, through the same storage backend the
 * app serves from (local disk, S3) or, for an external library, the file on
 * the share in place, as a stream: nothing is held in memory whole, videos
 * included. That is real I/O and egress on a NAS or S3 library, so the job
 * only ever starts from the admin's button, never by itself.
 *
 *   - Throttled: one original at a time, the way the other maintenance
 *     sweeps walk the library.
 *   - Resumable by construction: a candidate is a row without a hash and
 *     without a recorded read error, so a run that was paused, crashed or
 *     restarted leaves exactly the rest, and the next start picks up there.
 *     Nothing finished is read again.
 *   - Pausable: the pause button sets a flag on the job row
 *     (maintenanceJobState.requestPause), checked before each file.
 *   - An original that cannot be read is recorded on its row
 *     (content_sha256_error) and passed over, by this run and the next ones,
 *     until the admin asks for a retry or a refresh of the file clears it.
 */

const fs = require('fs');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { livePhotos } = require('../utils/photoVisibility');
const maintenanceJobs = require('./maintenanceJobState');
const { sha256File, sha256Stream } = require('./photoDuplicates');
const { resolvePhotoFilePath, resolvePhotoStorageKey } = require('./photoResolver');
const { getStorage } = require('./storage');

const JOB = maintenanceJobs.JOB_CONTENT_HASH_BACKFILL;
const BATCH = 200;
const ERROR_MAX = 255;

/**
 * The photos the job looks after: live, in a gallery that is not archived
 * (an archived original is inside the zip, not on storage), and servable
 * (a reference photo whose file is gone from the share has nothing to read;
 * it becomes a candidate again once the file is back).
 */
function inScope() {
  return livePhotos(db)
    .join('events', 'photos.event_id', 'events.id')
    .whereNull('photos.unavailable_reason')
    .where(function () {
      this.where('events.is_archived', false).orWhereNull('events.is_archived');
    });
}

/** What a run would read. */
function pending() {
  return inScope().whereNull('photos.content_sha256').whereNull('photos.content_sha256_error');
}

const isExternal = (photo) => photo.source_origin === 'external' || photo.source_origin === 'reference';

// Whether a file on the share is still the version the row records. One
// edited in place since is the external refresh's to pick up: it rewrites the
// row and hashes the new bytes itself.
const matchesRecorded = (photo, st) => (photo.size_bytes == null || Number(photo.size_bytes) === st.size)
  && (photo.source_mtime_ms == null || Number(photo.source_mtime_ms) === Math.floor(st.mtimeMs));

/**
 * Hash one original. Returns the hex digest, or null when the file is not
 * the version on the row (left for the refresh, not recorded as an error).
 * Throws when the original cannot be read.
 */
async function hashOriginal(photo) {
  const event = { source_mode: photo.source_mode, external_path: photo.external_path, slug: photo.slug };
  if (isExternal(photo)) {
    const full = resolvePhotoFilePath(event, photo);
    const before = await fs.promises.stat(full);
    if (!matchesRecorded(photo, before)) return null;
    const hash = await sha256File(full);
    // Changed while it was being read: the hash describes no one version.
    const after = await fs.promises.stat(full);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return null;
    return hash;
  }
  return sha256Stream(await getStorage().get(resolvePhotoStorageKey(event, photo)));
}

/**
 * The row as it was read: a replacement (new path and filename), a refresh
 * of an external file (new size and mtime) or a trash since makes the write
 * a no-op, so a hash never lands on bytes it was not computed from.
 */
function fenced(photo, token) {
  return livePhotos(db).where({
    id: photo.id,
    path: photo.path,
    filename: photo.filename,
    source_origin: photo.source_origin,
    external_relpath: photo.external_relpath ?? null,
    size_bytes: photo.size_bytes ?? null,
    source_mtime_ms: photo.source_mtime_ms ?? null,
  }).whereNull('content_sha256')
    // Only while this run still holds the job: a runner whose lease was taken
    // over while it read a file must not write what it read.
    .whereExists(function () {
      this.select(db.raw('1')).from('maintenance_jobs').where({ job_name: JOB, claim_token: token });
    });
}

/**
 * Walk the candidates in id order, a batch at a time (memory stays flat
 * however large the library is), until none are left, the claim is lost or
 * a pause is asked for. Releases the claim with the run's counts.
 */
async function run(token, lease) {
  let hashed = 0;
  let failed = 0;
  let skipped = 0;
  let paused = false;
  let lostClaim = false;
  let lastId = 0;
  const counts = () => ({ hashed, failed, skipped, paused });

  try {
    for (;;) {
      const batch = await pending()
        .where('photos.id', '>', lastId)
        .orderBy('photos.id')
        .limit(BATCH)
        .select(
          'photos.id', 'photos.path', 'photos.filename', 'photos.source_origin', 'photos.external_relpath',
          'photos.size_bytes', 'photos.source_mtime_ms',
          'events.source_mode', 'events.external_path', 'events.slug'
        );
      if (batch.length === 0) break;

      for (const photo of batch) {
        if (lease.lost()) { lostClaim = true; break; }
        if (await maintenanceJobs.pauseRequested(JOB, token)) { paused = true; break; }
        lastId = photo.id;

        let hash;
        try {
          hash = await hashOriginal(photo);
        } catch (err) {
          // Recorded and passed over: a missing or unreadable original is
          // never tried again in a loop, and never stops the run.
          logger.warn(`Content-hash backfill: original of photo ${photo.id} could not be read: ${err.message}`);
          failed++;
          await fenced(photo, token)
            .update({ content_sha256_error: String(err.message || err).slice(0, ERROR_MAX) })
            .catch((writeErr) => logger.warn(`Content-hash backfill: could not record the error of photo ${photo.id}: ${writeErr.message}`));
          continue;
        }
        if (!hash) { skipped++; continue; }
        const updated = await fenced(photo, token).update({ content_sha256: hash, content_sha256_error: null });
        if (updated) hashed++; else skipped++;
      }
      if (lostClaim || paused) break;
    }

    if (lostClaim) {
      logger.warn(`Content-hash backfill stopped: claim taken over after ${hashed} hashed, ${failed} unreadable`);
      return;
    }
    await maintenanceJobs.release(JOB, token, counts());
    logger.info(
      `Content-hash backfill ${paused ? 'paused' : 'complete'}: ${hashed} hashed, ${failed} unreadable, `
      + `${skipped} skipped (changed mid-run)`
    );
  } catch (err) {
    logger.error('Content-hash backfill aborted:', err);
    await maintenanceJobs.release(JOB, token, { ...counts(), error: err.message }).catch(() => {});
  } finally {
    lease.stop();
  }
}

/**
 * Claim the job and say how much it has to read. Returns null when another
 * run holds the claim, else `{ count, run }`: `run()` does the work (the
 * route defers it past the response), or is null when there is nothing to
 * read and the claim has already been given back.
 *
 * `retryUnreadable` first clears the recorded read errors, so the originals
 * that failed before (a NAS that was not mounted) are tried once more.
 */
async function start({ retryUnreadable = false } = {}) {
  // Before the claim, not after it: a pause requested between the claim and
  // a later clear would be lost although the request was acknowledged.
  await maintenanceJobs.clearIdlePause(JOB);
  const token = await maintenanceJobs.claim(JOB);
  if (!token) return null;
  const lease = maintenanceJobs.startLeaseKeeper(JOB, token);

  let count;
  try {
    if (retryUnreadable) {
      await livePhotos(db).whereNull('content_sha256').whereNotNull('content_sha256_error')
        .update({ content_sha256_error: null });
    }
    count = Number((await pending().count('photos.id as count').first()).count);
  } catch (err) {
    lease.stop();
    await maintenanceJobs.release(JOB, token);
    throw err;
  }

  if (count === 0) {
    lease.stop();
    await maintenanceJobs.release(JOB, token);
    return { count, run: null };
  }
  return { count, run: () => run(token, lease) };
}

/** Progress, for the status endpoint. */
async function status() {
  const counts = await inScope()
    .count('photos.id as total')
    .count({ hashed: db.raw('CASE WHEN photos.content_sha256 IS NOT NULL THEN 1 END') })
    .count({ unreadable: db.raw('CASE WHEN photos.content_sha256 IS NULL AND photos.content_sha256_error IS NOT NULL THEN 1 END') })
    .first();
  const total = Number(counts.total);
  const hashed = Number(counts.hashed);
  const unreadable = Number(counts.unreadable);
  const remaining = total - hashed - unreadable;
  const state = await maintenanceJobs.read(JOB);
  const row = await db('maintenance_jobs').where({ job_name: JOB }).first('pause_requested');
  return {
    total,
    hashed,
    pending: remaining,
    unreadable,
    isRunning: state.isRunning,
    // Asked to pause, finishing the file it is on.
    pausing: state.isRunning && Boolean(row && row.pause_requested),
    // The last run stopped on a pause and there is still work: the button
    // reads "Resume".
    paused: !state.isRunning && Boolean(state.lastResult && state.lastResult.paused) && remaining > 0,
    lastResult: state.lastResult,
  };
}

/** Ask the running job to pause. False when it is not running. */
function pause() {
  return maintenanceJobs.requestPause(JOB);
}

module.exports = { start, status, pause, hashOriginal, __test: { run, pending } };
