/**
 * Gallery folders — admin routes (issue 1786).
 *
 * Mounted at /api/admin. Everything is scoped to one event and guarded by
 * requireEventOwnership. Two permissions:
 *
 *   photos.upload   resolve the folders an upload needs. Creates missing ones
 *                   only when the caller also holds folders.manage; otherwise
 *                   each missing path becomes a folder request and the batch
 *                   lands in the closest existing folder.
 *   folders.manage  create, rename, move, delete folders; approve or reject
 *                   folder requests; apply an external folder's structure.
 *
 * Integrity rules (same event, depth 3, no cycles, never delete a photo) live
 * in services/folderTreeService.js.
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { db, logActivity } = require('../database/db');
const { adminAuth } = require('../middleware/auth');
const { requirePermission, userHasAllPermissions } = require('../middleware/permissions');
const { requireEventOwnership } = require('../middleware/ownership');
const { safeValidationErrors, errorResponse } = require('../utils/routeHelpers');
const { capabilityEvidence } = require('../usage/capabilityEvidence');
const tree = require('../services/folderTreeService');
const requests = require('../services/folderRequestService');
const downloadZipService = require('../services/downloadZipService');

const router = express.Router();

const MAX_RESOLVE_PATHS = 500;
const MAX_PATH_LENGTH = 1024;

const actorOf = (req) => ({ type: 'admin', id: req.admin.id, name: req.admin.username });
const eventIdOf = (req) => parseInt(req.params.eventId, 10);

function sendFolderError(res, err, fallback) {
  if (err instanceof tree.FolderError) {
    return res.status(err.status).json({ error: err.message, code: err.code, ...(err.details || {}) });
  }
  return errorResponse(res, err, 500, fallback);
}

function invalid(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  res.status(400).json({ errors: safeValidationErrors(errors) });
  return true;
}

const canManageFolders = (req) => userHasAllPermissions(req.admin.id, ['folders.manage']);

// The tree, open requests, and whether this caller may edit folders.
router.get('/events/:eventId/folders', adminAuth, requirePermission('photos.view'), requireEventOwnership, async (req, res) => {
  try {
    const eventId = eventIdOf(req);
    const [folders, open, canManage] = await Promise.all([
      tree.folderTree(eventId),
      requests.listRequests(eventId),
      canManageFolders(req),
    ]);
    res.json({ folders, requests: open, can_manage: canManage, max_depth: tree.MAX_FOLDER_DEPTH });
  } catch (err) {
    errorResponse(res, err, 500, 'Failed to load folders');
  }
});

router.post('/events/:eventId/folders', adminAuth, requirePermission('folders.manage'), requireEventOwnership, [
  body('name').isString().isLength({ min: 1, max: 100 }),
  body('parent_id').optional({ nullable: true }).isInt({ min: 1 }),
], async (req, res) => {
  if (invalid(req, res)) return;
  try {
    const eventId = eventIdOf(req);
    const id = await tree.createFolder(eventId, { name: req.body.name, parentId: req.body.parent_id ?? null });
    await logActivity('folder_created', { name: req.body.name }, eventId, actorOf(req));
    capabilityEvidence(res, 'gallery_folders');
    res.status(201).json({ id, folders: await tree.folderTree(eventId) });
  } catch (err) {
    sendFolderError(res, err, 'Failed to create folder');
  }
});

router.patch('/events/:eventId/folders/:folderId', adminAuth, requirePermission('folders.manage'), requireEventOwnership, [
  body('name').optional().isString().isLength({ min: 1, max: 100 }),
  // null = move to the gallery root; anything else must be a real id ("" or
  // true would otherwise coerce to 0/1).
  body('parent_id').optional({ nullable: true }).custom((v) => v === null || (typeof v !== 'boolean' && v !== '' && Number.isInteger(Number(v)) && Number(v) > 0)),
  body('allow_downloads').optional().isBoolean(),
], async (req, res) => {
  if (invalid(req, res)) return;
  try {
    const eventId = eventIdOf(req);
    const folderId = parseInt(req.params.folderId, 10);
    if (!(await tree.findEventFolder(eventId, folderId))) return res.status(404).json({ error: 'Folder not found' });
    if (req.body.name !== undefined) await tree.renameFolder(eventId, folderId, req.body.name);
    if (Object.prototype.hasOwnProperty.call(req.body, 'parent_id')) {
      const parent = req.body.parent_id === null ? null : Number(req.body.parent_id);
      await tree.moveFolder(eventId, folderId, parent);
    }
    if (req.body.allow_downloads !== undefined) {
      const { formatBoolean } = require('../utils/dbCompat');
      const { parseBooleanInput } = require('../utils/parsers');
      await db('photo_categories').where('id', folderId)
        .update({ allow_downloads: formatBoolean(parseBooleanInput(req.body.allow_downloads, true)) });
      downloadZipService.invalidate(eventId);
    }
    await logActivity('folder_updated', { folderId }, eventId, actorOf(req));
    res.json({ folders: await tree.folderTree(eventId) });
  } catch (err) {
    sendFolderError(res, err, 'Failed to update folder');
  }
});

// Delete a folder; its photos and subfolders move up to the parent.
router.delete('/events/:eventId/folders/:folderId', adminAuth, requirePermission('folders.manage'), requireEventOwnership, async (req, res) => {
  try {
    const eventId = eventIdOf(req);
    const folder = await tree.findEventFolder(eventId, req.params.folderId);
    if (!folder) return res.status(404).json({ error: 'Folder not found' });
    const moved = await tree.deleteFolder(eventId, folder.id);
    await logActivity('folder_deleted', { name: folder.name, movedPhotos: moved }, eventId, actorOf(req));
    downloadZipService.invalidate(eventId);
    res.json({ moved_photos: moved, folders: await tree.folderTree(eventId) });
  } catch (err) {
    sendFolderError(res, err, 'Failed to delete folder');
  }
});

/**
 * Resolve the directories of an upload to folders.
 *
 * Body: { paths: ["Export/Friday/Activity A", "Export", ""], skip_outer, dry_run }
 * — each file's directory relative to what was dropped or picked ("" = the
 * drop root). dry_run only reports (for the upload preview); otherwise
 * missing folders are created (folders.manage) or requested (everyone else).
 *
 * Response:
 *   results  { [inputPath]: { segments, first_look, folder_id,
 *              folder_request_id, status: root|exists|created|new|requested|needs_admin } }
 *   nodes    { ["Friday/Activity A"]: exists|new|needs_admin|created|requested }
 *            per level, for the preview tree
 *   limit    dry run only: null, or { code, limit, current, adding } when
 *            the upload would take the gallery past FOLDER_LIMITS (folders
 *            for a role that creates them, open requests for one that asks),
 *            so the dialog can say so before anything is sent
 */
