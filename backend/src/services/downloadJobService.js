/**
 * Custom-resolution download jobs (#858).
 *
 * The plain download-all is served from the pre-built cache, which is built at
 * the gallery's STANDARD resolution. When a guest picks a different size there
 * is nothing to cache against — so instead of holding an HTTP connection open
 * while sharp chews through a whole gallery (a reverse proxy would time it out
 * long before it finished), the archive is built as a job:
 *
 *   POST .../download-jobs   → { token, status: 'pending' }
 *   GET  .../download-jobs/:token        → poll { status, progress }
 *   GET  .../download-jobs/:token/file   → the finished zip
 *   GET  .../download-jobs/:token/parts/:n/file → one part of a split job
 *
 * State lives in the `download_jobs` table rather than in memory: an in-memory
 * map loses every "ready" job on restart and is simply wrong the moment the
 * backend runs more than one replica.
 *
 * Artifacts land in the same `.download-cache` directory as the pre-built zip.
 * That directory is a dotfile, and s3AutoImporter skips dotfiles, so job zips
 * can never be mistaken for gallery photos and re-imported.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = require('fs').promises;
const crypto = require('crypto');
const archiver = require('archiver');
const { db } = require('../database/db');
const { getStorage } = require('./storage');
const { createArchiveStreamGuard } = require('../utils/archiveStreamGuard');
const { getUseOriginalFilenames, getZipEntryNames } = require('./downloadFilenameService');
const { renderPhotoForDownload, resolveWatermarkSettings } = require('./downloadRendition');
const { resolvePhotoStorageKey, resolvePhotoFilePath } = require('./photoResolver');
const { parseResolution } = require('../utils/downloadResolutions');
const { applyPhotoVisibilityFilter, canSeeHiddenPhotos } = require('../utils/photoVisibility');
const logger = require('../utils/logger');
const applicationWork = require('./activeApplicationWork');

const blockedFoldersOf = (eventId) => require('./folderTreeService').downloadBlockedFolderIds(eventId);

// How long a finished archive stays downloadable before the sweep deletes it.
const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour
// Guards against a handful of guests each kicking off a whole-gallery resize.
const MAX_CONCURRENT_BUILDS = 2;
// Hard ceiling on queued+running builds. Gallery routes are not behind the
// general rate limiter, so without this a token holder could vary the photo
// subset to enqueue unbounded 500-photo resizes — each one parking a promise
// and eventually a full gallery's worth of CPU and disk.
const MAX_QUEUED_BUILDS = 8;
// A build heartbeats while it works. A row whose heartbeat is older than this
// has no live worker (crashed or restarted) and may be failed by recovery.
const LEASE_TIMEOUT_MS = 5 * 60 * 1000;
// Split archives (issue 1733). A job that would write more than this into one
// zip is written as several, built one after the other by the same build, so
// it holds one build slot and one temp file of at most a part at a time.
// Nothing breaks without it (the archiver writes ZIP64); the parts are for the
// person downloading: smaller files, and a failed transfer costs one part.
const PART_MAX_BYTES = 2 * 1024 * 1024 * 1024;
// A second bound for the case the byte count cannot be trusted (below).
const PART_MAX_FILES = 10000;
// A stored file whose row carries no size is counted as this much.
const UNKNOWN_SIZE_ESTIMATE = 25 * 1024 * 1024;

/**
 * Does a file of `size` bytes open a new part? A part is never left empty, so
 * a single file larger than the limit gets a part of its own. Sizes are what
 * is actually written: the rendered buffer for a resized or watermarked
 * photo, the stored size for one that ships unchanged.
 */
function startsNewPart(part, size, limits) {
  if (part.files === 0) return false;
  return part.files >= limits.maxFiles || part.bytes + size > limits.maxBytes;
}

/** The parts of a split job, in order; empty for a job that is one archive. */
function partsOf(job) {
  if (!job || !job.parts) return [];
  try {
    const parts = JSON.parse(job.parts);
    return Array.isArray(parts) ? parts : [];
  } catch (_) {
    return [];
  }
}

/**
 * Collapse an access level to the visibility scope that decides WHICH photos a
 * requester may receive. Anything that can see hidden photos is one scope;
 * ordinary guests are another. Part of the job dedup identity so archives are
 * never shared across the boundary.
 */
