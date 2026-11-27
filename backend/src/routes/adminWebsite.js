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
const { scopeEventsQuery, canAccessEvent } = require('../middleware/ownership');
const { handleAsync, validateRequest } = require('../utils/routeHelpers');
const { getStoragePath } = require('../config/storage');
const { adminThumbnailUrl, ADMIN_THUMBNAIL_COLUMNS } = require('../utils/adminThumbnailUrl');
const { AppError } = require('../utils/errors');
const { formatBoolean } = require('../utils/dbCompat');
const { parseBooleanInput } = require('../utils/parsers');
const { escapeLikePattern, likeWithEscape, unicodeSearchForms } = require('../utils/sqlSecurity');
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
  res.json(await websiteService.saveDraft(req.body.document, req.body.revision, req.admin));
}));

router.post('/publish', canEdit, [
  // The revision the editor last saved: publish exactly that, or 409.
  body('revision').isInt({ min: 0 }),
], handleAsync(async (req, res) => {
  validateRequest(req);
  res.json(await websiteService.publish(req.body.revision, req.admin.id));
}));

// The editor's preview of an unsaved document: rendered per request, never
// cached, never served on the public site.
router.post('/preview', canView, [
  body('document').isObject(),
  body('pageId').optional().isString().isLength({ max: 40 }),
  // The editor runs on another origin than the media (split origin): its
  // frame may not load a video from there, so the hero shows its poster.
  body('videoAsPoster').optional().isBoolean(),
], handleAsync(async (req, res) => {
  validateRequest(req);
  res.set('Cache-Control', 'no-store');
  res.json({ html: await websiteService.renderPreview(req.body.document, req.body.pageId, req.admin, {
    videoAsPoster: parseBooleanInput(req.body.videoAsPoster, false),
  }) });
}));

// URLs for the editor's thumbnails of picked images; null where the image
// would not appear on the public site (its gallery left the website) or is
// from a gallery the admin may not pick from.
router.post('/media/resolve', canView, [
  body('refs').isArray({ max: 500 }),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const refs = req.body.refs.filter((r) => r && typeof r === 'object');
  const photoIds = refs.filter((r) => r.source === 'photo').map((r) => Number(r.id)).filter(Number.isInteger);
  const assetIds = refs.filter((r) => r.source === 'asset' && typeof r.id === 'string').map((r) => r.id);
  const allowed = await websiteService.referencesAdminMay(req.admin, { photoIds });
  const [photos, assetRows] = await Promise.all([
    media.loadEligiblePhotos(photoIds.filter((id) => allowed.photoIds.has(id))),
    media.loadAssets(assetIds),
  ]);
  const urls = {};
  for (const id of photoIds) {
    urls[`photo:${id}`] = photos.has(id) ? `${media.mediaBase({ source: 'photo', id }, media.photoVersion(photos.get(id)))}/640` : null;
  }
  for (const id of assetIds) {
    const row = assetRows.get(id);
    urls[`asset:${id}`] = row ? assets.publicAsset(row).previewUrl || assets.publicAsset(row).videoUrl : null;
  }
  res.json({ urls });
}));

// Galleries the admin may act on (owner, assigned, or a role that manages
// every gallery: the rule of the admin photo routes), with their website
// opt-in and, when opted in but excluded, why (expired, ...). Paged and
// searchable by name, newest first; `onWebsite=1` lists only opted-in ones
// (the featured-galleries selector), `ids` fetches chosen ones by id.
router.get('/galleries', canView, [
  query('q').optional().isString().isLength({ max: 200 }),
  query('page').optional().isInt({ min: 1, max: 100000 }),
  query('pageSize').optional().isInt({ min: 1, max: 100 }),
  query('onWebsite').optional().isIn(['0', '1']),
  query('ids').optional().matches(/^\d+(,\d+){0,99}$/),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const pageSize = Number(req.query.pageSize) || 50;
  const page = Number(req.query.page) || 1;
  let rows = scopeEventsQuery(db('events'), req.admin, 'events.created_by')
    .where((q) => q.where('is_archived', formatBoolean(false)).orWhereNull('is_archived'));
  if (req.query.ids) rows = rows.whereIn('id', req.query.ids.split(',').map(Number));
  if (req.query.onWebsite === '1') rows = rows.where('show_on_website', formatBoolean(true));
  const term = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (term) {
    // Every stored spelling of the name, as the gallery list searches.
    rows = rows.where((b) => {
      for (const form of unicodeSearchForms(term)) b.orWhereRaw(likeWithEscape('event_name'), [`%${escapeLikePattern(form)}%`]);
    });
  }
  const found = await rows.orderBy('event_date', 'desc').orderBy('id', 'desc')
    .limit(pageSize + 1).offset((page - 1) * pageSize);
  const now = new Date();
  res.json({
    galleries: found.slice(0, pageSize).map((e) => ({
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
      canChange: canAccessEvent(req.admin, e),
    })),
    hasMore: found.length > pageSize,
  });
}));

// The per-gallery opt-in, under the rules of the gallery's own settings
// (events.edit on a gallery the admin may act on), plus cms.edit.
router.put('/galleries/:id', canEdit, requirePermission('events.edit'), [
  param('id').isInt({ min: 1 }),
  body('showOnWebsite').isBoolean(),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const event = await db('events').where({ id: Number(req.params.id) }).first();
  if (!event || !canAccessEvent(req.admin, event)) throw new AppError('Gallery not found', 404, 'EVENT_NOT_FOUND');
  // isBoolean() lets "false" and "0" through; Boolean() would make them true.
  const showOnWebsite = parseBooleanInput(req.body.showOnWebsite, false);
  await websiteService.setGalleryOnWebsite(event.id, showOnWebsite);
  res.json({ id: event.id, showOnWebsite });
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

// Uploads, newest first, paged and searchable by file name.
router.get('/assets', canView, [
  query('q').optional().isString().isLength({ max: 200 }),
  query('page').optional().isInt({ min: 1, max: 100000 }),
  query('pageSize').optional().isInt({ min: 1, max: 100 }),
  query('kind').optional().isIn(['image', 'video']),
], handleAsync(async (req, res) => {
  validateRequest(req);
  res.json(await assets.listAssets({
    q: typeof req.query.q === 'string' ? req.query.q.trim() : '',
    page: Number(req.query.page) || 1,
    pageSize: Number(req.query.pageSize) || 60,
    kind: req.query.kind || null,
  }));
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
    // A package a quote could not be made from is listed with why; the page
    // leaves it out.
    packages: packages.map((p) => ({
      id: p.id, name: p.name, description: p.description || '', currency: p.currency,
      unavailable: websiteService.packageOffer(p).unavailable,
    })),
  });
}));

module.exports = router;
