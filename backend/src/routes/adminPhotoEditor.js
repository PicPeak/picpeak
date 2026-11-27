/**
 * The photo editor's admin API (issue 2619).
 *
 *   GET  /:eventId/photos/:photoId/edit        the photo's edit and the size of its upright original
 *   GET  /:eventId/photos/:photoId/edit/base   the unedited photo at 1920 px, the editor's canvas
 *   PUT  /:eventId/photos/:photoId/edit        save an edit ({ params }), or reset it ({ params: null })
 *   POST /:eventId/photos/edit/batch           copy settings to photos ({ photo_ids, params, parts })
 *   GET  /:eventId/photos/edit/status          the background apply's progress for the gallery
 *
 * Behind the photoEditor feature flag and photos.edit, for the galleries the
 * admin may reach (requireEventOwnership, as the focal point and poster
 * routes). The params are validated strictly here (photoEditMath): nothing a
 * client sends reaches the renderer unchecked. Saving is cheap: the render,
 * the renditions and the gallery ZIP follow in the background
 * (photoEdits.js), one save after another per photo, the last one winning.
 */

const express = require('express');
const { db, logActivity } = require('../database/db');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { requireEventOwnership } = require('../middleware/ownership');
const { requireFeatureFlag } = require('../middleware/requireFeatureFlag');
const { livePhotos } = require('../utils/photoVisibility');
const { parsePositiveInt32 } = require('../utils/parsers');
const { errorResponse } = require('../utils/routeHelpers');
const { answerVanished } = require('../utils/streamResponse');
const math = require('../utils/photoEditMath');
const photoEdits = require('../services/photoEdits');

const router = express.Router();

// The most photos one batch copy takes; a gallery larger than this is copied in parts.
const MAX_BATCH = 1000;

const gate = [adminAuth, requireFeatureFlag('photoEditor'), requirePermission('photos.edit'), requireEventOwnership];
const actor = (req) => ({ type: 'admin', id: req.admin.id, name: req.admin.username });

const isVideoRow = (photo) => photo.media_type === 'video' || photo.type === 'video'
  || String(photo.mime_type || '').startsWith('video/');

/** Why this photo cannot be edited now, as [status, message], or null. */
function refusal(photo, event) {
  if (event.is_archived === true || event.is_archived === 1) return [409, 'An archived gallery cannot be edited'];
  if (isVideoRow(photo)) return [400, 'Videos cannot be edited'];
  if (photo.processing_status === 'pending' || photo.processing_status === 'processing') {
    return [409, 'The photo is still being processed'];
  }
  if (photo.processing_status === 'failed') return [409, 'The photo could not be processed'];
  return null;
}

/** The photo of this gallery named in the URL, or null once answered. */
async function loadPhoto(req, res) {
  const eventId = parsePositiveInt32(req.params.eventId);
  const photoId = parsePositiveInt32(req.params.photoId);
  const photo = eventId && photoId
    ? await livePhotos(db).where({ id: photoId, event_id: eventId }).first()
    : null;
  if (!photo) {
    res.status(404).json({ error: 'Photo not found' });
    return null;
  }
  const event = await db('events').where({ id: eventId }).first('id', 'is_archived');
  return { photo, event };
}

/** What the editor needs to open a photo. */
function editPayload(photo) {
  return {
    photo_id: photo.id,
    params: photoEdits.paramsOf(photo),
    edit_rev: Number(photo.edit_rev) || 0,
    edit_applied_rev: Number(photo.edit_applied_rev) || 0,
    // The upright original: crops and focal points are fractions of it.
    width: photo.width || null,
    height: photo.height || null,
    edited_width: photo.edit_width || null,
    edited_height: photo.edit_height || null,
  };
}

router.get('/:eventId/photos/edit/status', ...gate, async (req, res) => {
  try {
    const eventId = parsePositiveInt32(req.params.eventId);
    if (!eventId) return res.status(404).json({ error: 'Event not found' });
    res.json(await photoEdits.status(eventId));
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to read the edit progress');
  }
});

