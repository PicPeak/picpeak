/**
 * Import the files under an external-media folder into an event.
 *
 * This used to live inline in POST /events/:id/import-external. It moved here
 * because the folder watcher (issue 1187) needs to run the exact same pass
 * the Import button runs — same walk, same dedupe, same insert, same
 * thumbnail and face handling — without going through HTTP.
 *
 * Mutual exclusion is the database claim from maintenanceJobState, keyed per
 * event. It replaces the in-process Set the route used to keep (#1162): that
 * Set stopped a double-click in ONE process, but a watcher on a second
 * replica, or an admin clicking Import while the watcher is mid-run on
 * another, would still walk the same tree twice. The unique index from
 * migration 186 keeps that from duplicating rows; the claim keeps it from
 * wasting the walk. The run heartbeats as it goes so a claim from a process
 * that died is taken over rather than held forever.
 */

const path = require('path');
const fs = require('fs').promises;
const sharp = require('sharp');
const { db, logActivity } = require('../database/db');
const logger = require('../utils/logger');
const { resolveExternalPath } = require('./externalMediaService');
const { generateThumbnail, extractCaptureDate, orientedDimensions } = require('./imageProcessor');
const { isUniqueViolation } = require('../utils/dbErrors');
const { resolveCredit } = require('./photoCredit');
const jobState = require('./maintenanceJobState');

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

class ImportInProgressError extends Error {
  constructor(eventId) {
    super('An import is already running for this event. Wait for it to finish before starting another.');
    this.name = 'ImportInProgressError';
    this.eventId = eventId;
  }
}

class EventNotFoundError extends Error {
  constructor(eventId) {
    super('Event not found');
    this.name = 'EventNotFoundError';
    this.eventId = eventId;
  }
}

