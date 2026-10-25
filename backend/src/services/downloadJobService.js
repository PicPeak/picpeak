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
 *   POST .../download-jobs/:token/notify → mail me when it is ready
 *                                          (downloadJobNotifier.js)
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
const { renderPhotoForDownload, renderPreviewForDownload, previewDownloadName, resolveWatermarkSettings, isVideo } = require('./downloadRendition');
const { isGalleryPriced, resolveForcedWatermarkSettingsForPhoto } = require('../modules/photoSales/priceRules');
const { resolvePhotoStorageKey, resolvePhotoFilePath } = require('./photoResolver');
const { parseResolution, getDownloadGlobals } = require('../utils/downloadResolutions');
const { isGalleryAvailable, isGalleryExpired } = require('../utils/galleryLifecycle');
const { parseBooleanInput } = require('../utils/parsers');
const { applyPhotoVisibilityFilter, canSeeHiddenPhotos, livePhotos, wherePhotoProcessed } = require('../utils/photoVisibility');
const logger = require('../utils/logger');
const applicationWork = require('./activeApplicationWork');

const blockedFoldersOf = (eventId) => require('./folderTreeService').downloadBlockedFolderIds(eventId);

// How long a finished archive stays downloadable before the sweep deletes it:
// the "keep prepared downloads for" setting, one hour unless an admin raised
// it. Read when a job is created, so a change applies to new jobs.
const HOUR_MS = 60 * 60 * 1000;
async function jobTtlMs() {
  return (await getDownloadGlobals()).job_retention_hours * HOUR_MS;
}
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
  }

  cacheDir(slug) {
    return path.posix.join('events/active', slug, '.download-cache');
  }

  jobKey(slug, token) {
    return path.posix.join(this.cacheDir(slug), `job-${token}.zip`);
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
  dedupKey(eventId, resolution, resolvedPhotoIds, watermark, visibilityScope, priced = false) {
    const ids = [...resolvedPhotoIds].map(Number).sort((a, b) => a - b).join(',');
    // The full watermark SETTINGS, not just the on/off flag: an admin who
    // edits the watermark text or logo while it stays enabled would otherwise
    // have the old mark served from a ready job for the rest of its TTL.
    const wm = watermark
      ? crypto.createHash('sha256').update(JSON.stringify(watermark)).digest('hex').slice(0, 16)
      : 'raw';
    // Photo sales: a priced gallery packages previews, so a job
    // built before pricing (clean originals) must not match. Unpriced keys
    // stay byte-identical to upstream.
    const sales = priced ? '|priced' : '';
    return crypto.createHash('sha256')
      .update(`${eventId}|${resolution}|${visibilityScope}|${ids}|${wm}${sales}`)
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
    // Only what the gallery list shows: no photo still processing (or failed).
    let query = wherePhotoProcessed(livePhotos(db))
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
    const dedupKey = this.dedupKey(event.id, resolution, resolvedIds, watermark, scope, isGalleryPriced(event));

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
      const expiresAt = new Date(Date.now() + await jobTtlMs()).toISOString();

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
      job.event_id, job.resolution, ids, watermark, visibilityScope(accessLevel), isGalleryPriced(event)
    );
    return expected === job.dedup_key;
  }

  // Only a job still in flight: one cancelForEvent() failed keeps its reason.
  async _fail(id, message) {
    await db('download_jobs').where({ id }).whereIn('status', ['pending', 'building']).update({
      status: 'failed',
      error: String(message).slice(0, 500),
      completed_at: new Date().toISOString(),
    });
  }

  /**
   * Fail every queued, building and ready job of a gallery and delete the
   * zips of the ready ones. The archive calls it before it deletes the
   * gallery's files. A build still running finds its row failed: it stops,
   * or throws away the zip it uploaded instead of marking the job ready.
   */
  async cancelForEvent(eventId, message) {
    await db('download_jobs')
      .where({ event_id: eventId })
      .whereIn('status', ['pending', 'building', 'ready'])
      .update({ status: 'failed', error: message, completed_at: new Date().toISOString() });
    // Read after the update, so a build that went ready just before it is
    // in here with its zip_path.
    const withZip = await db('download_jobs')
      .where({ event_id: eventId, status: 'failed' })
      .whereNotNull('zip_path');
    const storage = getStorage();
    for (const job of withZip) {
      await storage.delete(job.zip_path).catch((e) =>
        logger.warn('Failed deleting download job artifact', { jobId: job.id, error: e.message }));
    }
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
    try {
      // A job the archive failed while it waited for a slot stays failed.
      const started = await db('download_jobs').where({ id, status: 'pending' })
        .update({ status: 'building', heartbeat_at: new Date().toISOString() });
      if (started === 0) return;

      // Same query that produced the dedup identity, so the archive can never
      // contain photos the requester wasn't entitled to at creation time.
      const photos = await this.photoQuery(event.id, photoIds, accessLevel, await blockedFoldersOf(event.id))
        .select('photos.*')
        .orderBy('photos.uploaded_at', 'desc');

      if (photos.length === 0) {
        await this._fail(id, 'No photos available for this selection');
        return;
      }

      const box = parseResolution(resolution);
      const storage = getStorage();
      const useOriginal = await getUseOriginalFilenames();
      const entryNames = getZipEntryNames(photos, useOriginal);

      tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'picpeak-dljob-'));
      const tmpPath = path.join(tmpDir, `${crypto.randomBytes(4).toString('hex')}.zip`);

      let appended = 0;
      const appendedIds = [];
      let cancelled = false;
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
          for (let i = 0; i < photos.length; i += 1) {
            const photo = photos[i];
            const name = entryNames[i] || `photo-${photo.id}.jpg`;
            try {
              // Photo sales: before the checkout every
              // photo of a priced gallery is packaged as the watermarked
              // low-quality preview; free photos and non-priced galleries
              // keep the historical build unchanged. Videos stay untouched.
              let photoSettings = watermarkSettings;
              let previewEntry = null;
              if (isGalleryPriced(event) && !isVideo(photo)) {
                photoSettings = await resolveForcedWatermarkSettingsForPhoto(event, photo);
                previewEntry = await renderPreviewForDownload(photo, photoSettings);
                // No preview means no photo: the original must never stand in.
                if (!previewEntry) throw new Error('No sales preview of this photo');
              }
              if (previewEntry) {
                archive.append(previewEntry.buffer, { name: previewDownloadName(name, previewEntry.extension) });
              } else {
                const rendered = await renderPhotoForDownload(event, photo, box, photoSettings);
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
              }
              appended += 1;
              appendedIds.push(photo.id);
              // Progress is coarse (photo count, not bytes) but it is what the
              // modal needs to show movement on a long build.
              if (appended % 10 === 0 || appended === photos.length) {
                // Doubles as the lease heartbeat — see LEASE_TIMEOUT_MS. No
                // row updated means the archive cancelled the job.
                const alive = await db('download_jobs').where({ id, status: 'building' })
                  .update({ photo_count: appended, heartbeat_at: new Date().toISOString() });
                if (alive === 0) {
                  cancelled = true;
                  break;
                }
              }
            } catch (err) {
              logger.warn('Skipping photo in download job', { jobId: id, photoId: photo.id, error: err.message });
            }
          }
          archive.finalize();
        })().catch((err) => { guard.destroyAll(); reject(err); });
      });

      if (cancelled) return;
      if (appended === 0) {
        await this._fail(id, 'No photos could be packaged');
        return;
      }

      const stat = await fsp.stat(tmpPath);
      const row = await db('download_jobs').where({ id }).first();
      if (row.status !== 'building') return;
      const key = this.jobKey(event.slug, row.token);
      await storage.putFromFile(key, tmpPath);

      // Only a job still building goes ready. The archive can cancel it
      // during the upload, after it deleted the gallery's files: then the
      // zip belongs to no job and goes too.
      const committed = await db('download_jobs').where({ id, status: 'building' }).update({
        status: 'ready',
        zip_path: key,
        size_bytes: stat.size,
        photo_count: appended,
        // Only what actually landed in the zip: a missing/corrupt source is
        // skipped, and counting it as downloaded would inflate that photo's
        // stats for a file the guest never received. Kept SEPARATE from
        // photo_ids, which is the requested set the dedup fingerprint was
        // computed from — overwriting it would make every job with a skipped
        // photo fail the delivery fingerprint check.
        delivered_photo_ids: JSON.stringify(appendedIds),
        completed_at: new Date().toISOString(),
      });
      if (committed === 0) {
        await storage.delete(key).catch((e) =>
          logger.warn('Failed deleting download job artifact', { jobId: id, error: e.message }));
        return;
      }
      logger.info('Download job ready', { jobId: id, photos: appended, bytes: stat.size });
      // Whoever asked to be mailed (issue 1733). The archive is ready either
      // way, so a mail that cannot be queued must not fail the job.
      await require('./downloadJobNotifier').notifyReady(id)
        .catch((err) => logger.warn('Download job mail failed', { jobId: id, error: err.message }));
    } catch (err) {
      logger.error('Download job error', { jobId: id, error: err.message });
      await this._fail(id, err.message).catch(() => {});
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

  /**
   * Can this finished archive still be handed to anyone (issue 1733)?
   *
   * The same answers the delivery route gives, asked without a request: the
   * gallery has to be open (not deleted, archived, deactivated or expired),
   * downloads have to be on, and the archive has to match the gallery as it
   * is now (isStillDeliverable: every photo still visible to the scope it was
   * built for, same watermark, same folder and category permissions). A
   * draft counts as open, because an admin preview can download from it.
   */
  async isDeliverableToAnyone(job, event) {
    if (!isGalleryAvailable(event, { adminPreview: true }) || isGalleryExpired(event)) return false;
    if (!parseBooleanInput(event.allow_downloads, true)) return false;
    // The two scopes map onto the two access levels that differ in what they
    // see: a 'hidden' archive was built for a client, the rest for a guest.
    const accessLevel = job.visibility_scope === 'hidden' ? 'client' : 'guest';
    return this.isStillDeliverable(job, event, accessLevel);
  }

  /**
   * Delete jobs past their retention, and finished archives that can no
   * longer be delivered: with a retention of days instead of an hour, those
   * would otherwise sit on disk until it ran out.
   *
   * Safe on several replicas at once: deleting a file that is already gone
   * is not an error in either storage backend, and deleting rows by id is a
   * no-op for the replica that comes second. Returns how many were removed.
   */
  async sweepExpired() {
    const now = new Date().toISOString();
    const expired = await db('download_jobs').where('expires_at', '<=', now);

    const undeliverable = [];
    const ready = await db('download_jobs').where({ status: 'ready' }).where('expires_at', '>', now);
    const events = new Map();
    for (const job of ready) {
      try {
        if (!events.has(job.event_id)) {
          events.set(job.event_id, await db('events').where({ id: job.event_id }).first());
        }
        if (!(await this.isDeliverableToAnyone(job, events.get(job.event_id)))) undeliverable.push(job);
      } catch (e) {
        // Unknown is not undeliverable: keep it and ask again next round.
        logger.warn('Could not check a download job for deliverability', { jobId: job.id, error: e.message });
      }
    }

    const doomed = [...expired, ...undeliverable];
    if (doomed.length === 0) return 0;

    const storage = getStorage();
    for (const job of doomed) {
      if (job.zip_path) {
        await storage.delete(job.zip_path).catch((e) =>
          logger.warn('Failed deleting download job artifact', { jobId: job.id, error: e.message }));
      }
    }
    const ids = doomed.map((j) => j.id);
    // Explicitly, not only through the cascade: SQLite enforces foreign keys
    // per connection.
    await db('download_job_recipients').whereIn('job_id', ids).del();
    // After the recipients (nothing new is queued for these jobs from here
    // on) and before the jobs, so a failure leaves them for the next round.
    await require('./downloadJobNotifier').cancelPendingMails(doomed);
    await db('download_jobs').whereIn('id', ids).del();
    logger.info(`Download job sweep removed ${expired.length} expired and ${undeliverable.length} undeliverable job(s)`);
    return doomed.length;
  }
}

module.exports = new DownloadJobService();
