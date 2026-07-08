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
const { generateThumbnail } = require('../services/imageProcessor');

const router = express.Router();

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
  try {
    const eventId = parseInt(req.params.id);
    const { external_path, recursive = true, map = { individual: 'individual', collages: 'collages' } } = req.body || {};
    if (!external_path) return res.status(400).json({ error: 'external_path is required' });

    // Load event
    const event = await db('events').where('id', eventId).first();
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const baseAbs = resolveExternalPath({ external_path }, '');
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

      try {
        // Check if already exists (by external_relpath)
        const exists = await db('photos')
          .where({ event_id: eventId, external_relpath: f.rel })
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

        const inserted = await db('photos')
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
            external_relpath: f.rel
          })
          .returning('id');

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

    // Update event fields
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
  }
});

module.exports = router;