function visibilityScope(accessLevel) {
  return canSeeHiddenPhotos(accessLevel) ? 'hidden' : 'public';
}

class DownloadJobService {
  constructor() {
    this.running = 0;
    // jobId -> in-flight build promise. Only jobs present here are safe to
    // rejoin; rows left 'pending'/'building' by a previous process are not.
    this.liveBuilds = new Map();
    // Slots claimed between the admission check and the liveBuilds entry.
    // Without it, concurrent requests all pass the check before any registers.
    this.reserved = 0;
    this.partLimits = { maxBytes: PART_MAX_BYTES, maxFiles: PART_MAX_FILES };
  }

  cacheDir(slug) {
    return path.posix.join('events/active', slug, '.download-cache');
  }

  jobKey(slug, token) {
    return path.posix.join(this.cacheDir(slug), `job-${token}.zip`);
  }

  partKey(slug, token, part) {
    return path.posix.join(this.cacheDir(slug), `job-${token}-part${part}.zip`);
  }

  /**
   * Stable identity for "the same archive".
   *
   * SECURITY: `visibilityScope` and the RESOLVED photo id list are part of the
   * identity, not just the requested one. A PIN client sees hidden photos that
   * an ordinary guest must not; without the scope in the key, a guest asking
   * for the same size would be handed the client's job token and could
   * download hidden photos, because the delivery route only checks the event
   * id. Hashing the resolved id set also stops a stale archive being reused
   * after photos are added, removed or hidden.
   */
  dedupKey(eventId, resolution, resolvedPhotoIds, watermark, visibilityScope) {
    const ids = [...resolvedPhotoIds].map(Number).sort((a, b) => a - b).join(',');
    // The full watermark SETTINGS, not just the on/off flag: an admin who
    // edits the watermark text or logo while it stays enabled would otherwise
    // have the old mark served from a ready job for the rest of its TTL.
    const wm = watermark
      ? crypto.createHash('sha256').update(JSON.stringify(watermark)).digest('hex').slice(0, 16)
      : 'raw';
    return crypto.createHash('sha256')
      .update(`${eventId}|${resolution}|${visibilityScope}|${ids}|${wm}`)
      .digest('hex')
      .slice(0, 64);
  }

  /**
   * The photos a given requester would actually receive. Used both to build
   * the dedup identity and to build the archive, so the two can never drift.
   */
  photoQuery(eventId, photoIds, accessLevel, blockedFolders = []) {
    // blockedFolders: folders whose downloads are off, inherited downwards
    // (issue 1786) — from folderTreeService.downloadBlockedFolderIds.
    let query = db('photos')
      .leftJoin('photo_categories', 'photos.category_id', 'photo_categories.id')
      .where('photos.event_id', eventId)
      .where(function () {
        this.whereNull('photos.category_id')
          .orWhere('photo_categories.allow_downloads', true)
          .orWhereNull('photo_categories.allow_downloads');
      })
      .where(require('./folderTreeService').whereFolderAllowsDownload(blockedFolders));
    if (photoIds && photoIds.length) {
      query = query.whereIn('photos.id', photoIds);
    }
    return applyPhotoVisibilityFilter(query, accessLevel);
  }

  /**
   * Find a job that already satisfies this request — either still building or
   * finished and not yet expired. Failed jobs are ignored so a transient error
   * doesn't poison every later attempt.
   *
   * `pending`/`building` rows are only reusable while THIS process is actually
   * building them: after a restart those rows have no live worker, so rejoining
   * one would leave the client polling until the TTL expires.
   */
  async findReusable(eventId, dedupKey) {
    const rows = await db('download_jobs')
      .where({ event_id: eventId, dedup_key: dedupKey })
      .whereIn('status', ['pending', 'building', 'ready'])
      .where('expires_at', '>', new Date().toISOString())
      .orderBy('id', 'desc');
    return rows.find((r) => r.status === 'ready' || this.liveBuilds.has(r.id)) || null;
  }

