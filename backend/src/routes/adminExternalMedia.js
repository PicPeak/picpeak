const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { requireEventOwnership } = require('../middleware/ownership');
const { list, resolveExternalPath, getExternalMediaRoot } = require('../services/externalMediaService');
const { db, logActivity } = require('../database/db');
const sharp = require('sharp');
const logger = require('../utils/logger');
const { generateThumbnail, extractCaptureDate } = require('../services/imageProcessor');
const { isUniqueViolation } = require('../utils/dbErrors');

const router = express.Router();

// Events with an import running in THIS process (#1162).
//
// The second line of defence, not the first: migration 176 puts a unique index
// on (event_id, external_relpath), and that is what actually makes a duplicate
// impossible — it holds across replicas, across restarts, and against anything
// that inserts external rows without going through this route.
//
// This set exists for the reason the duplicates got filed in the first place:
// a large tree takes long enough that the run LOOKS hung, so admins click
// again. Letting that second run walk the whole tree only to have every insert
// bounce off the index wastes minutes of CPU and reports a nonsense
// `skipped: 6012` back. Failing it immediately with 409 says what happened.
const importsInFlight = new Set();

// GET /api/admin/external-media/list?path=relative/dir
router.get('/list', adminAuth, requirePermission('photos.view'), async (req, res) => {
  try {
    const relPath = (req.query.path || '').replace(/^\/+/, '');
    const result = await list(relPath);
    res.json(result);
  } catch (error) {
    logger.warn('Invalid external media path requested', {
      path: req.query.path,
      error: error.message
    });
    res.status(400).json({ error: 'Invalid external media path' });
  }
});

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
      if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
        const rel = path.relative(baseDir, full);
        results.push({ full, rel, name: e.name });
      }
    }
  }
  return results;
}

// POST /api/admin/events/:id/import-external
// Body: { external_path: string, recursive?: boolean, map?: { individual?: string, collages?: string } }
router.post('/events/:id/import-external', adminAuth, requirePermission('photos.upload'), requireEventOwnership, async (req, res) => {
  const eventId = parseInt(req.params.id);
  if (importsInFlight.has(eventId)) {
    return res.status(409).json({
      error: 'An import is already running for this event. Wait for it to finish before starting another.'
    });
  }
  importsInFlight.add(eventId);
  try {
    const { external_path, recursive = true, map = { individual: 'individual', collages: 'collages' } } = req.body || {};
    if (!external_path) return res.status(400).json({ error: 'external_path is required' });

    // Load event
    const event = await db('events').where('id', eventId).first();
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const baseAbs = resolveExternalPath({ external_path }, '');

    // What gets STORED on the row (#1163). `f.rel` stays relative to the
    // imported folder because the type inference below reads its first segment
    // ('individual' / 'collages'); external_relpath is written relative to
    // EXTERNAL_MEDIA_ROOT so the row does not depend on a column this very
    // handler is about to overwrite.
    const basePrefix = String(external_path).replace(/^\/+|\/+$/g, '');
    const toRootRelative = (rel) => (basePrefix ? path.join(basePrefix, rel) : rel);
    // Collect files
    const files = recursive ? await walkDir(baseAbs, baseAbs) : (await fs.readdir(baseAbs, { withFileTypes: true }))
      .filter(e => e.isFile())
      .map(e => ({ full: path.join(baseAbs, e.name), rel: e.name, name: e.name }))
      .filter(f => ['.jpg', '.jpeg', '.png', '.webp'].includes(path.extname(f.name).toLowerCase()));

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

    let imported = 0;
    let thumbnailsGenerated = 0;
    let thumbnailsFailed = 0;

    // Insert photos
    for (const f of dedupeMap.values()) {
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
        // index from migration 176 is the guard, and the catch below is how
        // this loop converges when it fires.
        const exists = await db('photos')
          .where({ event_id: eventId, external_relpath: relFromRoot })
          .first();
        if (exists) { skipped++; continue; }
        const stats = await fs.stat(f.full);

        // Extract dimensions via Sharp
        let width = null;
        let height = null;
        try {
          const metadata = await sharp(f.full).metadata();
          width = metadata.width || null;
          height = metadata.height || null;
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

        let inserted;
        try {
          inserted = await db('photos')
            .insert({
              event_id: eventId,
              filename: f.name,
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
              captured_at: capturedAt ? capturedAt.toISOString() : null
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

        imported += (inserted?.length ? 1 : 0);
      } catch (e) {
        skipped++;
      }
    }

    // Safe for existing EXTERNAL rows as of #1163. It was not: relpaths were
    // stored relative to external_path, so overwriting the column here rebased
    // every row already in the event onto the new folder — quietly, because
    // their thumbnails were already on local disk and the grid carried on
    // rendering. Rows now carry a root-relative path and this write cannot
    // reach them.
    await db('events').where('id', eventId).update({ source_mode: 'reference', external_path });

    await logActivity(
      'external_import_completed',
      { event_id: eventId, imported, skipped, thumbnailsGenerated, thumbnailsFailed, external_path },
      eventId,
      { type: 'admin' }
    );

    res.json({ imported, skipped, thumbnailsGenerated, thumbnailsFailed });
  } catch (error) {
    logger.error('External media import failed', {
      eventId: req.params.id,
      externalPath: req.body?.external_path,
      error: error.message
    });
    res.status(500).json({ error: 'Failed to import external media' });
  } finally {
    // In `finally` and not at the end of `try`: an import that throws must
    // still release the event, or a single failure locks out every retry
    // until the process restarts.
    importsInFlight.delete(eventId);
  }
});

module.exports = router;
