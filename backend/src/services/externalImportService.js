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
const sharp = require('./isolatedSharp');
const { retryTransient } = require('./imageResourcePolicy');
const { db, logActivity } = require('../database/db');
const logger = require('../utils/logger');
const { getExternalMediaRoot } = require('./externalMediaService');
const { assertRealpathUnder } = require('../utils/fileSecurityUtils');
const {
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  isVideoFile,
  videoMimeType,
  importableExtensions,
} = require('./externalMediaTypes');
const { generateThumbnail, extractCaptureDate, orientedDimensions } = require('./imageProcessor');
const { exifColumn } = require('./photoExif');
const { processUploadedVideo, posterFrameError, extractVideoMetadata } = require('./videoProcessor');
const { isInterruption: isResourceError } = require('./mediaProcessPolicy');
const { isUniqueViolation } = require('../utils/dbErrors');
const { resolveCredit } = require('./photoCredit');
const { photoCapOf, insertPhotoWithinCap } = require('./photoCap');
const jobState = require('./maintenanceJobState');
const externalAccess = require('./externalMediaAccess');
const folderTree = require('./folderTreeService');
const { parseBooleanInput } = require('../utils/parsers');
const { formatBoolean, isPostgreSQL } = require('../utils/dbCompat');
const { livePhotos } = require('../utils/photoVisibility');

/**
 * Where an external file lands (issues 1786 + 1562), from its path relative
 * to the imported folder. The first segment is still consumed by the
 * individual/collages type map. With the event's folder structure on, the
 * remaining directories become nested folders; a top-level FirstLook keyword
 * folder is a marker (photos flagged, folder not created) either way.
 */
function externalPlacement(rel, { map, keywords, mirror }) {
  const dirs = path.dirname(rel) === '.' ? [] : path.dirname(rel).split(path.sep);
  if (dirs.length && (dirs[0] === map.collages || dirs[0] === map.individual)) dirs.shift();
  const segs = folderTree.toSegments(dirs);
  // A directory name that is never a folder (".thumbnails", a name with a
  // backslash): the file is not part of the delivery, as on uploads.
  if (segs === null) return { segments: null, firstLook: false };
  if (segs.length && folderTree.matchesFirstLookKeyword(segs[0], keywords)) {
    return { segments: [], firstLook: true };
  }
  return { segments: mirror ? segs.slice(0, folderTree.MAX_FOLDER_DEPTH) : [], firstLook: false };
}

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

// Rows read from the share: what a scan looks after. A photo replaced by an
// upload keeps its external_relpath but is managed from then on.
const SERVED_ORIGINS = ['external', 'reference'];

// photos.unavailable_reason (migration 312) of a photo whose file is gone from
// the share: no gallery viewer sees it, the admin does.
const SOURCE_MISSING = 'source_missing';

/**
 * The served rows of an event under the folder a pass walked, with what the
 * vanished-file handling needs. `inScope` takes a root-relative path.
 */
async function servedRowsInScope(eventId, inScope) {
  const rows = await livePhotos(db)
    .where({ event_id: eventId })
    .whereIn('source_origin', SERVED_ORIGINS)
    .whereNotNull('external_relpath')
    .select('id', 'external_relpath', 'unavailable_reason', 'size_bytes', 'source_mtime_ms', 'filename', 'source_filename',
      'media_type', 'width', 'height', 'captured_at', 'duration');
  return rows.filter((r) => inScope(r.external_relpath));
}

/**
 * Whether a row's file is on the share: 'present', 'missing' (nothing at the
 * path) or 'unknown' (any other error, or a file only reachable through a
 * link out of the folder). Only 'missing' ever hides a photo.
 */
async function sourcePresence(access, full) {
  try {
    await fs.lstat(full);
  } catch (err) {
    return err.code === 'ENOENT' || err.code === 'ENOTDIR' ? 'missing' : 'unknown';
  }
  try {
    await externalAccess.authorizeSelectedFile(access, full);
    return 'present';
  } catch (_) {
    return 'unknown';
  }
}

/**
 * Whether a new file reads as the picture a vanished row recorded: same
 * dimensions and capture date (photo) or dimensions and runtime (video).
 * Anything unreadable, or a row without those values (a photo without a
 * capture date included), is not a match.
 */
async function describesRow(row, f) {
  if (row.width == null || row.height == null) return false;
  try {
    if (row.media_type === 'video' || isVideoFile(f.name)) {
      if (row.duration == null) return false;
      const m = await extractVideoMetadata(f.full);
      return Number(m.width) === Number(row.width) && Number(m.height) === Number(row.height)
        && Math.abs(Number(m.duration) - Number(row.duration)) < 0.5;
    }
    const { width, height } = orientedDimensions(await sharp(f.full).metadata());
    if (width !== Number(row.width) || height !== Number(row.height)) return false;
    // Two pictures without a capture date prove nothing: no match.
    if (!row.captured_at) return false;
    const taken = await extractCaptureDate(f.full).catch(() => null);
    return Boolean(taken) && taken.getTime() === new Date(row.captured_at).getTime();
  } catch (_) {
    return false;
  }
}

/**
 * A file renamed or moved on the share (issue 2121): its row, whose file is
 * gone, and a new file of the same size, modification time and extension,
 * seen in the same pass. The row takes the new path instead of the new file
 * being imported next to it. Size and time alone can meet by chance, so the
 * new file must also describe what the row recorded (describesRow). Only
 * one-to-one matches move: two candidates on
 * either side are left alone (the old row is marked missing and the new file
 * imported, as without this). The file name follows when the row still
 * carried the old one; folder, category and everything else stay.
 *
 * Stops as soon as `isLost()` says the pass lost its claim or eligibility.
 * Returns the number of rows moved.
 */
