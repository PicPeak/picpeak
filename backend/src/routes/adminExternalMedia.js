const express = require('express');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { requireEventOwnership } = require('../middleware/ownership');
const { db } = require('../database/db');
const { list } = require('../services/externalMediaService');
const jobState = require('../services/maintenanceJobState');
const logger = require('../utils/logger');
const {
  importExternalFolder,
  ImportInProgressError,
  EventNotFoundError,
  jobNameFor,
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
// Body: { external_path?: string, recursive?: boolean, map?: { individual?: string, collages?: string } }
//
// Without `external_path` this imports, or rescans, the folder the gallery's
// Photo source already points at: the admin UI's one-click Rescan, which no
// longer asks for the folder again. A path in the body still imports that
// folder and points the gallery at it, as before.
//
// The import itself lives in services/externalImportService.js so the folder
// watcher (issue 1187) runs the identical pass without an HTTP request. This
// handler only validates, maps the service's errors to status codes, and
// records who asked.
router.post('/events/:id/import-external', adminAuth, requirePermission('photos.upload'), requireEventOwnership, async (req, res) => {
  const eventId = parseInt(req.params.id);
  const { recursive = true, map = { individual: 'individual', collages: 'collages' } } = req.body || {};
  let external_path = typeof req.body?.external_path === 'string' ? req.body.external_path.trim() : '';
  if (!external_path) {
    const event = await db('events').where({ id: eventId }).first('source_mode', 'external_path');
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (event.source_mode === 'reference' && event.external_path) external_path = event.external_path;
  }
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
      externalPath: external_path,
      error: error.message
    });
    res.status(500).json({ error: 'Failed to import external media' });
  }
});

// GET /api/admin/external-media/events/:id/status
// Whether an import of the gallery's folder is running, and when the last one
// finished: the Photos tab's "Last scan" and Rescan state.
router.get('/events/:id/status', adminAuth, requirePermission('photos.view'), requireEventOwnership, async (req, res) => {
  try {
    const state = await jobState.read(jobNameFor(parseInt(req.params.id)));
    res.json({ is_running: state.isRunning, finished_at: state.finishedAt, last_result: state.lastResult });
  } catch (error) {
    logger.error('External import status failed', { eventId: req.params.id, error: error.message });
    res.status(500).json({ error: 'Failed to read import status' });
  }
});

module.exports = router;