router.post('/:eventId/photos/edit/batch', ...gate, async (req, res) => {
  try {
    const eventId = parsePositiveInt32(req.params.eventId);
    const event = eventId ? await db('events').where({ id: eventId }).first('id', 'is_archived') : null;
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (event.is_archived === true || event.is_archived === 1) {
      return res.status(409).json({ error: 'An archived gallery cannot be edited' });
    }
    const { photo_ids: rawIds, params: rawParams, parts: rawParts } = req.body || {};
    if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > MAX_BATCH) {
      return res.status(400).json({ error: `photo_ids must list 1 to ${MAX_BATCH} photos` });
    }
    const ids = [...new Set(rawIds.map((id) => parsePositiveInt32(id)))];
    if (ids.some((id) => !id)) return res.status(400).json({ error: 'photo_ids must be photo ids' });
    const parts = Array.isArray(rawParts) ? [...new Set(rawParts)] : ['tone', 'geometry'];
    if (!parts.length || parts.some((part) => !['tone', 'geometry'].includes(part))) {
      return res.status(400).json({ error: 'parts must name tone and/or geometry' });
    }
    const { params, error } = math.validateEditParams(rawParams);
    if (error) return res.status(400).json({ error });

    const photos = await livePhotos(db).where({ event_id: eventId }).whereIn('id', ids);
    if (photos.length !== ids.length) return res.status(404).json({ error: 'Some photos are not in this gallery' });
    const changes = [];
    const skipped = [];
    for (const photo of photos) {
      if (refusal(photo, event)) {
        skipped.push(photo.id);
        continue;
      }
      // The copied parts over what the photo has; re-validated as a whole.
      const merged = math.validateEditParams(math.mergeParts(photoEdits.paramsOf(photo), params, parts));
      if (merged.error) return res.status(400).json({ error: merged.error });
      changes.push({ photo, params: merged.params });
    }
    const revisions = changes.length ? await photoEdits.saveEdits(changes) : {};
    await logActivity('photo_edits_copied', { count: changes.length, parts }, eventId, actor(req));
    res.json({ queued: changes.length, skipped, revisions });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to copy the edit');
  }
});

router.get('/:eventId/photos/:photoId/edit', ...gate, async (req, res) => {
  try {
    const loaded = await loadPhoto(req, res);
    if (!loaded) return;
    if (isVideoRow(loaded.photo)) return res.status(400).json({ error: 'Videos cannot be edited' });
    res.json(editPayload(loaded.photo));
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to read the edit');
  }
});

router.get('/:eventId/photos/:photoId/edit/base', ...gate, async (req, res) => {
  try {
    const loaded = await loadPhoto(req, res);
    if (!loaded) return;
    if (isVideoRow(loaded.photo)) return res.status(400).json({ error: 'Videos cannot be edited' });
    const jpeg = await photoEdits.originalPreviewJpeg(loaded.photo, { interactive: true });
    res.set({
      'Content-Type': 'image/jpeg',
      'Content-Length': jpeg.length,
      // The URL names the source file (photos.service), which a replacement changes.
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(jpeg);
  } catch (error) {
    if (answerVanished(res, error, 'Photo file not found')) return;
    if (error.status === 503) return res.status(503).set('Retry-After', '5').json({ error: 'Image processing is busy; try again shortly' });
    errorResponse(res, error, 500, 'Failed to load the photo for editing');
  }
});

router.put('/:eventId/photos/:photoId/edit', ...gate, async (req, res) => {
  try {
    const loaded = await loadPhoto(req, res);
    if (!loaded) return;
    const { photo, event } = loaded;
    const denied = refusal(photo, event);
    if (denied) return res.status(denied[0]).json({ error: denied[1] });
    const raw = req.body?.params;
    if (raw === undefined) return res.status(400).json({ error: 'params is required (null resets the edit)' });
    let params = null;
    if (raw !== null) {
      const result = math.validateEditParams(raw);
      if (result.error) return res.status(400).json({ error: result.error });
      params = result.params;
    }
    await photoEdits.saveEdits([{ photo, params }]);
    const saved = await livePhotos(db).where({ id: photo.id }).first();
    await logActivity('photo_edited', {
      photo_id: photo.id, reset: !photoEdits.paramsOf(saved),
    }, photo.event_id, actor(req));
    res.json(editPayload(saved));
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to save the edit');
  }
});

module.exports = router;