async function moveRenamedRows({ eventId, unseen, newFiles, toRootRelative, fullOf, access, automatic, isLost }) {
  const keyOf = (size, mtimeMs, name) => `${Number(size)}:${Math.floor(Number(mtimeMs))}:${path.extname(name).toLowerCase()}`;
  const group = (items, key) => {
    const map = new Map();
    for (const item of items) {
      const k = key(item);
      map.set(k, map.has(k) ? null : item);
    }
    return map;
  };
  const gone = group(
    unseen.filter((r) => r.size_bytes != null && r.source_mtime_ms != null),
    (r) => keyOf(r.size_bytes, r.source_mtime_ms, r.external_relpath)
  );
  const arrived = group(newFiles, (f) => keyOf(f.size, f.mtimeMs, f.name));
  let moved = 0;
  for (const [key, row] of gone) {
    // The claim or (automatic passes) the event's eligibility went: stop.
    if (isLost()) break;
    const f = arrived.get(key);
    if (!row || !f) continue;
    if (await sourcePresence(access, fullOf(row.external_relpath)) !== 'missing') continue;
    if (!(await describesRow(row, f))) continue;
    // The lookups above can outlast the claim: checked again before writing.
    if (isLost()) break;
    const newRel = toRootRelative(f.rel);
    if (automatic && await db('external_import_exclusions').where({ event_id: eventId, external_relpath: newRel }).first()) continue;
    const oldName = path.basename(row.external_relpath);
    const updates = { external_relpath: newRel, unavailable_reason: null };
    if (row.filename === oldName) updates.filename = f.name;
    if (row.source_filename === oldName) updates.source_filename = f.name;
    try {
      // Fenced on what was read: a row repointed or replaced since stays.
      moved += await livePhotos(db)
        .where({ id: row.id, external_relpath: row.external_relpath })
        .whereIn('source_origin', SERVED_ORIGINS)
        .update(updates);
    } catch (err) {
      // Another writer imported the new path meanwhile: both rows stay.
      if (!isUniqueViolation(err)) logger.warn(`Could not move photo ${row.id} to its renamed file: ${err.message}`);
    }
  }
  return moved;
}

// Bounds on the recursive walk. An event owner with photos.upload chooses the
// subtree, and a mount can be arbitrarily deep and wide; the walk stops at
// these, reports that it did, and imports what it found.
const MAX_WALK_DEPTH = 16;
const MAX_WALK_ENTRIES = 100000;

// How often a running import authorises its source again.
const REAUTHORIZE_EVERY_FILES = 500;
const REAUTHORIZE_EVERY_MS = 30000;

// Helper to recursively collect files under a directory, filtered by extension.
// `budget` is shared across the recursion: entries left to look at, and
// whether a bound was hit.
async function walkDir(dir, baseDir, extensions, budget = { entries: MAX_WALK_ENTRIES, truncated: false }, depth = 0, access = null) {
  const results = [];
  if (access) await externalAccess.authorizeSelectedFile(access, dir);
  if (depth > MAX_WALK_DEPTH) {
    budget.truncated = true;
    return results;
  }
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (budget.entries <= 0) {
      budget.truncated = true;
      break;
    }
    budget.entries -= 1;
    if (e.name.startsWith('.')) continue;
    // Never follow a link, to a directory or a file: the walk stays inside
    // the base it was given.
    if (e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      results.push(...await walkDir(full, baseDir, extensions, budget, depth + 1, access));
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (extensions.includes(ext)) {
        const rel = path.relative(baseDir, full);
        results.push({ full, rel, name: e.name });
      }
    }
  }
  return results;
}

// The derivative columns of a photo row. Each one renders the file's bytes,
// so a file edited in place makes every one of them stale.
const DERIVATIVE_COLUMNS = ['thumbnail_path', 'preview_path', 'hero_path', 'watermark_path'];

/**
 * A file already imported at this path, seen again on a re-scan.
 *
 * Unchanged (same size and modification time as recorded): nothing to do.
 * Changed: the row takes the new dimensions, capture date, camera details,
 * size and mtime, its derivatives are
 * dropped (the lazy paths build them again from the new bytes on first view)
 * and the thumbnail is made at once, as on import. Faces and scene tags
 * describe the old picture, so they are purged and queued again where the
 * gallery has them on.
 *
 * A video (issue 2114) takes the new size, mtime, runtime, codecs and
 * dimensions, gets a new poster frame, and its web copy and adaptive
 * streaming ladder start over: their columns are reset in the same update,
 * attempt ids included, so a transcode still running on the old bytes loses
 * its claim and cannot publish, and the queues convert the new file while
 * the settings are on. The old copy and ladder are removed once the row no
 * longer names them. Videos have no faces, scene tags or EXIF credit.
 *
 * Only rows still served from the share: a photo replaced by an upload keeps
 * its external_relpath (the dedupe key) but no longer reads this file.
 *
 * Returns 'refreshed', 'unchanged' (the file is the version recorded),
 * 'deferred' (automatic pass, file still being written) or 'skipped' (not
 * served from the share, or not refreshed this time).
 */
