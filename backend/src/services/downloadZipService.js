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
const { renderPhotoForDownload } = require('./downloadRendition');
const { resolveEventDownloadPolicy } = require('../utils/downloadResolutions');
const logger = require('../utils/logger');

const DEBOUNCE_MS = 5000;

// How many storage reads may be open at once while the archive is built.
// archiver drains its queue one entry at a time, so a stream appended ahead of
// its turn just parks an S3 socket with a full receive buffer. The SDK agent
// pool is 50 sockets wide and shared with uploads, thumbnails and gallery
// reads, so an unbounded loop over a large event starves the whole process.
// Two keeps the next photo's round trip overlapped with the current write
// without ever leaving more than one socket idle.
const MAX_INFLIGHT_READS = 2;
// How many cached zips may be REBUILT at once in the background (#1399).
//
// invalidateAll() invalidates every event that has a cached zip, and each
// invalidate() arms its own debounce timer in the same tick — so they all fire
// together and, before this, every one of them started building at once. Each
// build opens its own storage reads, so 25 events was enough to exhaust the S3
// agent pool and stall uploads, thumbnails and gallery reads until the burst
// finished.
//
// This caps the BACKGROUND path only. A foreground generateZip() — a guest
// actually waiting for a download — is never queued behind a rebuild.
const MAX_CONCURRENT_REGENS = 2;

class DownloadZipService {
  constructor() {
    this.activeBuilds = new Map();   // eventId -> { promise, version }
    this.debounceTimers = new Map();  // eventId -> setTimeout handle
    this.versions = new Map();        // eventId -> generation counter
    this.buildCancellers = new Map(); // eventId -> abort the in-flight build
    this.pendingCleanups = new Map(); // eventId -> invalidate()'s cleanup, until it settles
    this.regenActive = 0;             // background rebuilds running right now
    this.regenWaiters = [];           // resolvers parked waiting for a slot
    this.stopped = false;
  }

  /**
   * Run a BACKGROUND rebuild under the concurrency cap (#1399). Foreground
   * callers deliberately do not go through here: someone is waiting on that
   * response, and making them queue behind a settings-change burst would trade
   * one stall for another.
   */
  async _withRegenSlot(fn) {
    if (this.stopped) return undefined;
    if (this.regenActive >= MAX_CONCURRENT_REGENS) {
      await new Promise((resolve) => this.regenWaiters.push(resolve));
      // Shutdown can drain the queue while we were parked.
      if (this.stopped) return undefined;
    }
    this.regenActive += 1;
    try {
      return await fn();
    } finally {
      this.regenActive -= 1;
      const next = this.regenWaiters.shift();
      if (next) next();
    }
  }