/**
 * Would the planned folders or requests take the event past its cap? The
 * real resolve refuses at the cap with a 409 after creating what fit, so
 * the preview says so first. Joining an open request is free, as in
 * openRequest.
 */
async function forecastLimit(eventId, newFolders, newRequests) {
  const { MAX_FOLDERS_PER_EVENT, MAX_OPEN_REQUESTS_PER_EVENT } = tree.FOLDER_LIMITS;
  if (newFolders.size > 0) {
    const current = await tree.countEventFolders(eventId);
    if (current + newFolders.size > MAX_FOLDERS_PER_EVENT) {
      return { code: 'FOLDER_LIMIT_REACHED', limit: MAX_FOLDERS_PER_EVENT, current, adding: newFolders.size };
    }
  }
  if (newRequests.size > 0) {
    const open = await db('folder_requests').where({ event_id: eventId, status: 'pending' }).select('path');
    const openPaths = new Set(open.map((row) => row.path));
    const adding = [...newRequests].filter((path) => !openPaths.has(path)).length;
    if (adding > 0 && open.length + adding > MAX_OPEN_REQUESTS_PER_EVENT) {
      return { code: 'FOLDER_REQUEST_LIMIT_REACHED', limit: MAX_OPEN_REQUESTS_PER_EVENT, current: open.length, adding };
    }
  }
  return null;
}