async function refreshChangedFile(row, f, { automatic, settleMs }) {
  const served = row.source_origin === 'external' || row.source_origin === 'reference';
  if (!served) return 'skipped';
  const isVideo = row.media_type === 'video' || isVideoFile(f.name);
  if (row.size_bytes == null) {
    // Imported before the size was recorded: nothing to compare against, so
    // record it and treat the file as the one the derivatives were made from.
    await db('photos').where({ id: row.id }).whereNull('size_bytes')
      .update({ size_bytes: f.size, source_mtime_ms: Math.floor(f.mtimeMs) });
    return 'unchanged';
  }
  // Size and modification time: an edit that keeps the byte count (a rating
  // or keyword written into the file) still moves the mtime. A row imported
  // before the mtime was recorded compares by size alone this once.
  const unchanged = (st) => Number(row.size_bytes) === st.size
    && (row.source_mtime_ms == null || Number(row.source_mtime_ms) === Math.floor(st.mtimeMs));
  if (unchanged(f)) {
    // Recorded now, with the same assumption as the size above: the file
    // seen is the one the derivatives were made from. Treating every such
    // row as changed would rebuild every external photo, and purge its
    // faces and tags, on the first pass after an upgrade.
    if (row.source_mtime_ms == null) {
      await db('photos').where({ id: row.id, size_bytes: row.size_bytes }).whereNull('source_mtime_ms')
        .update({ source_mtime_ms: Math.floor(f.mtimeMs) });
    }
    return 'unchanged';
  }
  // Stat again: the walk that produced `f` can be minutes old. A copy still
  // landing on the mount is left for the next pass, the same settle rule new
  // files get.
  const before = await fs.stat(f.full);
  if (unchanged(before)) return 'unchanged';
  if (automatic && settleMs > 0 && Date.now() - before.mtimeMs < settleMs) return 'deferred';

  let width = null;
  let height = null;
  let capturedAt = null;
  let exif = {};
  let credit = null;
  let video = null;
  if (isVideo) {
    // What ffprobe can tell, as on import. A file it cannot read still
    // gets the refresh (the poster falls back to the placeholder, as on
    // import); only a busy media worker leaves it for the next pass.
    let probed = null;
    try {
      probed = await extractVideoMetadata(f.full);
    } catch (probeErr) {
      if (isResourceError(probeErr)) return 'skipped';
      logger.warn(`Could not read changed external video ${f.rel}: ${probeErr.message}`);
    }
    // Read before the transaction: a query inside it would wait on
    // SQLite's single connection.
    video = { probed, webCopy: await require('./videoRenditionService').isEnabled() };
  } else {
    try {
      ({ width, height } = orientedDimensions(await retryTransient(() => sharp(f.full).metadata())));
    } catch (dimErr) {
      // Unreadable now (a half-written file the settle rule missed, or a
      // format Sharp refuses): keep the row as it is and try on the next pass.
      logger.warn(`Could not read changed external file ${f.rel}: ${dimErr.message}`);
      return 'skipped';
    }
    try {
      capturedAt = await extractCaptureDate(f.full);
    } catch (dateErr) {
      logger.warn(`Could not extract capture date for ${f.rel}: ${dateErr.message}`);
    }
    exif = await exifColumn(f.full);
    // The credit read from the file follows the file; a manual one stays.
    const creditFromFile = !row.credit_source || row.credit_source === 'exif';
    credit = creditFromFile ? await resolveCredit({ localPath: f.full, isVideo: false }) : null;
  }
  // Everything above must describe one version of the file: if it moved
  // while being read, try again on the next pass.
  const stats = await fs.stat(f.full);
  if (stats.size !== before.size || stats.mtimeMs !== before.mtimeMs) return 'deferred';

  const { getStorage } = require('./storage');
  const {
    deletePreviewTiers, deleteThumbnailTiers, previewTierKeys, thumbnailTierKeys,
  } = require('./imageProcessor');
  const storage = getStorage();

  // The caches go first, while the row still records the old size, so a
  // pass that cannot clear them leaves the row eligible and tries again.
  // Responsive tiers are served from a cache hit without looking at the
  // source, so one that survives would show the old picture for good; they
  // are checked, as the orientation repair does. A tier rebuilt meanwhile
  // by a viewer came from the new bytes and only costs a later retry.
  for (const column of DERIVATIVE_COLUMNS) {
    const key = row[column];
    if (!key) continue;
    // Another row pointing at this photo's file would show the edited
    // picture once it is rebuilt (the keys are named after this photo), so
    // that row lets go of it too and builds its own from its own source.
    const others = { [column]: null, ...(column === 'thumbnail_path' ? { thumb_hash: null } : {}) };
    await db('photos').whereNot('id', row.id).where(column, key).update(others);
    await storage.delete(key).catch(() => {});
  }
  await deletePreviewTiers(row).catch(() => {});
  await deleteThumbnailTiers(row).catch(() => {});
  const survivors = await Promise.all(
    [...previewTierKeys(row), ...thumbnailTierKeys(row)]
      .map((k) => storage.stat(k).then((st) => (st ? k : null)).catch(() => k))
  );
  if (survivors.some(Boolean)) {
    logger.warn(`Changed external photo ${row.id} (${f.rel}): cached renditions could not be removed, retrying on the next pass`);
    return 'skipped';
  }

  // Faces and scene tags describe the old picture: purged in the same
  // transaction as the new metadata, so neither lands without the other.
  const event = await db('events').where({ id: row.event_id }).first();
  const faceOn = await require('./faceSettings').isEnabledForEvent(event);
  const tagOn = await require('./tagSettings').isEnabledForEvent(event);
  const { purgePhotoFaces } = require('./faceProcessor');
  const { purgePhotoTags } = require('./tagProcessor');

  // Fenced on what was read: a concurrent pass that already refreshed the
  // row, or a replacement that repointed it, wins and this one does nothing.
  const fence = {
    id: row.id, size_bytes: row.size_bytes, source_mtime_ms: row.source_mtime_ms ?? null,
    source_origin: row.source_origin, external_relpath: row.external_relpath,
  };
  const m = video?.probed || {};
  const updates = {
    size_bytes: stats.size,
    source_mtime_ms: Math.floor(stats.mtimeMs),
    ...(isVideo ? {
      duration: m.duration ?? null,
      video_codec: m.videoCodec || null,
      audio_codec: m.audioCodec || null,
      width: m.width || null,
      height: m.height || null,
      // The poster note is written again with the new poster below.
      processing_error: null,
      // The web copy and the ladder start over, as on a replacement: the
      // attempt ids go, so a transcode of the old bytes can publish nothing.
      // The web copy is queued while its setting is on, except in an
      // archived gallery (as backfillPending); the ladder's queue picks up a
      // video with no status by itself.
      web_path: null,
      web_attempt_id: null,
      web_attempts: 0,
      web_retry_at: null,
      web_status: video.webCopy && !parseBooleanInput(event?.is_archived, false) ? 'pending' : null,
      web_started_at: null,
      web_error: null,
      hls_path: null,
      hls_status: null,
      hls_attempt_id: null,
      hls_attempts: 0,
      hls_retry_at: null,
      hls_started_at: null,
      hls_error: null,
    } : {
      width,
      height,
      captured_at: capturedAt ? capturedAt.toISOString() : null,
      // Camera details describe the file: the new one's, or none.
      exif_json: null,
      ...exif,
    }),
    thumb_hash: null,
  };
  for (const column of DERIVATIVE_COLUMNS) updates[column] = null;
  // A video's web copy and ladder as the row names them at the commit, read
  // under the row lock: one a transcode claimed or published since the
  // ladder was listed is removed too, and one claimed after the commit
  // converts the new bytes and is kept. The listing is made before the
  // transaction: on SQLite it holds the only connection.
  const sweepOldLadder = isVideo
    ? await require('./videoHlsService').captureLadder(await db('photos').where({ id: row.id }).first())
    : null;
  let atCommit = null;
  const committed = await db.transaction(async (trx) => {
    if (isVideo) {
      let read = trx('photos').where(fence);
      if (isPostgreSQL()) read = read.forUpdate();
      atCommit = await read.first();
      if (!atCommit) return false;
    }
    if (await trx('photos').where(fence).update(updates) !== 1) return false;
    if (isVideo) return true;
    if (credit) {
      await trx('photos').where({ id: row.id })
        .where((q) => q.whereNull('credit_source').orWhere('credit_source', 'exif'))
        .update({ credit_name: credit.credit_name || null, credit_source: credit.credit_source || null });
    }
    // A category the face scan chose for the old picture: the next scan
    // only categorises photos without one, so it has to go with the faces.
    // A category an admin chose stays.
    await trx('photos').where({ id: row.id, auto_categorized: formatBoolean(true) })
      .update({ category_id: null, auto_categorized: formatBoolean(false) });
    await purgePhotoFaces(row.id, trx);
    await purgePhotoTags(row.id, trx);
    await trx('photos').where({ id: row.id }).update({
      face_status: faceOn ? 'pending' : null,
      tag_status: tagOn ? 'pending' : null,
    });
    return true;
  });
  if (!committed) return 'skipped';

  // The tiers again, now that the row names the new version. A tier render
  // of the old bytes checks the row after writing (keepTierIfCurrent): one
  // that checked between the sweep above and the commit kept its file, under
  // an old-version key nothing derives any more. Only keys the new version
  // does not also list, so nothing it still reads goes.
  const current = { ...row, ...updates };
  const currentKeys = new Set([...previewTierKeys(current), ...thumbnailTierKeys(current)]);
  await Promise.all([...previewTierKeys(row), ...thumbnailTierKeys(row)]
    .filter((k) => !currentKeys.has(k))
    .map((k) => storage.delete(k).catch(() => {})));

  const thisVersion = { id: row.id, size_bytes: stats.size, source_mtime_ms: Math.floor(stats.mtimeMs) };
  if (isVideo) {
    // Nothing names the old copy or ladder any more.
    await require('./videoRenditionService').deleteWebCopy(atCommit);
    await sweepOldLadder(atCommit);
    // The poster, as the import makes it, under a key naming this version
    // (the old one went with the caches above): a pass over a later edit
    // never writes, or deletes, this one's file. The stem is cut to a
    // length the version suffix and storage's staging name still fit in.
    try {
      const posterName = require('./mediaAttemptService').outputName(
        `ext${row.id}_${path.basename(f.rel).replace(/\.[^.]+$/, '.jpg')}`,
        { id: `v${stats.size}m${Math.floor(stats.mtimeMs)}` }
      );
      const thumbnailKey = path.posix.join('thumbnails', `thumb_${posterName}`);
      const result = await processUploadedVideo(f.full, thumbnailKey);
      const took = await db('photos').where(thisVersion).whereNull('thumbnail_path').update({
        thumbnail_path: result.thumbnailKey,
        thumb_hash: result.thumbHash || null,
        processing_error: result.placeholder ? posterFrameError(result.thumbnailError) : null,
      });
      // A viewer's lazy poster got there first (under a key of its own), or
      // the file changed again: this one is nobody's.
      if (!took && result.thumbnailKey) {
        const now = await db('photos').where({ id: row.id }).first('thumbnail_path');
        if (now?.thumbnail_path !== result.thumbnailKey) await storage.delete(result.thumbnailKey).catch(() => {});
      }
    } catch (videoErr) {
      // ensureThumbnail makes it on first view instead.
      logger.warn(`Poster regeneration failed for changed external video ${row.id} (${f.rel}): ${videoErr.message}`);
      await db('photos').where(thisVersion).update({ processing_error: posterFrameError(videoErr.message) }).catch(() => {});
    }
  } else {
    try {
      const meta = {};
      const outputBasename = `ext${row.id}_${path.basename(f.rel)}`;
      const thumbnailPath = await generateThumbnail(f.full, { outputBasename, meta });
      if (thumbnailPath) {
        await db('photos').where(thisVersion)
          .whereNull('thumbnail_path')
          .update({ thumbnail_path: thumbnailPath, thumb_hash: meta.thumbHash || null });
      }
    } catch (thumbErr) {
      // ensureThumbnail makes it on first view instead.
      logger.warn(`Thumbnail regeneration failed for changed external photo ${row.id} (${f.rel}): ${thumbErr.message}`);
    }
  }

  // The watermark service keeps results in memory by the path it read and
  // that file's size and mtime, so no process serves the old picture from
  // it once the file changed. Its entries for the old bytes are dropped here
  // only to free the memory sooner (this process; others age them out).
  const watermarkService = require('./watermarkService');
  watermarkService.forgetSource(f.full);
  if (typeof storage.resolveLocalPath === 'function') {
    const derivativeKeys = [
      ...DERIVATIVE_COLUMNS.map((column) => row[column]).filter(Boolean),
      ...previewTierKeys(row), ...thumbnailTierKeys(row),
    ];
    for (const key of derivativeKeys) {
      try { watermarkService.forgetSource(storage.resolveLocalPath(key)); } catch (_) { /* not a local key */ }
    }
  }
  return 'refreshed';
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
 * @returns {Promise<{imported:number, skipped:number, deferred:number, excluded:number, thumbnailsGenerated:number, thumbnailsFailed:number, truncated:boolean, capReached:boolean, moved:number, missing:number, returned:number}>}
 *   `truncated`: the recursive walk hit its depth or entry bound and the
 *   folder was not read in full. `capReached`: the event's photo cap stopped
 *   the import; what was not imported is counted in `skipped`. `moved`: rows
 *   that followed a renamed file; `missing`: photos whose file is gone from
 *   the share, taken out of the gallery; `returned`: such photos whose file
 *   is back (issue 2121).
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
  // Load event
  const event = await db('events').where('id', eventId).first();
  if (!event) throw new EventNotFoundError(eventId);
  let access = await externalAccess.authorizeImport(eventId, externalPath, { actor, automatic });
  const external_path = access.relativePath;
  const mirrorFolders = parseBooleanInput(event.folder_structure, false);
  const firstLookKeywords = await folderTree.getFirstLookKeywords();
  const folderIdByPath = new Map();
  let firstLookImported = 0;

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
      && externalAccess.isStoredBinding(now, external_path)
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
    const baseAbs = access.target;
    // resolveExternalPath checks the string; this checks the filesystem. A
    // symlink inside EXTERNAL_MEDIA_ROOT chosen as the folder would otherwise
    // import whatever it points at and persist paths that lead back there.
    await assertRealpathUnder(getExternalMediaRoot(), baseAbs);

    // What gets STORED on the row (#1163). `f.rel` stays relative to the
    // imported folder because the type inference below reads its first segment
    // ('individual' / 'collages'); external_relpath is written relative to
    // EXTERNAL_MEDIA_ROOT so the row does not depend on a column this very
    // function is about to overwrite.
    const basePrefix = String(external_path).replace(/^\/+|\/+$/g, '');
    const toRootRelative = (rel) => (basePrefix ? path.join(basePrefix, rel) : rel);

    // Collect files. Images always; videos only for the types this install
    // accepts as uploads (see importableExtensions). The walk lists every
    // media type: a file of a type that is no longer allowed is still
    // visited when the gallery already has a row for it, so an edit to it is
    // picked up (issue 2120). It is never imported new.
    const extensions = await importableExtensions();
    const mediaExtensions = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS];
    const walkBudget = { entries: MAX_WALK_ENTRIES, truncated: false };
    const walked = recursive ? await walkDir(baseAbs, baseAbs, mediaExtensions, walkBudget, 0, access) : (await fs.readdir(baseAbs, { withFileTypes: true }))
      .filter(e => e.isFile())
      .map(e => ({ full: path.join(baseAbs, e.name), rel: e.name, name: e.name }))
      .filter(f => mediaExtensions.includes(path.extname(f.name).toLowerCase()));
    const isAllowed = (f) => extensions.includes(path.extname(f.name).toLowerCase());
    const disallowed = walked.filter((f) => !isAllowed(f));
    const disallowedWithRow = disallowed.length
      ? await existingRelpaths(eventId, disallowed.map((f) => toRootRelative(f.rel)))
      : new Set();
    const files = walked
      .filter((f) => isAllowed(f) || disallowedWithRow.has(toRootRelative(f.rel)))
      .map((f) => (isAllowed(f) ? f : { ...f, refreshOnly: true }));

    // Files gone from the share (issue 2121) are only judged after a complete
    // read of a folder that answered: a walk cut short says nothing about the
    // files it did not reach, and a folder that lists no file at all is as
    // likely an unmounted share (an empty mount point) as an emptied one. The
    // rows judged are this event's served rows under the folder walked (only
    // its own files when the walk was not recursive); a row whose file the
    // walk did not list is looked up at its path, so a file the walk leaves
    // out for another reason (a type no longer imported, a dot folder) is
    // never taken for a deleted one.
    const scopePrefix = basePrefix ? path.normalize(basePrefix) : '';
    const relInBase = (rel) => (scopePrefix ? rel.slice(scopePrefix.length + 1) : rel);
    const inScope = (rel) => {
      if (scopePrefix && !rel.startsWith(scopePrefix + path.sep)) return false;
      const inner = relInBase(rel);
      return Boolean(inner) && !inner.split(path.sep).includes('..') && (recursive || !inner.includes(path.sep));
    };
    const fullOf = (rel) => path.join(baseAbs, relInBase(rel));
    const walkComplete = !walkBudget.truncated && files.length > 0;
    const seenRelpaths = new Set(files.map((f) => toRootRelative(f.rel)));

    // Prepare file metadata and deduplicate by filename within type (keep largest)
    let skipped = 0;
    const preparedFiles = [];
    // Files of a type no longer allowed, with a row: refreshed, never
    // inserted, so they stay out of the dedupe and the settle wait below,
    // which only decide what gets inserted.
    const refreshOnlyFiles = [];
    for (const f of files) {
      await externalAccess.authorizeSelectedFile(access, f.full);
      try {
        const stats = await fs.stat(f.full);
        const segs = f.rel.split(path.sep);
        let type = 'individual';
        if (segs[0] === map.collages) type = 'collage';
        if (segs[0] === map.individual) type = 'individual';
        const where = externalPlacement(f.rel, { map, keywords: firstLookKeywords, mirror: mirrorFolders });
        if (where.segments === null) { skipped++; continue; }
        (f.refreshOnly ? refreshOnlyFiles : preparedFiles).push({ ...f, type, size: stats.size, mtimeMs: stats.mtimeMs, where });
      } catch (err) {
        skipped++;
      }
    }

    // Same name in two subfolders is two photos once the subfolders are
    // gallery folders (Friday/IMG_0001.jpg vs Saturday/IMG_0001.jpg); without
    // folders the historical type+name key stays, so flat imports dedupe
    // exactly as before.
    // The first-look flag is part of the key in both modes: FirstLook/IMG_1.jpg
    // and the full set's IMG_1.jpg are two photos (issue 1562), and completing
    // the delivery is what pairs them up.
    const dedupeKeyOf = (file) => (mirrorFolders
      ? `${file.type}:${path.dirname(file.rel).toLowerCase()}:${path.basename(file.rel).toLowerCase()}`
      : `${file.type}:${file.where && file.where.firstLook ? 'fl:' : ''}${path.basename(file.rel).toLowerCase()}`);
    const dedupeMap = new Map();
    for (const file of preparedFiles) {
      const dedupeKey = dedupeKeyOf(file);
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
          if (!dedupeMap.has(dedupeKeyOf(f))) continue;
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
          dedupeMap.delete(dedupeKeyOf(f));
        }
        if (deferred) logger.info(`External import for event ${eventId}: ${deferred} file(s) still changing, left for the next pass`);
      }
    }

    if (lost) throw new ImportInProgressError(eventId);
    access = await externalAccess.authorizeImport(eventId, external_path, { actor, automatic });
    // From here the source is authorised again every REAUTHORIZE_EVERY_FILES
    // files or REAUTHORIZE_EVERY_MS, whichever comes first, not per file: each
    // check is several queries and realpaths, and a run can be 100000 files.
    let authorizedAt = Date.now();
    let filesSinceAuthorized = 0;

    if (automatic) {
      // Follow the row, never write it. Writing source_mode/external_path
      // here would silently undo a save made while the tree was being walked
      // or the settle wait was running; and importing into an event that no
      // longer qualifies is wrong too. Re-read and stop if the row moved.
      // The heartbeat tick keeps re-checking during the loop.
      if (!(await stillEligible())) {
        logger.info(`External import for event ${eventId}: event no longer eligible, nothing imported`);
        const empty = { imported: 0, refreshed: 0, skipped, deferred, excluded, thumbnailsGenerated: 0, thumbnailsFailed: 0, truncated: walkBudget.truncated, capReached: false };
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
    let refreshed = 0;
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
    // are still untouched — see the whereNull there. Videos are kept out of
    // this list: they are not scanned, the same as for managed uploads.
    const importedPhotoIds = [];

    let superseded = false;

    // The event's photo cap (events.photo_cap). The upload routes enforce it;
    // this path inserted straight into `photos` and never looked. Checked and
    // inserted in one transaction per row by insertPhotoWithinCap, the same
    // as every other ingest, so a concurrent upload cannot overshoot with it.
    const photoCap = photoCapOf(event);
    let capReached = false;

    // A renamed file takes its row along before the loop below would import
    // it as a new photo (issue 2121).
    let moved = 0;
    let missing = 0;
    let returned = 0;
    // Paths of existing rows the loop below took through refreshChangedFile.
    const refreshedPaths = new Set();
    if (walkComplete) {
      const unseen = (await servedRowsInScope(eventId, inScope)).filter((r) => !seenRelpaths.has(r.external_relpath));
      if (unseen.length) {
        const candidates = [...dedupeMap.values()];
        const known = await existingRelpaths(eventId, candidates.map((f) => toRootRelative(f.rel)));
        const newFiles = candidates.filter((f) => !known.has(toRootRelative(f.rel)));
        if (newFiles.length) {
          moved = await moveRenamedRows({
            eventId, unseen, newFiles, toRootRelative, fullOf, access, automatic, isLost: () => lost,
          });
        }
      }
    }

    // Insert photos
    for (const f of [...dedupeMap.values(), ...refreshOnlyFiles]) {
      filesSinceAuthorized += 1;
      if (filesSinceAuthorized >= REAUTHORIZE_EVERY_FILES || Date.now() - authorizedAt >= REAUTHORIZE_EVERY_MS) {
        await externalAccess.authorizeImport(eventId, external_path, { actor, automatic });
        authorizedAt = Date.now();
        filesSinceAuthorized = 0;
      }
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
        // Its row went away since the walk: a type no longer allowed is not
        // imported again.
        if (!exists && f.refreshOnly) { skipped++; continue; }
        if (!exists && capReached) { skipped++; continue; }
        if (exists) {
          // The same path with other bytes: the file was edited on the share
          // (a re-export from Lightroom over the proof). Without this the row
          // kept the old dimensions, capture date and every derivative, so
          // the gallery showed the old picture for as long as they lived.
          const outcome = await refreshChangedFile(exists, f, { automatic, settleMs });
          refreshedPaths.add(relFromRoot);
          if (outcome === 'refreshed') refreshed++;
          else if (outcome === 'deferred') deferred++;
          else skipped++;
          // The file is back on the share: the photo is again in the gallery
          // once the row describes it, as recorded or refreshed. A copy still
          // landing, or bytes that could not be read, keep it out.
          if ((outcome === 'refreshed' || outcome === 'unchanged') && exists.unavailable_reason === SOURCE_MISSING) {
            returned += await livePhotos(db).where({ id: exists.id, unavailable_reason: SOURCE_MISSING })
              .update({ unavailable_reason: null });
          }
          continue;
        }

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
        const isVideo = isVideoFile(f.name);

        // Extract dimensions via Sharp. A video gets them from ffprobe after
        // the insert, together with its poster frame and runtime.
        let width = null;
        let height = null;
        if (!isVideo) {
          try {
            // A busy image worker is asked again before the file goes in
            // without dimensions; it is never left out of the import for that.
            const metadata = await retryTransient(() => sharp(f.full).metadata());
            // Oriented, not raw: a portrait shot from a body that tags rather
            // than rotates reports landscape dimensions, and the grid would size
            // its tile from those (#1185).
            ({ width, height } = orientedDimensions(metadata));
          } catch (dimErr) {
            logger.warn(`Could not extract dimensions for ${f.rel}: ${dimErr.message}`);
          }
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
        if (!isVideo) {
          try {
            capturedAt = await extractCaptureDate(f.full);
          } catch (dateErr) {
            logger.warn(`Could not extract capture date for ${f.rel}: ${dateErr.message}`);
          }
        }

        // Camera details (issue 1733, D1), same best-effort read.
        const exif = isVideo ? {} : await exifColumn(f.full);

        // Credit from EXIF (#1561), same best-effort read as the date above.
        // Videos carry none, as on every other ingest path.
        const credit = await resolveCredit({ localPath: f.full, isVideo });

        // Folder + first-look flag (issues 1786, 1562). Folders are created on
        // insert only; a rescan never moves an existing row, so an admin's
        // manual moves survive.
        const where = f.where || externalPlacement(f.rel, { map, keywords: firstLookKeywords, mirror: mirrorFolders });
        let folderId = null;
        if (where.segments.length) {
          const key = folderTree.pathKey(where.segments);
          if (!folderIdByPath.has(key)) {
            // foldAtLimit: past the per-event folder cap the file still imports,
            // into the deepest existing folder (logged), instead of being skipped.
            folderIdByPath.set(key, (await folderTree.ensurePath(eventId, where.segments, { canCreate: true, foldAtLimit: true })).folderId);
          }
          folderId = folderIdByPath.get(key);
        }

        let inserted;
        try {
          inserted = await insertPhotoWithinCap({
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
            // With the size, the version a re-scan compares (issue 2059).
            source_mtime_ms: Math.floor(stats.mtimeMs),
            width,
            height,
            source_origin: 'external',
            external_relpath: relFromRoot,
            folder_id: folderId,
            first_look: formatBoolean(where.firstLook),
            // .toISOString() rather than the Date: inside jest, Dates handed
            // to the sqlite3 binding land as the literal string
            // "[object Object]" (see CLAUDE.md). Strings round-trip on both
            // engines.
            captured_at: capturedAt ? capturedAt.toISOString() : null,
            ...exif,
            // Both columns, as the upload pipeline writes them: every
            // serving route and every image-only job tells a video from a
            // photo by these two.
            ...(isVideo ? { media_type: 'video', mime_type: videoMimeType(f.name) } : {}),
            ...credit
          }, photoCap);
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

        if (inserted === null) {
          // The cap is reached. Nothing after this file can be inserted
          // either, so the new files left are skipped without a stat or a
          // decode. The loop goes on for the files already in the gallery:
          // an edited one further down must still be refreshed, or a gallery
          // at its cap would never pick up an edit behind a new file.
          capReached = true;
          skipped++;
          logger.info(`External import for event ${eventId}: photo cap of ${photoCap} reached after ${imported} imported`);
          continue;
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
        if (photoId != null && !isVideo) {
          try {
            const outputBasename = `ext${photoId}_${path.basename(f.rel)}`;
            const meta = {};
            const thumbnailPath = await generateThumbnail(f.full, { outputBasename, meta });
            if (thumbnailPath) {
              await db('photos').where({ id: photoId }).update({ thumbnail_path: thumbnailPath, thumb_hash: meta.thumbHash || null });
              thumbnailsGenerated++;
            } else {
              thumbnailsFailed++;
            }
          } catch (thumbErr) {
            thumbnailsFailed++;
            logger.warn(`Thumbnail generation failed for external photo ${photoId} (${f.rel}): ${thumbErr.message}`);
          }
        }

        // A video goes through the same routine an uploaded one does: a poster
        // frame (or the placeholder when ffmpeg cannot read the file) plus
        // whatever ffprobe can tell about it, read straight off the mount. The
        // key is the one regenerateVideoThumbnail derives for an external row,
        // so a later regenerate overwrites this file instead of leaving it
        // behind. Best-effort like the image branch: on a failure
        // thumbnail_path stays null and ensureThumbnail retries on first view.
        if (photoId != null && isVideo) {
          try {
            const thumbnailKey = path.posix.join(
              'thumbnails',
              `thumb_ext${photoId}_${path.basename(f.rel).replace(/\.[^.]+$/, '.jpg')}`
            );
            const result = await processUploadedVideo(f.full, thumbnailKey);
            const m = result.metadata || {};
            await db('photos').where({ id: photoId }).update({
              thumbnail_path: result.thumbnailKey,
              thumb_hash: result.thumbHash || null,
              // Browser-playable copy (issue 1430, item 8). The copy is
              // written to the managed backend; the NAS file is never
              // touched.
              // Metadata stripping (issue 2102) queues it too.
              ...(await require('./videoRenditionService').queuesVideos() ? { web_status: 'pending' } : {}),
              // The placeholder is a completed row with a note, so the admin
              // grid can show it and offer a retry (issue 1430, item 6).
              processing_error: result.placeholder ? posterFrameError(result.thumbnailError) : null,
              ...(m.duration != null ? { duration: m.duration } : {}),
              ...(m.videoCodec ? { video_codec: m.videoCodec } : {}),
              ...(m.audioCodec ? { audio_codec: m.audioCodec } : {}),
              ...(m.width ? { width: m.width } : {}),
              ...(m.height ? { height: m.height } : {}),
            });
            thumbnailsGenerated++;
          } catch (videoErr) {
            thumbnailsFailed++;
            logger.warn(`Video processing failed for external video ${photoId} (${f.rel}): ${videoErr.message}`);
            await db('photos').where({ id: photoId })
              .update({ processing_error: posterFrameError(videoErr.message) })
              .catch(() => {});
          }
        }

        if (photoId != null && !isVideo) importedPhotoIds.push(photoId);
        imported += (inserted?.length ? 1 : 0);
        if (photoId != null && where.firstLook) firstLookImported += 1;

        // The manual Import is the explicit intent the exclusion list exists
        // to protect: what it brings back is no longer excluded.
        if (!automatic && photoId != null) {
          await db('external_import_exclusions').where({ event_id: eventId, external_relpath: relFromRoot }).delete();
        }
      } catch (e) {
        if (e instanceof externalAccess.ExternalMediaAccessError || e.code === 'PATH_OUTSIDE_BASE') throw e;
        skipped++;
      }
    }

    // Files gone from the share (issue 2121): never deleted, since a share
    // can come back. The photo leaves every gallery view and stays in the
    // admin's, marked, until the file returns (the mark goes) or the admin
    // deletes it. A visibility an admin chose is not touched either way.
    if (walkComplete && !superseded && !lost) {
      // On the loop's authorisation budget: each lookup counts as a file.
      const reauthorizeIfDue = async () => {
        if (filesSinceAuthorized >= REAUTHORIZE_EVERY_FILES || Date.now() - authorizedAt >= REAUTHORIZE_EVERY_MS) {
          access = await externalAccess.authorizeImport(eventId, external_path, { actor, automatic });
          authorizedAt = Date.now();
          filesSinceAuthorized = 0;
        }
      };
      await reauthorizeIfDue();
      // The folder must still answer: a share that dropped since the walk
      // would otherwise read as every file deleted.
      const stillThere = await fs.readdir(baseAbs).then((entries) => entries.length > 0).catch(() => false);
      for (const row of stillThere ? await servedRowsInScope(eventId, inScope) : []) {
        if (lost) break;
        // A file the loop took is its to restore: only after its refresh (or
        // a check that it is the version recorded) succeeded.
        if (refreshedPaths.has(row.external_relpath)) continue;
        const full = fullOf(row.external_relpath);
        let state = 'present';
        if (!seenRelpaths.has(row.external_relpath)) {
          filesSinceAuthorized += 1;
          await reauthorizeIfDue();
          state = await sourcePresence(access, full);
        }
        if (state === 'missing' && row.unavailable_reason == null) {
          // Fenced on the path and origin read: a row moved or replaced
          // since is not this file's.
          missing += await livePhotos(db)
            .where({ id: row.id, external_relpath: row.external_relpath })
            .whereIn('source_origin', SERVED_ORIGINS)
            .whereNull('unavailable_reason')
            .update({ unavailable_reason: SOURCE_MISSING });
        } else if (state === 'present' && row.unavailable_reason === SOURCE_MISSING) {
          // Back at its path but not taken by the loop (a type no longer
          // imported, a file another of the same name shadows): restored
          // only as the very version the row recorded.
          const st = await fs.stat(full).catch(() => null);
          const recorded = st && row.size_bytes != null && row.source_mtime_ms != null
            && Number(row.size_bytes) === st.size && Number(row.source_mtime_ms) === Math.floor(st.mtimeMs);
          if (recorded) {
            returned += await livePhotos(db).where({ id: row.id, unavailable_reason: SOURCE_MISSING })
              .update({ unavailable_reason: null });
          }
        }
      }
      if (missing) logger.info(`External import for event ${eventId}: ${missing} photo(s) whose file is gone from the share left the gallery`);
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

    // Scene tagging (issue 1733): the same late read and the same whereNull.
    try {
      const freshEvent = await db('events').where('id', eventId).first();
      if (importedPhotoIds.length && await require('./tagSettings').isEnabledForEvent(freshEvent)) {
        for (let i = 0; i < importedPhotoIds.length; i += 500) {
          await db('photos')
            .whereIn('id', importedPhotoIds.slice(i, i + 500))
            .whereNull('tag_status')
            .update({ tag_status: 'pending' });
        }
      }
    } catch (err) {
      logger.warn(`Could not queue imported photos for tagging (event ${eventId}): ${err.message}`);
    }

    const result = {
      imported, refreshed, skipped, deferred, excluded, thumbnailsGenerated, thumbnailsFailed,
      truncated: walkBudget.truncated, capReached, moved, missing, returned,
    };
    const changed = imported > 0 || refreshed > 0 || moved > 0 || missing > 0 || returned > 0;

    // A prebuilt "Download All" zip is only checked for existence, so it
    // kept serving the gallery as it was before this pass: without the new
    // photos, and with the old picture of an edited one. Once per pass, as
    // the upload and replacement routes do.
    if (changed) {
      try {
        require('./downloadZipService').invalidate(eventId);
      } catch (err) {
        logger.warn(`Download zip invalidation failed for event ${eventId}: ${err.message}`);
      }
    }

    if (firstLookImported > 0) {
      await require('./deliveryService').markFirstLookArrived(eventId, { actor, source: 'import' })
        .catch((err) => logger.warn(`First look switch failed for event ${eventId}: ${err.message}`));
    }

    // Only a run that changed something goes into the activity log. The
    // watcher re-runs this pass on a timer for every watched event, and a
    // "0 imported, 6012 skipped" row every fifteen minutes per event would
    // bury the entries an admin is actually looking for.
    if (changed || actor?.type !== 'system') {
      await logActivity(
        'external_import_completed',
        { event_id: eventId, ...result, external_path },
        eventId,
        actor || { type: 'system' }
      );
    }

    if (!superseded) await jobState.release(jobName, token, result);
    return result;
  } catch (error) {
    // Record the failure as the outcome, so the Photos tab (GET
    // /external-media/events/:id/status) says the import failed instead of
    // showing a finished scan of an apparently empty folder. Released in the
    // catch rather than a finally so a run that lost its claim does not clear
    // the new owner's flag — release() is token-scoped and refuses that anyway,
    // but there is no reason to make the call.
    // The marker is shown in the admin UI, so it carries a fixed code, not
    // the message: fs errors quote the absolute path under
    // EXTERNAL_MEDIA_ROOT, which the route's 500 deliberately hides.
    await jobState.release(jobName, token, { failed: true, error: importFailureCode(error) });
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
  }
}

/** The reason for a failed import, as a code the admin UI translates. */
function importFailureCode(error) {
  switch (error?.code) {
  case 'ENOENT':
  case 'ENOTDIR':
    return 'folder_missing';
  case 'EACCES':
  case 'EPERM':
    return 'permission_denied';
  default:
    return 'import_failed';
  }
}

module.exports = {
  externalPlacement,
  importExternalFolder,
  importFailureCode,
  recordExclusions,
  ImportInProgressError,
  EventNotFoundError,
  jobNameFor,
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
};
