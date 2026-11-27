/**
 * Website builder admin API (issue 2618), mounted at /api/admin/website.
 *
 * Every route needs an admin, the `websiteBuilder` flag, and the CMS
 * permissions that already guard the legal pages: cms.view to read and
 * preview, cms.edit to change the draft, publish and upload. Opting a gallery
 * into the website additionally needs events.edit and the gallery's owner.
 */
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const multer = require('multer');
const { body, param, query } = require('express-validator');
const { db } = require('../database/db');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { requireFeatureFlag, isFeatureEnabled } = require('../middleware/requireFeatureFlag');
const { ownsEvent, scopeEventsListQuery, canAccessEvent } = require('../middleware/ownership');
const { handleAsync, validateRequest } = require('../utils/routeHelpers');
const { getStoragePath } = require('../config/storage');
const { adminThumbnailUrl, ADMIN_THUMBNAIL_COLUMNS } = require('../utils/adminThumbnailUrl');
const { AppError } = require('../utils/errors');
const { formatBoolean } = require('../utils/dbCompat');
const websiteService = require('../services/website/service');
const assets = require('../services/website/assets');
const media = require('../services/website/media');
const { requiresGalleryPassword } = require('../utils/galleryLifecycle');

const router = express.Router();

router.use(adminAuth);
router.use(requireFeatureFlag('websiteBuilder', 'WEBSITE_BUILDER_DISABLED'));

const canView = requirePermission('cms.view');
const canEdit = requirePermission('cms.edit');

// The editor's state: the draft (created on first open, importing the
// single-page site) and when it was last published.
router.get('/', canView, handleAsync(async (req, res) => {
  res.json(await websiteService.getEditorState(req.admin.id));
}));

router.put('/draft', canEdit, [
  body('document').isObject(),
  body('revision').optional({ nullable: true }).isInt({ min: 0 }),
], handleAsync(async (req, res) => {
  validateRequest(req);
  res.json(await websiteService.saveDraft(req.body.document, req.body.revision, req.admin.id));
}));

router.post('/publish', canEdit, [
  body('revision').optional({ nullable: true }).isInt({ min: 0 }),
], handleAsync(async (req, res) => {
  validateRequest(req);
  res.json(await websiteService.publish(req.body.revision, req.admin.id));
}));

router.post('/discard', canEdit, handleAsync(async (req, res) => {
  res.json(await websiteService.discardDraft(req.admin.id));
}));

// The editor's preview of an unsaved document: rendered per request, never
// cached, never served on the public site.
router.post('/preview', canView, [
  body('document').isObject(),
  body('pageId').optional().isString().isLength({ max: 40 }),
], handleAsync(async (req, res) => {
  validateRequest(req);
  res.set('Cache-Control', 'no-store');
  res.json({ html: await websiteService.renderPreview(req.body.document, req.body.pageId) });
}));

// URLs for the editor's thumbnails of picked images; null where the image
// would not appear on the public site (its gallery left the website).
router.post('/media/resolve', canView, [
  body('refs').isArray({ max: 500 }),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const refs = req.body.refs.filter((r) => r && typeof r === 'object');
  const photoIds = refs.filter((r) => r.source === 'photo').map((r) => Number(r.id)).filter(Number.isInteger);
  const assetIds = refs.filter((r) => r.source === 'asset' && typeof r.id === 'string').map((r) => r.id);
  const [photos, assetRows] = await Promise.all([media.loadEligiblePhotos(photoIds), media.loadAssets(assetIds)]);
  const urls = {};
  for (const id of photoIds) urls[`photo:${id}`] = photos.has(id) ? `${media.mediaBase({ source: 'photo', id })}/640` : null;
  for (const id of assetIds) {
    const row = assetRows.get(id);
    urls[`asset:${id}`] = row ? assets.publicAsset(row).previewUrl || assets.publicAsset(row).videoUrl : null;
  }
  res.json({ urls });
}));

// Galleries the admin can see, with their website opt-in and, when opted in
// but excluded, why (password, expired, ...).
router.get('/galleries', canView, handleAsync(async (req, res) => {
  const rows = await scopeEventsListQuery(db('events'), req.admin, 'events.created_by')
    .where((q) => q.where('is_archived', formatBoolean(false)).orWhereNull('is_archived'))
    .orderBy('event_date', 'desc').orderBy('id', 'desc').limit(300);
  const now = new Date();
  res.json({
    galleries: rows.map((e) => ({
      id: e.id,
      name: e.event_name,
      slug: e.slug,
      date: e.event_date,
      showOnWebsite: e.show_on_website === true || e.show_on_website === 1,
      // The picker says that opting in publishes the picked photos although
      // the gallery has a password.
      hasPassword: requiresGalleryPassword(e),
      eligible: media.isEventWebsiteEligible(e, now),
      reason: media.eventIneligibleReason(e, now),
      canChange: ownsEvent(req.admin, e),
    })),
  });
}));