router.post('/events/:eventId/folders/resolve', adminAuth, requirePermission('photos.upload'), requireEventOwnership, [
  body('paths').isArray({ max: MAX_RESOLVE_PATHS }),
  body('paths.*').isString().isLength({ max: MAX_PATH_LENGTH }),
  body('skip_outer').optional().isBoolean(),
  body('dry_run').optional().isBoolean(),
  body('keep_structure').optional().isBoolean(),
], async (req, res) => {
  if (invalid(req, res)) return;
  try {
    const eventId = eventIdOf(req);
    const dryRun = req.body.dry_run === true || req.body.dry_run === 'true';
    const keepStructure = !(req.body.keep_structure === false || req.body.keep_structure === 'false');
    const skipOuter = req.body.skip_outer === true || req.body.skip_outer === 'true';
    const canCreate = await canManageFolders(req);
    const keywords = await tree.getFirstLookKeywords();
    const inputs = [...new Set(req.body.paths)];
    const { mapped, singleRoot } = tree.mapDirectories(inputs, { keywords, skipOuter });

    const results = {};
    const nodes = {};
    const byTarget = new Map();
    let created = 0;
    const requested = [];
    // Dry run: what the real call would add, for the limit forecast.
    const newFolders = new Set();
    const newRequests = new Set();

    for (const input of inputs) {
      const m = mapped[input] || { segments: null, firstLook: false };
      if (m.segments === null) {
        results[input] = { segments: null, first_look: false, folder_id: null, status: 'skipped' };
        continue;
      }
      const segments = keepStructure ? m.segments : [];
      const key = tree.pathKey(segments);
      if (!byTarget.has(key)) {
        let entry;
        if (segments.length === 0) {
          entry = { folder_id: null, status: 'root' };
        } else {
          const r = await tree.ensurePath(eventId, segments, { canCreate, dryRun });
          if (r.missingFrom === -1) {
            entry = { folder_id: r.folderId, status: r.created.length ? 'created' : 'exists' };
            created += r.created.length;
          } else if (dryRun) {
            entry = { folder_id: r.folderId, status: canCreate ? 'new' : 'needs_admin' };
            if (canCreate) {
              // Lower-cased: ensurePath matches a sibling case-insensitively,
              // so "Foo/A" and "foo/B" create one "Foo", not two.
              for (let i = r.missingFrom + 1; i <= segments.length; i += 1) newFolders.add(tree.pathKey(segments.slice(0, i)).toLowerCase());
            } else {
              newRequests.add(key);
            }
          } else {
            const requestId = await requests.openRequest(eventId, segments, r.folderId, req.admin.id);
            requested.push(key);
            entry = { folder_id: r.folderId, folder_request_id: requestId, status: 'requested' };
          }
          for (let i = 1; i <= segments.length; i += 1) {
            const prefix = tree.pathKey(segments.slice(0, i));
            const missingFrom = r.missingFrom;
            let node;
            if (missingFrom === -1 || i - 1 < missingFrom) node = (r.created.length && i > segments.length - r.created.length) ? 'created' : 'exists';
            else if (dryRun) node = canCreate ? 'new' : 'needs_admin';
            else node = 'requested';
            nodes[prefix] = node;
          }
        }
        byTarget.set(key, entry);
      }
      results[input] = { segments, first_look: m.firstLook, ...byTarget.get(key) };
    }

    if (!dryRun) {
      if (created > 0) {
        await logActivity('folders_created', { count: created }, eventId, actorOf(req));
        capabilityEvidence(res, 'gallery_folders');
      }
      if (requested.length > 0) {
        const event = await db('events').where('id', eventId).first('event_name');
        await logActivity('folder_requested', { count: requested.length, paths: requested.slice(0, 10), eventName: event?.event_name }, eventId, actorOf(req));
      }
    }

    const limit = dryRun ? await forecastLimit(eventId, newFolders, newRequests) : null;
    res.json({ can_manage: canCreate, single_root: singleRoot, max_depth: tree.MAX_FOLDER_DEPTH, results, nodes, limit });
  } catch (err) {
    sendFolderError(res, err, 'Failed to resolve folders');
  }
});

