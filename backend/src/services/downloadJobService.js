/**
 * Prepared gallery archive downloads (#858, #1966).
 *
 * The ready whole-gallery cache is already a native download. Other archives
 * are prepared as jobs so neither a browser Blob nor a long-running HTTP
 * preparation request has to hold a whole gallery:
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
const { Transform } = require('stream');
const archiver = require('archiver');
const { db } = require('../database/db');
const { getStorage } = require('./storage');
const { createArchiveStreamGuard } = require('../utils/archiveStreamGuard');
const { getUseOriginalFilenames, getZipEntryNames } = require('./downloadFilenameService');
const { renderPhotoForDownload, renderPreviewForDownload, previewDownloadName, renderedDownloadType, resolveWatermarkSettings, isVideo } = require('./downloadRendition');
const { isGalleryPriced, resolveForcedWatermarkSettingsForPhoto } = require('../modules/photoSales/priceRules');
const { resolvePhotoStorageKey, resolvePhotoFilePath } = require('./photoResolver');
const { parseResolution, getDownloadGlobals, resolveEventDownloadPolicy, pickRequestedResolution } = require('../utils/downloadResolutions');
const { isGalleryAvailable, isGalleryExpired } = require('../utils/galleryLifecycle');
const { parseBooleanInput } = require('../utils/parsers');
const { applyPhotoVisibilityFilter, canSeeHiddenPhotos, livePhotos, wherePhotoProcessed } = require('../utils/photoVisibility');
const logger = require('../utils/logger');
const applicationWork = require('./activeApplicationWork');
const { buildEntryManifest } = require('./downloadJobManifest');
const { retireReadyJobs } = require('./downloadJobCache');
const { readEntryManifest } = require('./downloadJobDelivery');
const { createBuildProgress } = require('./downloadJobProgress');
const { downloadLimitOf } = require('./downloadQuota');
const { uniquifyZipNames } = require('../utils/filenameSanitizer');

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
// A gallery cannot fill the instance queue. The storage budget includes
// in-flight reservations and evicts replaceable ready archives as needed.
const MAX_EVENT_BUILDS = 2;
const MAX_EVENT_STORED_JOBS = 4;
const STALL_TIMEOUT_MS = 2 * 60 * 1000;
const PROGRESS_INTERVAL_MS = 30 * 1000;
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
  constructor({ stallTimeoutMs = STALL_TIMEOUT_MS } = {}) {
    this.running = 0;
    // jobId -> in-flight build promise. Only jobs present here are safe to
    // rejoin; rows left 'pending'/'building' by a previous process are not.
    this.liveBuilds = new Map();
    // Slots claimed between the admission check and the liveBuilds entry.
    // Without it, concurrent requests all pass the check before any registers.
    this.reserved = 0;
    this.stallTimeoutMs = stallTimeoutMs;
    this.readyStats = new Map();
    this.reservedByEvent = new Map();
    this.buildEvents = new Map();
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
  dedupKey(eventId, resolution, resolvedPhotoIds, watermark, visibilityScope, priced = false, { version = 1, previewOnly = false } = {}) {
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
    const mode = version >= 2 ? `|v${version}|${previewOnly ? 'preview' : 'download'}` : '';
    const sales = priced ? '|priced' : '';
    return crypto.createHash('sha256')
      .update(`${eventId}|${resolution}|${visibilityScope}|${ids}|${wm}${sales}${mode}`)
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
  async findReusable(eventId, dedupKey, query = db) {
    const rows = await query('download_jobs')
      .where({ event_id: eventId, dedup_key: dedupKey })
      .whereIn('status', ['pending', 'building', 'ready'])
      .where(function () {
        this.where('expires_at', '>', new Date().toISOString()).orWhereIn('status', ['pending', 'building']);
      })
      .orderBy('id', 'desc');
    return rows.find((r) => {
      if (r.status !== 'ready') return this.liveBuilds.has(r.id);
      if ((r.policy_version || 1) < 2) return true;
      if (r.policy_version === 2) return false;
      let ids;
      try { ids = JSON.parse(r.delivered_photo_ids); } catch (_) { return false; }
      return !!readEntryManifest(r, ids, Number(r.size_bytes));
    }) || null;
  }

  /**
   * Create (or join) a job. Returns the job row. Building continues in the
   * background — callers poll getStatus().
   */
  async createJob({ event, resolution, photoIds, accessLevel, previewOnly = false }) {
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
    const identityWatermark = isGalleryPriced(event)
      ? { download: watermark, sales: await resolveForcedWatermarkSettingsForPhoto(event) } : watermark;
    // v3 retires archives whose v2 boundaries came from archive.pointer().
    const dedupKey = this.dedupKey(event.id, resolution, resolvedIds, identityWatermark, scope, isGalleryPriced(event), { version: 3, previewOnly });

    const existing = await this.findReusable(event.id, dedupKey);
    if (existing) return existing;
    await this.recoverOrphanedJobs(event.id);

    // Refuse rather than queue without bound. The client shows this as a
    // retryable error, which is far better than accepting work the box can't
    // absorb and timing the user out anyway.
    //
    // The slot is reserved SYNCHRONOUSLY here — checking liveBuilds.size and
    // only populating it after the awaited insert let a burst of concurrent
    // requests all pass the check before any of them registered.
    const eventInFlight = (this.reservedByEvent.get(event.id) || 0)
      + [...this.buildEvents.values()].filter((eventId) => eventId === event.id).length;
    if (eventInFlight >= MAX_EVENT_BUILDS || this.reserved + this.liveBuilds.size >= MAX_QUEUED_BUILDS) {
      const err = new Error('Too many downloads are being prepared right now');
      err.code = 'BUSY';
      throw err;
    }
    this.reserved += 1;
    this.reservedByEvent.set(event.id, (this.reservedByEvent.get(event.id) || 0) + 1);

    try {
      const token = crypto.randomBytes(32).toString('hex');
      const ttl = await jobTtlMs();
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.parse(createdAt) + ttl).toISOString();

      const admit = () => db.transaction(async (trx) => {
        // Same event-row serialization as the download allowance: SQLite
        // serializes writes; Postgres needs an explicit row lock.
        if (trx.client.config.client === 'pg') await trx('events').where({ id: event.id }).forUpdate().first();
        const reused = await this.findReusable(event.id, dedupKey, trx);
        if (reused) return { reused };
        const rows = await trx('download_jobs').where({ event_id: event.id })
          .where(function () { this.whereIn('status', ['pending', 'building', 'ready']).orWhereNotNull('zip_path'); })
          .select('status');
        const busy = rows.filter((row) => ['pending', 'building'].includes(row.status)).length;
        if (busy >= MAX_EVENT_BUILDS) {
          const err = new Error('Too many downloads are being prepared for this gallery. Please try again later');
          err.code = 'BUSY';
          throw err;
        }
        // A failed deletion still occupies disk: reclaim it before admitting
        // more work, rather than letting repeated storage errors bypass the cap.
        if (rows.some((row) => row.status === 'failed')) return { full: true };
        const evicted = await retireReadyJobs(trx, event.id, rows.length - MAX_EVENT_STORED_JOBS + 1);
        if (!evicted) return { full: true };
        const inserted = await trx('download_jobs').insert({
          token,
          event_id: event.id,
          resolution,
          photo_ids: JSON.stringify(resolvedIds),
          dedup_key: dedupKey,
          visibility_scope: scope,
          policy_version: 3,
          preview_only: previewOnly,
          status: 'pending',
          heartbeat_at: new Date().toISOString(),
          created_at: createdAt,
          expires_at: expiresAt,
        }).returning('id');
        return { id: inserted[0]?.id ?? inserted[0], evicted };
      });
      let admitted = await admit();
      if (admitted.full) {
        // Reclaim expired/stale artifacts without waiting for the scheduled
        // sweep. Delete outside the admission transaction and its row lock.
        await this.sweepExpired(event.id);
        admitted = await admit();
        if (admitted.full) {
          const err = new Error('This gallery has reached its prepared download limit. Please reuse an existing download or try again later');
          err.code = 'BUSY';
          throw err;
        }
      }
      if (admitted.reused) return admitted.reused;
      const { id } = admitted;
      try {
        // Storage I/O stays outside the transaction. Do not build another
        // archive if the old artifact could not be reclaimed.
        const reclaimed = await this.evictJobs(admitted.evicted);
        if (reclaimed !== admitted.evicted.length) {
          const err = new Error('Could not reclaim prepared download storage. Please try again later');
          err.code = 'BUSY';
          throw err;
        }
      } catch (error) {
        await this._fail(id, 'Could not reclaim prepared download storage');
        throw error;
      }

      // Fire and forget — the row is the source of truth for progress. The
      // liveBuilds entry is what makes a pending/building row reusable; a row
      // without one is an orphan from a previous process.
      const promise = applicationWork.track('download job',
        () => this._build(id, event, resolution, resolvedIds, watermark, accessLevel, previewOnly, ttl))
        .catch((err) => logger.error('Download job build failed', { jobId: id, error: err.message }))
        .finally(() => { this.liveBuilds.delete(id); this.buildEvents.delete(id); });
      this.liveBuilds.set(id, promise);
      this.buildEvents.set(id, event.id);

      return await db('download_jobs').where({ id }).first();
    } finally {
      // The slot is now accounted for by liveBuilds (or the insert failed).
      this.reserved -= 1;
      const remaining = this.reservedByEvent.get(event.id) - 1;
      if (remaining) this.reservedByEvent.set(event.id, remaining);
      else this.reservedByEvent.delete(event.id);
    }
  }

  async getStatus(token) {
    const job = await db('download_jobs').where({ token }).first();
    // Startup cannot fail a recent lease belonging to another replica. A
    // worker lost just before restart becomes stale later; polling must then
    // report failure rather than spin forever without the old UI timeout.
    if (job && ['pending', 'building'].includes(job.status)
        && (!job.heartbeat_at || Date.now() - new Date(job.heartbeat_at).getTime() > LEASE_TIMEOUT_MS)) {
      await this.recoverOrphanedJobs();
      return db('download_jobs').where({ token }).first();
    }
    return job;
  }

  /** Polls share a brief existence probe; GET/HEAD always stat afresh. */
  async readyStat(job) {
    if (!job.zip_path) return null;
    const cached = this.readyStats.get(job.zip_path);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;
    if (this.readyStats.size >= 256) this.readyStats.delete(this.readyStats.keys().next().value);
    const promise = getStorage().stat(job.zip_path);
    this.readyStats.set(job.zip_path, { expiresAt: Date.now() + 5000, promise });
    try { return await promise; }
    catch (error) { this.readyStats.delete(job.zip_path); throw error; }
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
    return !!await this.deliveryPhotos(job, event, accessLevel);
  }

  /** The authorized photo projection also supplies the archive filename. */
  async deliveryPhotos(job, event, accessLevel) {
    // Unreleased v2 artifacts used buffered pointer values as boundaries.
    // Never reuse/charge against those; the normal sweep retires them.
    if (job.policy_version === 2) return false;
    const policy = await resolveEventDownloadPolicy(event);
    if (job.resolution !== policy.standard && pickRequestedResolution(policy, job.resolution) === null) return false;
    let ids;
    try {
      ids = JSON.parse(job.photo_ids || '[]');
    } catch (_) {
      return false;
    }
    if (!Array.isArray(ids) || ids.length === 0) return false;

    // Every packaged photo must still be visible to this requester.
    const visible = await this.photoQuery(job.event_id, ids, accessLevel, await blockedFoldersOf(job.event_id))
      .select('photos.id', 'photos.media_type', 'photos.mime_type');
    if (visible.length !== ids.length) return false;

    // …and the archive must still match the CURRENT rendition policy. Turning
    // a watermark on, editing it, or revoking a resolution after the job went
    // ready would otherwise keep serving the old bytes for the rest of the
    // TTL. Recomputing the identity is the cheapest way to notice: any input
    // that changes the archive changes the key.
    const watermark = await resolveWatermarkSettings(event);
    const identityWatermark = job.policy_version >= 2 && isGalleryPriced(event)
      ? { download: watermark, sales: await resolveForcedWatermarkSettingsForPhoto(event) } : watermark;
    const expected = this.dedupKey(
      job.event_id, job.resolution, ids, identityWatermark, visibilityScope(accessLevel), isGalleryPriced(event),
      { version: job.policy_version || 1, previewOnly: !!job.preview_only }
    );
    return expected === job.dedup_key ? visible : null;
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
    await this.evictJobs(withZip);
  }

  async _build(id, event, resolution, photoIds, watermarkSettings, accessLevel, previewOnly, ttl) {
    // Queued work has not started a source read. Keep that lease while it
    // waits; an active build below must earn renewals by making progress.
    let queueCancelled = false;
    const queuedHeartbeat = setInterval(() => {
      db('download_jobs').where({ id, status: 'pending' }).update({ heartbeat_at: new Date().toISOString() })
        .then((changed) => { if (!changed) queueCancelled = true; })
        .catch((err) => logger.warn('Download queue heartbeat failed', { jobId: id, error: err.message }));
    }, PROGRESS_INTERVAL_MS);
    queuedHeartbeat.unref();
    let acquired = false;
    let tmpDir;
    let progress;
    let heartbeat;
    try {
      while (this.running >= MAX_CONCURRENT_BUILDS) {
        if (queueCancelled) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      clearInterval(queuedHeartbeat);
      this.running += 1;
      acquired = true;
      const started = await db('download_jobs').where({ id, status: 'pending' })
        .update({ status: 'building', heartbeat_at: new Date().toISOString() });
      if (!started) return;
      progress = createBuildProgress(this.stallTimeoutMs);
      const folders = await progress.wait(blockedFoldersOf(event.id));
      const photos = await progress.wait(this.photoQuery(event.id, photoIds, accessLevel, folders)
        .select('photos.*').orderBy('photos.uploaded_at', 'desc'));
      if (!photos.length) throw new Error('No photos available for this selection');

      const box = parseResolution(resolution);
      const storage = getStorage();
      const entryNames = getZipEntryNames(photos, await progress.wait(getUseOriginalFilenames()));
      tmpDir = await progress.wait(fsp.mkdtemp(path.join(os.tmpdir(), 'picpeak-dljob-')));
      const tmpPath = path.join(tmpDir, `${crypto.randomBytes(4).toString('hex')}.zip`);
      const packaged = [];
      const finalNames = new Map();
      let reportAt = Date.now();
      let reportedCount = 0;
      let reportedRevision = progress.revision;
      let reporting = false;
      const report = async (force = false) => {
        if (reporting || progress.signal.aborted) return;
        if (!force && (progress.revision === reportedRevision
            || (packaged.length - reportedCount < 10 && Date.now() - reportAt < PROGRESS_INTERVAL_MS))) return;
        reporting = true;
        const revision = progress.revision, count = packaged.length;
        try {
          // One conditional write checks cancellation AND reports progress;
          // at most once per ten entries or thirty seconds, not twice/photo.
          const changed = await progress.wait(db('download_jobs').where({ id, status: 'building' })
            .update({ photo_count: count, heartbeat_at: new Date().toISOString() }));
          if (!changed) progress.abort(new Error('Download preparation was cancelled'));
          reportedRevision = revision; reportedCount = count; reportAt = Date.now();
        } finally { reporting = false; }
      };
      heartbeat = setInterval(() => { report().catch((error) => progress.abort(error)); }, PROGRESS_INTERVAL_MS);
      heartbeat.unref();

      await progress.wait(new Promise((resolve, reject) => {
        const output = fs.createWriteStream(tmpPath);
        const archive = archiver('zip', { zlib: { level: 0 } });
        let failure;
        let completeEntry;
        const fail = (error) => {
          if (failure) return;
          failure = error;
          guard.destroyAll();
          archive.abort();
          output.destroy();
          completeEntry?.(error);
          reject(error);
        };
        const guard = createArchiveStreamGuard({ onFatalError: fail });
        const aborted = () => fail(progress.signal.reason);
        progress.signal.addEventListener('abort', aborted, { once: true });
        output.on('error', fail);
        archive.on('error', fail);
        output.on('close', () => {
          progress.signal.removeEventListener('abort', aborted);
          if (failure) reject(failure); else resolve();
        });
        // Bytes flowing through the archive count even for a very large
        // video. Rendering/opening a stalled source produces no such signal.
        archive.on('data', () => progress.touch());
        archive.pipe(output);
        (async () => {
          for (let i = 0; i < photos.length; i += 1) {
            progress.signal.throwIfAborted();
            const photo = photos[i];
            const name = entryNames[i] || `photo-${photo.id}.jpg`;
            let source;
            let entryName = name;
            try {
              const salesPreview = isGalleryPriced(event) && !isVideo(photo);
              const settings = salesPreview
                ? await progress.wait(resolveForcedWatermarkSettingsForPhoto(event, photo)) : watermarkSettings;
              if (previewOnly || salesPreview) {
                const preview = await progress.wait(renderPreviewForDownload(photo, settings));
                if (!preview) throw new Error('No preview of this photo');
                source = preview.buffer;
                entryName = previewDownloadName(name, preview.extension);
              } else {
                source = await progress.wait(renderPhotoForDownload(event, photo, box, settings));
                if (source) entryName = renderedDownloadType(source, photo, name).name;
                else {
                  const key = resolvePhotoStorageKey(event, photo);
                  if (key && storage.kind() === 'local' && !await progress.wait(storage.stat(key))) {
                    throw new Error('Photo missing in storage');
                  }
                  if (!key) await progress.wait(fsp.access(resolvePhotoFilePath(event, photo)));
                  // Register a late-opening source too: the closed guard
                  // destroys it if the deadline expired while it opened.
                  source = await progress.wait((key ? storage.get(key) : Promise.resolve(fs.createReadStream(resolvePhotoFilePath(event, photo))))
                    .then((stream) => guard.track(stream)));
                }
              }
            } catch (error) {
              progress.signal.throwIfAborted();
              logger.warn('Skipping photo in download job', { jobId: id, photoId: photo.id, error: error.message });
              progress.touch();
              await report();
              continue;
            }
            if (failure) { source.destroy?.(); return; }
            // Conversion can give distinct source extensions the same final
            // name. Uniquify after rewriting, against every packaged entry.
            entryName = uniquifyZipNames([entryName], finalNames)[0];
            await progress.wait(new Promise((done, failed) => {
              const onEntry = (entry) => {
                completeEntry = null;
                packaged.push({ photoId: photo.id, name: entry.name });
                progress.touch();
                done();
              };
              completeEntry = (error) => { archive.removeListener('entry', onEntry); failed(error); };
              archive.once('entry', onEntry);
              archive.append(source, { name: entryName });
            }));
            await report();
          }
          await archive.finalize();
        })().catch(fail);
      }));
      if (!packaged.length) throw new Error('No photos could be packaged');
      const stat = await progress.wait(fsp.stat(tmpPath));
      const manifest = await progress.wait(buildEntryManifest(tmpPath, packaged, stat.size));
      await report(true);
      progress.signal.throwIfAborted();
      const row = await progress.wait(db('download_jobs').where({ id, status: 'building' }).first());
      if (!row) return;
      const key = this.jobKey(event.slug, row.token);
      // Stream the upload through the storage abstraction so local and S3
      // copies also have observable progress and a reclaimable source.
      const uploadSource = fs.createReadStream(tmpPath);
      // A transform preserves back-pressure. A data listener on the source
      // could drain bytes before a storage backend finishes opening its writer.
      const uploadBody = new Transform({ transform(chunk, encoding, done) { progress.touch(); done(null, chunk); } });
      uploadSource.once('error', (error) => uploadBody.destroy(error));
      uploadBody.once('error', (error) => progress.abort(error));
      const stopUpload = () => { uploadSource.destroy(); uploadBody.destroy(progress.signal.reason); };
      progress.signal.addEventListener('abort', stopUpload, { once: true });
      const upload = storage.put(key, uploadBody);
      uploadSource.pipe(uploadBody);
      try { await progress.wait(upload); }
      catch (error) {
        // A backend may finish after cancellation; never leave that late
        // artifact behind or let it turn an abandoned job into a ready one.
        void upload.then(() => storage.delete(key)).catch(() => {});
        throw error;
      } finally {
        progress.signal.removeEventListener('abort', stopUpload);
        uploadSource.destroy();
        uploadBody.destroy();
      }
      const committed = await db('download_jobs').where({ id, status: 'building' }).update({
        status: 'ready', zip_path: key, size_bytes: stat.size, photo_count: packaged.length,
        // Keep the requested identity separate from entries actually shipped.
        delivered_photo_ids: JSON.stringify(packaged.map((entry) => entry.photoId)),
        entry_manifest: JSON.stringify(manifest),
        expires_at: new Date(Date.now() + ttl).toISOString(), completed_at: new Date().toISOString(),
      });
      if (!committed) {
        await storage.delete(key).catch((error) => logger.warn('Failed deleting download job artifact', { jobId: id, error: error.message }));
        return;
      }
      progress.close();
      clearInterval(heartbeat);
      logger.info('Download job ready', { jobId: id, photos: packaged.length, bytes: stat.size });
      await require('./downloadJobNotifier').notifyReady(id)
        .catch((error) => logger.warn('Download job mail failed', { jobId: id, error: error.message }));
    } catch (error) {
      logger.error('Download job error', { jobId: id, error: error.message });
      await this._fail(id, error.message).catch(() => {});
    } finally {
      clearInterval(queuedHeartbeat);
      clearInterval(heartbeat);
      progress?.close();
      if (acquired) this.running -= 1;
      if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Fail rows left mid-build by a previous process. Without this they linger
   * as 'pending'/'building' until the TTL, and although findReusable now skips
   * them, the client that owns such a token would poll a job that can never
   * finish. Called once at startup.
   */
  async recoverOrphanedJobs(eventId) {
    // Only rows whose LEASE has expired. A live worker heartbeats while it
    // builds, so in a multi-replica deployment a rolling restart can't have
    // one replica fail jobs another is still working on — which a blanket
    // "fail everything pending" would do.
    const staleBefore = new Date(Date.now() - LEASE_TIMEOUT_MS).toISOString();
    const query = db('download_jobs');
    if (eventId !== undefined) query.where({ event_id: eventId });
    const orphaned = await query
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
    if (job.preview_only && !downloadLimitOf(event)) return false;
    // The two scopes map onto the two access levels that differ in what they
    // see: a 'hidden' archive was built for a client, the rest for a guest.
    const accessLevel = job.visibility_scope === 'hidden' ? 'client' : 'guest';
    return this.isStillDeliverable(job, event, accessLevel);
  }

  /** A failed or stalled key must not prevent cleanup of other archives. */
  async _deleteArtifact(job) {
    if (!job.zip_path) return true;
    const progress = createBuildProgress(this.stallTimeoutMs);
    try {
      await progress.wait(getStorage().delete(job.zip_path));
      this.readyStats.delete(job.zip_path);
      return true;
    } catch (error) {
      logger.warn('Failed deleting download job artifact', { jobId: job.id, error: error.message });
      return false;
    } finally { progress.close(); }
  }

  /** Keep the token/notification history until its original retention ends. */
  async evictJobs(jobs) {
    let reclaimed = 0;
    for (const job of jobs) {
      if (!await this._deleteArtifact(job)) continue;
      await db('download_jobs').where({ id: job.id, status: 'failed' }).update({
        zip_path: null, size_bytes: null, entry_manifest: null,
      });
      reclaimed += 1;
    }
    return reclaimed;
  }

  /** Remove files before rows, retaining failed deletions for the next sweep. */
  async removeJobs(jobs) {
    let removed = 0;
    for (const job of jobs) {
      if (!await this._deleteArtifact(job)) continue;
      // Keep the existing sweep order: a notify pass that already claimed a
      // recipient must commit before its deletion, so cancellation sees its mail.
      await db('download_job_recipients').where({ job_id: job.id }).del();
      await require('./downloadJobNotifier').cancelPendingMails([job]);
      await db('download_jobs').where({ id: job.id }).del();
      removed += 1;
    }
    return removed;
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
  async sweepExpired(eventId) {
    const now = new Date().toISOString();
    const staleBefore = new Date(Date.now() - LEASE_TIMEOUT_MS).toISOString();
    const inScope = (query) => eventId === undefined ? query : query.where({ event_id: eventId });
    await this.evictJobs(await inScope(db('download_jobs')).where({ status: 'failed' }).whereNotNull('zip_path'));
    const expired = await inScope(db('download_jobs')).where('expires_at', '<=', now)
      .where(function () {
        this.whereNotIn('status', ['pending', 'building'])
          .orWhereNull('heartbeat_at').orWhere('heartbeat_at', '<', staleBefore);
      });

    const undeliverable = [];
    const ready = await inScope(db('download_jobs')).where({ status: 'ready' }).where('expires_at', '>', now);
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

    const removed = await this.removeJobs(doomed);
    logger.info(`Download job sweep removed ${removed} of ${doomed.length} expired/undeliverable job(s)`);
    return removed;
  }
}

module.exports = new DownloadJobService();
