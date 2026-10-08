const express = require('express');
const { adminAuth } = require('../middleware/auth');
const { requirePermission, requireSuperAdmin } = require('../middleware/permissions');
const { requireEventOwnership } = require('../middleware/ownership');
const { list } = require('../services/externalMediaService');
const externalAccess = require('../services/externalMediaAccess');
const logger = require('../utils/logger');
const {
  importExternalFolder,
  ImportInProgressError,
  EventNotFoundError,
} = require('../services/externalImportService');

const router = express.Router();

function sourceError(res, error, fallback) {
  if (!(error instanceof externalAccess.ExternalMediaAccessError)) {
    logger.error(fallback, { error: error.message });
  }
  return res.status(error instanceof externalAccess.ExternalMediaAccessError ? error.statusCode : 500)
    .json({ error: error instanceof externalAccess.ExternalMediaAccessError ? error.message : fallback });
}

// GET /api/admin/external-media/list?path=relative/dir
router.get('/list', adminAuth, requirePermission('photos.view'), async (req, res) => {
  try {
    const relPath = req.query.path || '';
    const result = await list(relPath, req.admin);
    res.json(result);
  } catch (error) {
    if (error instanceof externalAccess.ExternalMediaAccessError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    logger.warn('Invalid external media path requested', {
      path: req.query.path,
      error: error.message
    });
    res.status(400).json({ error: 'Invalid external media path' });
  }
});

router.get('/sources', adminAuth, requirePermission('photos.view'), async (req, res) => {
  try {
    const admin = await externalAccess.principal(req.admin.id, 'photos.view');
    res.json({ sources: await externalAccess.listSources(admin.id), can_assign: admin.roleName === 'super_admin', owners: await externalAccess.ownerChoices(admin.id) });
  } catch (error) {
    sourceError(res, error, 'Failed to read external sources');
  }
});

// Assignment, transfer and revocation are instance-owner actions. Gallery-wide
// permissions do not grant ownership of the external mount.
router.put('/sources', adminAuth, requireSuperAdmin(), async (req, res) => {
  try {
    const source = await externalAccess.assignSource(req.admin.id, req.body?.path, req.body?.owner_id);
    res.json({ source });
  } catch (error) {
    sourceError(res, error, 'Failed to assign external source');
  }
});

router.delete('/sources/:sourceId', adminAuth, requireSuperAdmin(), async (req, res) => {
  try {
    const id = Number(req.params.sourceId);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid source ID' });
    await externalAccess.revokeSource(req.admin.id, id);
    res.json({ success: true });
  } catch (error) {
    sourceError(res, error, 'Failed to revoke external source');
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
    if (error instanceof externalAccess.ExternalMediaAccessError) {
      return res.status(error.statusCode).json({ error: error.message });
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