  async stop() {
    this.stopped = true;
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    // Release anything parked for a slot so shutdown can't hang on a queue
    // that will never drain — they check `stopped` and return without building.
    const waiters = this.regenWaiters.splice(0);
    for (const resume of waiters) resume();
    await Promise.allSettled([...this.activeBuilds.values()].map(build => build.promise));
    await Promise.allSettled([...this.pendingCleanups.values()]);
    this.versions.clear();
    this.buildCancellers.clear();
    this.pendingCleanups.clear();
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
    // If already building, return the existing promise — unless an
    // invalidate() has moved the version on since that build started: its
    // result is going to be discarded, so the debounced regeneration that
    // lands while it is still uploading needs a fresh build. Wait for the
    // stale one to settle first rather than overlapping it: both would write
    // the same key and share one canceller slot, and the stale build's
    // discard would remove the replacement's zip.
    for (;;) {
      const existing = this.activeBuilds.get(eventId);
      if (existing) {
        if (existing.version === (this.versions.get(eventId) || 0)) return existing.promise;
        await existing.promise.catch(() => {});
        if (this.activeBuilds.get(eventId) === existing) this.activeBuilds.delete(eventId);
        // stop() may have drained everything while we waited: a build
        // started now would never be awaited by anyone.
        if (this.stopped) return { success: false, error: 'Service stopped' };
        continue;
      }
      // invalidate() runs its cleanup fire-and-forget. Still pending, it
      // would delete the shared key and clear the row AFTER this build
      // published its fresh zip; let it finish first, then look again.
      const cleaning = this.pendingCleanups.get(eventId);
      if (!cleaning) break;
      await cleaning;
      if (this.stopped) return { success: false, error: 'Service stopped' };
    }

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

    // Storage reads appended to the archive but not yet drained. A failed or
    // invalidated build must destroy them: archiver's own abort() leaves the
    // source streams alone, and an unread S3 response body holds its socket
    // open for the life of the process (the SDK arms its socketTimeout on a
    // 3s delay and clears it as soon as the response headers land, so
    // nothing ever reclaims the socket).
    const openReads = new Set();
    let cancelled = false;
    let slotWaiter = null;

    const wakeSlotWaiter = () => {
      if (!slotWaiter) return;
      const resume = slotWaiter;
      slotWaiter = null;
      resume();
    };
    const releaseRead = (stream) => {
      openReads.delete(stream);
      wakeSlotWaiter();
    };
    // Assigned once the archive exists. Bumping the generation counter only
    // stops the build the next time the loop looks at it, and the loop can be
    // parked waiting for a read slot that a stalled archive will never free,
    // so invalidation cancels the build directly instead of leaving a note.
    let failBuild = null;

    const trackRead = (stream) => {
      openReads.add(stream);
      stream.once('end', () => releaseRead(stream));
      stream.once('close', () => releaseRead(stream));
      stream.once('error', () => releaseRead(stream));
      return stream;
    };

    try {
      const event = await db('events').where({ id: eventId }).first();
      if (!event) return { success: false, error: 'Event not found' };

      // The prebuilt zip is served to ordinary gallery guests (the
      // download-all fast path), so it must exclude hidden/client-only
      // photos — NULL visibility counts as visible (pre-migration rows).
      // PIN-clients bypass this cache and stream a full archive instead.
      const photos = await db('photos')
        .where({ event_id: eventId })
        .where(function () {
          this.where('visibility', 'visible').orWhereNull('visibility');
        })
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

      // The cached archive is built AT the gallery's standard resolution
      // (#858) — 'original' keeps the historical behaviour. Any change to the
      // standard invalidates this zip via the settings write paths, so a
      // cached archive always matches the currently configured size.
      const { standardBox } = await resolveEventDownloadPolicy(event);

      const finalKey = this.getCacheKey(event.slug);

      tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'picpeak-zipbuild-'));
      const tmpPath = path.join(tmpDir, `${crypto.randomBytes(4).toString('hex')}-all.zip`);

      // #493: resolve display filenames (with collision suffix) before the
      // streaming starts so the loop just indexes the precomputed array.
      const useOriginal = await getUseOriginalFilenames();
      const entryNames = getZipEntryNames(photos, useOriginal);

      this.buildCancellers.set(eventId, () => {
        if (failBuild) failBuild(new Error('Build invalidated'));
      });

      // Build zip — level 0 (store only) since photos are already compressed
      await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(tmpPath);
        const archive = archiver('zip', { zlib: { level: 0 } });

        failBuild = (err) => {
          if (cancelled) return;
          cancelled = true;
          wakeSlotWaiter();
          // abort() throws if archiver already tore itself down.
          try { archive.abort(); } catch (_) { /* already aborted */ }
          reject(err);
        };

        output.on('close', resolve);
        archive.on('error', failBuild);
        archive.pipe(output);

        // Block until archiver has drained enough of its queue for another
        // read. Also returns when the build is cancelled, so a stalled
        // archive cannot park the loop here forever.
        const waitForReadSlot = async () => {
          while (!cancelled && openReads.size >= MAX_INFLIGHT_READS) {
            await new Promise((resume) => { slotWaiter = resume; });
          }
        };

        const uniqueTypes = new Set(photos.map(p => p.type)).size;
        const hasMultipleTypes = uniqueTypes > 1;

