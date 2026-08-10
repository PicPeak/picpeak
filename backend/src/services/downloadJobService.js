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
const { getUseOriginalFilenames, getZipEntryNames } = require('./downloadFilenameService');
const { renderPhotoForDownload, resolveWatermarkSettings } = require('./downloadRendition');
const { resolvePhotoStorageKey, resolvePhotoFilePath } = require('./photoResolver');
const { parseResolution } = require('../utils/downloadResolutions');
const { applyPhotoVisibilityFilter } = require('../utils/photoVisibility');
const logger = require('../utils/logger');

// How long a finished archive stays downloadable before the sweep deletes it.
const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour
// Guards against a handful of guests each kicking off a whole-gallery resize.
const MAX_CONCURRENT_BUILDS = 2;

class DownloadJobService {
  constructor() {
    this.running = 0;
  }

  cacheDir(slug) {
    return path.posix.join('events/active', slug, '.download-cache');
  }

  jobKey(slug, token) {
    return path.posix.join(this.cacheDir(slug), `job-${token}.zip`);
  }

  /**
   * Stable identity for "the same archive": same event, same size, same photo
   * set, same watermark decision. A second requester joins an in-flight or
   * still-valid job instead of paying for the resize twice.
   */
  dedupKey(eventId, resolution, photoIds, watermarked) {
    const ids = photoIds ? [...photoIds].map(Number).sort((a, b) => a - b).join(',') : 'all';
    return crypto.createHash('sha256')
      .update(`${eventId}|${resolution}|${ids}|${watermarked ? 'wm' : 'raw'}`)
      .digest('hex')
      .slice(0, 64);
  }

  /**
   * Find a job that already satisfies this request — either still building or
   * finished and not yet expired. Failed jobs are ignored so a transient error
   * doesn't poison every later attempt.
   */
  async findReusable(eventId, dedupKey) {
    return db('download_jobs')
      .where({ event_id: eventId, dedup_key: dedupKey })
      .whereIn('status', ['pending', 'building', 'ready'])
      .where('expires_at', '>', new Date().toISOString())
      .orderBy('id', 'desc')
      .first();
  }

  /**
   * Create (or join) a job. Returns the job row. Building continues in the
   * background — callers poll getStatus().
   */
  async createJob({ event, resolution, photoIds, accessLevel }) {
    const watermark = await resolveWatermarkSettings(event);
    const dedupKey = this.dedupKey(event.id, resolution, photoIds, !!watermark);

    const existing = await this.findReusable(event.id, dedupKey);
    if (existing) return existing;

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + JOB_TTL_MS).toISOString();

    const inserted = await db('download_jobs').insert({
      token,
      event_id: event.id,
      resolution,
      photo_ids: photoIds ? JSON.stringify(photoIds) : null,
      dedup_key: dedupKey,
      status: 'pending',
      created_at: new Date().toISOString(),
      expires_at: expiresAt,
    }).returning('id');
    const id = inserted[0]?.id ?? inserted[0];

    // Fire and forget — the row is the source of truth for progress.
    this._build(id, event, resolution, photoIds, watermark, accessLevel)
      .catch((err) => logger.error('Download job build failed', { jobId: id, error: err.message }));

    return db('download_jobs').where({ id }).first();
  }

  async getStatus(token) {
    return db('download_jobs').where({ token }).first();
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
    try {
      await db('download_jobs').where({ id }).update({ status: 'building' });

      let query = db('photos')
        .leftJoin('photo_categories', 'photos.category_id', 'photo_categories.id')
        .where('photos.event_id', event.id)
        .where(function () {
          this.whereNull('photos.category_id')
            .orWhere('photo_categories.allow_downloads', true)
            .orWhereNull('photo_categories.allow_downloads');
        });
      if (photoIds && photoIds.length) {
        query = query.whereIn('photos.id', photoIds);
      }
      // Same visibility rules as the live download routes — a job must never
      // become a way to collect photos the requester can't otherwise see.
      const photos = await applyPhotoVisibilityFilter(query, accessLevel)
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
      await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(tmpPath);
        // level 0 — photos are already compressed, so deflate only burns CPU.
        const archive = archiver('zip', { zlib: { level: 0 } });
        output.on('close', resolve);
        archive.on('error', reject);
        archive.pipe(output);

        (async () => {
          for (let i = 0; i < photos.length; i += 1) {
            const photo = photos[i];
            const name = entryNames[i] || `photo-${photo.id}.jpg`;
            try {
              const rendered = await renderPhotoForDownload(event, photo, box, watermarkSettings);
              if (rendered) {
                archive.append(rendered, { name });
              } else {
                const key = resolvePhotoStorageKey(event, photo);
                if (key) {
                  archive.append(await storage.get(key), { name });
                } else {
                  archive.file(resolvePhotoFilePath(event, photo), { name });
                }
              }
              appended += 1;
              // Progress is coarse (photo count, not bytes) but it is what the
              // modal needs to show movement on a long build.
              if (appended % 10 === 0 || appended === photos.length) {
                await db('download_jobs').where({ id }).update({ photo_count: appended });
              }
            } catch (err) {
              logger.warn('Skipping photo in download job', { jobId: id, photoId: photo.id, error: err.message });
            }
          }
          archive.finalize();
        })().catch(reject);
      });

      if (appended === 0) {
        await this._fail(id, 'No photos could be packaged');
        return;
      }

      const stat = await fsp.stat(tmpPath);
      const key = this.jobKey(event.slug, (await db('download_jobs').where({ id }).first()).token);
      await storage.putFromFile(key, tmpPath);

      await db('download_jobs').where({ id }).update({
        status: 'ready',
        zip_path: key,
        size_bytes: stat.size,
        photo_count: appended,
        completed_at: new Date().toISOString(),
      });
      logger.info('Download job ready', { jobId: id, photos: appended, bytes: stat.size });
    } catch (err) {
      logger.error('Download job error', { jobId: id, error: err.message });
      await this._fail(id, err.message).catch(() => {});
    } finally {
      this.running -= 1;
      if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Delete expired jobs and their artifacts. Returns how many were removed. */
  async sweepExpired() {
    const now = new Date().toISOString();
    const expired = await db('download_jobs').where('expires_at', '<=', now);
    if (expired.length === 0) return 0;

    const storage = getStorage();
    for (const job of expired) {
      if (job.zip_path) {
        await storage.delete(job.zip_path).catch((e) =>
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
