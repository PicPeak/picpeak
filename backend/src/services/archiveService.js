const archiver = require('archiver');
const { objectsToCsv } = require('../utils/spreadsheetSafe');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { db } = require('../database/db');
const { queueEmail, getSupportEmail } = require('./emailProcessor');
const logger = require('../utils/logger');
const feedbackService = require('./feedbackService');
const { getStorage } = require('./storage');
const { resolvePhotoStorageKey } = require('./photoResolver');
const { getUseOriginalFilenames } = require('./downloadFilenameService');
const { createArchiveStreamGuard } = require('../utils/archiveStreamGuard');
const { AppError } = require('../utils/errors');
const { parseBooleanInput } = require('../utils/parsers');
const jobState = require('./maintenanceJobState');
const { formatBoolean } = require('../utils/dbCompat');
const {
  sanitizeForZipEntry,
  uniquifyZipNames,
} = require('../utils/filenameSanitizer');

// One archive job per gallery (issue 2012). The route checked is_archived and
// then ran the whole job, and is_archived is only set once the zip is up, so a
// second click, a bulk archive or the expiry checker could start another job
// on the same gallery, and the first to finish deleted the photos the others
// were still reading. The claim is a maintenance_jobs row per gallery, so it
// holds across replicas and on both engines, and it is taken here rather than
// in the callers so all three are covered. No transaction is held open: the
// claim is one conditional UPDATE, renewed by a heartbeat while the job runs.
// A process that dies stops renewing, and the gallery is free again once the
// lease goes stale (maintenanceJobState.DEFAULT_STALE_MS); a fixed timeout
// would have to outlast the slowest archive on the slowest storage instead.
// archiveJobName, isZipKey, isExpiryAttempt and importArchiveRecords live in
// archiveRecords.js: the restore worker loads that one without this service.
const { archiveJobName, isZipKey, isExpiryAttempt, importArchiveRecords } = require('./archiveRecords');
// How often the post-publish cleanup re-checks the claim (see buildArchive).
const CLEANUP_CLAIM_CHECK_MS = 5000;
// events.archive_path is 255 characters; `events/archived/<slug>-<12 hex>.zip`
// spends 33 of them around the slug.
const ARCHIVE_SLUG_MAX = 255 - 33;

/** Whether an archive job holds a live claim on the gallery. */
async function isArchiveRunning(eventId) {
  return (await jobState.read(archiveJobName(eventId))).isRunning;
}

/**
 * Take the archive claim on a gallery and keep it renewed while held.
 *
 * Returns null when a live job holds it. A caller that has to act before the
 * archive starts (the expiry checker deactivates the gallery first) claims
 * here and hands the lease to archiveEvent, so nothing can start in between.
 * Whoever claimed releases; release() runs once.
 */