        const addPhotos = async () => {
          for (let i = 0; i < photos.length; i += 1) {
            const photo = photos[i];
            // Check if build was invalidated
            if (cancelled) return;
            if (this.versions.get(eventId) !== version) {
              return failBuild(new Error('Build invalidated'));
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

            // Resize to the gallery's standard resolution (#858) and/or
            // watermark. Returns null when neither applies, so an
            // original-size unwatermarked gallery still streams straight
            // from storage with nothing buffered.
            let rendered = null;
            try {
              rendered = await renderPhotoForDownload(event, photo, standardBox, effectiveSettings);
            } catch (err) {
              logger.warn('Skipping photo in pre-zip', { photoId: photo.id, error: err.message });
              continue;
            }

            if (rendered) {
              archive.append(rendered, { name: archiveName });
            } else if (storageKey) {
              await waitForReadSlot();
              if (cancelled) return;
              const stream = await storage.get(storageKey);
              // The build can be cancelled while the read is in flight, and a
              // stream nobody appends is a stream nobody closes.
              if (cancelled || this.versions.get(eventId) !== version) {
                stream.destroy();
                if (cancelled) return;
                return failBuild(new Error('Build invalidated'));
              }
              archive.append(trackRead(stream), { name: archiveName });
            } else {
              const filePath = resolvePhotoFilePath(event, photo);
              archive.file(filePath, { name: archiveName });
            }
          }

          archive.finalize();
        };

        addPhotos().catch(failBuild);
      });

      // Check version again — another invalidation may have arrived
      if (this.versions.get(eventId) !== version) {
        return { success: false, error: 'Build invalidated' };
      }

      // Upload to storage (atomic from caller's perspective: storage.put writes
      // to a tmp file/object first then commits in LocalFs; in S3 the key only
      // exists after the multipart upload completes).
      await storage.putFromFile(finalKey, tmpPath, { contentType: 'application/zip' });

      // An invalidate() that arrived during the upload has already run its
      // cleanup; publishing now would put a zip built under the old settings
      // back into the row. Drop the object instead.
      if (this.versions.get(eventId) !== version) {
        await storage.delete(finalKey).catch(() => {});
        return { success: false, error: 'Build invalidated' };
      }

      const stat = await storage.stat(finalKey);

      await db('events').where({ id: eventId }).update({
        download_zip_path: finalKey,
        download_zip_generated_at: new Date(),
      });

      // The stat and the row write are awaits too: an invalidate() landing
      // in either window has run its cleanup already, and the write above
      // just put the stale zip back. Undo exactly that — only while the row
      // still points at this key, so a newer build's publication is left
      // alone.
      if (this.versions.get(eventId) !== version) {
        await db('events')
          .where({ id: eventId, download_zip_path: finalKey })
          .update({ download_zip_path: null, download_zip_generated_at: null });
        await storage.delete(finalKey).catch(() => {});
        return { success: false, error: 'Build invalidated' };
      }

      logger.info('Pre-zip generated', { eventId, slug: event.slug, size: stat.size, photos: photos.length });
      return { success: true, key: finalKey, size: stat.size };
    } catch (err) {
      if (err.message === 'Build invalidated') {
        return { success: false, error: 'Build invalidated' };
      }
      logger.error('downloadZipService._build error', { eventId, error: err.message });
      return { success: false, error: err.message };
    } finally {
      this.buildCancellers.delete(eventId);
      for (const stream of openReads) {
        stream.destroy();
      }
      openReads.clear();
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

    // Stop the in-flight build now so it releases its storage reads, rather
    // than when it next reaches the top of its loop.
    const cancelBuild = this.buildCancellers.get(eventId);
    if (cancelBuild) cancelBuild();

    // Cancel pending debounce
    const timer = this.debounceTimers.get(eventId);
    if (timer) clearTimeout(timer);

    // Fire-and-forget cleanup — tracked until it settles, so generateZip can
    // wait for it instead of publishing underneath it. A second invalidate()
    // keeps the first one's cleanup in the tracked promise.
    const previous = this.pendingCleanups.get(eventId);
    const run = this._cleanup(eventId).catch(err =>
      logger.warn('downloadZipService.invalidate cleanup error', { eventId, error: err.message })
    );
    const tracked = Promise.all([previous, run]).then(() => {
      if (this.pendingCleanups.get(eventId) === tracked) this.pendingCleanups.delete(eventId);
    });
    this.pendingCleanups.set(eventId, tracked);

    // Debounce regeneration
    const newTimer = setTimeout(() => {
      this.debounceTimers.delete(eventId);
      // Through the cap (#1399): invalidateAll arms every one of these in the
      // same tick, so without it they all start building together.
      this._withRegenSlot(() => this.generateZip(eventId)).catch(err =>
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
      // A first build still in flight has no download_zip_path yet, so the
      // query misses it — and it read its settings when it started. Left
      // alone, its version checks pass and it publishes a zip built under
      // the old settings. Taken BEFORE the query: a build that finishes
      // while the SELECT runs leaves activeBuilds and writes the row after
      // the query read it, so it would be in neither set afterwards.
      const building = [...this.activeBuilds.keys()];
      const events = await db('events')
        .whereNotNull('download_zip_path')
        .select('id');
      const ids = new Set([...events.map((event) => event.id), ...building]);
      for (const id of ids) {
        this.invalidate(id);
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
