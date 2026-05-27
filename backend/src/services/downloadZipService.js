/**
 * DownloadZipService
 *
 * Pre-generates ZIP archives for "Download All" so guests get instant
 * downloads with Content-Length instead of on-the-fly streaming that
 * crashes mobile browsers.
 *
 * Pattern follows watermarkGeneratorService.js — singleton with
 * in-memory locking and debounced background regeneration.
 *
 * Storage: zips are written to a local tmp file then uploaded to the
 * configured storage backend (local fs or S3) via storage.putFromFile.
 * The cached zip is served via the storage backend on download.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const archiver = require('archiver');
const { db } = require('../database/db');
const watermarkService = require('./watermarkService');
const { resolvePhotoStorageKey, resolvePhotoFilePath } = require('./photoResolver');
const { getStorage } = require('./storage');
const { getUseOriginalFilenames, getZipEntryNames } = require('./downloadFilenameService');
const logger = require('../utils/logger');

const DEBOUNCE_MS = 5000;

class DownloadZipService {
  constructor() {
    this.activeBuilds = new Map();   // eventId -> { promise, version }
    this.debounceTimers = new Map();  // eventId -> setTimeout handle
    this.versions = new Map();        // eventId -> generation counter
  }

  /**
   * Relative storage key for the cached zip.
   */
  getCacheKey(slug) {
    return path.posix.join('events/active', slug, '.download-cache', 'all.zip');
  }

  /**
   * Check if a valid cached zip exists.
   * Returns { key, size, generatedAt } or null. The key is a relative storage
   * key — callers stream it via storage.get() rather than reading directly.
   */
  async getZipInfo(eventId) {
    try {
      const event = await db('events')
        .where({ id: eventId })
        .select('download_zip_path', 'download_zip_generated_at', 'slug')
        .first();

      if (!event || !event.download_zip_path) return null;

      const storage = getStorage();
      const key = this.getCacheKey(event.slug);
      const stat = await storage.stat(key);
      if (!stat) {
        // File gone — clear stale DB record
        await db('events').where({ id: eventId }).update({
          download_zip_path: null,
          download_zip_generated_at: null,
        });
        return null;
      }
      return {
        key,
        size: stat.size,
        generatedAt: event.download_zip_generated_at,
      };
    } catch (err) {
      logger.warn('downloadZipService.getZipInfo error', { eventId, error: err.message });
      return null;
    }
  }

  /**
   * Generate the pre-zip for an event. Returns { success, key, size } or { success: false }.
   * Concurrent calls for the same eventId share one in-flight build.
   */
  async generateZip(eventId) {
    // If already building, return the existing promise
    const existing = this.activeBuilds.get(eventId);
    if (existing) return existing.promise;

    const version = (this.versions.get(eventId) || 0) + 1;
    this.versions.set(eventId, version);

    const promise = this._build(eventId, version);
    this.activeBuilds.set(eventId, { promise, version });

    try {
      return await promise;
    } finally {
      // Only clear if this is still the active build
      const current = this.activeBuilds.get(eventId);
      if (current && current.version === version) {
        this.activeBuilds.delete(eventId);
      }
    }
  }

  async _build(eventId, version) {
    const storage = getStorage();
    let tmpDir;

    try {
      const event = await db('events').where({ id: eventId }).first();
      if (!event) return { success: false, error: 'Event not found' };

      const photos = await db('photos')
        .where({ event_id: eventId })
        .select('*')
        .orderBy('type', 'asc')
        .orderBy('uploaded_at', 'desc');

      if (photos.length === 0) return { success: false, error: 'No photos' };

      // Watermark logic (same as gallery.js download-all)
      const watermarkSettings = await watermarkService.getWatermarkSettings();
      const eventWatermarkEnabled = event.watermark_downloads === true || event.watermark_downloads === 1;
      const shouldApplyWatermark = (watermarkSettings && watermarkSettings.enabled) || eventWatermarkEnabled;
      const effectiveSettings = shouldApplyWatermark ? {
        ...watermarkSettings,
        enabled: true,
        text: event.watermark_text || watermarkSettings?.text || 'Protected',
      } : null;

      const finalKey = this.getCacheKey(event.slug);

      tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'picpeak-zipbuild-'));
      const tmpPath = path.join(tmpDir, `${crypto.randomBytes(4).toString('hex')}-all.zip`);

      // #493: resolve display filenames (with collision suffix) before the
      // streaming starts so the loop just indexes the precomputed array.
      const useOriginal = await getUseOriginalFilenames();
      const entryNames = getZipEntryNames(photos, useOriginal);

      // Build zip — level 0 (store only) since photos are already compressed
      await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(tmpPath);
        const archive = archiver('zip', { zlib: { level: 0 } });

        output.on('close', resolve);
        archive.on('error', reject);
        archive.pipe(output);

        const uniqueTypes = new Set(photos.map(p => p.type)).size;
        const hasMultipleTypes = uniqueTypes > 1;

        const addPhotos = async () => {
          for (let i = 0; i < photos.length; i += 1) {
            const photo = photos[i];
            // Check if build was invalidated
            if (this.versions.get(eventId) !== version) {
              archive.abort();
              return reject(new Error('Build invalidated'));
            }

            const entryName = entryNames[i];
            let archiveName;
            if (hasMultipleTypes) {
              const folderName = photo.type === 'individual' ? 'Individual Photos' : 'Collages';
              archiveName = path.join(folderName, entryName);
            } else {
              archiveName = entryName;
            }

            // External-mode photos still live on local disk; managed photos go
            // through the storage backend. resolvePhotoStorageKey returns null
            // for external, in which case fall back to resolvePhotoFilePath.
            const storageKey = resolvePhotoStorageKey(event, photo);

            if (shouldApplyWatermark && effectiveSettings) {
              try {
                let sourcePath;
                if (storageKey) {
                  // Stream the original to a tmp file just long enough for sharp
                  // (watermarkService) to operate on it. Avoids buffering the
                  // entire image in memory for huge originals.
                  sourcePath = path.join(tmpDir, `wm-${crypto.randomBytes(4).toString('hex')}`);
                  await storage.getToFile(storageKey, sourcePath);
                } else {
                  sourcePath = resolvePhotoFilePath(event, photo);
                }
                const buf = await watermarkService.applyWatermark(sourcePath, effectiveSettings);
                archive.append(buf, { name: archiveName });
                if (storageKey) {
                  await fsp.unlink(sourcePath).catch(() => {});
                }
              } catch (err) {
                logger.warn('Skipping watermark in pre-zip', { photoId: photo.id, error: err.message });
              }
            } else if (storageKey) {
              const stream = await storage.get(storageKey);
              archive.append(stream, { name: archiveName });
            } else {
              const filePath = resolvePhotoFilePath(event, photo);
              archive.file(filePath, { name: archiveName });
            }
          }

          archive.finalize();
        };

        addPhotos().catch(reject);
      });

      // Check version again — another invalidation may have arrived
      if (this.versions.get(eventId) !== version) {
        return { success: false, error: 'Build invalidated' };
      }

      // Upload to storage (atomic from caller's perspective: storage.put writes
      // to a tmp file/object first then commits in LocalFs; in S3 the key only
      // exists after the multipart upload completes).
      await storage.putFromFile(finalKey, tmpPath, { contentType: 'application/zip' });

      const stat = await storage.stat(finalKey);

      await db('events').where({ id: eventId }).update({
        download_zip_path: finalKey,
        download_zip_generated_at: new Date(),
      });

      logger.info('Pre-zip generated', { eventId, slug: event.slug, size: stat.size, photos: photos.length });
      return { success: true, key: finalKey, size: stat.size };
    } catch (err) {
      if (err.message === 'Build invalidated') {
        return { success: false, error: 'Build invalidated' };
      }
      logger.error('downloadZipService._build error', { eventId, error: err.message });
      return { success: false, error: err.message };
    } finally {
      if (tmpDir) {
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  /**
   * Invalidate the cached zip for an event.
   * Deletes the file, clears DB, debounces regeneration.
   */
  invalidate(eventId) {
    // Bump version to signal any in-flight build is stale
    this.versions.set(eventId, (this.versions.get(eventId) || 0) + 1);

    // Cancel pending debounce
    const timer = this.debounceTimers.get(eventId);
    if (timer) clearTimeout(timer);

    // Fire-and-forget cleanup
    this._cleanup(eventId).catch(err =>
      logger.warn('downloadZipService.invalidate cleanup error', { eventId, error: err.message })
    );

    // Debounce regeneration
    const newTimer = setTimeout(() => {
      this.debounceTimers.delete(eventId);
      this.generateZip(eventId).catch(err =>
        logger.warn('downloadZipService debounced regen error', { eventId, error: err.message })
      );
    }, DEBOUNCE_MS);
    this.debounceTimers.set(eventId, newTimer);
  }

  /**
   * Invalidate all events (e.g., global watermark settings changed).
   */
  async invalidateAll() {
    try {
      const events = await db('events')
        .whereNotNull('download_zip_path')
        .select('id');
      for (const event of events) {
        this.invalidate(event.id);
      }
    } catch (err) {
      logger.error('downloadZipService.invalidateAll error', { error: err.message });
    }
  }

  /**
   * Full cleanup — delete file and clear DB. Used on event deletion/archival.
   */
  async cleanup(eventId) {
    this.versions.set(eventId, (this.versions.get(eventId) || 0) + 1);
    const timer = this.debounceTimers.get(eventId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(eventId);
    }
    await this._cleanup(eventId);
  }

  async _cleanup(eventId) {
    try {
      const storage = getStorage();
      const event = await db('events')
        .where({ id: eventId })
        .select('slug', 'download_zip_path')
        .first();

      if (event && event.download_zip_path) {
        await storage.delete(this.getCacheKey(event.slug)).catch(() => {});
      }

      await db('events').where({ id: eventId }).update({
        download_zip_path: null,
        download_zip_generated_at: null,
      });
    } catch (err) {
      logger.warn('downloadZipService._cleanup error', { eventId, error: err.message });
    }
  }
}

module.exports = new DownloadZipService();