// The per-gallery opt-in. Owner-only: making a gallery's photos public is
// the owner's call, like its password.
router.put('/galleries/:id', canEdit, requirePermission('events.edit'), [
  param('id').isInt({ min: 1 }),
  body('showOnWebsite').isBoolean(),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const event = await db('events').where({ id: Number(req.params.id) }).first();
  if (!event || !canAccessEvent(req.admin, event)) throw new AppError('Gallery not found', 404, 'EVENT_NOT_FOUND');
  if (!ownsEvent(req.admin, event)) throw new AppError('Only the gallery owner can change this', 403, 'FORBIDDEN');
  await websiteService.setGalleryOnWebsite(event.id, req.body.showOnWebsite);
  res.json({ id: event.id, showOnWebsite: Boolean(req.body.showOnWebsite) });
}));

// Photos of an eligible gallery, for the image picker. Admin thumbnails for
// the picker itself; the public URL is only ever built by the renderer.
router.get('/galleries/:id/photos', canView, [
  param('id').isInt({ min: 1 }),
  query('page').optional().isInt({ min: 1, max: 10000 }),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const event = await db('events').where({ id: Number(req.params.id) }).first();
  if (!event || !canAccessEvent(req.admin, event)) throw new AppError('Gallery not found', 404, 'EVENT_NOT_FOUND');
  if (!media.isEventWebsiteEligible(event)) {
    throw new AppError('This gallery is not on the website', 409, 'WEBSITE_GALLERY_NOT_ELIGIBLE');
  }
  const pageSize = 60;
  const page = Number(req.query.page) || 1;
  const rows = await media.guestPhotoQuery().where('photos.event_id', event.id)
    .orderBy('photos.id', 'asc').limit(pageSize + 1).offset((page - 1) * pageSize)
    .select('photos.id', 'photos.width', 'photos.height', 'photos.original_filename', ...ADMIN_THUMBNAIL_COLUMNS);
  res.json({
    photos: rows.slice(0, pageSize).map((p) => ({
      id: p.id,
      width: p.width,
      height: p.height,
      filename: p.original_filename,
      thumbnailUrl: adminThumbnailUrl(event.id, p),
    })),
    hasMore: rows.length > pageSize,
  });
}));

router.get('/assets', canView, handleAsync(async (req, res) => {
  res.json({ assets: await assets.listAssets() });
}));

// The temp directory is made on the first upload, not when the module loads:
// importing the server must not touch the storage volume.
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const dir = path.join(getStoragePath(), 'temp');
      fs.mkdir(dir, { recursive: true }).then(() => cb(null, dir), cb);
    },
  }),
  // Single unnamed `file` field; no bracket-indexed field names (as adminCMS).
  limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 2, fieldArrayIndexLimit: 0 },
});

router.post('/assets', canEdit, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message, code: 'WEBSITE_UPLOAD_FAILED' });
    return next();
  });
}, handleAsync(async (req, res) => {
  const file = req.file;
  if (!file) throw new AppError('No file uploaded', 400, 'WEBSITE_UPLOAD_FAILED');
  try {
    const isVideo = /^video\//i.test(file.mimetype || '') || /\.mp4$/i.test(file.originalname || '');
    if (!isVideo && file.size > 30 * 1024 * 1024) throw new AppError('An image can be at most 30 MB', 400, 'WEBSITE_ASSET_TOO_LARGE');
    const asset = isVideo
      ? await assets.createVideoAsset(file, req.admin.id)
      : await assets.createImageAsset(file, req.admin.id);
    res.status(201).json({ asset });
  } finally {
    await fs.unlink(file.path).catch(() => {});
  }
}));

router.delete('/assets/:id', canEdit, [
  param('id').matches(/^[0-9a-f]{24}$/),
], handleAsync(async (req, res) => {
  validateRequest(req);
  await assets.deleteAsset(req.params.id);
  res.status(204).end();
}));

// The CRM catalogue's packages, read-only, for the pricing block. Empty while
// quotes are off: the catalogue belongs to that feature.
router.get('/packages', canView, handleAsync(async (req, res) => {
  if (!(await isFeatureEnabled('quotes'))) return res.json({ available: false, packages: [] });
  const { listPackages } = require('../services/quoteCatalogService');
  const packages = await listPackages({ activeOnly: true });
  return res.json({
    available: true,
    packages: packages.map((p) => ({ id: p.id, name: p.name, description: p.description || '', currency: p.currency })),
  });
}));

module.exports = router;