// Mirror an external folder's existing structure onto photos not in a folder
// yet (an event that switched folder structure on after its first import).
router.post('/events/:eventId/folders/apply-external-structure', adminAuth, requirePermission(['folders.manage', 'photos.upload'], { requireAll: true }), requireEventOwnership, async (req, res) => {
  try {
    const eventId = eventIdOf(req);
    const event = await db('events').where('id', eventId).first();
    if (!event || event.source_mode !== 'reference' || !event.external_path) {
      return res.status(400).json({ error: 'This event does not use an external folder' });
    }
    const { externalPlacement } = require('../services/externalImportService');
    const keywords = await tree.getFirstLookKeywords();
    const base = String(event.external_path).replace(/^\/+|\/+$/g, '');
    const rows = await db('photos')
      .where({ event_id: eventId, source_origin: 'external' })
      .whereNull('folder_id')
      .whereNotNull('external_relpath')
      .select('id', 'external_relpath');
    const map = { individual: 'individual', collages: 'collages' };
    const cache = new Map();
    let moved = 0;
    let limited = false;
    for (const row of rows) {
      const rel = String(row.external_relpath);
      if (base && !rel.startsWith(`${base}/`)) continue;
      const where = externalPlacement(base ? rel.slice(base.length + 1) : rel, { map, keywords, mirror: true });
      if (!where.segments.length) continue;
      const key = tree.pathKey(where.segments);
      // At the folder cap the photos go into the closest existing folder,
      // as external import does, instead of stopping halfway with a 409.
      if (!cache.has(key)) {
        const placed = await tree.ensurePath(eventId, where.segments, { canCreate: true, foldAtLimit: true });
        if (placed.limited) limited = true;
        cache.set(key, placed.folderId);
      }
      moved += await db('photos').where('id', row.id).whereNull('folder_id').update({ folder_id: cache.get(key) });
    }
    if (moved > 0) {
      await logActivity('folder_structure_applied', { moved, folders: cache.size }, eventId, actorOf(req));
      downloadZipService.invalidate(eventId);
    }
    // `limited`: some photos went into a parent folder because the gallery
    // reached its folder limit; the UI says so.
    res.json({ moved, limited, folders: await tree.folderTree(eventId) });
  } catch (err) {
    sendFolderError(res, err, 'Failed to apply the folder structure');
  }
});

router.get('/events/:eventId/folder-requests', adminAuth, requirePermission('photos.view'), requireEventOwnership, async (req, res) => {
  try {
    res.json({ requests: await requests.listRequests(eventIdOf(req)) });
  } catch (err) {
    errorResponse(res, err, 500, 'Failed to load folder requests');
  }
});

router.post('/events/:eventId/folder-requests/:requestId/approve', adminAuth, requirePermission('folders.manage'), requireEventOwnership, [
  body('target_folder_id').optional({ nullable: true }).isInt({ min: 1 }),
], async (req, res) => {
  if (invalid(req, res)) return;
  try {
    const eventId = eventIdOf(req);
    const result = await requests.approveRequest(eventId, req.params.requestId, req.admin.id, {
      targetFolderId: req.body.target_folder_id ?? null,
    });
    await logActivity('folder_request_approved', { path: result.path, moved: result.moved }, eventId, actorOf(req));
    downloadZipService.invalidate(eventId);
    res.json({ ...result, folders: await tree.folderTree(eventId), requests: await requests.listRequests(eventId) });
  } catch (err) {
    sendFolderError(res, err, 'Failed to approve the folder request');
  }
});

router.post('/events/:eventId/folder-requests/:requestId/reject', adminAuth, requirePermission('folders.manage'), requireEventOwnership, async (req, res) => {
  try {
    const eventId = eventIdOf(req);
    const result = await requests.rejectRequest(eventId, req.params.requestId, req.admin.id);
    await logActivity('folder_request_rejected', { path: result.path }, eventId, actorOf(req));
    res.json({ ...result, requests: await requests.listRequests(eventId) });
  } catch (err) {
    sendFolderError(res, err, 'Failed to reject the folder request');
  }
});

module.exports = router;