  /**
   * Create (or join) a job. Returns the job row. Building continues in the
   * background — callers poll getStatus().
   */
  async createJob({ event, resolution, photoIds, accessLevel }) {
    const watermark = await resolveWatermarkSettings(event);

    // Resolve the photo set up front, under THIS requester's visibility, so
    // the dedup identity reflects what they may actually receive.
    const resolved = await this.photoQuery(event.id, photoIds, accessLevel, await blockedFoldersOf(event.id)).select('photos.id');
    const resolvedIds = resolved.map((r) => r.id);
    if (resolvedIds.length === 0) {
      const err = new Error('No photos available for this selection');
      err.code = 'NO_PHOTOS';
      throw err;
    }

    const scope = visibilityScope(accessLevel);
    const dedupKey = this.dedupKey(event.id, resolution, resolvedIds, watermark, scope);

    const existing = await this.findReusable(event.id, dedupKey);
    if (existing) return existing;

    // Refuse rather than queue without bound. The client shows this as a
    // retryable error, which is far better than accepting work the box can't
    // absorb and timing the user out anyway.
    //
    // The slot is reserved SYNCHRONOUSLY here — checking liveBuilds.size and
    // only populating it after the awaited insert let a burst of concurrent
    // requests all pass the check before any of them registered.
    if (this.reserved + this.liveBuilds.size >= MAX_QUEUED_BUILDS) {
      const err = new Error('Too many downloads are being prepared right now');
      err.code = 'BUSY';
      throw err;
    }
    this.reserved += 1;

    try {
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + JOB_TTL_MS).toISOString();

      const inserted = await db('download_jobs').insert({
        token,
        event_id: event.id,
        resolution,
        photo_ids: JSON.stringify(resolvedIds),
        dedup_key: dedupKey,
        visibility_scope: scope,
        status: 'pending',
        heartbeat_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        expires_at: expiresAt,
      }).returning('id');
      const id = inserted[0]?.id ?? inserted[0];

      // Fire and forget — the row is the source of truth for progress. The
      // liveBuilds entry is what makes a pending/building row reusable; a row
      // without one is an orphan from a previous process.
      const promise = applicationWork.track('download job',
        () => this._build(id, event, resolution, resolvedIds, watermark, accessLevel))
        .catch((err) => logger.error('Download job build failed', { jobId: id, error: err.message }))
        .finally(() => this.liveBuilds.delete(id));
      this.liveBuilds.set(id, promise);

      return await db('download_jobs').where({ id }).first();
    } finally {
      // The slot is now accounted for by liveBuilds (or the insert failed).
      this.reserved -= 1;
    }
  }

  async getStatus(token) {
    return db('download_jobs').where({ token }).first();
  }

  /** Exposed so the delivery route can re-check the requester's scope. */
  visibilityScopeFor(accessLevel) {
    return visibilityScope(accessLevel);
  }

  /**
   * Is every photo in this finished archive STILL visible to the requester?
   *
   * The scope check alone isn't enough: a photo hidden after a public job went
   * ready stays inside that zip, and both job and requester are still
   * 'public', so the archive would keep serving it for the rest of its TTL.
   * Re-running the visibility query at delivery closes that window.
   */
  async isStillDeliverable(job, event, accessLevel) {
    let ids;
    try {
      ids = JSON.parse(job.photo_ids || '[]');
    } catch (_) {
      return false;
    }
    if (!Array.isArray(ids) || ids.length === 0) return false;

    // Every packaged photo must still be visible to this requester.
    const visible = await this.photoQuery(job.event_id, ids, accessLevel, await blockedFoldersOf(job.event_id)).select('photos.id');
    if (visible.length !== ids.length) return false;

    // …and the archive must still match the CURRENT rendition policy. Turning
    // a watermark on, editing it, or revoking a resolution after the job went
    // ready would otherwise keep serving the old bytes for the rest of the
    // TTL. Recomputing the identity is the cheapest way to notice: any input
    // that changes the archive changes the key.
    const watermark = await resolveWatermarkSettings(event);
    const expected = this.dedupKey(
      job.event_id, job.resolution, ids, watermark, visibilityScope(accessLevel)
    );
    return expected === job.dedup_key;
  }

  async _fail(id, message) {
    await db('download_jobs').where({ id }).update({
      status: 'failed',
      error: String(message).slice(0, 500),
      completed_at: new Date().toISOString(),
    });
  }

  async _build(id, event, resolution, photoIds, watermarkSettings, accessLevel) {
    // Back-pressure: a queued job stays 'pending' (which the UI shows as
    // "preparing") rather than piling more sharp pipelines onto a box that is
    // already saturated.
    while (this.running >= MAX_CONCURRENT_BUILDS) {
      await new Promise((r) => setTimeout(r, 500));
    }
    this.running += 1;

    let tmpDir;
    // Archives already in storage. One entry for an ordinary job; several
    // when the content outgrew a part (issue 1733).
    const uploaded = [];
    const storage = getStorage();
    try {
      await db('download_jobs').where({ id }).update({ status: 'building', heartbeat_at: new Date().toISOString() });

      // Same query that produced the dedup identity, so the archive can never
      // contain photos the requester wasn't entitled to at creation time.
      // The id breaks ties, so the same job always splits the same way.
      const photos = await this.photoQuery(event.id, photoIds, accessLevel, await blockedFoldersOf(event.id))
        .select('photos.*')
        .orderBy('photos.uploaded_at', 'desc')
        .orderBy('photos.id', 'desc');

      if (photos.length === 0) {
        await this._fail(id, 'No photos available for this selection');
        return;
      }

      const box = parseResolution(resolution);
      const useOriginal = await getUseOriginalFilenames();
      // Named across the whole job, so two parts never hold the same name
      // and all of them can be unpacked into one folder.
      const entryNames = getZipEntryNames(photos, useOriginal);
      const { token } = await db('download_jobs').where({ id }).first();

      tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'picpeak-dljob-'));

      let appended = 0;
      // Index of the next photo to place, and a photo already rendered that
      // did not fit the part being closed.
      let next = 0;
      let carried = null;
      while (next < photos.length) {
        const tmpPath = path.join(tmpDir, `${crypto.randomBytes(4).toString('hex')}.zip`);
        const partIds = [];
        let partBytes = 0;
        await new Promise((resolve, reject) => {
          const output = fs.createWriteStream(tmpPath);
          // level 0 — photos are already compressed, so deflate only burns CPU.
          const archive = archiver('zip', { zlib: { level: 0 } });
          // Bound and reclaim the storage reads (#1399 follow-up). The per-photo
          // catch below deliberately skips a bad source, but it never destroyed
          // the stream it had already opened, so every skipped photo leaked a
          // socket for the life of the process.
          // A queued read that dies would otherwise stall the archive and hold
          // its slot for the life of the build, so it fails the job instead.
          const guard = createArchiveStreamGuard({
            onFatalError: (err) => { guard.destroyAll(); archive.abort(); reject(err); },
          });
          output.on('close', resolve);
          archive.on('error', (err) => { guard.destroyAll(); reject(err); });
          archive.pipe(output);

          (async () => {
            for (; next < photos.length; next += 1) {
              const photo = photos[next];
              const name = entryNames[next] || `photo-${photo.id}.jpg`;
              try {
                const rendered = carried
                  ? carried.rendered
                  : await renderPhotoForDownload(event, photo, box, watermarkSettings);
                carried = null;
                const size = rendered ? rendered.length : (Number(photo.size_bytes) || UNKNOWN_SIZE_ESTIMATE);
                if (startsNewPart({ files: partIds.length, bytes: partBytes }, size, this.partLimits)) {
                  carried = { rendered };
                  break;
                }
                if (rendered) {
                  archive.append(rendered, { name });
                } else {
                  const key = resolvePhotoStorageKey(event, photo);
                  if (key) {
                    if (!await guard.acquire()) break;
                    archive.append(guard.track(await storage.get(key)), { name });
                  } else {
                    archive.file(resolvePhotoFilePath(event, photo), { name });
                  }
                }
                appended += 1;
                partIds.push(photo.id);
                partBytes += size;
                // Progress is coarse (photo count, not bytes) but it is what the
                // modal needs to show movement on a long build.
                if (appended % 10 === 0 || appended === photos.length) {
                  // Doubles as the lease heartbeat — see LEASE_TIMEOUT_MS.
                  await db('download_jobs').where({ id })
                    .update({ photo_count: appended, heartbeat_at: new Date().toISOString() });
                }
              } catch (err) {
                logger.warn('Skipping photo in download job', { jobId: id, photoId: photo.id, error: err.message });
              }
            }
            archive.finalize();
          })().catch((err) => { guard.destroyAll(); reject(err); });
        });

        // Only the tail can come out empty: every photo left was skipped.
        if (partIds.length === 0) break;

        const stat = await fsp.stat(tmpPath);
        // An ordinary job keeps its one key. Whether this is one is known
        // only when its first archive closes with nothing left to place.
        const key = uploaded.length === 0 && next >= photos.length
          ? this.jobKey(event.slug, token)
          : this.partKey(event.slug, token, uploaded.length + 1);
        await storage.putFromFile(key, tmpPath);
        uploaded.push({ zip_path: key, size_bytes: stat.size, photo_ids: partIds });
        // The next part reuses the space: at most one part sits in the temp dir.
        await fsp.rm(tmpPath, { force: true });
        await db('download_jobs').where({ id }).update({ heartbeat_at: new Date().toISOString() });
      }

      if (uploaded.length === 0) {
        await this._fail(id, 'No photos could be packaged');
        return;
      }

      const split = uploaded.length > 1;
      const totalBytes = uploaded.reduce((sum, part) => sum + part.size_bytes, 0);
      await db('download_jobs').where({ id }).update({
        status: 'ready',
        // A split job has no single archive; its parts carry the keys.
        zip_path: split ? null : uploaded[0].zip_path,
        parts: split ? JSON.stringify(uploaded) : null,
        size_bytes: totalBytes,
        photo_count: appended,
        // Only what actually landed in the zip: a missing/corrupt source is
        // skipped, and counting it as downloaded would inflate that photo's
        // stats for a file the guest never received. Kept SEPARATE from
        // photo_ids, which is the requested set the dedup fingerprint was
        // computed from — overwriting it would make every job with a skipped
        // photo fail the delivery fingerprint check.
        delivered_photo_ids: JSON.stringify(uploaded.flatMap((part) => part.photo_ids)),
        completed_at: new Date().toISOString(),
      });
      logger.info('Download job ready', { jobId: id, photos: appended, bytes: totalBytes, parts: uploaded.length });
    } catch (err) {
      logger.error('Download job error', { jobId: id, error: err.message });
      await this._fail(id, err.message).catch(() => {});
      // A failed row records no archive, so the sweep would never find these.
      for (const part of uploaded) {
        await storage.delete(part.zip_path).catch(() => {});
      }
    } finally {
      this.running -= 1;
      if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Fail rows left mid-build by a previous process. Without this they linger
   * as 'pending'/'building' until the TTL, and although findReusable now skips
   * them, the client that owns such a token would poll a job that can never
   * finish. Called once at startup.
   */
  async recoverOrphanedJobs() {
    // Only rows whose LEASE has expired. A live worker heartbeats while it
    // builds, so in a multi-replica deployment a rolling restart can't have
    // one replica fail jobs another is still working on — which a blanket
    // "fail everything pending" would do.
    const staleBefore = new Date(Date.now() - LEASE_TIMEOUT_MS).toISOString();
    const orphaned = await db('download_jobs')
      .whereIn('status', ['pending', 'building'])
      .where(function () {
        this.whereNull('heartbeat_at').orWhere('heartbeat_at', '<', staleBefore);
      })
      .update({
        status: 'failed',
        error: 'Interrupted by a server restart — please request the download again',
        completed_at: new Date().toISOString(),
      });
    if (orphaned > 0) {
      logger.info(`Failed ${orphaned} download job(s) orphaned by a restart`);
    }
    return orphaned;
  }

  /** Delete expired jobs and their artifacts. Returns how many were removed. */
  async sweepExpired() {
    const now = new Date().toISOString();
    const expired = await db('download_jobs').where('expires_at', '<=', now);
    if (expired.length === 0) return 0;

    const storage = getStorage();
    for (const job of expired) {
      const keys = [job.zip_path, ...partsOf(job).map((part) => part.zip_path)].filter(Boolean);
      for (const key of keys) {
        await storage.delete(key).catch((e) =>
          logger.warn('Failed deleting download job artifact', { jobId: job.id, error: e.message }));
      }
    }
    await db('download_jobs').whereIn('id', expired.map((j) => j.id)).del();
    logger.info(`Download job sweep removed ${expired.length} expired job(s)`);
    return expired.length;
  }
}

module.exports = new DownloadJobService();
module.exports.JOB_TTL_MS = JOB_TTL_MS;
module.exports.partsOf = partsOf;
module.exports.startsNewPart = startsNewPart;