async function claimArchive(eventId) {
  const jobName = archiveJobName(eventId);
  await jobState.ensure(jobName);
  const token = await jobState.claim(jobName);
  if (!token) return null;
  const lease = { jobName, token, lost: false };
  const heartbeatTimer = setInterval(() => {
    jobState.heartbeat(jobName, token).then((ok) => { if (!ok) lease.lost = true; });
  }, jobState.HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();
  await removeAbandonedUpload(lease);
  let released = false;
  lease.release = async () => {
    if (released) return;
    released = true;
    clearInterval(heartbeatTimer);
    await jobState.release(jobName, token).catch((err) =>
      logger.warn(`Failed to release the archive claim for event ${eventId}: ${err.message}`));
  };
  return lease;
}

// Zips nothing names, kept on the gallery's claim row (last_result, which
// archive claims never use for a result):
//   - upload: the key a run is about to upload, cleared when it publishes or
//     removes the zip itself. Still there when the next claim lands, the run
//     died in between; each run writes a key of its own, so nothing would ever
//     overwrite or name that zip.
//   - superseded: zips a restore brought back. Kept until the gallery has a
//     newer archive, or is deleted: until then the zip is the copy to fall
//     back on, should anything (a job that stalled past its lease with a
//     delete under way) take a restored file. An abandoned upload joins
//     them once removed, to be removed again at the same points.
// Written only under the writer's own claim token.
const isArchiveKey = (key) => typeof key === 'string' && key.startsWith('events/archived/');

const parseArchiveState = (row) => {
  let state = null;
  try { state = JSON.parse(row?.last_result || 'null'); } catch { state = null; }
  return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
};

async function readArchiveState(jobName, conn = db) {
  return parseArchiveState(await conn('maintenance_jobs').where({ job_name: jobName }).first('last_result'));
}

// The state as this lease sees it, or null once the claim has moved on: a
// run that lost its claim must not act on what the new owner recorded.
async function readOwnState(lease, conn = db) {
  const row = await conn('maintenance_jobs')
    .where({ job_name: lease.jobName, claim_token: lease.token })
    .first('last_result');
  return row ? parseArchiveState(row) : null;
}

const writeArchiveState = (lease, state, conn = db) => conn('maintenance_jobs')
  .where({ job_name: lease.jobName, claim_token: lease.token })
  .update({ last_result: Object.keys(state).length ? JSON.stringify(state) : null });

const withSuperseded = (state, key) => {
  const superseded = Array.isArray(state.superseded) ? state.superseded : [];
  if (!superseded.includes(key)) superseded.push(key);
  return { ...state, superseded };
};

async function recordUpload(lease, key) {
  const { upload: _previous, ...state } = (await readOwnState(lease)) || {};
  await writeArchiveState(lease, key ? { ...state, upload: key } : state);
}

/**
 * Record the zip a restore brought back, to remove once it is superseded.
 * Pass the restore's transaction: the record has to land with the update
 * that clears archive_path, or nothing would name the zip any more. Throws
 * when the claim has moved on, so that update rolls back.
 */
async function recordSupersededArchive(lease, key, conn = db) {
  if (!isArchiveKey(key)) return;
  const state = await readOwnState(lease, conn);
  if (!state || !(await writeArchiveState(lease, withSuperseded(state, key), conn))) {
    throw new AppError('The archive claim was taken over', 409, 'ARCHIVE_IN_PROGRESS');
  }
}


/**
 * Zips restores brought back for this gallery, not yet removed. Never one
 * another gallery's archive_path names: that zip is its archive.
 */
async function supersededArchives(eventId) {
  const { superseded } = await readArchiveState(archiveJobName(eventId));
  const keys = Array.isArray(superseded) ? superseded.filter(isZipKey) : [];
  if (!keys.length) return [];
  const named = new Set(await db('events').whereIn('archive_path', keys).whereNot('id', eventId).pluck('archive_path'));
  return keys.filter((key) => !named.has(key));
}

/**
 * The zip a restore made before per-run keys left at the shared key
 * `events/archived/<slug>.zip`. Nothing recorded it: the next archive of the
 * slug used to overwrite it, and no longer does. Returned while no other
 * gallery's archive_path names it (an archive made before per-run keys is
 * still at such a key) and no other gallery's claim row records it; the
 * gallery's own archive_path is removed with it anyway. A rename records it
 * before the slug changes.
 */
async function legacyArchiveKeys(event) {
  if (!event || typeof event.slug !== 'string' || !event.slug) return [];
  const key = `events/archived/${event.slug}.zip`;
  if (!isZipKey(key)) return [];
  const named = await db('events').where('archive_path', key).whereNot('id', event.id).first('id');
  if (named) return [];
  // A gallery restored from it since per-run keys keeps it as its fallback,
  // and can have been renamed and its slug reused since. Matched as the
  // key's JSON text, the way last_result holds it.
  const recorded = await db('maintenance_jobs')
    .where('job_name', 'like', `${archiveJobName('')}%`)
    .whereNot('job_name', archiveJobName(event.id))
    .whereRaw('last_result LIKE ? ESCAPE \'!\'', [`%${JSON.stringify(key).slice(1, -1).replace(/[!%_]/g, (c) => `!${c}`)}%`])
    .select('last_result');
  const claimedElsewhere = recorded.some((row) => {
    const state = parseArchiveState(row);
    return state.upload === key || (Array.isArray(state.superseded) && state.superseded.includes(key));
  });
  return claimedElsewhere ? [] : [key];
}


/**
 * The claim rows' records, per gallery, for a portable export:
 * { "<eventId>": { superseded: [keys], expiry } }. maintenance_jobs is not
 * exported (live lease state), but its superseded zips are, under
 * events/archived, and these records are what removes them; an expiry
 * attempt is what retries a failed expiry archive. An upload a run has not
 * published (or died before publishing) goes with the superseded zips: on
 * the target nothing runs it.
 */
async function exportArchiveRecords(conn = db) {
  const rows = await conn('maintenance_jobs')
    .where('job_name', 'like', `${archiveJobName('')}%`)
    .whereNotNull('last_result')
    .select('job_name', 'last_result');
  const records = {};
  for (const row of rows) {
    const eventId = Number(row.job_name.slice(archiveJobName('').length));
    if (!Number.isInteger(eventId) || eventId <= 0) continue;
    const state = parseArchiveState(row);
    const keys = [...(Array.isArray(state.superseded) ? state.superseded : []), state.upload].filter(isZipKey);
    const record = {};
    if (keys.length) record.superseded = [...new Set(keys)];
    if (isExpiryAttempt(state.expiry)) record.expiry = state.expiry;
    if (Object.keys(record).length) records[eventId] = record;
  }
  return records;
}


// The expiry checker's attempt to archive a gallery it deactivated, kept on
// the same claim row (state key `expiry`: { attempts, at, expiresAt }) so a
// failed attempt is retried in a later pass. The checker only selects active
// galleries otherwise, and this is what tells its own deactivation apart from
// an admin's.
async function expiryAttempts() {
  const rows = await db('maintenance_jobs')
    .where('job_name', 'like', `${archiveJobName('')}%`)
    .whereNotNull('last_result')
    .select('job_name', 'last_result');
  return rows
    .map((row) => ({
      eventId: Number(row.job_name.slice(archiveJobName('').length)),
      attempt: parseArchiveState(row).expiry,
    }))
    .filter(({ eventId, attempt }) => Number.isInteger(eventId)
      && attempt && typeof attempt === 'object' && Number.isInteger(attempt.attempts));
}

/** The recorded expiry attempt as this lease sees it, or null. */
async function readExpiryAttempt(lease) {
  const state = await readOwnState(lease);
  return state?.expiry || null;
}

/** Record an expiry attempt under the lease, or clear it with null. False once the claim moved on. */
async function writeExpiryAttempt(lease, attempt) {
  const own = await readOwnState(lease);
  if (!own) return false;
  const { expiry: _previous, ...state } = own;
  return Boolean(await writeArchiveState(lease, attempt ? { ...state, expiry: attempt } : state));
}

// Never a key an event row names: that zip is somebody's archive.
const isReferenced = async (key) => Boolean(await db('events').where('archive_path', key).first('id'));

async function removeAbandonedUpload(lease) {
  try {
    const own = await readOwnState(lease);
    if (!own || !isArchiveKey(own.upload)) return;
    const { upload: key, ...state } = own;
    let next = state;
    // Published after all (the answer to its commit was lost): keep it.
    if (!(await isReferenced(key))) {
      await getStorage().delete(key).then(
        () => logger.info(`Removed the archive upload an interrupted run left behind: ${key}`),
        (err) => logger.warn(`Failed to remove the abandoned archive upload ${key}: ${err.message}`));
      // Kept with the superseded zips either way: the removal can fail, and a
      // run stalled mid-upload can still land the zip after it. The next
      // publish or the gallery delete removes it again.
      next = withSuperseded(state, key);
    }
    await writeArchiveState(lease, next);
  } catch (err) {
    logger.warn(`Could not check ${lease.jobName} for an abandoned archive upload: ${err.message}`);
  }
}

/** rmdir, bottom-up, every directory under `dir` (and `dir`) that holds nothing. */
async function pruneEmptyDirs(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return;
  for (const entry of entries) {
    if (entry.isDirectory()) await pruneEmptyDirs(path.join(dir, entry.name));
  }
  // Fails, and is meant to, on a directory that still holds something.
  await fsp.rmdir(dir).catch(() => {});
}

/** After a publish: the gallery has a newer archive, the restored-from zips can go. */
async function removeSupersededArchives(lease, publishedKey, event) {
  try {
    const state = await readOwnState(lease);
    if (!state) return;
    const kept = [];
    const candidates = [...(Array.isArray(state.superseded) ? state.superseded : [])];
    for (const key of await legacyArchiveKeys(event)) if (!candidates.includes(key)) candidates.push(key);
    for (const key of candidates) {
      if (!isArchiveKey(key) || key === publishedKey) continue;
      if (await isReferenced(key)) continue;
      try {
        await getStorage().delete(key);
      } catch (err) {
        logger.warn(`Failed to remove the superseded archive ${key}: ${err.message}`);
        kept.push(key);
      }
    }
    const { superseded: _done, ...rest } = state;
    await writeArchiveState(lease, kept.length ? { ...rest, superseded: kept } : rest);
  } catch (err) {
    logger.warn(`Could not remove the superseded archives of ${lease.jobName}: ${err.message}`);
  }
}

async function archiveEvent(event, { lease: heldLease = null } = {}) {
  const lease = heldLease || await claimArchive(event.id);
  if (!lease) {
    throw new AppError('This gallery is already being archived', 409, 'ARCHIVE_IN_PROGRESS');
  }
  try {
    // Read again under the claim: the caller's row can predate a job that
    // finished in the meantime, and archiving an archived gallery again would
    // zip its now empty prefix and publish that as the archive.
    const current = await db('events').where('id', event.id).first();
    if (!current) throw new AppError('Event not found', 404, 'EVENT_NOT_FOUND');
    if (parseBooleanInput(current.is_archived, false)) {
      throw new AppError('Event is already archived', 400, 'EVENT_ALREADY_ARCHIVED');
    }
    await buildArchive(current, lease);
  } finally {
    if (!heldLease) await lease.release();
  }
}

// Written at the zip root by buildArchive, next to the photos.
const MANIFEST_FILE = 'photos_manifest.json';
const FEEDBACK_JSON_FILE = 'feedback_data.json';
const FEEDBACK_CSV_FILE = 'feedback_data.csv';
const FEEDBACK_SUMMARY_FILE = 'feedback_summary.json';
const ARCHIVE_METADATA_FILES = [MANIFEST_FILE, FEEDBACK_JSON_FILE, FEEDBACK_CSV_FILE, FEEDBACK_SUMMARY_FILE];

async function buildArchive(event, lease) {
  const storage = getStorage();
  const archiveName = `${event.slug}.zip`;
  // A key of this run's own (issue 2012): a runner whose lease was taken over
  // can still be uploading, and at a shared key it would overwrite the zip
  // the winner published after deleting the originals. The download names
  // the file after the slug, so the suffix is never seen.
  // Bounded to events.archive_path (varchar 255 on PostgreSQL): the suffix
  // keeps it unique, the slug is only there for a human reading storage.
  const archiveRelKey = path.posix.join('events/archived',
    `${String(event.slug).slice(0, ARCHIVE_SLUG_MAX)}-${crypto.randomBytes(6).toString('hex')}.zip`);
  const eventPrefix = path.posix.join('events/active', event.slug);

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'picpeak-archive-'));
  // Not named after the slug: the temp directory is this run's own already,
  // and a slug past 242 characters made the name too long for the file system.
  const tmpArchive = path.join(tmpDir, 'archive.zip');

  try {
    // The gallery's trash (issue 1733) is deleted for good first: the zip
    // below takes every file under the gallery's prefix, and a photo the
    // admin deleted does not belong in the archive that is handed on.
    await require('./photoTrash').purgeEventTrash(event);

    // Photos manifest — the gallery filenames are renamed on upload, so
    // `original_filename` (and category linkage) can't be derived from the
    // extracted files alone. Persisting a manifest inside the archive lets a
    // future restore round-trip recover those fields. Falls back to bare
    // filename for archives produced before this lands (see restore path).
    // Serialized further down, once the zip entry names are known.
    let manifestRows = [];
    try {
      manifestRows = await db('photos')
        .leftJoin('photo_categories', 'photos.category_id', 'photo_categories.id')
        .where('photos.event_id', event.id)
        .select(
          'photos.filename',
          'photos.original_filename',
          'photos.type',
          // Not derivable from the extension for every format, and restore
          // has to know a video from a photo to write the row back. Both,
          // because neither is reliable alone: fileWatcher sets a video/*
          // mime_type but never media_type, so its videos carry the 'image'
          // default and every reader knows them as videos only through mime.
          'photos.media_type',
          'photos.mime_type',
          'photos.uploaded_at',
          // Photo credits (#1561): who uploaded it and the name on it, which
          // no file carries (a guest name, an admin correction), and the
          // guest's visibility snapshot. The ZIP is a snapshot: a guest
          // erased later is not rewritten out of an existing archive — the
          // restore drops the credit of any guest no longer on the event.
          'photos.uploaded_by',
          'photos.credit_name',
          'photos.credit_source',
          'photos.uploader_guest_id',
          'photos.credit_visible_to_guests',
          'photo_categories.name as category_name',
          // For resolving the row's storage key below, not written out.
          'photos.path',
          'photos.source_origin',
          // Turned into folder_path below (issue 1786), not written out.
          'photos.folder_id',
          'photos.first_look',
          // A team upload still under review (issue 743) has to come back
          // under review, not published by the restore.
          'photos.moderation_status',
          // Who uploaded it (issue 743), for the review badge; restored only
          // while that account still exists.
          'photos.uploaded_by_admin_id',
          // The frame an admin picked for a video's poster (issue 2263),
          // which the restored poster is rebuilt at.
          'photos.poster_offset_seconds',
        );
      // The folder a photo lives in, as a path ("Saturday/Activity B"):
      // folder ids do not survive a restore into a fresh database, names do.
      const folders = await require('./folderTreeService').eventFolders(event.id);
      const byId = new Map(folders.map((f) => [Number(f.id), f]));
      const pathOf = (id) => {
        const names = [];
        let cur = byId.get(Number(id));
        const seen = new Set();
        while (cur && !seen.has(cur.id)) {
          seen.add(cur.id);
          names.unshift(cur.name);
          cur = cur.parent_id ? byId.get(Number(cur.parent_id)) : null;
        }
        return names.length ? names.join('/') : null;
      };
      manifestRows = manifestRows.map((row) => ({ ...row, folder_path: row.folder_id ? pathOf(row.folder_id) : null }));
    } catch (error) {
      logger.error(`Error building photos manifest for event ${event.slug}:`, error);
      // Non-fatal — restore will fall back to filename as original_filename
      // for events archived without a manifest, same as the legacy behaviour.
    }

    // Collect feedback data first so it can be included as in-memory entries.
    const feedbackEntries = [];
    const feedbackSettings = await feedbackService.getEventFeedbackSettings(event.id);
    if (feedbackSettings.feedback_enabled) {
      try {
        logger.info(`Exporting feedback data for event ${event.slug}`);
        const feedbackData = await feedbackService.exportEventFeedback(event.id);

        if (feedbackData && feedbackData.length > 0) {
          feedbackEntries.push({
            name: FEEDBACK_JSON_FILE,
            buffer: Buffer.from(JSON.stringify(feedbackData, null, 2), 'utf8'),
          });
          feedbackEntries.push({
            name: FEEDBACK_CSV_FILE,
            buffer: Buffer.from(convertToCSV(feedbackData), 'utf8'),
          });
          const summary = await feedbackService.getEventFeedbackSummary(event.id);
          feedbackEntries.push({
            name: FEEDBACK_SUMMARY_FILE,
            buffer: Buffer.from(JSON.stringify(summary, null, 2), 'utf8'),
          });
          logger.info(`Feedback data exported: ${feedbackData.length} entries`);
        }
      } catch (error) {
        logger.error(`Error exporting feedback for event ${event.slug}:`, error);
        // Continue with archiving even if feedback export fails
      }
    }

    // Stream every photo (and any other content under events/active/{slug}/) into
    // the zip directly from the storage backend. Two kinds of file under the
    // prefix stay out of the zip but are still deleted with the originals:
    // the "Download all" cache, a second copy of every photo, and the
    // metadata files a restore wrote back, which are rebuilt fresh below and
    // would otherwise go in twice under the same name.
    const storedEntries = await storage.list(eventPrefix);
    const leftOut = new Set(ARCHIVE_METADATA_FILES.map((name) => `${eventPrefix}/${name}`));
    const photoEntries = storedEntries.filter((entry) => (
      !leftOut.has(entry.key) && !entry.key.startsWith(`${eventPrefix}/.download-cache/`)
    ));

    // #493: optionally rename zip entries to use original camera filenames.
    // Build a Map<storage_key, original_filename> from the photos table so we
    // can swap the basename of each entry while keeping the folder structure
    // (e.g. `individual/DSC_1234.jpg` instead of `individual/slug_001.jpg`).
    const useOriginal = await getUseOriginalFilenames();
    const originalsByKey = new Map();
    if (useOriginal) {
      const photoRows = await db('photos').where('event_id', event.id).select('*');
      for (const photoRow of photoRows) {
        if (!photoRow.original_filename) continue;
        try {
          const key = resolvePhotoStorageKey(event, photoRow);
          if (key) originalsByKey.set(key, photoRow.original_filename);
        } catch {
          // External-mode rows have no managed key; skip silently.
        }
      }
    }

    // Compute (subfolder, displayName) up front so collisions across the
    // whole zip can be resolved deterministically with `_N` suffixes.
    const photoNames = photoEntries.map((entry) => {
      const rel = entry.key.startsWith(`${eventPrefix}/`)
        ? entry.key.slice(eventPrefix.length + 1)
        : entry.key;
      if (!useOriginal) return rel;
      const originalBase = originalsByKey.get(entry.key);
      if (!originalBase) return rel;
      const sep = rel.lastIndexOf('/');
      const folder = sep >= 0 ? rel.slice(0, sep + 1) : '';
      return `${folder}${sanitizeForZipEntry(originalBase)}`;
    });
    const dedupedNames = uniquifyZipNames(photoNames);

    // Each manifest row records the entry name its file was emitted under,
    // so restore can match entry to row exactly. Matching on the basename
    // cannot always: with original names on, two photos sharing an original
    // are emitted as `X.jpg` and `X_1.jpg`, and an original can equal another
    // row's internal name. Both are undecidable from the basename alone.
    let photosManifestEntry = null;
    if (manifestRows.length > 0) {
      const zipPathByKey = new Map(photoEntries.map((entry, i) => [entry.key, dedupedNames[i]]));
      const manifest = manifestRows.map((row) => {
        const { path: _path, source_origin: _origin, folder_id: _folder, ...fields } = row;
        let zipPath = null;
        try {
          const key = resolvePhotoStorageKey(event, row);
          if (key) zipPath = zipPathByKey.get(key) || null;
        } catch {
          // No managed key (empty path on a legacy row): restore falls back
          // to the basename for this one, as it does for older archives.
        }
        return { ...fields, zip_path: zipPath };
      });
      photosManifestEntry = {
        name: MANIFEST_FILE,
        buffer: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
      };
      logger.info(`Photos manifest prepared: ${manifest.length} entries`);
    }

    let totalBytes = 0;
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(tmpArchive);
      const archive = archiver('zip', { zlib: { level: 9 } });
      // Bound and reclaim the storage reads, as the download builders do:
      // archiver drains one source at a time, so opening a read per photo in
      // the loop parked every other body on an S3 socket until its turn,
      // and a large event held most of the shared agent pool. Two in flight;
      // every open read is destroyed on any failure.
      const guard = createArchiveStreamGuard({
        onFatalError: (err) => { guard.destroyAll(); archive.abort(); reject(err); },
      });

      output.on('close', () => {
        totalBytes = archive.pointer();
        resolve();
      });
      output.on('error', (err) => { guard.destroyAll(); archive.abort(); reject(err); });
      archive.on('error', (err) => { guard.destroyAll(); reject(err); });
      archive.pipe(output);

      const append = async () => {
        for (let i = 0; i < photoEntries.length; i += 1) {
          const entry = photoEntries[i];
          const nameInZip = dedupedNames[i];
          if (!await guard.acquire()) return;
          archive.append(guard.track(await storage.get(entry.key)), { name: nameInZip });
        }
        for (const f of feedbackEntries) {
          archive.append(f.buffer, { name: f.name });
        }
        if (photosManifestEntry) {
          archive.append(photosManifestEntry.buffer, { name: photosManifestEntry.name });
        }
        archive.finalize();
      };

      append().catch((err) => { guard.destroyAll(); reject(err); });
    });

    // Upload the finalized zip to the storage backend.
    await recordUpload(lease, archiveRelKey);
    await storage.putFromFile(archiveRelKey, tmpArchive, { contentType: 'application/zip' });

    logger.info(`Archive created: ${archiveName} (${totalBytes} bytes)`);

    // Publish only while this run still holds the claim and nobody archived
    // the gallery first (issue 2012): a lease declared stale and taken over
    // (a stall long enough for that) must not mark the gallery archived or go
    // on to delete the originals the new owner is reading. The claim row is
    // locked first: a plain subquery would read it from the statement's
    // snapshot on PostgreSQL, so a takeover committed while the UPDATE waited
    // on the event row would go unseen. A takeover then waits for this commit
    // and its job re-reads is_archived. A run that loses removes its own zip;
    // the winner's sits at its own key. The DB goes BEFORE deleting originals
    // so a crash mid-cleanup leaves the archive accessible rather than
    // orphaning the photos.
    let published;
    try {
      published = !lease.lost && await db.transaction(async (trx) => {
        const held = await trx('maintenance_jobs')
          .where({ job_name: lease.jobName, claim_token: lease.token, is_running: true })
          .modify((q) => { if (trx.client.config.client === 'pg') q.forUpdate(); })
          .first('job_name');
        if (!held) return 0;
        const { upload: _published, ...state } = (await readOwnState(lease, trx)) || {};
        await writeArchiveState(lease, state, trx);
        return trx('events')
          .where('id', event.id)
          .where('is_archived', formatBoolean(false))
          .update({
            is_archived: true,
            archive_path: archiveRelKey,
            // The zip's own byte size — the same number the completion email
            // reports below. Persisted so the archives list can sort and display it
            // without statting every archive on every request.
            archive_size: totalBytes,
            archived_at: new Date(),
          });
      });
    } catch (err) {
      // The commit can have landed with only its answer lost: the zip stays
      // when the row names it, or the archive would point at nothing.
      const row = await db('events').where('id', event.id).first('archive_path').catch(() => null);
      if (row && row.archive_path !== archiveRelKey) await storage.delete(archiveRelKey).catch(() => {});
      throw err;
    }
    if (!published) {
      await storage.delete(archiveRelKey)
        .then(() => recordUpload(lease, null))
        .catch((err) => logger.warn(`Failed to remove the unpublished archive ${archiveRelKey}: ${err.message}`));
      throw new AppError('The archive claim was taken over', 409, 'ARCHIVE_IN_PROGRESS');
    }
    await removeSupersededArchives(lease, archiveRelKey, event);

    // The cleanup below deletes by key. A run that stalls past its lease
    // after publishing (a suspended process) can find the gallery restored
    // by then, its originals back under the same keys: checked before the
    // first delete and again once a few seconds have passed, and on a lost or
    // unreadable claim the cleanup stops. Leftover originals are recoverable; deleting
    // restored photos is not.
    // Checked before the first delete too: the run can have stalled anywhere
    // between the publish and here.
    let checkedAt = 0;
    const assertStillHeld = async () => {
      if (!lease.lost && Date.now() - checkedAt < CLEANUP_CLAIM_CHECK_MS) return;
      const renewed = await db('maintenance_jobs')
        .where({ job_name: lease.jobName, claim_token: lease.token, is_running: true })
        .update({ heartbeat_at: new Date().toISOString() });
      if (!renewed) {
        lease.lost = true;
        throw new AppError('The archive claim was taken over during cleanup', 409, 'ARCHIVE_IN_PROGRESS');
      }
      checkedAt = Date.now();
    };

    // Fire event.archived webhook (#327). Receivers infer per-photo loss
    // from this event — we deliberately do NOT fire photo.deleted for each
    // archived photo to avoid flooding subscribers on bulk archives.
    // Canonical event subject (#341) so the shape matches event.created /
    // event.published / event.expired; archive_path is an event.archived-
    // specific extra.
    try {
      const webhookService = require('./webhookService');
      await webhookService.fire('event.archived', {
        event: {
          ...webhookService.buildEventSubject({
            id: event.id,
            slug: event.slug,
            event_name: event.event_name,
            event_type: event.event_type,
            event_date: event.event_date,
            share_token: event.share_token,
            customer_name: event.customer_name || event.host_name,
            customer_email: event.customer_email || event.host_email,
            customer_phone: event.customer_phone,
          }),
          archive_path: archiveRelKey,
        },
      });
    } catch (e) { /* non-fatal */ }

    // The download cache goes with the originals and is not in the zip, so a
    // finished download job would be reused after a restore and answer 410
    // until it expired: fail them, the next request builds a new one. A job
    // still building would finish after the delete below and upload its zip
    // again, so it is failed too.
    await assertStillHeld();
    await require('./downloadJobService').cancelForEvent(
      event.id, 'The gallery was archived, please request the download again'
    );

    // Delete the originals from storage.
    for (const entry of storedEntries) {
      await assertStillHeld();
      await storage.delete(entry.key).catch((err) =>
        logger.warn(`Failed to delete archived original ${entry.key}: ${err.message}`)
      );
    }

    // On local disk the deleted keys were files in subfolders (collages/,
    // individual/, .download-cache/): drop what is empty now.
    if (storage.kind() === 'local') {
      await pruneEmptyDirs(storage.resolveLocalPath(eventPrefix)).catch(() => {});
    }

    // The download-all zip went with the loop above: clear the record that
    // points at it and cancel a build still in flight.
    await require('./downloadZipService').cleanup(event.id);

    // Delete derived images (thumbnails / heroes / previews / watermarks)
    // for this event's photos. The originals are inside the zip; the
    // derived tiers are throwaway and will be regenerated lazily on
    // restore (or not at all for archived events that nobody opens).
    const photos = await db('photos').where('event_id', event.id);
    for (const photo of photos) {
      await assertStillHeld();
      if (photo.thumbnail_path) {
        await storage.delete(photo.thumbnail_path).catch(() => {});
      }
      if (photo.hero_path) {
        await storage.delete(photo.hero_path).catch(() => {});
      }
      // Lightbox preview tier (#492). Same disposable-derived
      // semantics as thumbnails / heroes — wipe on archive.
      if (photo.preview_path) {
        await storage.delete(photo.preview_path).catch(() => {});
      }
      // Browser-playable video copy (issue 1430): the original is in the
      // zip, the copy is not. The row is reset with it: a row left at
      // `complete` would name a copy storage no longer has, and the
      // switch-on backfill only takes NULL and failed rows, so the restored
      // video could never get its copy back. The restore route re-queues it.
      // `skipped` rows have no copy and the original comes back byte for
      // byte, so that verdict stays.
      if (photo.web_path || (photo.web_status && photo.web_status !== 'skipped')) {
        if (photo.web_path) await storage.delete(photo.web_path).catch(() => {});
        await db('photos').where({ id: photo.id }).update({
          web_path: null, web_status: null, web_started_at: null, web_error: null,
        });
      }
      // Adaptive streaming ladder (issue 1733): derived, and not in the zip.
      // The row starts over, so the queue transcodes it again on a restore.
      // The row first: a transcode still running loses its claim with it and
      // cannot publish a ladder behind the sweep.
      if (photo.hls_status || photo.hls_path) {
        await db('photos').where({ id: photo.id }).update({
          hls_path: null, hls_status: null, hls_attempt_id: null, hls_started_at: null, hls_error: null,
        });
        await require('./videoHlsService').deleteLadder(photo);
      }
      // Outside the guard: a tier can exist when the canonical rendition never
      // did, so keying cleanup off preview_path would strand phone-only photos.
      await require('./imageProcessor').deletePreviewTiers(photo);
      await require('./imageProcessor').deleteThumbnailTiers(photo);
      // Best effort: remove watermarked variants too if a refactor added them.
      if (photo.watermark_path) {
        await storage.delete(photo.watermark_path).catch(() => {});
      }
    }

    // Purge face data (#1074). photo_faces cascades off photos, but archiving
    // does NOT delete the photo rows — and event_people hangs off the event,
    // which also survives. So neither would go without an explicit purge, and
    // an archived gallery would keep its biometric data indefinitely.
    //
    // Face data is derived: if the event is ever restored, re-enabling
    // detection re-scans. Nothing irreplaceable is lost except assigned
    // names, which is the same trade already accepted for backups/exports.
    try {
      const { purgeEvent } = require('./faceProcessor');
      await purgeEvent(event.id);

      // Turn detection OFF as well. purgeEvent clears the rows but leaves the
      // toggle on, so restoring the archive would bring back a gallery that
      // claims face detection is enabled while having no people and no queued
      // work — indistinguishable from a broken scan. Off is the honest state:
      // the photographer re-enables it and gets a fresh backfill, which is
      // exactly the flow the toggle already implements.
      await db('events').where({ id: event.id })
        .update({ face_recognition_enabled: false, faces_last_scan_at: null });
    } catch (err) {
      // Never fail an archive over this — but say so loudly, because it
      // means biometric data outlived the gallery.
      logger.error(
        `Archive: failed to purge face data for event ${event.slug} — ` +
        `face rows may remain. ${err.message}`
      );
    }

    // Queue completion email — admin_email is nullable on events (migration 073);
    // skip queueing rather than violating email_queue.recipient_email NOT NULL.
    //
    // The shipped EN/DE templates (legacy 028) and NL/PT/RU (core 075) reference
    // {{host_name}}, {{photo_count}}, {{archive_date}} and {{support_email}};
    // without these the recipient saw literal {{...}} placeholders.
    if (event.admin_email) {
      const supportEmail = await getSupportEmail();
      await queueEmail(event.id, event.admin_email, 'archive_complete', {
        host_name: event.customer_name || event.host_name || 'Admin',
        event_name: event.event_name,
        event_date: event.event_date,
        photo_count: photoEntries.length,
        archive_size: (totalBytes / 1024 / 1024).toFixed(2) + ' MB',
        archive_date: new Date(),
        support_email: supportEmail
      });
    } else {
      logger.info(`Skipping archive_complete email for event ${event.slug}: no admin_email set`);
    }
  } catch (error) {
    logger.error(`Error archiving event ${event.slug}:`, error);
    throw error;
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Feedback rows to CSV; quoting and formula neutralisation (GHSA-q82f)
// are the shared csvCell.
function convertToCSV(data) {
  return objectsToCsv(data);
}

module.exports = {
  archiveEvent, claimArchive, isArchiveRunning, pruneEmptyDirs, recordSupersededArchive, supersededArchives,
  legacyArchiveKeys, exportArchiveRecords, importArchiveRecords,
  expiryAttempts, readExpiryAttempt, writeExpiryAttempt,
};
