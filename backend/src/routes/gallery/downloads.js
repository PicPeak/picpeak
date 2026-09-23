const express = require('express');
const { db, logActivity } = require('../../database/db');
const { parseBooleanInput } = require('../../utils/parsers');
const archiver = require('archiver');
const path = require('path');
const { resolvePhotoContentType } = require('../../utils/photoContentType');
const router = express.Router();
const watermarkService = require('../../services/watermarkService');
const { verifyGalleryAccess, denySlideshowToken } = require('../../middleware/gallery');
const { noStoreCache } = require('../../middleware/noStoreCache');
const logger = require('../../utils/logger');
const { pipeStreamToResponse } = require('../../utils/streamResponse');
const { resolvePhotoFilePath, resolvePhotoStorageKey } = require('../../services/photoResolver');
const { errorResponse } = require('../../utils/routeHelpers');
const { blockHiddenGallery } = require('../../utils/revealMode');
const downloadZipService = require('../../services/downloadZipService');
const { renderPhotoForDownload, resolveWatermarkSettings } = require('../../services/downloadRendition');
const downloadJobService = require('../../services/downloadJobService');
const {
  resolveEventDownloadPolicy,
  pickRequestedResolution,
  parseResolution,
} = require('../../utils/downloadResolutions');
const { applyPhotoVisibilityFilter, canSeeHiddenPhotos } = require('../../utils/photoVisibility');
const {
  getUseOriginalFilenames,
  pickRawDownloadName,
  getZipEntryNames,
} = require('../../services/downloadFilenameService');
const { buildContentDisposition } = require('../../utils/filenameSanitizer');
const { getStorage } = require('../../services/storage');
const { createArchiveStreamGuard } = require('../../utils/archiveStreamGuard');
const fs = require('fs');
function parseByteRange(header, size) {
  if (!header || typeof header !== 'string' || !size) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  let start;
  let end;
  if (rawStart === '') {
    // Suffix form: the last N bytes.
    const suffix = parseInt(rawEnd, 10);
    if (!suffix) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = parseInt(rawStart, 10);
    end = rawEnd === '' ? size - 1 : parseInt(rawEnd, 10);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}
function galleryActor(req) {
  // Portal tokens run as accessLevel 'guest' but carry via:'customer'
  // (req.viaCustomer); PIN-client logins carry accessLevel 'client'.
  // Both are customers, not guests (codex review of #849, final round).
  const isCustomer = !!(req && (req.viaCustomer || req.accessLevel === 'client'));
  return { type: isCustomer ? 'customer' : 'guest' };
}
const SINGLE_DOWNLOAD_DEBOUNCE_MS = 60 * 60 * 1000;
const singleDownloadNotifiedAt = new Map();
function notifySinglePhotoDownload(event, req) {
  const now = Date.now();
  const last = singleDownloadNotifiedAt.get(event.id) || 0;
  if (now - last < SINGLE_DOWNLOAD_DEBOUNCE_MS) return;
  singleDownloadNotifiedAt.set(event.id, now);
  logActivity('gallery_downloaded', { scope: 'single' }, event.id, galleryActor(req));
}

router.get('/:slug/download/:photoId', verifyGalleryAccess, denySlideshowToken, blockHiddenGallery, async (req, res) => {
  try {
    const { photoId } = req.params;

    // Check if downloads are allowed for this event
    if (!parseBooleanInput(req.event.allow_downloads, true)) {
      return res.status(403).json({ error: 'Downloads are disabled for this gallery' });
    }

    const photo = await db('photos')
      .where({ id: photoId, event_id: req.event.id })
      .first();

    if (!photo) {
      return res.status(404).json({ error: 'Photo not found' });
    }

    // Block guest access to hidden photos
    if (photo.visibility === 'hidden' && req.accessLevel !== 'client') {
      return res.status(403).json({ error: 'Photo not available' });
    }

    // Per-category download permission (#640). Photos without a category are
    // always downloadable when the event allows downloads — only categorised
    // photos can opt out per-category.
    if (photo.category_id) {
      const cat = await db('photo_categories')
        .where('id', photo.category_id)
        .first('allow_downloads');
      if (cat && !parseBooleanInput(cat.allow_downloads, true)) {
        return res.status(403).json({ error: 'Downloads are disabled for this category' });
      }
    }

    // Download resolution (#858). Resolved BEFORE the counters below: a
    // rejected resolution must not inflate download stats, which a guest
    // could otherwise do by replaying ?resolution=bogus.
    const isVideo = photo.media_type === 'video'
      || (photo.mime_type && photo.mime_type.startsWith('video/'));
    const policy = await resolveEventDownloadPolicy(req.event);
    const requested = pickRequestedResolution(policy, req.query.resolution);
    if (requested === null) {
      return res.status(400).json({ error: 'Resolution not available for this gallery' });
    }
    const box = isVideo ? null : parseResolution(requested);

    // A HEAD is a metadata probe, not a download. Answering it below the
    // counters recorded every probe as a real download, and answering it below
    // renderPhotoForDownload fetched and watermarked an image whose body Node
    // then discards. Both happen before this point in a GET, so HEAD leaves
    // here — with no side effects and no bytes read.
    if (req.method === 'HEAD') {
      const headUseOriginal = await getUseOriginalFilenames();
      const headHeaders = {
        'Content-Type': resolvePhotoContentType(photo),
        'Content-Disposition': buildContentDisposition(pickRawDownloadName(photo, headUseOriginal)),
        'Accept-Ranges': 'bytes',
      };

      // Content-Length only when the bytes ship untransformed AND the size can
      // be read without fetching them. A watermark or resize changes the
      // length, and the only way to learn the new one is to do the work this
      // branch exists to avoid — HEAD is allowed to omit it.
      const headWatermark = await resolveWatermarkSettings(req.event);
      if (!box && !headWatermark) {
        try {
          const headKey = resolvePhotoStorageKey(req.event, photo);
          const headStorage = getStorage();
          if (headKey && headStorage.kind() !== 'local') {
            const headStat = await headStorage.stat(headKey);
            if (!headStat) return res.status(404).json({ error: 'Photo file not found' });
            headHeaders['Content-Length'] = headStat.size;
            if (headStat.mtime) headHeaders['Last-Modified'] = new Date(headStat.mtime).toUTCString();
          }
        } catch (headErr) {
          // No length is a valid HEAD; not worth failing the probe over.
          logger.debug('HEAD probe could not stat the object', { photoId, error: headErr.message });
        }
      }

      res.set(headHeaders);
      return res.end();
    }

    // Admin preview (#868) downloads are excluded from the download count +
    // guest analytics — kept out of client-facing stats.
    if (!req.isAdminPreview) {
      // Update download count
      await db('photos').where('id', photoId).increment('download_count', 1);

      // Log download
      await db('access_logs').insert({
        event_id: req.event.id,
        ip_address: req.ip,
        user_agent: req.headers['user-agent'],
        action: 'download',
        photo_id: photoId
      });
    }
    // Surface in the admin notification bell (#746) — debounced, and only
    // once the response actually finished: notifying up-front would log a
    // download that then 404s/fails and the debounce would suppress the
    // next real one for an hour (codex review of #849).
    res.on('finish', () => {
      if (res.statusCode < 400 && !req.isAdminPreview) notifySinglePhotoDownload(req.event, req);
    });
    
    // #493: if the admin enabled "use original filenames", surface the
    // pre-rename camera filename in Content-Disposition. Storage path is
    // unchanged — only the user-visible download name is swapped.
    const useOriginal = await getUseOriginalFilenames();
    const downloadName = pickRawDownloadName(photo, useOriginal);
    const contentDisposition = buildContentDisposition(downloadName);

    // The gallery's standard applies to EVERY ordinary download, single photos
    // included — otherwise a lowered standard is trivially bypassed by
    // downloading photos one at a time. `box` was resolved above, before the
    // counters. Videos have no resize path and always ship as-is.
    //
    // renderPhotoForDownload (#858) owns the resize-then-watermark ordering
    // and the storage fetch, and is what the zip builders below already use.
    // It returns null when the photo needs no transformation at all, which is
    // the default gallery's common case and lets us ship the stored bytes
    // without buffering a full-size original into memory.
    const effectiveSettings = await resolveWatermarkSettings(req.event);

    let rendered;
    try {
      rendered = await renderPhotoForDownload(req.event, photo, box, effectiveSettings);
    } catch (renderError) {
      // Classify, the same way the pass-through branch below does. This can
      // reject because the source object is gone, but equally because
      // getToFile timed out, the tmp filesystem filled up, or sharp failed —
      // and reporting an operational failure as 404 tells the guest their
      // photo does not exist and tells us nothing.
      const gone = renderError.code === 'ENOENT'
        || renderError.name === 'NoSuchKey'
        || renderError.name === 'NotFound'
        || renderError.$metadata?.httpStatusCode === 404;
      logger.error('Failed to render photo for download', {
        slug: req.params.slug,
        photoId,
        eventId: req.event.id,
        error: renderError.message,
      });
      return gone
        ? res.status(404).json({ error: 'Photo file not found' })
        : res.status(500).json({ error: 'Failed to download photo' });
    }

    if (rendered) {
      res.set({
        'Content-Type': resolvePhotoContentType(photo),
        'Content-Disposition': contentDisposition,
        'Content-Length': rendered.length
      });

      return res.send(rendered);
    }

    // Untransformed: ship the stored bytes.
    //
    // Managed photos live behind the storage abstraction and on an S3/R2
    // deployment are not on local disk at all — resolving a filesystem path
    // unconditionally here is what made every single-photo download 404 with
    // ENOENT in S3 mode (#1048), while download-all and secure-images worked
    // because they already went through getStorage().
    //
    // resolvePhotoStorageKey returns null for external/reference photos: those
    // live on a local mount and keep the sendFile path.
    let storageKey = null;
    try {
      storageKey = resolvePhotoStorageKey(req.event, photo);
    } catch (resolveError) {
      logger.error('Failed to resolve photo storage key for download', {
        slug: req.params.slug,
        photoId,
        eventId: req.event.id,
        error: resolveError.message,
      });
      return res.status(404).json({ error: 'Photo file not found' });
    }

    const storage = getStorage();
    if (storageKey && storage.kind() !== 'local') {
      // Deliberately NOT the local path: res.sendFile emits Content-Length,
      // Accept-Ranges, ETag and Last-Modified and answers Range requests with
      // a 206, and a bare stream.pipe(res) has none of that. On local disk
      // sendFile stays the better implementation, so it stays the branch.
      //
      // On S3 we reproduce the parts that matter for a download: the length
      // (browsers need it for the progress indicator, which matters most on
      // exactly the large files this route serves) and Range, so an
      // interrupted download resumes instead of appending a second full body
      // onto the partial file. Conditional requests are not reproduced —
      // there is no ETag here, so a client revalidating gets the whole body,
      // same as it does today.
      const stat = await storage.stat(storageKey);
      if (!stat) {
        logger.error('Photo not found in storage backend for download', {
          slug: req.params.slug,
          photoId,
          eventId: req.event.id,
          storageKey,
        });
        return res.status(404).json({ error: 'Photo file not found' });
      }

      const lastModified = stat.mtime ? new Date(stat.mtime).toUTCString() : null;
      const headers = {
        'Content-Type': resolvePhotoContentType(photo),
        'Content-Disposition': contentDisposition,
        'Accept-Ranges': 'bytes',
      };
      if (lastModified) headers['Last-Modified'] = lastModified;

      // If-Range: a client resuming an interrupted download sends back the
      // validator it was given last time. If the object has been replaced
      // since — the watcher re-importing a swapped file, an admin re-upload —
      // answering 206 from the NEW bytes lets the client splice two different
      // versions into one corrupt file. A validator that doesn't match means
      // a full 200, which is the whole point of the header.
      const ifRange = req.headers['if-range'];
      const staleValidator = !!ifRange && (!lastModified || ifRange.trim() !== lastModified);
      const range = staleValidator ? null : parseByteRange(req.headers.range, stat.size);

      // Open the stream BEFORE any header is staged or sent. stat() succeeding
      // does not mean get() will: a concurrent delete or replace, or a
      // transient backend error, lands here. Once writeHead(206) has gone out
      // the outer catch can do nothing but throw ERR_HTTP_HEADERS_SENT, and in
      // the non-range case it would send its 500 JSON underneath the staged
      // image/jpeg attachment headers — a .jpg file full of JSON.
      let stream;
      try {
        stream = range
          ? await storage.getRange(storageKey, range.start, range.end)
          : await storage.get(storageKey);
      } catch (fetchError) {
        const gone = fetchError.code === 'ENOENT'
          || fetchError.name === 'NoSuchKey'
          || fetchError.name === 'NotFound'
          || fetchError.$metadata?.httpStatusCode === 404;
        logger.error('Failed to open photo stream for download', {
          slug: req.params.slug,
          photoId,
          eventId: req.event.id,
          storageKey,
          error: fetchError.message,
        });
        return gone
          ? res.status(404).json({ error: 'Photo file not found' })
          : res.status(500).json({ error: 'Failed to download photo' });
      }

      if (range) {
        // status()+set() rather than writeHead(): writeHead commits the
        // response immediately, so a stream that resolves and THEN errors
        // before its first chunk would leave pipeStreamToResponse able only to
        // destroy the connection. Staged headers are flushed by the first body
        // write, which means an error at byte zero can still clear them and
        // return a clean, retryable status instead of a transport reset.
        res.status(206).set({
          ...headers,
          'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
          'Content-Length': (range.end - range.start) + 1,
        });
      } else {
        res.set({ ...headers, 'Content-Length': stat.size });
      }
      pipeStreamToResponse(stream, res, {
        context: range ? `download range for photo ${photo.id}` : `download for photo ${photo.id}`,
      });
      return;
    }

    let filePath;
    try {
      filePath = resolvePhotoFilePath(req.event, photo);
    } catch (resolveError) {
      logger.error('Failed to resolve photo path for download', {
        slug: req.params.slug,
        photoId,
        eventId: req.event.id,
        error: resolveError.message,
      });
      return res.status(404).json({ error: 'Photo file not found' });
    }

    // res.download() builds Content-Disposition itself but doesn't emit the
    // RFC 5987 filename* parameter, so unicode camera filenames would lose
    // their bytes on download. Set the header explicitly and stream the
    // file with res.sendFile-equivalent semantics.
    res.set({
      'Content-Type': resolvePhotoContentType(photo),
      'Content-Disposition': contentDisposition,
    });
    res.sendFile(filePath, (downloadError) => {
      if (downloadError) {
        logger.error('Error streaming gallery download', {
          slug: req.params.slug,
          photoId,
          eventId: req.event.id,
          error: downloadError.message,
        });
      }
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to download photo');
  }
});

/**
 * Abort a streaming archive whose headers are already on the wire.
 *
 * Aborting only the archive is not enough: archiver then ends its output, so
 * a read that failed mid-copy reached the guest as a truncated ZIP inside a
 * complete 200, and a read that failed while still queued left the archive
 * and the response open forever (review of PR 1582). Destroying the response
 * breaks the connection, which every client reports as a failed download.
 *
 * Also used, without `err`, on a plain client disconnect (issue 1587): a
 * guest closing the tab is not an error worth logging, but an archive.file()
 * source (external photos) mid-copy needs the same unpipe/abort/resume to
 * close its descriptor — the guard alone never sees that source.
 */
function abortStreamingArchive({ archive, guard, res, err, eventId, route }) {
  if (err) {
    logger.error('Gallery archive aborted after a failed read', {
      eventId,
      route,
      error: err?.code || err?.name || 'Error',
    });
  }
  guard.destroyAll();
  archive.unpipe(res);
  archive.abort();
  // abort() waits for the entry being copied, and an archive.file() source
  // (external photos) is not in the guard: with nothing reading the archive
  // any more it would stay paused with its descriptor open. Discard the
  // rest instead, so that entry runs to its end and closes.
  archive.resume();
  if (!res.destroyed) {
    res.destroy(err instanceof Error ? err : undefined);
  }
}

// finalize() settles on the archive's end or error, and an aborted archive may
// emit neither; the response closing ends the wait too.
async function finalizeOrClose(archive, res) {
  const finalized = archive.finalize();
  finalized.catch(() => {}); // failures are handled by abortStreamingArchive
  await Promise.race([finalized, new Promise((resolve) => res.once('close', resolve))]);
}

// Download all photos as ZIP
// Zip downloads count toward each contained photo's download_count (#895)
// — previously only single-photo downloads did, so galleries whose guests
// grab the zip showed 0 per-photo downloads forever. Used by the
// pre-generated-zip branches only: it mirrors downloadZipService._build,
// which zips EVERY event photo with no per-category allow_downloads
// filter — the counter has to reflect what actually shipped. (Because of
// that, the route only serves the prebuilt zip when no photo sits in a
// category with downloads turned off.) Known approximation: _build skips entries whose
// WATERMARK step fails and still publishes the zip; counting those
// would need a persisted archive manifest, which isn't worth it for
// that tail case. Fire-and-forget at the call sites: counters must
// never fail a download.
async function bumpEventDownloadCounts(eventId) {
  await db('photos').where('event_id', eventId).increment('download_count', 1);
}

router.get('/:slug/download-all', verifyGalleryAccess, denySlideshowToken, blockHiddenGallery, async (req, res) => {
  // Hoisted so the catch can reclaim reads opened before the failure.
  let guard = null;
  // The client hung up. An aborted archive rejects finalize() with ABORTED,
  // and the catch would then try to send JSON over a response whose ZIP
  // headers already went out — ERR_HTTP_HEADERS_SENT, unhandled, on an
  // ordinary cancelled download.
  let cancelled = false;
  try {
    // Check if downloads are allowed for this event
    if (!parseBooleanInput(req.event.allow_downloads, true)) {
      return res.status(403).json({ error: 'Downloads are disabled for this gallery' });
    }

    // Try to serve pre-generated zip (instant download with Content-Length).
    // Guests may use the prebuilt cache ONLY when the event has no hidden
    // photos: a cache built before a photo was hidden — or before this
    // visibility-aware builder shipped — could otherwise still leak it, and
    // getZipInfo only checks the DB pointer + file stat, not freshness. When
    // hidden photos exist, guests fall through to the visibility-filtered
    // stream below. PIN-clients always stream a full archive.
    const isClient = canSeeHiddenPhotos(req.accessLevel);
    const eventHasHidden = await db('photos')
      .where({ event_id: req.event.id, visibility: 'hidden' })
      .first()
      .then(Boolean);
    // The prebuilt archive holds every photo, but a category can turn its
    // downloads off, and the stream below leaves those photos out. Guests get
    // the cache only when no photo sits in such a category; otherwise the
    // prebuilt zip would hand them exactly the photos they may not download.
    const eventHasDownloadRestrictedPhotos = (isClient || eventHasHidden)
      ? false
      : await db('photos')
        .join('photo_categories', 'photos.category_id', 'photo_categories.id')
        .where('photos.event_id', req.event.id)
        .where('photo_categories.allow_downloads', false)
        .first('photos.id')
        .then(Boolean);
    const streamOnly = isClient || eventHasHidden || eventHasDownloadRestrictedPhotos;
    const zipInfo = streamOnly
      ? null
      : await downloadZipService.getZipInfo(req.event.id);
    if (zipInfo) {
      const storage = getStorage();

      // Stream via the authenticated route so logout, restore and account
      // changes are checked on every download, including S3-backed archives.
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Length', zipInfo.size);
      res.setHeader('Content-Disposition', `attachment; filename="${req.event.slug}.zip"`);
      const stream = await storage.get(zipInfo.key);
      pipeStreamToResponse(stream, res, { context: `prepared zip for event ${req.event.id}`, missingStatus: 410 });

      // Log bulk download (admin preview #868 excluded — stats stay client-only).
      if (!req.isAdminPreview) {
        db('access_logs').insert({
          event_id: req.event.id,
          ip_address: req.ip,
          user_agent: req.headers['user-agent'],
          action: 'download_all'
        }).catch(() => {});
        bumpEventDownloadCounts(req.event.id).catch(() => {});
        // Surface in the admin notification bell (#746) — only once the
        // stream actually finished; logging at pipe-time would report
        // downloads that then broke mid-transfer (codex review of #849).
        res.on('finish', () => {
          if (res.statusCode < 400) logActivity('gallery_downloaded', { scope: 'all' }, req.event.id, galleryActor(req));
        });
      }
      return;
    }

    // Fallback: on-the-fly streaming (existing behavior). Only pre-build the
    // guest cache when it will actually be served next time — a guest
    // download of an event with no hidden photos. Client bypasses and
    // hidden-photo events always stream, so rebuilding the guest archive on
    // those requests is wasted I/O (codex review).
    if (!streamOnly) {
      downloadZipService.generateZip(req.event.id).catch(err =>
        logger.warn('Background zip generation failed', { eventId: req.event.id, error: err.message })
      );
    }

    // Fetch photos — exclude photos in categories that disabled downloads (#640).
    // Uncategorised photos are always included; categories without the column
    // (pre-migration-135) fall through the LEFT JOIN's null and are included.
    const photos = await applyPhotoVisibilityFilter(
      db('photos')
        .leftJoin('photo_categories', 'photos.category_id', 'photo_categories.id')
        .where('photos.event_id', req.event.id)
        .where(function () {
          this.whereNull('photos.category_id')
            .orWhere('photo_categories.allow_downloads', true)
            .orWhereNull('photo_categories.allow_downloads');
        }),
      req.accessLevel
    )
      .select('photos.*')
      .orderBy('photos.type', 'asc')
      .orderBy('photos.uploaded_at', 'desc');

    if (photos.length === 0) {
      return res.status(404).json({ error: 'No photos found' });
    }

    // Count unique types
    const uniqueTypes = new Set(photos.map(p => p.type)).size;
    const hasMultipleTypes = uniqueTypes > 1;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${req.event.slug}.zip"`);

    const archive = archiver('zip', { zlib: { level: 5 } });
    // A throw here used to escape the event emitter as an uncaught exception.
    const failArchive = (err) => {
      if (cancelled) return;
      cancelled = true;
      abortStreamingArchive({ archive, guard, res, err, eventId: req.event.id, route: 'download-all' });
    };
    archive.on('error', failArchive);

    // Reclaim storage reads on every exit (#1399 follow-up). A guest closing
    // the tab mid-download used to leave every appended-but-undrained read
    // parked on its socket for the life of the process.
    guard = createArchiveStreamGuard({
      // A queued read that dies takes the archive with it: archiver has no
      // listener on it yet, so it would otherwise sit in the queue and stall
      // the download forever.
      onFatalError: failArchive,
    });
    res.on('close', () => {
      if (!res.writableFinished) {
        cancelled = true;
        abortStreamingArchive({ archive, guard, res, eventId: req.event.id, route: 'download-all' });
      }
    });

    archive.pipe(res);

    // Get watermark settings - apply if global setting OR event-level setting is enabled
    const watermarkSettings = await watermarkService.getWatermarkSettings();
    const eventWatermarkEnabled = req.event.watermark_downloads === true || req.event.watermark_downloads === 1;
    const shouldApplyWatermark = (watermarkSettings && watermarkSettings.enabled) || eventWatermarkEnabled;
    const effectiveSettings = shouldApplyWatermark ? {
      ...watermarkSettings,
      enabled: true,
      text: req.event.watermark_text || watermarkSettings?.text || 'Protected'
    } : null;

    // The gallery's standard resolution applies to the streamed archive too,
    // not only the cached one (#858).
    const { standardBox: bulkBox } = await resolveEventDownloadPolicy(req.event);

    // Add photos to archive — managed photos via storage backend, external via local path.
    const { resolvePhotoStorageKey } = require('../../services/photoResolver');
    const storage = getStorage();
    // #493: resolve a unique display filename per photo up-front so collisions
    // get a deterministic `_1` suffix before the entries hit the archive.
    const useOriginalBulk = await getUseOriginalFilenames();
    const bulkEntryNames = getZipEntryNames(photos, useOriginalBulk);
    // Only photos whose append succeeded count as downloaded (#895) — the
    // catch below deliberately skips missing/corrupt sources, and those
    // never make it into the archive.
    const appendedIds = [];
    for (let i = 0; i < photos.length; i += 1) {
      const photo = photos[i];
      const storageKey = resolvePhotoStorageKey(req.event, photo);
      const entryName = bulkEntryNames[i];
      let archiveName;
      if (hasMultipleTypes) {
        const folderName = photo.type === 'individual' ? 'Individual Photos' : 'Collages';
        archiveName = path.join(folderName, entryName);
      } else {
        archiveName = entryName;
      }

      try {
        // Verify the source exists BEFORE appending — but only for local
        // sources: fs.createReadStream is lazy, so its error fires outside
        // this try/catch and the archive 'error' handler then kills the
        // whole response instead of skipping one photo (#895 review). S3's
        // get() awaits GetObject and rejects right here on a missing key,
        // so a preflight HEAD per entry would just be a redundant serial
        // round trip (500-photo zip = 500 extra HEADs).
        if (storageKey && storage.kind() === 'local') {
          const srcStat = await storage.stat(storageKey);
          if (!srcStat) {
            throw new Error(`Photo missing in storage: ${storageKey}`);
          }
        } else if (!storageKey && !fs.existsSync(resolvePhotoFilePath(req.event, photo))) {
          throw new Error('Photo file missing on disk');
        }

        // Resize to the gallery's standard resolution (#858) and/or watermark.
        // This branch runs whenever the cached zip isn't usable — the first
        // download after an invalidation, PIN clients, and galleries with
        // hidden photos all land here, so skipping the cap would leak
        // full-resolution files for exactly those cases.
        const rendered = await renderPhotoForDownload(req.event, photo, bulkBox, effectiveSettings);
        if (rendered) {
          archive.append(rendered, { name: archiveName });
        } else if (storageKey) {
          if (!await guard.acquire()) break;
          const stream = await storage.get(storageKey);
          archive.append(guard.track(stream), { name: archiveName });
        } else {
          archive.file(resolvePhotoFilePath(req.event, photo), { name: archiveName });
        }
        appendedIds.push(photo.id);
      } catch (err) {
        logger.warn('Skipping photo in bulk download due to error', {
          slug: req.params.slug,
          photoId: photo.id,
          eventId: req.event.id,
          error: err.message,
        });
      }
    }

    // Notification only after the response actually finished — finalize()
    // ends Archiver's input, not the HTTP transfer (codex review of #849,
    // confirmation round). Registered before finalize so it can't be missed.
    // Admin preview (#868) streams the archive but is excluded from stats.
    if (!req.isAdminPreview) {
      res.on('finish', () => {
        if (res.statusCode < 400) logActivity('gallery_downloaded', { scope: 'all' }, req.event.id, galleryActor(req));
      });
    }
    if (cancelled) return;
    await finalizeOrClose(archive, res);
    // A failed or abandoned archive is not a download.
    if (cancelled) return;

    if (!req.isAdminPreview) {
      // Log bulk download
      await db('access_logs').insert({
        event_id: req.event.id,
        ip_address: req.ip,
        user_agent: req.headers['user-agent'],
        action: 'download_all'
      })
        // The archive is complete by now; a failed log write must not reach
        // the catch below, which would destroy a response still draining.
        .catch((err) => logger.warn('Gallery download log write failed', {
          eventId: req.event.id,
          error: err?.code || err?.name || 'Error',
        }));
      // Exactly the photos that made it into this archive (#895) — skipped
      // (missing/corrupt) sources don't count.
      if (appendedIds.length > 0) {
        db('photos').whereIn('id', appendedIds)
          .increment('download_count', 1).catch(() => {});
      }
    }
  } catch (error) {
    if (guard) guard.destroyAll();
    // Nothing to say to a client that already left, and the headers are gone.
    // A half-sent archive must not be left open or ended as if complete.
    if (cancelled || res.headersSent) {
      if (!res.destroyed) res.destroy();
      return;
    }
    errorResponse(res, error, 500, 'Failed to create download archive');
  }
});

// Download selected photos as ZIP
router.post('/:slug/download-selected', verifyGalleryAccess, denySlideshowToken, blockHiddenGallery, async (req, res) => {
  // Hoisted so the catch can reclaim reads opened before the failure.
  let selectedGuard = null;
  let selectedCancelled = false;
  try {
    // Check if downloads are allowed for this event
    if (!parseBooleanInput(req.event.allow_downloads, true)) {
      return res.status(403).json({ error: 'Downloads are disabled for this gallery' });
    }

    const ids = Array.isArray(req.body?.photo_ids) ? req.body.photo_ids : [];
    if (!ids.length) {
      return res.status(400).json({ error: 'photo_ids is required (non-empty array)' });
    }

    // Clean IDs
    const photoIds = ids
      .map((v) => parseInt(v, 10))
      .filter((v) => Number.isInteger(v))
      .slice(0, 500);

    if (photoIds.length === 0) {
      return res.status(400).json({ error: 'No valid photo IDs provided' });
    }

    // Fetch photos — exclude photos in categories that disabled downloads (#640).
    // Same LEFT JOIN pattern as the download-all endpoint.
    const photos = await applyPhotoVisibilityFilter(
      db('photos')
        .leftJoin('photo_categories', 'photos.category_id', 'photo_categories.id')
        .where('photos.event_id', req.event.id)
        .whereIn('photos.id', photoIds)
        .where(function () {
          this.whereNull('photos.category_id')
            .orWhere('photo_categories.allow_downloads', true)
            .orWhereNull('photo_categories.allow_downloads');
        }),
      req.accessLevel
    )
      .select('photos.*')
      .orderBy('photos.uploaded_at', 'desc');

    if (photos.length === 0) {
      return res.status(404).json({ error: 'No photos found for selected IDs' });
    }

    // Download resolution (#858). Resolve BEFORE any header goes out — once
    // the archive starts streaming we can no longer return a JSON error.
    const selectedPolicy = await resolveEventDownloadPolicy(req.event);
    const selectedResolution = pickRequestedResolution(selectedPolicy, req.body?.resolution);
    if (selectedResolution === null) {
      return res.status(400).json({ error: 'Resolution not available for this gallery' });
    }
    const selectedBox = parseResolution(selectedResolution);

    const archiveName = `${req.event.slug}-selected.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${archiveName}"`);

    const archive = archiver('zip', { zlib: { level: 5 } });
    // The headers are already out, so a 500 here only ended the ZIP cleanly
    // and truncated. Same abort as download-all.
    const failSelected = (err) => {
      if (selectedCancelled) return;
      selectedCancelled = true;
      abortStreamingArchive({
        archive, guard: selectedGuard, res, err, eventId: req.event.id, route: 'download-selected',
      });
    };
    archive.on('error', failSelected);

    // Same reclaim contract as download-all above (#1399 follow-up).
    selectedGuard = createArchiveStreamGuard({ onFatalError: failSelected });
    res.on('close', () => {
      if (!res.writableFinished) {
        selectedCancelled = true;
        abortStreamingArchive({
          archive, guard: selectedGuard, res, eventId: req.event.id, route: 'download-selected',
        });
      }
    });

    archive.pipe(res);

    // Check watermark settings - apply if global setting OR event-level setting is enabled
    const watermarkSettings = await watermarkService.getWatermarkSettings();
    const eventWatermarkEnabled = req.event.watermark_downloads === true || req.event.watermark_downloads === 1;
    const shouldApplyWatermark = (watermarkSettings && watermarkSettings.enabled) || eventWatermarkEnabled;
    const effectiveSettings = shouldApplyWatermark ? {
      ...watermarkSettings,
      enabled: true,
      text: req.event.watermark_text || watermarkSettings?.text || 'Protected'
    } : null;

    const { resolvePhotoStorageKey: resolveSelectedKey } = require('../../services/photoResolver');
    const selectedStorage = getStorage();
    // #493: same display-name resolution as bulk download, with dedup.
    const useOriginalSelected = await getUseOriginalFilenames();
    const selectedEntryNames = getZipEntryNames(photos, useOriginalSelected);
    // Only photos whose append succeeded count as downloaded (#895).
    const appendedIds = [];
    for (let i = 0; i < photos.length; i += 1) {
      const photo = photos[i];
      const name = selectedEntryNames[i] || `photo-${photo.id}.jpg`;
      const storageKey = resolveSelectedKey(req.event, photo);
      try {
        // Same pre-append source check as download-all (#895 review),
        // local backend only: a lazy fs stream's async error would kill
        // the response instead of skipping the photo; S3's get() rejects
        // at the await below, so no redundant per-entry HEAD there.
        if (storageKey && selectedStorage.kind() === 'local') {
          const srcStat = await selectedStorage.stat(storageKey);
          if (!srcStat) {
            throw new Error(`Photo missing in storage: ${storageKey}`);
          }
        } else if (!storageKey && !fs.existsSync(resolvePhotoFilePath(req.event, photo))) {
          throw new Error('Photo file missing on disk');
        }

        // Resize (#858) and/or watermark. renderPhotoForDownload returns null
        // when neither applies, so the untransformed case still streams from
        // storage rather than buffering the whole photo.
        const rendered = await renderPhotoForDownload(req.event, photo, selectedBox, effectiveSettings);
        if (rendered) {
          archive.append(rendered, { name });
        } else if (storageKey) {
          if (!await selectedGuard.acquire()) break;
          const stream = await selectedStorage.get(storageKey);
          archive.append(selectedGuard.track(stream), { name });
        } else {
          archive.file(resolvePhotoFilePath(req.event, photo), { name });
        }
        appendedIds.push(photo.id);
      } catch (err) {
        logger.warn('Skipping selected photo due to error', {
          slug: req.params.slug,
          photoId: photo.id,
          eventId: req.event.id,
          error: err.message,
        });
      }
    }

    // See download-all: notify only on response 'finish'.
    // Admin preview (#868) streams the archive but is excluded from stats.
    if (!req.isAdminPreview) {
      res.on('finish', () => {
        if (res.statusCode < 400) logActivity('gallery_downloaded', { scope: 'selected', photo_count: photoIds.length }, req.event.id, galleryActor(req));
      });
    }
    if (selectedCancelled) return;
    await finalizeOrClose(archive, res);
    if (selectedCancelled) return;

    if (!req.isAdminPreview) {
      await db('access_logs').insert({
        event_id: req.event.id,
        ip_address: req.ip,
        user_agent: req.headers['user-agent'],
        action: 'download_selected'
      })
        // The archive is complete by now; a failed log write must not reach
        // the catch below, which would destroy a response still draining.
        .catch((err) => logger.warn('Gallery download log write failed', {
          eventId: req.event.id,
          error: err?.code || err?.name || 'Error',
        }));
      // Exactly the photos that made it into this archive (#895) — skipped
      // (missing/corrupt) sources don't count.
      if (appendedIds.length > 0) {
        db('photos').whereIn('id', appendedIds)
          .increment('download_count', 1).catch(() => {});
      }
    }
  } catch (error) {
    if (selectedGuard) selectedGuard.destroyAll();
    if (selectedCancelled || res.headersSent) {
      if (!res.destroyed) res.destroy();
      return;
    }
    errorResponse(res, error, 500, 'Failed to download selected photos');
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Custom-resolution download jobs (#858).
//
// The plain download-all is served from the pre-built cache at the gallery's
// STANDARD resolution. Picking a different size has nothing to cache against,
// and resizing a whole gallery inside one request would sit far past any
// reverse-proxy timeout — so those archives are built as a job the client
// polls. Same access rules as the download routes above.
// ──────────────────────────────────────────────────────────────────────────

// Kick off (or join) a build. Returns the polling token.
router.post('/:slug/download-jobs', verifyGalleryAccess, denySlideshowToken, blockHiddenGallery, async (req, res) => {
  try {
    if (!parseBooleanInput(req.event.allow_downloads, true)) {
      return res.status(403).json({ error: 'Downloads are disabled for this gallery' });
    }

    const policy = await resolveEventDownloadPolicy(req.event);
    if (!policy.pickerEnabled) {
      return res.status(403).json({ error: 'Resolution choice is not enabled for this gallery' });
    }
    const resolution = pickRequestedResolution(policy, req.body?.resolution);
    if (resolution === null) {
      return res.status(400).json({ error: 'Resolution not available for this gallery' });
    }

    // Optional subset. Absent = the whole visible gallery.
    let photoIds = null;
    if (Array.isArray(req.body?.photo_ids) && req.body.photo_ids.length) {
      photoIds = req.body.photo_ids
        .map((v) => parseInt(v, 10))
        .filter((v) => Number.isInteger(v))
        .slice(0, 500);
      if (photoIds.length === 0) {
        return res.status(400).json({ error: 'No valid photo IDs provided' });
      }
    }

    let job;
    try {
      job = await downloadJobService.createJob({
        event: req.event,
        resolution,
        photoIds,
        accessLevel: req.accessLevel,
      });
    } catch (err) {
      if (err.code === 'NO_PHOTOS') {
        return res.status(404).json({ error: 'No photos available for this selection' });
      }
      if (err.code === 'BUSY') {
        return res.status(429).json({ error: 'Too many downloads are being prepared right now — please try again shortly' });
      }
      throw err;
    }

    res.status(202).json({
      token: job.token,
      status: job.status,
      resolution: job.resolution,
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to start download preparation');
  }
});

// Poll. The token is unguessable, but it is never sufficient on its own —
// verifyGalleryAccess still runs and the job must belong to THIS event.
// no-store: a cached 'preparing' would strand the caller in a poll that can
// never observe the job finishing.
router.get('/:slug/download-jobs/:token', verifyGalleryAccess, denySlideshowToken, blockHiddenGallery, noStoreCache, async (req, res) => {
  try {
    const job = await downloadJobService.getStatus(req.params.token);
    if (!job || job.event_id !== req.event.id) {
      return res.status(404).json({ error: 'Download job not found' });
    }
    res.json({
      status: job.status,
      resolution: job.resolution,
      photo_count: job.photo_count || 0,
      size_bytes: job.size_bytes || null,
      error: job.status === 'failed' ? (job.error || 'Preparation failed') : undefined,
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to read download job');
  }
});

// Deliver the finished archive.
router.get('/:slug/download-jobs/:token/file', verifyGalleryAccess, denySlideshowToken, blockHiddenGallery, async (req, res) => {
  try {
    // Downloads can be switched off after a job was created — every other
    // download route re-checks this per request, so this one must too.
    if (!parseBooleanInput(req.event.allow_downloads, true)) {
      return res.status(403).json({ error: 'Downloads are disabled for this gallery' });
    }

    const job = await downloadJobService.getStatus(req.params.token);
    if (!job || job.event_id !== req.event.id) {
      return res.status(404).json({ error: 'Download job not found' });
    }
    // The token alone never grants access: the archive was built under one
    // visibility scope, and only a requester still in that scope may take it.
    // Without this, a leaked client token would hand hidden photos to a guest.
    if (job.visibility_scope !== downloadJobService.visibilityScopeFor(req.accessLevel)) {
      return res.status(404).json({ error: 'Download job not found' });
    }
    if (job.status !== 'ready' || !job.zip_path) {
      return res.status(409).json({ error: 'Download is not ready yet', status: job.status });
    }
    if (new Date(job.expires_at).getTime() <= Date.now()) {
      return res.status(410).json({ error: 'This download has expired — please request it again' });
    }
    // A photo hidden AFTER this archive was built is still inside it, and the
    // scope check above can't see that — both sides remain 'public'. Re-run
    // the visibility query over the packaged set before handing it over.
    if (!(await downloadJobService.isStillDeliverable(job, req.event, req.accessLevel))) {
      return res.status(409).json({
        error: 'This gallery changed since the download was prepared — please request it again',
        status: 'stale',
      });
    }

    const storage = getStorage();
    const stat = await storage.stat(job.zip_path);
    if (!stat) {
      return res.status(410).json({ error: 'This download is no longer available' });
    }

    // Stats parity with the other bulk paths (#895): only count once the
    // response actually completed, and keep admin previews out of guest stats.
    res.on('finish', () => {
      if (res.statusCode >= 400 || req.isAdminPreview) return;
      // The DELIVERED set, not the requested one: a photo whose source was
      // missing at build time isn't in the zip and must not be counted.
      let ids = [];
      try {
        ids = JSON.parse(job.delivered_photo_ids || job.photo_ids || '[]');
      } catch (_) { /* malformed row — skip counting rather than fail */ }
      if (ids.length > 0) {
        db('photos').whereIn('id', ids).increment('download_count', 1).catch(() => {});
      }
      db('access_logs').insert({
        event_id: req.event.id,
        ip_address: req.ip,
        user_agent: req.headers['user-agent'],
        action: 'download',
        photo_id: null,
      }).catch(() => {});
      logActivity('gallery_downloaded', { scope: 'all', resolution: job.resolution },
        req.event.id, galleryActor(req));
    });

    const suffix = job.resolution === 'original' ? 'original' : job.resolution;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `attachment; filename="${req.event.slug}-${suffix}.zip"`);
    const stream = await storage.get(job.zip_path);
    pipeStreamToResponse(stream, res, { context: `download job ${job.id}`, missingStatus: 410 });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to serve prepared download');
  }
});

// Explicit per-photo view beacon (#895). Counting views on the image-
// serving routes is wrong in both directions: the lightbox preloads the
// prev/next neighbours (three fetches per open), while a preloaded
// neighbour that becomes the current slide is never re-fetched (#505
// keeps the DOM node alive across the swipe) — so request-level counters
// overcount preloads AND undercount swipe-throughs. Instead the lightbox
// pings this endpoint exactly when a photo becomes the visible slide.
// This also covers enhanced/maximum-protection galleries, whose bytes
// are served by /api/secure-images and never pass the routes below.
// The slideshow kiosk is excluded (denySlideshowToken; migration 138).

module.exports = router;
