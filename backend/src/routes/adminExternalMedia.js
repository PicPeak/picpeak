const express = require('express');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { requireEventOwnership } = require('../middleware/ownership');
const { list } = require('../services/externalMediaService');
const logger = require('../utils/logger');
const {
  importExternalFolder,
  ImportInProgressError,
  EventNotFoundError,
} = require('../services/externalImportService');

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

// POST /api/admin/events/:id/import-external
// Body: { external_path: string, recursive?: boolean, map?: { individual?: string, collages?: string } }
//
// The import itself lives in services/externalImportService.js so the folder
// watcher (issue 1187) runs the identical pass without an HTTP request. This
// handler only validates, maps the service's errors to status codes, and
// records who asked.
router.post('/events/:id/import-external', adminAuth, requirePermission('photos.upload'), requireEventOwnership, async (req, res) => {
  const eventId = parseInt(req.params.id);
  const { external_path, recursive = true, map = { individual: 'individual', collages: 'collages' } } = req.body || {};
  if (!external_path) return res.status(400).json({ error: 'external_path is required' });

  try {
    const result = await importExternalFolder({
      eventId,
      externalPath: external_path,
      recursive,
      map,
      actor: { type: 'admin', id: req.admin?.id, name: req.admin?.username },
    });
    res.json(result);
  } catch (error) {
    if (error instanceof EventNotFoundError) {
      return res.status(404).json({ error: 'Event not found' });
    }
    if (error instanceof ImportInProgressError) {
      // Another run holds this event — a double-click, or the watcher on any
      // replica mid-pass. Say so rather than walking the tree a second time.
      return res.status(409).json({ error: error.message });
    }
    if (error.code === 'PATH_OUTSIDE_BASE') {
      // A folder that is a symlink out of EXTERNAL_MEDIA_ROOT: the caller's
      // choice, not a server fault.
      return res.status(400).json({ error: 'Invalid external media path' });
    }
    logger.error('External media import failed', {
      eventId: req.params.id,
      externalPath: req.body?.external_path,
      error: error.message
    });
    res.status(500).json({ error: 'Failed to import external media' });
  }
});

module.exports = router;