const jobNameFor = (eventId) => `external_import:${eventId}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Remember that an admin deleted these photos, so an automatic pass does not
 * bring them back (migration 209). Called from the photo delete routes.
 *
 * Keyed on external_relpath alone, not on source_origin: a replaced external
 * photo (photoReplacementService) becomes `managed` but deliberately keeps
 * its relpath, and deleting that replacement must not republish the NAS
 * original either. Rows without a relpath were never imported from the
 * folder and are skipped. Insert failures are swallowed on purpose: a
 * duplicate means the row is already there, and anything else must not turn
 * a successful delete into a 500.
 */
async function recordExclusions(eventId, photos) {
  for (const photo of photos) {
    if (!photo.external_relpath) continue;
    try {
      await db('external_import_exclusions').insert({ event_id: eventId, external_relpath: photo.external_relpath });
    } catch (err) {
      if (!isUniqueViolation(err)) {
        logger.warn(`Could not record import exclusion for photo ${photo.id}: ${err.message}`);
      }
    }
  }
}

/**
 * Root-relative paths of the rows an event already has, for a set of
 * candidates. Chunked for SQLite's bound-parameter cap.
 */
async function existingRelpaths(eventId, relpaths) {
  const found = new Set();
  for (let i = 0; i < relpaths.length; i += 500) {
    const rows = await db('photos')
      .where({ event_id: eventId })
      .whereIn('external_relpath', relpaths.slice(i, i + 500))
      .select('external_relpath');
    for (const r of rows) found.add(r.external_relpath);
  }
  return found;
}

// Helper to recursively collect files under a directory, filtered by image extensions
async function walkDir(dir, baseDir) {
  const results = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      results.push(...await walkDir(full, baseDir));
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (IMAGE_EXTENSIONS.includes(ext)) {
        const rel = path.relative(baseDir, full);
        results.push({ full, rel, name: e.name });
      }
    }
  }
  return results;
}

/**
 * Run one import pass.
 *
 * @param {object} opts
 * @param {number} opts.eventId
 * @param {string} opts.externalPath  folder relative to EXTERNAL_MEDIA_ROOT
 * @param {boolean} [opts.recursive=true]
 * @param {{individual?: string, collages?: string}} [opts.map]
 * @param {object|null} [opts.actor]  passed through to logActivity
 * @param {boolean} [opts.automatic=false]  the watcher's pass, as opposed to
 *   the Import button. An automatic pass never rewrites the event's source
 *   configuration (it follows the row, and stops if the row moved under it),
 *   skips files an admin deleted from this event (migration 209), and defers
 *   files that are still changing. The manual Import writes the folder it was
 *   given onto the event, ignores the exclusion list and clears it for what it
 *   imports.
 * @param {number} [opts.settleMs=0]  automatic passes: a new file modified
 *   within the last settleMs, or whose size moves during a wait of settleMs,
 *   is left for the next pass instead of being imported half-copied
 * @returns {Promise<{imported:number, skipped:number, deferred:number, excluded:number, thumbnailsGenerated:number, thumbnailsFailed:number}>}
 * @throws {EventNotFoundError} when the event does not exist
 * @throws {ImportInProgressError} when another run holds the claim for this event
 */
async function importExternalFolder({
  eventId,
  externalPath,
  recursive = true,
  map = { individual: 'individual', collages: 'collages' },
  actor = null,
  automatic = false,
  settleMs = 0,
}) {
  const external_path = externalPath;

  // Load event
  const event = await db('events').where('id', eventId).first();
  if (!event) throw new EventNotFoundError(eventId);

  // The claim comes AFTER the event lookup and BEFORE anything touches the
  // filesystem: a large tree takes long enough that a run looks hung and
  // admins click again, and letting that second run walk the whole tree only
  // to bounce every insert off the unique index wastes minutes of CPU and
  // reports a nonsense `skipped: 6012` back. Failing fast says what happened.
  const jobName = jobNameFor(eventId);
  await jobState.ensure(jobName);
  const token = await jobState.claim(jobName);
  if (!token) throw new ImportInProgressError(eventId);

  // Renew the lease on a clock for the WHOLE run, walk included. A large tree
  // on a slow mount can take longer than the stale window just to list, and
  // a runner declared stale during that phase would hand the folder to a
  // second runner while this one is about to start inserting. `lost` is
  // checked before the event is touched and on every loop iteration.
  let lost = false;

  // Automatic passes follow the row. The watcher decided to run this pass
  // from a snapshot of the event that may be a minute old by the time the
  // walk and the settle wait are done — and a long pass over a slow mount
  // can outlive several admin saves. The pass stops as soon as the event no
  // longer qualifies: watcher off, archived, deactivated, switched to
  // managed, or pointed at another folder.
  const stillEligible = async () => {
    const now = await db('events')
      .where('id', eventId)
      .select('source_mode', 'external_path', 'external_watch', 'is_active', 'is_archived')
      .first();
    return Boolean(now)
      && now.source_mode === 'reference'
      && (now.external_path || '') === String(external_path)
      && Boolean(now.external_watch)
      && Boolean(now.is_active)
      && !now.is_archived;
  };

  const heartbeatTimer = setInterval(() => {
    jobState.heartbeat(jobName, token).then((ok) => { if (!ok) lost = true; });
    if (automatic) {
      stillEligible().then((ok) => { if (!ok) lost = true; }).catch(() => {});
    }
  }, jobState.HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  try {
    const baseAbs = resolveExternalPath({ external_path }, '');

    // What gets STORED on the row (#1163). `f.rel` stays relative to the
    // imported folder because the type inference below reads its first segment
    // ('individual' / 'collages'); external_relpath is written relative to
    // EXTERNAL_MEDIA_ROOT so the row does not depend on a column this very
    // function is about to overwrite.
    const basePrefix = String(external_path).replace(/^\/+|\/+$/g, '');
    const toRootRelative = (rel) => (basePrefix ? path.join(basePrefix, rel) : rel);

    // Collect files
    const files = recursive ? await walkDir(baseAbs, baseAbs) : (await fs.readdir(baseAbs, { withFileTypes: true }))
      .filter(e => e.isFile())
      .map(e => ({ full: path.join(baseAbs, e.name), rel: e.name, name: e.name }))
      .filter(f => IMAGE_EXTENSIONS.includes(path.extname(f.name).toLowerCase()));

    // Prepare file metadata and deduplicate by filename within type (keep largest)
    let skipped = 0;
    const preparedFiles = [];
    for (const f of files) {
      try {
        const stats = await fs.stat(f.full);
        const segs = f.rel.split(path.sep);
        let type = 'individual';
        if (segs[0] === map.collages) type = 'collage';
        if (segs[0] === map.individual) type = 'individual';
        preparedFiles.push({ ...f, type, size: stats.size });
      } catch (err) {
        skipped++;
      }
    }

    const dedupeMap = new Map();
    for (const file of preparedFiles) {
      const dedupeKey = `${file.type}:${path.basename(file.rel).toLowerCase()}`;
      const existing = dedupeMap.get(dedupeKey);
      if (!existing || file.size > existing.size) {
        if (existing) skipped++;
        dedupeMap.set(dedupeKey, file);
      } else {
        skipped++;
      }
    }

    let deferred = 0;
    let excluded = 0;

    // Automatic passes: a file still being copied onto the mount is left for
    // the next pass. chokidar's awaitWriteFinish settles only the file that
    // fired the event, not its siblings, and the sweep sees no events at all
    // — so the check is done here, on the candidates that would actually be
    // inserted: anything modified within settleMs, or whose size moves across
    // a wait of settleMs, is deferred. One wait per pass, not per file. The
    // manual Import does not need it: an admin presses it when the copy is
    // done.
    if (automatic && settleMs > 0) {
      const candidates = [...dedupeMap.values()];
      const known = await existingRelpaths(eventId, candidates.map((f) => toRootRelative(f.rel)));
      const fresh = candidates.filter((f) => !known.has(toRootRelative(f.rel)));

      {
        const unsettled = [];
        const before = new Map();
        for (const f of fresh) {
          if (!dedupeMap.has(`${f.type}:${path.basename(f.rel).toLowerCase()}`)) continue;
          try {
            const st = await fs.stat(f.full);
            if (Date.now() - st.mtimeMs < settleMs) unsettled.push(f);
            else before.set(f.full, st.size);
          } catch (_) {
            unsettled.push(f);
          }
        }
        if (before.size) {
          await sleep(settleMs);
          for (const f of fresh) {
            if (!before.has(f.full)) continue;
            try {
              const st = await fs.stat(f.full);
              if (st.size !== before.get(f.full) || Date.now() - st.mtimeMs < settleMs) unsettled.push(f);
            } catch (_) {
              unsettled.push(f);
            }
          }
        }
        for (const f of unsettled) {
          deferred++;
          dedupeMap.delete(`${f.type}:${path.basename(f.rel).toLowerCase()}`);
        }
        if (deferred) logger.info(`External import for event ${eventId}: ${deferred} file(s) still changing, left for the next pass`);
      }
    }

    if (lost) throw new ImportInProgressError(eventId);

    if (automatic) {
      // Follow the row, never write it. Writing source_mode/external_path
      // here would silently undo a save made while the tree was being walked
      // or the settle wait was running; and importing into an event that no
      // longer qualifies is wrong too. Re-read and stop if the row moved.
      // The heartbeat tick keeps re-checking during the loop.
      if (!(await stillEligible())) {
        logger.info(`External import for event ${eventId}: event no longer eligible, nothing imported`);
        const empty = { imported: 0, skipped, deferred, excluded, thumbnailsGenerated: 0, thumbnailsFailed: 0 };
        await jobState.release(jobName, token, null);
        return empty;
      }
    } else {
      // Point the event at the new directory BEFORE inserting anything.
      //
      // Two reasons, both about what a half-finished import leaves behind. The
    // update used to run after the loop, so an import that died at photo 500
    // of 1000 left those 500 rows carrying external_relpath into the NEW tree
    // while the event still resolved against the OLD one — every one of them
    // unreadable. And with face detection on, enqueueEvent accepts
    // processing_status NULL (faceProcessor.js:243-246), which these inserts
    // leave unset, so an admin hitting the toggle or Re-scan mid-import could
    // queue those same rows against the stale path and burn them to 'failed'.
    //
    // Safe to do first for existing MANAGED photos: photo.source_origin takes
    // precedence over event.source_mode in both resolvers (photoResolver.js:23,
    // :52) and is NOT NULL defaulting to 'managed', so flipping source_mode
    // does not touch them.
    //
    // Safe for existing EXTERNAL rows too, as of #1163. It was not: relpaths
    // were stored relative to external_path, so overwriting the column here
    // rebased every row already in the event onto the new folder — quietly,
    // because their thumbnails were already on local disk and the grid carried
    // on rendering. Rows now carry a root-relative path and this write cannot
    // reach them.
      await db('events').where('id', eventId).update({ source_mode: 'reference', external_path });
    }

    let imported = 0;
    let thumbnailsGenerated = 0;
    let thumbnailsFailed = 0;

    // Face detection (#1090). Managed uploads are enqueued by photoProcessor,
    // which sets face_status 'pending' once a photo is processed
    // (photoProcessor.js:573) — but external media never goes through it, it
    // is inserted directly here. Before #1090 that was invisible, because
    // faceProcessor skipped externals anyway; now that they are scannable, an
    // import into an already-enabled event would still sit unscanned until
    // someone pressed Re-scan.
    //
    // Ids are collected unconditionally and the setting is read at the END,
    // not here: this loop can run for many minutes on a large library, and an
    // admin who enables detection during it would otherwise leave every photo
    // imported after that moment stuck at NULL forever — the toggle endpoint
    // only queues rows that already existed when it fired.
    //
    // The event path is already committed (above), so the enqueue below is
    // free of the ordering hazard it used to carry. It stays at the end anyway
    // so the setting can be read after the loop, and it only touches rows that
    // are still untouched — see the whereNull there. No video guard needed:
    // walkDir collects only jpg/jpeg/png/webp.
    const importedPhotoIds = [];

    let superseded = false;

    // Insert photos
    for (const f of dedupeMap.values()) {
      if (lost) {
        // Either another process took the claim over — it is walking this
        // same folder now, and the unique index makes anything we insert from
        // here a wasted stat + decode — or (automatic passes) the event
        // stopped qualifying. Stop and let whoever owns it now finish.
        superseded = true;
        logger.warn(`External import for event ${eventId} stopped mid-run (claim lost or event no longer eligible) after ${imported} imported`);
        break;
      }

      // Infer type by subfolder names
      const segs = f.rel.split(path.sep);
      let type = 'individual';
      if (segs[0] === map.collages) type = 'collage';
      if (segs[0] === map.individual) type = 'individual';

      const relFromRoot = toRootRelative(f.rel);

      try {
        // Fast path only. This SELECT settles the common case — a re-import of
        // a folder already in the event — without paying for a stat and a
        // Sharp metadata read per file. It is NOT the guard: those two calls
        // sit between here and the INSERT below, which is exactly the window
        // two overlapping imports both walked through (#1162). The unique
        // index from migration 186 is the guard, and the catch below is how
        // this loop converges when it fires.
        const exists = await db('photos')
          .where({ event_id: eventId, external_relpath: relFromRoot })
          .first();
        if (exists) { skipped++; continue; }

        // Automatic passes: checked HERE, per file, not against a snapshot
        // taken before the loop — an admin can delete a photo (which records
        // the exclusion) while this pass is walking or settling, and a
        // snapshot would let the loop re-insert it moments later.
        if (automatic) {
          const excludedRow = await db('external_import_exclusions')
            .where({ event_id: eventId, external_relpath: relFromRoot })
            .first();
          if (excludedRow) { excluded++; continue; }
        }
        const stats = await fs.stat(f.full);

        // Extract dimensions via Sharp
        let width = null;
        let height = null;
        try {
          const metadata = await sharp(f.full).metadata();
          // Oriented, not raw: a portrait shot from a body that tags rather
          // than rotates reports landscape dimensions, and the grid would size
          // its tile from those (#1185).
          ({ width, height } = orientedDimensions(metadata));
        } catch (dimErr) {
          logger.warn(`Could not extract dimensions for ${f.rel}: ${dimErr.message}`);
        }

        // Capture date from EXIF (#1172). Managed uploads get this from
        // photoProcessor, which external media never goes through — so
        // captured_at stayed NULL for every externally imported photo, and the
        // gallery's "Date Taken" sort silently degraded into import order via
        // its COALESCE fallback. On a library imported in two batches that put
        // the first days of a trip after the last ones.
        //
        // Read here because the file is already open a few lines above for the
        // dimensions, so this costs one more read of the same source rather
        // than a second pass over the mount.
        //
        // Best-effort, exactly like the dimensions: a source without EXIF, or
        // one Sharp/exifr cannot parse, imports with captured_at NULL and
        // falls back to uploaded_at as before.
        let capturedAt = null;
        try {
          capturedAt = await extractCaptureDate(f.full);
        } catch (dateErr) {
          logger.warn(`Could not extract capture date for ${f.rel}: ${dateErr.message}`);
        }

        // Credit from EXIF (#1561), same best-effort read as the date above.
        const credit = await resolveCredit({ localPath: f.full });

        let inserted;
        try {
          inserted = await db('photos')
            .insert({
              event_id: eventId,
              filename: f.name,
              // The camera-original name (#745). External ingest never sets
              // original_filename, and NAS-mounted galleries are among the
              // most likely to be driven from Lightroom — without this the
              // round-trip has nothing to match a RAW against.
              source_filename: f.name,
              // Keep path as a hint for legacy code but not used for resolution in external mode
              path: path.join(event.slug, f.name),
              thumbnail_path: null,
              type,
              size_bytes: stats.size,
              width,
              height,
              source_origin: 'external',
              external_relpath: relFromRoot,
              // .toISOString() rather than the Date: inside jest, Dates handed
              // to the sqlite3 binding land as the literal string
              // "[object Object]" (see CLAUDE.md). Strings round-trip on both
              // engines.
              captured_at: capturedAt ? capturedAt.toISOString() : null,
              ...credit
            })
            .returning('id');
        } catch (insertErr) {
          // Another writer inserted this exact path while we were reading
          // metadata. That is the outcome the index exists to produce, and it
          // is a skip rather than a failure — the row is there, it just isn't
          // ours. Counting it as `skipped` keeps the reported totals honest;
          // before the index this landed in the outer catch as a nameless
          // failure, or (more often) never fired at all and duplicated the row.
          if (isUniqueViolation(insertErr)) { skipped++; continue; }
          throw insertErr;
        }

        const photoId = Array.isArray(inserted) && inserted.length
          ? (typeof inserted[0] === 'object' ? inserted[0].id : inserted[0])
          : null;

        // Generate the thumbnail right away so the gallery grid can use the
        // managed thumbnail endpoint instead of falling back to the full
        // NAS-streamed original (#423). Best-effort: a single failure logs
        // a warning and leaves thumbnail_path=null — the gallery's
        // ensureThumbnail will retry lazily on first view. The cost of
        // doing this synchronously is ~100-300ms per image; for the
        // worst-case 1000-photo import that's still under the 5-minute
        // request timeout typical of the import flow.
        if (photoId != null) {
          try {
            const outputBasename = `ext${photoId}_${path.basename(f.rel)}`;
            const thumbnailPath = await generateThumbnail(f.full, { outputBasename });
            if (thumbnailPath) {
              await db('photos').where({ id: photoId }).update({ thumbnail_path: thumbnailPath });
              thumbnailsGenerated++;
            } else {
              thumbnailsFailed++;
            }
          } catch (thumbErr) {
            thumbnailsFailed++;
            logger.warn(`Thumbnail generation failed for external photo ${photoId} (${f.rel}): ${thumbErr.message}`);
          }
        }

        if (photoId != null) importedPhotoIds.push(photoId);
        imported += (inserted?.length ? 1 : 0);

        // The manual Import is the explicit intent the exclusion list exists
        // to protect: what it brings back is no longer excluded.
        if (!automatic && photoId != null) {
          await db('external_import_exclusions').where({ event_id: eventId, external_relpath: relFromRoot }).delete();
        }
      } catch (e) {
        skipped++;
      }
    }

    // The event already resolves to the new directory (set before the loop),
    // so the queue is safe to open. Still done here rather than on insert so
    // the setting below is read after the loop. Guarded the same way
    // photoProcessor guards it
    // (both the global flag and the per-event toggle), so installs without the
    // feature still never write a face_status. Re-read here rather than before
    // the loop so a toggle flipped mid-import is honoured.
    let queueFaces = false;
    try {
      const { isEnabledForEvent } = require('./faceSettings');
      const freshEvent = await db('events').where('id', eventId).first();
      queueFaces = await isEnabledForEvent(freshEvent);
    } catch (err) {
      // Never let the face feature break an import — the photos are the point.
      logger.warn(`Could not resolve face settings for event ${eventId}: ${err.message}`);
    }

    // Chunked because SQLite caps a statement at 999 bound parameters and an
    // import can be far larger than that.
    if (queueFaces && importedPhotoIds.length) {
      let queued = 0;
      for (let i = 0; i < importedPhotoIds.length; i += 500) {
        // whereNull, not a blanket set. Committing the event path before the
        // loop means a toggle or Re-scan firing mid-import can now genuinely
        // queue and even finish some of these rows — so an unconditional
        // update would drag 'done' rows back to 'pending' for a duplicate
        // scan, and knock 'processing' rows out from under the worker
        // mid-flight. Only rows nothing has touched are ours to queue.
        queued += await db('photos')
          .whereIn('id', importedPhotoIds.slice(i, i + 500))
          .whereNull('face_status')
          .update({ face_status: 'pending' });
      }
      logger.info(`Queued ${queued} of ${importedPhotoIds.length} imported external photo(s) for face scanning (event ${eventId})`);
    }

    const result = { imported, skipped, deferred, excluded, thumbnailsGenerated, thumbnailsFailed };

    // Only a run that changed something goes into the activity log. The
    // watcher re-runs this pass on a timer for every watched event, and a
    // "0 imported, 6012 skipped" row every fifteen minutes per event would
    // bury the entries an admin is actually looking for.
    if (imported > 0 || actor?.type !== 'system') {
      await logActivity(
        'external_import_completed',
        { event_id: eventId, ...result, external_path },
        eventId,
        actor || { type: 'admin' }
      );
    }

    if (!superseded) await jobState.release(jobName, token, result);
    return result;
  } catch (error) {
    // Release without a result so the last real outcome is kept, and in the
    // catch rather than a finally so a run that lost its claim does not clear
    // the new owner's flag — release() is token-scoped and refuses that anyway,
    // but there is no reason to make the call.
    await jobState.release(jobName, token, null);
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
  }
}

module.exports = {
  importExternalFolder,
  recordExclusions,
  ImportInProgressError,
  EventNotFoundError,
  jobNameFor,
  IMAGE_EXTENSIONS,
};
