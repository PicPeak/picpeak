/**
 * Public v1 API — events + photo upload + share link.
 *
 * Surface chosen for the n8n / automation use case (#322): create gallery,
 * upload photos, get a share URL. Intentionally narrow — update/delete
 * are admin-only via the UI for v1. Mounts under /api/v1 with apiTokenAuth.
 *
 * Each route is annotated with @openapi JSDoc that swagger-jsdoc picks
 * up to generate docs/openapi.yaml (gitignored), which is then synced
 * into the picpeak-docs site at docs.picpeak.app.
 */

const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const { body, query, validationResult } = require('express-validator');
const { safeValidationErrors } = require('../../utils/routeHelpers');
const { db, logActivity } = require('../../database/db');
const { apiTokenAuth, requireApiScope } = require('../../middleware/apiTokenAuth');
const { requireEventOwnership, scopeEventsQuery } = require('../../middleware/ownership');
// GHSA-9697: migration 081 defines a token's effective permissions as the
// INTERSECTION of the owner's role permissions and the token's scope flags.
// requireApiScope only ever checked the scope half — so a token minted while
// its owner was super_admin kept full write access after the owner was demoted
// to viewer (userManagementService never touches api_tokens). These
// requirePermission gates supply the missing half; they key on req.admin.id,
// which apiTokenAuth populates.
const { requirePermission } = require('../../middleware/permissions');

const { buildShareLinkVariants } = require('../../services/shareLinkService');
const {
  generateThumbnail,
  ensurePreviewImage,
  ensurePreviewImageAtWidth,
  normalizeTierWidth,
  PREVIEW_WIDTHS,
  RESIZE_PRESERVES_FORMAT
} = require('../../services/imageProcessor');
const logger = require('../../utils/logger');

const { formatBoolean } = require('../../utils/dbCompat');

const { isValidEventType } = require('../../services/eventTypeService');
const { replacePhoto } = require('../../services/photoReplacementService');
const { getMaxFileSizeBytes, DEFAULT_MAX_FILE_SIZE_MB } = require('../../services/uploadSettings');
const downloadZipService = require('../../services/downloadZipService');
const { PhotoFilterBuilder } = require('../../utils/photoFilterBuilder');
const { PhotoExportService } = require('../../services/photoExportService');
const { mergeMarks } = require('../../services/markMerge');
const feedbackService = require('../../services/feedbackService');
const archiver = require('archiver');
const { Readable } = require('stream');
const { getStorage } = require('../../services/storage');
const { resolvePhotoStorageKey, resolvePhotoFilePath } = require('../../services/photoResolver');
const { pickRawDownloadName } = require('../../services/downloadFilenameService');
const { buildContentDisposition, sanitizeForZipEntry } = require('../../utils/filenameSanitizer');
const { resolvePhotoContentType } = require('../../utils/photoContentType');
const { pipeStreamToResponse } = require('../../utils/streamResponse');
const { createArchiveStreamGuard } = require('../../utils/archiveStreamGuard');
const { recordSingleDownload } = require('../../services/apiDownloadNotifications');
const { parseResolution } = require('../../utils/downloadResolutions');
const { renderPhotoForDownload, isVideo } = require('../../services/downloadRendition');

const router = express.Router();

// Reused for its getPhotosWithFeedback() enrichment (colour tallies + the
// caller's own marks); the v1 surface exposes no export formats.
const photoExportService = new PhotoExportService();

const getStoragePath = () => process.env.STORAGE_PATH || path.join(__dirname, '../../../../storage');

// ──────────────────────────────────────────────────────────────────────────
// Multer for single-photo upload. Lean — no replace-by-name, no batching.
// ──────────────────────────────────────────────────────────────────────────
const photoStorage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    const tempDir = path.join(getStoragePath(), 'temp');
    await fs.mkdir(tempDir, { recursive: true });
    cb(null, tempDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `v1_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`);
  }
});
const buildPhotoUpload = (maxFileSizeBytes) => multer({
  storage: photoStorage,
  // CVE-2026-82333: single unnamed `photo` field only — no legitimate
  // array-indexed field names, so reject any bracket-index field name.
  limits: { fileSize: maxFileSizeBytes, fieldArrayIndexLimit: 0 },
  fileFilter: (_req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image uploads are accepted on this endpoint'));
  }
}).single('photo');

// The per-file cap was hardcoded to 100MB here, so general_max_file_size_mb
// (Settings → General) didn't apply to the v1 upload either. Resolve it per
// request — the admin can change it at runtime — and turn multer's generic
// "File too large" into a 400 that names the configured limit.
const photoUpload = async (req, res, next) => {
  let maxFileSizeBytes;
  try {
    maxFileSizeBytes = await getMaxFileSizeBytes();
  } catch {
    maxFileSizeBytes = DEFAULT_MAX_FILE_SIZE_MB * 1024 * 1024;
  }
  buildPhotoUpload(maxFileSizeBytes)(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      const limitMb = Math.floor(maxFileSizeBytes / (1024 * 1024));
      return res.status(400).json({ error: `File too large. Maximum size is ${limitMb} MB per file.` });
    }
    next(err);
  });
};

// slugify now imported from ../../utils/slug — shared with adminEvents
// and events.js so the diacritic fix from #502 lands here too (#525).

// ──────────────────────────────────────────────────────────────────────────
// POST /events — create event
// ──────────────────────────────────────────────────────────────────────────

/**
 * @openapi
 * /events:
 *   post:
 *     tags: [Events]
 *     summary: Create a gallery event
 *     description: Returns the new event's id, slug, and absolute share URL.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [event_name, event_type]
 *             properties:
 *               event_name: { type: string }
 *               event_type:
 *                 type: string
 *                 description: "Slug of an active event type from the catalog (Settings → Event Types). Defaults on a fresh install: wedding, birthday, corporate, other. GET /api/v1/event-types lists the live values."
 *               event_date: { type: string, format: date, nullable: true }
 *               customer_name: { type: string, nullable: true }
 *               customer_email: { type: string, format: email, nullable: true }
 *               customer_phone: { type: string, nullable: true, description: "Only persisted when the global phone-field setting is enabled." }
 *               admin_email: { type: string, format: email, nullable: true }
 *               require_password: { type: boolean, nullable: true, description: "When omitted, falls back to the global event_default_require_password setting." }
 *               password: { type: string, nullable: true, description: "Required when require_password resolves to true." }
 *               expires_at: { type: string, format: date-time, nullable: true }
 *               color_theme: { type: string, nullable: true, description: "Preset name (e.g. 'default') or JSON-encoded ThemeConfig. Persisted as-is on the event row." }
 *               feedback_enabled: { type: boolean, nullable: true, description: "Enable guest feedback for this gallery. When omitted, falls back to the global event_default_feedback_enabled setting." }
 *               enable_devtools_protection: { type: boolean, nullable: true, description: "Block right-click / devtools shortcuts in the gallery. When omitted, falls back to the global enable_devtools_protection setting." }
 *               protection_level: { type: string, nullable: true, enum: [basic, standard, enhanced, maximum], description: "Image protection level. When omitted, falls back to the global default_protection_level setting." }
 *               use_canvas_rendering: { type: boolean, nullable: true, description: "Render gallery images to a canvas instead of an img tag. When omitted, falls back to the global enable_canvas_rendering setting." }
 *               image_quality: { type: integer, minimum: 1, maximum: 100, nullable: true, description: "Served image quality percentage. When omitted, falls back to the global default_image_quality setting." }
 *               hero_logo_visible: { type: boolean, nullable: true, description: "Show event logo in the hero block. When omitted, falls back to the global branding_logo_display_hero setting." }
 *               hero_logo_size: { type: string, nullable: true, enum: [small, medium, large, xlarge], description: "Hero logo size. When omitted, falls back to the global branding_logo_size setting." }
 *               hero_logo_position: { type: string, nullable: true, enum: [top, center, bottom], description: "Hero logo position. Defaults to 'top' (not settings-backed — see migration 084)." }
 *               download_limit: { type: integer, minimum: 1, nullable: true, description: "Maximum number of distinct photos the gallery may download. null = unlimited. When omitted, falls back to the global event_default_download_limit setting." }
 *     responses:
 *       201:
 *         description: Event created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: integer }
 *                 slug: { type: string }
 *                 share_url: { type: string, format: uri }
 *                 share_token: { type: string }
 *       400: { description: Validation error }
 *       401: { description: Missing/invalid token }
 *       403: { description: Token lacks admin scope }
 */
router.post(
  '/events',
  apiTokenAuth,
  requireApiScope('admin'),
  requirePermission('events.create'),
  [
    body('event_name').isString().trim().notEmpty(),
    // Validate against the live event_types catalog (admins can rename/delete
    // the defaults and add custom types), not a hardcoded whitelist (#800).
    body('event_type').isString().trim().notEmpty().bail().custom(async (value) => {
      if (!(await isValidEventType(value))) {
        throw new Error('Unknown event type — must match an active event type slug');
      }
      return true;
    }),
    body('event_date').optional({ nullable: true, checkFalsy: true }).isISO8601(),
    body('customer_name').optional({ nullable: true }).isString(),
    body('customer_email').optional({ nullable: true, checkFalsy: true }).isEmail(),
    body('customer_phone').optional({ nullable: true, checkFalsy: true }).isString().isLength({ max: 32 }),
    body('admin_email').optional({ nullable: true, checkFalsy: true }).isEmail(),
    body('require_password').optional().isBoolean(),
    body('password').optional({ nullable: true }).isString().isLength({ min: 6 }),
    body('expires_at').optional({ nullable: true, checkFalsy: true }).isISO8601(),
    body('color_theme').optional({ nullable: true }).isString().trim(),
    body('feedback_enabled').optional().isBoolean(),
    body('enable_devtools_protection').optional().isBoolean(),
    body('protection_level').optional().not().isArray().isIn(['basic', 'standard', 'enhanced', 'maximum']),
    body('use_canvas_rendering').optional().not().isArray().isBoolean().toBoolean(),
    body('image_quality').optional().not().isArray().isInt({ min: 1, max: 100 }).toInt(),
    body('hero_logo_visible').optional().isBoolean(),
    body('hero_logo_size').optional().isIn(['small', 'medium', 'large', 'xlarge']),
    body('hero_logo_position').optional().isIn(['top', 'center', 'bottom']),
    body('download_limit').optional({ nullable: true }).not().isArray().isInt({ min: 1, max: 2147483647 }).toInt()
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: safeValidationErrors(errors) });
      const created = await require('../../services/eventCreationService').createEvent(req.body, {
        actor: req.admin, source: 'v1',
      });
      res.status(201).json({ id: created.id, slug: created.slug, share_url: created.share_link, share_token: created.share_token });
    } catch (error) {
      if (error.isOperational) return res.status(error.statusCode).json(error.responseBody || { error: error.message, code: error.code });
      logger.error('v1 POST /events failed', { error: error.message, stack: error.stack });
      res.status(500).json({ error: 'Failed to create event', detail: error.message });
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────
// GET /events — list
// ──────────────────────────────────────────────────────────────────────────

/**
 * @openapi
 * /events:
 *   get:
 *     tags: [Events]
 *     summary: List gallery events (paginated)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 25 }
 *     responses:
 *       200:
 *         description: Paginated list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 events:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/EventSummary' }
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     page: { type: integer }
 *                     limit: { type: integer }
 *                     total: { type: integer }
 */
router.get(
  '/events',
  apiTokenAuth,
  requireApiScope('read'),
  requirePermission('events.view'),
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt()
  ],
  async (req, res) => {
    try {
      const page = req.query.page || 1;
      const limit = req.query.limit || 25;
      const offset = (page - 1) * limit;

      // Scope to events the token owner may see (GHSA-9697). Previously this
      // listed every event on the instance regardless of who owned the token.
      const [events, totalRow] = await Promise.all([
        scopeEventsQuery(
          db('events')
            .select('id', 'slug', 'event_name', 'event_type', 'event_date', 'expires_at',
              'is_active', 'is_archived', 'is_draft', 'created_at'),
          req.admin
        )
          .orderBy('created_at', 'desc')
          .limit(limit)
          .offset(offset),
        scopeEventsQuery(db('events').count('id as count'), req.admin).first()
      ]);
      const total = parseInt(totalRow?.count || 0, 10);
      res.json({ events, pagination: { page, limit, total } });
    } catch (error) {
      logger.error('v1 GET /events failed', { error: error.message });
      res.status(500).json({ error: 'Failed to list events' });
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────
// GET /event-types — read (catalog discovery for event creation, #800)
// ──────────────────────────────────────────────────────────────────────────

/**
 * @openapi
 * /event-types:
 *   get:
 *     tags: [Events]
 *     summary: List active event types
 *     description: The slugs accepted as `event_type` when creating events. The catalog is admin-customizable (Settings → Event Types), so integrations should discover values here instead of hardcoding them.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Active event types
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 eventTypes:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       slug_prefix: { type: string }
 *                       name: { type: string }
 *                       emoji: { type: string }
 */
router.get('/event-types', apiTokenAuth, requireApiScope('read'), requirePermission('events.view'), async (req, res) => {
  try {
    const types = await db('event_types')
      .where('is_active', formatBoolean(true))
      .orderBy('display_order', 'asc')
      .select('slug_prefix', 'name', 'emoji');
    res.json({ eventTypes: types });
  } catch (error) {
    logger.error('v1 GET /event-types failed', { error: error.message });
    res.status(500).json({ error: 'Failed to list event types' });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// GET /events/:id — read
// ──────────────────────────────────────────────────────────────────────────

/**
 * @openapi
 * /events/{id}:
 *   get:
 *     tags: [Events]
 *     summary: Get a single event
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Event details }
 *       404: { description: Not found }
 */
router.get('/events/:id', apiTokenAuth, requireApiScope('read'), requirePermission('events.view'), requireEventOwnership, async (req, res) => {
  try {
    const event = await db('events').where({ id: req.params.id }).first();
    if (!event) return res.status(404).json({ error: 'Event not found' });
    delete event.password_hash;
    delete event.client_password_hash;
    // #1271 — the encrypted copies are server-only as well
    delete event.password_recoverable;
    delete event.client_password_recoverable;
    res.json(event);
  } catch (error) {
    logger.error('v1 GET /events/:id failed', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch event' });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// POST /events/:id/photos — upload one photo
// ──────────────────────────────────────────────────────────────────────────

/**
 * @openapi
 * /events/{id}/photos:
 *   post:
 *     tags: [Photos]
 *     summary: Upload a single photo to an event
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [photo]
 *             properties:
 *               photo: { type: string, format: binary }
 *               category_id:
 *                 type: integer
 *                 description: |
 *                   Optional. If provided, the photo is filed under the
 *                   given photo_categories.id (must belong to the event
 *                   or be a global category). If omitted, the photo
 *                   lands uncategorized.
 *     responses:
 *       201:
 *         description: Photo uploaded
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: integer }
 *                 filename: { type: string }
 *                 path: { type: string }
 *                 thumbnail_path: { type: string, nullable: true }
 *                 size_bytes: { type: integer }
 *                 category_id: { type: integer, nullable: true }
 *       400: { description: No file or invalid type }
 *       404: { description: Event not found, or replaces_photo_id not in this event }
 */
router.post(
  '/events/:id/photos',
  apiTokenAuth,
  requireApiScope('write'),
  requirePermission('photos.upload'),
  requireEventOwnership,
  photoUpload,
  async (req, res) => {
    let tempPath = null;
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded under field "photo"' });
      tempPath = req.file.path;

      const event = await db('events').where({ id: req.params.id }).first();
      if (!event) return res.status(404).json({ error: 'Event not found' });

      // Optional category assignment, mirroring the admin upload route
      // (adminPhotos.js). Multipart form field `category_id`. If the
      // category looks up to a "collage" slug, the photo's `type` flips
      // accordingly so existing collage-aware UI paths still work.
      const rawCategoryId = req.body?.category_id;
      const parsedCategoryId = rawCategoryId ? parseInt(rawCategoryId, 10) : NaN;
      let categoryId = null;
      let photoType = 'individual';
      if (!Number.isNaN(parsedCategoryId)) {
        // Scope to categories owned by this event (event_id = event.id) or
        // marked global (is_global = true) — see migration
        // backend/migrations/legacy/004_add_categories_and_cms.js. An API
        // token inherits its owning admin's powers (no per-event scoping
        // in apiTokenAuth), so accepting any category_id would silently
        // mis-file uploads under a category belonging to a different event.
        const category = await db('photo_categories')
          .where({ id: parsedCategoryId })
          .andWhere(function () {
            this.where({ event_id: event.id }).orWhere('is_global', true);
          })
          .first();
        if (!category) {
          return res.status(400).json({
            error: `Unknown or out-of-scope category_id ${parsedCategoryId}`,
          });
        }
        categoryId = category.id;
        if (category.slug === 'collage' || category.slug === 'collages') {
          photoType = 'collage';
        }
      }

      // Replacement (#745). The Lightroom plugin stores the picpeak photo id
      // on the catalogue photo, so the id rides along even after the editor
      // renames the render — which makes the id, not the filename, the
      // reliable key for putting a finished edit back over its proof.
      //
      // Scoped to this event on purpose: a token inherits its owner's powers
      // across every event they can see, so an id from another gallery would
      // otherwise overwrite a photo the caller never named in the URL.
      const rawReplacesId = req.body?.replaces_photo_id;
      if (rawReplacesId !== undefined && rawReplacesId !== null && rawReplacesId !== '') {
        const replacesId = parseInt(rawReplacesId, 10);
        if (Number.isNaN(replacesId)) {
          // Cleanup is in this route's catch block, so an early return has to
          // drop the multer temp file itself or it leaks.
          await fs.unlink(tempPath).catch(() => {});
          tempPath = null;
          return res.status(400).json({ error: 'replaces_photo_id must be an integer' });
        }
        const target = await db('photos')
          .where({ id: replacesId, event_id: event.id })
          .first();
        if (!target) {
          await fs.unlink(tempPath).catch(() => {});
          tempPath = null;
          return res.status(404).json({
            error: `No photo ${replacesId} in event ${event.id}`,
          });
        }

        const result = await replacePhoto(target, tempPath, {
          originalFilename: req.file.originalname,
          mimeType: req.file.mimetype,
          event,
        });
        // replacePhoto unlinks the temp file on success. Unlink again anyway:
        // a FAILED replacement returns before doing so, and this route only
        // cleans up in its catch block, so the failure path would otherwise
        // strand the upload. Already-gone is not an error here.
        await fs.unlink(tempPath).catch(() => {});
        tempPath = null;
        if (!result.success) {
          return res.status(500).json({ error: `Replacement failed: ${result.error}` });
        }

        // Guests are served a cached ZIP of the whole gallery. Without this
        // they keep downloading the pre-edit photo indefinitely, which
        // defeats the point of putting the edit back. adminPhotos.js does the
        // same after its replacements.
        downloadZipService.invalidate(event.id);

        // event.id, not null: the dashboard feed excludes NULL-event rows for
        // scoped callers (GHSA-jhcf), so a system-level entry would vanish
        // from the audit trail of the photographer who owns the event.
        await logActivity('photo_replaced', {
          photoId: result.photo.id,
          originalFilename: req.file.originalname,
          previousFilename: result.previousFilename,
          eventName: event.event_name,
          via: 'v1_api',
        }, event.id, { type: 'admin', id: req.admin.id, name: req.admin.username });

        return res.status(200).json({
          replaced: true,
          photo: {
            id: result.photo.id,
            filename: result.photo.filename,
            original_filename: result.photo.original_filename,
            source_filename: result.photo.source_filename,
            previous_filename: result.previousFilename,
            size_bytes: result.photo.size_bytes,
            width: result.photo.width,
            height: result.photo.height,
          },
        });
      }

      const ext = path.extname(req.file.originalname);
      const finalName = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
      // photo.path is stored relative to events/active so resolvePhotoStorageKey
      // can rebuild the full key on read. Same shape as adminPhotos uploads.
      const relPath = path.posix.join(event.slug, finalName);
      const finalKey = path.posix.join('events/active', relPath);

      const stat = fsSync.statSync(tempPath);

      // Read sharp metadata + generate thumbnail FROM the local temp file
      // before uploading the original through the storage backend. (Same
      // ordering as adminPhotos.js so sharp/ffmpeg always have a real fs path.)
      let width = null;
      let height = null;
      try {
        const meta = await sharp(tempPath).metadata();
        // Oriented, not raw — see imageProcessor.orientedDimensions (#1185).
        ({ width, height } = require('../../services/imageProcessor').orientedDimensions(meta));
      } catch { /* non-fatal */ }

      // Credit from EXIF (#1561), read before the temp file is moved away.
      const credit = await require('../../services/photoCredit').resolveCredit({ localPath: tempPath });

      let thumbRel = null;
      try {
        thumbRel = await generateThumbnail(tempPath);
      } catch (err) {
        logger.warn('v1 thumbnail generation failed', { err: err.message });
      }

      // Upload the original via the storage backend (local fs OR S3),
      // then drop the multer temp file.
      const { getStorage } = require('../../services/storage');
      await getStorage().putFromFile(finalKey, tempPath, { contentType: req.file.mimetype });
      await fs.unlink(tempPath).catch(() => {});
      tempPath = null;

      const insertResult = await db('photos').insert({
        event_id: event.id,
        filename: finalName,
        original_filename: req.file.originalname,
        // The camera-original name, kept separate so a later replace can
        // overwrite original_filename without losing the round-trip's match
        // key (migration 193, #745).
        source_filename: req.file.originalname,
        path: relPath,
        thumbnail_path: thumbRel,
        type: photoType,
        category_id: categoryId,
        size_bytes: stat.size,
        width,
        height,
        media_type: 'image',
        mime_type: req.file.mimetype,
        uploaded_at: new Date().toISOString(),
        uploaded_by: 'admin',
        ...credit
      }).returning('id');
      const id = insertResult[0]?.id || insertResult[0];

      await logActivity('photo_uploaded', { via: 'api_v1', filename: finalName }, event.id, {
        type: 'admin', id: req.admin.id, name: req.admin.username
      });

      // Webhook (#327): one event per uploaded photo so receivers get a
      // 1:1 stream they can react to.
      try {
        const webhookService = require('../../services/webhookService');
        await webhookService.fire('photo.uploaded', {
          event: { id: event.id, slug: event.slug, event_name: event.event_name },
          photo: { id, filename: finalName, original_filename: req.file.originalname, size_bytes: stat.size, width, height },
        });
      } catch (e) { /* non-fatal */ }

      res.status(201).json({
        id,
        filename: finalName,
        path: relPath,
        thumbnail_path: thumbRel,
        size_bytes: stat.size,
        category_id: categoryId
      });
    } catch (error) {
      logger.error('v1 POST /events/:id/photos failed', { error: error.message });
      if (tempPath) await fs.unlink(tempPath).catch(() => {});
      res.status(500).json({ error: 'Failed to upload photo' });
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────
// GET /events/:id/share-link — full URL for sending to guests
// ──────────────────────────────────────────────────────────────────────────

/**
 * @openapi
 * /events/{id}/share-link:
 *   get:
 *     tags: [Events]
 *     summary: Get the absolute share URL for an event
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Share URL
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 slug: { type: string }
 *                 share_token: { type: string }
 *                 share_url: { type: string, format: uri }
 *       404: { description: Not found }
 */
router.get('/events/:id/share-link', apiTokenAuth, requireApiScope('read'), requirePermission('events.view'), requireEventOwnership, async (req, res) => {
  try {
    const event = await db('events').where({ id: req.params.id }).first();
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const { shareUrl } = await buildShareLinkVariants({ slug: event.slug, shareToken: event.share_token });
    res.json({ slug: event.slug, share_token: event.share_token, share_url: shareUrl });
  } catch (error) {
    logger.error('v1 GET /events/:id/share-link failed', { error: error.message });
    res.status(500).json({ error: 'Failed to build share link' });
  }
});

// The list filters, shared with the originals ZIP below so a caller can zip
// exactly what it just listed.
const photoFilterValidators = [
  query('marked_only').optional().isBoolean(),
  query('mark_source').optional().isIn(['client', 'mine', 'either']),
  query('color_labels').optional().isString(),
  query('my_color_labels').optional().isString(),
  query('min_rating').optional().isFloat({ min: 0, max: 5 }).toFloat(),
  query('my_min_rating').optional().isInt({ min: 1, max: 5 }).toInt(),
  query('logic').optional().isIn(['AND', 'OR'])
];

function buildPhotoFilters(req) {
  return {
    min_rating: req.query.min_rating,
    my_min_rating: req.query.my_min_rating,
    color_labels: req.query.color_labels,
    my_color_labels: req.query.my_color_labels,
    marked_only: req.query.marked_only,
    mark_source: req.query.mark_source || 'either',
    // The token's owning admin. `my_*` filters and marks are per-admin
    // (migration 183 is unique on photo_id + admin_id), so a second
    // admin's triage is deliberately invisible here.
    admin_id: req.admin.id,
    logic: req.query.logic || 'AND'
  };
}

/**
 * @openapi
 * /events/{id}/photos:
 *   get:
 *     summary: List an event's photos with their proofing marks
 *     description: >
 *       Feeds the Lightroom round-trip (#745): the plugin fetches the photos a
 *       client (or the photographer) marked while proofing, matches them to
 *       local RAW files by `source_filename`, and applies the stars and colour
 *       labels in the catalogue. Also usable for any automation that needs to
 *       know what was picked.
 *     tags: [Photos]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 50 }
 *       - in: query
 *         name: marked_only
 *         schema: { type: boolean }
 *         description: Only photos carrying a star rating or colour label from `mark_source`.
 *       - in: query
 *         name: mark_source
 *         schema: { type: string, enum: [client, mine, either], default: either }
 *         description: >
 *           Whose marks `marked_only` and the merged `label`/`rating` fields
 *           reflect. `mine` is the calling token owner's own triage.
 *       - in: query
 *         name: color_labels
 *         schema: { type: string }
 *         description: Comma-separated client colours, e.g. `green,yellow`.
 *       - in: query
 *         name: my_color_labels
 *         schema: { type: string }
 *         description: Comma-separated colours from the token owner's own marks.
 *       - in: query
 *         name: min_rating
 *         schema: { type: number, minimum: 0, maximum: 5 }
 *       - in: query
 *         name: my_min_rating
 *         schema: { type: integer, minimum: 1, maximum: 5 }
 *       - in: query
 *         name: logic
 *         schema: { type: string, enum: [AND, OR], default: AND }
 *     responses:
 *       200:
 *         description: Photos with feedback
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 photos:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: integer }
 *                       filename: { type: string }
 *                       original_filename: { type: string, nullable: true }
 *                       source_filename:
 *                         type: string
 *                         nullable: true
 *                         description: Camera-original name, preserved across replaces. Match on this.
 *                       average_rating: { type: number }
 *                       feedback_count: { type: integer }
 *                       like_count: { type: integer }
 *                       favorite_count: { type: integer }
 *                       comment_count: { type: integer }
 *                       color_labels:
 *                         type: object
 *                         description: >
 *                           Per-colour tallies across guests, keyed by colour —
 *                           for example a green count of 2 and a red count of 1.
 *                           Braces are spelled out here on purpose: an inline
 *                           JSON example in an unquoted YAML scalar parses as a
 *                           flow mapping and swagger-jsdoc drops the whole route.
 *                       dominant_color_label: { type: string, nullable: true }
 *                       my_rating: { type: integer, nullable: true }
 *                       my_color_label: { type: string, nullable: true }
 *                       color_label:
 *                         type: string
 *                         nullable: true
 *                         description: Merged colour for `mark_source`. What a client should apply.
 *                       rating:
 *                         type: integer
 *                         nullable: true
 *                         description: Merged 0-5 rating for `mark_source`.
 *                       size_bytes:
 *                         type: integer
 *                         nullable: true
 *                         description: >
 *                           Recorded size of the stored original. Null means UNKNOWN, not
 *                           zero — such a row is still sized from storage and still counts
 *                           against the ZIP size cap, so do not sum these to predict it.
 *                       media_type:
 *                         type: string
 *                         nullable: true
 *                         description: '`image` or `video`. A video is never resized by `resolution`.'
 *                       mime_type: { type: string, nullable: true }
 *                       processing_status:
 *                         type: string
 *                         nullable: true
 *                         description: >
 *                           `complete` unless the async worker is still on this photo.
 *                           The preview and download routes answer 503 or 422 for the
 *                           other states, so a client can poll instead of failing.
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     page: { type: integer }
 *                     limit: { type: integer }
 *                     total: { type: integer }
 *                     filtered: { type: integer }
 *                     pages: { type: integer }
 *       403: { description: Token lacks scope or permission }
 *       404: { description: Event not found }
 */
router.get(
  '/events/:id/photos',
  apiTokenAuth,
  requireApiScope('read'),
  requirePermission('photos.view'),
  requireEventOwnership,
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    ...photoFilterValidators
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: safeValidationErrors(errors) });
      }

      const eventId = parseInt(req.params.id, 10);
      const event = await db('events').where({ id: eventId }).first();
      if (!event) return res.status(404).json({ error: 'Event not found' });

      const page = req.query.page || 1;
      const limit = req.query.limit || 50;
      const markSource = req.query.mark_source || 'either';
      const filters = buildPhotoFilters(req);
      // Which colour-label set the event currently uses (#1197): a dormant
      // set left behind by a mode switch must not answer a colour filter.
      const { identity_mode: identityMode } =
        await feedbackService.getEventFeedbackSettings(eventId);

      // Two-step on purpose: PhotoFilterBuilder knows how to FILTER on marks
      // but its select list carries none of them, while
      // photoExportService.getPhotosWithFeedback knows how to ENRICH but does
      // not filter. Filter to a page of ids first, then enrich just those —
      // which also keeps the per-colour tally query bounded by page size.
      const filterBuilder = new PhotoFilterBuilder(
        db('photos').select('photos.id'),
        eventId,
        identityMode
      );
      filterBuilder
        .applyFilters(filters)
        .applySorting('filename', 'asc')
        .applyPagination(page, limit);

      const [idRows, countResult, summary] = await Promise.all([
        filterBuilder.getQuery(),
        PhotoFilterBuilder.buildCountQuery(db, eventId, filters, identityMode),
        PhotoFilterBuilder.getSummary(db, eventId, identityMode)
      ]);

      const pageIds = idRows.map(r => r.id);
      const photos = pageIds.length
        ? await photoExportService.getPhotosWithFeedback(eventId, pageIds, req.admin.id)
        : [];

      // What a client needs to decide HOW to fetch each row: whether it is a
      // video (never resized), what the bytes will be labelled as, how big
      // the original is, and whether the async worker has finished with it.
      // Queried here rather than widened into getPhotosWithFeedback, which is
      // shared with the CSV/JSON photo exports and shouldn't grow columns for
      // one caller. Bounded by the page size, on the primary key.
      // event_id is redundant — pageIds come from a builder already scoped to
      // this event, behind requireEventOwnership — and is repeated anyway so
      // the scoping is local to the query rather than inherited from two
      // statements above.
      const mediaRows = pageIds.length
        ? await db('photos').where('event_id', eventId).whereIn('id', pageIds)
          .select('id', 'media_type', 'mime_type', 'processing_status')
        : [];
      const mediaById = new Map(mediaRows.map((r) => [r.id, r]));

      const filtered = parseInt(countResult[0]?.count, 10) || 0;

      res.json({
        photos: photos.map(photo => {
          const merged = mergeMarks(photo, markSource);
          return {
            id: photo.id,
            filename: photo.filename,
            original_filename: photo.original_filename || null,
            // What the round-trip matches on. Null only for rows predating
            // migration 193 that had no original_filename either.
            // filename is the last fallback on purpose: fileWatcher and
            // external-media ingest never set original_filename, so for NAS
            // and auto-import galleries the camera name lives only there.
            source_filename: photo.source_filename || photo.original_filename || photo.filename || null,
            category: photo.category_name || null,
            average_rating: photo.average_rating ? parseFloat(photo.average_rating) : 0,
            feedback_count: photo.feedback_count || 0,
            like_count: photo.like_count || 0,
            favorite_count: photo.favorite_count || 0,
            comment_count: photo.comment_count || 0,
            color_labels: photo.color_labels || {},
            dominant_color_label: photo.dominant_color_label || null,
            my_rating: photo.my_rating ?? null,
            my_color_label: photo.my_color_label || null,
            color_label: merged.color_label,
            rating: merged.rating,
            width: photo.width || null,
            height: photo.height || null,
            size_bytes: Number(photo.size_bytes) > 0 ? Number(photo.size_bytes) : null,
            // ?? rather than ||: this is a second round trip over the same
            // rows, so a photo deleted between them is absent here. Reporting
            // null says "unknown", where defaulting would advertise a video as
            // a resizable image.
            media_type: mediaById.get(photo.id)?.media_type ?? null,
            mime_type: mediaById.get(photo.id)?.mime_type ?? null,
            // 'complete' unless the async worker is still on it. The preview
            // and download routes answer 503/422 for the other states.
            processing_status: mediaById.get(photo.id)?.processing_status ?? null,
            uploaded_at: photo.uploaded_at || null
          };
        }),
        pagination: {
          page,
          limit,
          total: summary.total,
          filtered,
          pages: Math.ceil(filtered / limit) || 0
        }
      });
    } catch (error) {
      logger.error('v1 GET /events/:id/photos failed', { error: error.message });
      res.status(500).json({ error: 'Failed to list photos' });
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────
// Original downloads (issue 1473)
//
// Integration access to the STORED original — not the gallery's download
// rendition: no resize to the gallery standard, no watermark, no preview tier.
// The gallery's own download routes stay the only guest path; these two never
// touch its accounting (access_logs, photos.download_count, the download
// limit) because an integration fetching photos is not a guest downloading
// them. What they leave behind is one activity_logs row per request, ids only.
// ──────────────────────────────────────────────────────────────────────────

// The ZIP's ?ids= list. Matches the gallery's download-selected cap.
const MAX_ZIP_IDS = 500;
// Refuse up front rather than stream for hours: a request this big is better
// split with ?ids= (the photo list is paginated anyway). Bytes come from
// photos.size_bytes; a row without a recorded size (null or 0) is statted in
// storage before the check rather than counted as zero (on GET only; HEAD
// stops at the recorded-size check to stay cheap). The byte cap is also
// enforced on the bytes actually streamed. An object so tests can lower it.
const MAX_ZIP_PHOTOS = 5000;
const zipLimits = { maxBytes: 20 * 1024 * 1024 * 1024, maxConcurrentPerToken: 2 };
// ZIPs being built per API token (token id -> count). In-process on purpose:
// PicPeak runs one backend process, and the cap only has to stop one token
// from holding many long archive streams and storage reads at once.
const zipsInFlight = new Map();
const MISSING_MANIFEST_NAME = 'MISSING_FILES.txt';
// Stats in flight while sizing rows without a recorded size.
const SIZE_STAT_CONCURRENCY = 8;

const isTrue = (value) => value === true || value === 1 || value === '1' || value === 'true';

const isGoneError = (err) => Boolean(err) && (err.code === 'ENOENT'
  || err.code === 'ENOTDIR'
  || err.name === 'NoSuchKey'
  || err.name === 'NotFound'
  || err.$metadata?.httpStatusCode === 404);

// LocalFsStorage refuses a key that climbs out of its root. For a download
// that is a row naming no usable file, not a server error.
const isUnsafeKeyError = (err) =>
  /^LocalFsStorage: (path traversal rejected|invalid relative path)/.test(err?.message || '');

// What gets logged about a failure: its class, never its message, which can
// carry a storage key (event slug and filename).
const errorClass = (err) => err?.code || err?.name || 'Error';

// Runs after requireEventOwnership: the event exists and the caller may see
// it. An archived event's originals live only inside its archive zip, which is
// not a per-photo read (see the PR for why that is not attempted here).
async function loadDownloadableEvent(req, res) {
  const event = await db('events').where({ id: parseInt(req.params.id, 10) }).first();
  if (!event) {
    res.status(404).json({ error: 'Event not found' });
    return null;
  }
  if (isTrue(event.is_archived)) {
    res.status(409).json({
      error: 'This event is archived; its originals are only in the archive. Restore the event to download them.',
      code: 'EVENT_ARCHIVED'
    });
    return null;
  }
  return event;
}

// A row id as PostgreSQL's integer column accepts it. Anything else —
// non-numeric, or past 2^31-1 — would be rejected there as a 500 before any
// 404 or 400 could be answered.
const PG_MAX_INT = 2147483647;
const isRowId = (value) => /^\d{1,10}$/.test(String(value)) && Number(value) <= PG_MAX_INT;

function requireNumericEventId(req, res, next) {
  if (!isRowId(req.params.id)) return res.status(404).json({ error: 'Event not found' });
  next();
}

/**
 * Where a photo's stored original lives: `{ key }` in the storage backend
 * (managed photos, local disk or S3) or `{ filePath }` on a local mount
 * (external/reference photos). Both resolvers build it from the photo row,
 * never from request input. null when the row names no usable location —
 * including a managed key that normalises out of events/active/.
 */
function locateOriginal(event, photo) {
  try {
    const key = resolvePhotoStorageKey(event, photo);
    if (key) {
      return path.posix.normalize(key).startsWith('events/active/') ? { key } : null;
    }
    return { filePath: resolvePhotoFilePath(event, photo) };
  } catch {
    return null;
  }
}

/** Byte size of the stored original, or null when it is missing. */
async function statOriginal(location) {
  if (location.key) {
    try {
      const stat = await getStorage().stat(location.key);
      return stat ? stat.size : null;
    } catch (err) {
      if (isGoneError(err) || isUnsafeKeyError(err)) return null;
      throw err;
    }
  }
  try {
    const stat = await fs.stat(location.filePath);
    return stat.isFile() ? stat.size : null;
  } catch (err) {
    if (isGoneError(err)) return null;
    throw err;
  }
}

/**
 * Open a photo's stored original. Returns null when the file is gone.
 *
 * `size` is always known on local disk; on S3 it costs a HEAD, which the ZIP
 * skips (get() rejects on a missing key by itself) and leaves null.
 */
async function openOriginal(event, photo, { needSize = true } = {}) {
  const location = locateOriginal(event, photo);
  if (!location) return null;

  let size = null;
  // Local reads are lazy: a missing file would only error after the stream
  // was handed on, so it is statted here instead.
  if (needSize || !location.key || getStorage().kind() === 'local') {
    size = await statOriginal(location);
    if (size === null) return null;
  }

  if (!location.key) return { stream: fsSync.createReadStream(location.filePath), size };
  try {
    return { stream: await getStorage().get(location.key), size };
  } catch (err) {
    if (isGoneError(err) || isUnsafeKeyError(err)) return null;
    throw err;
  }
}

/**
 * ZIP entry names: the original upload name, zip-safe (sanitizeForZipEntry
 * replaces `:` and the rest of the Windows-reserved characters so entries
 * extract cleanly there too) and duplicates suffixed `_1`, `_2` … compared
 * case-insensitively, so `IMG.jpg` and `img.JPG` do not overwrite each other
 * when extracted onto a case-insensitive filesystem.
 */
function zipEntryNames(rawNames) {
  const taken = new Set();
  return rawNames.map((raw) => {
    const name = sanitizeForZipEntry(raw);
    const ext = path.extname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    let candidate = name;
    for (let n = 1; taken.has(candidate.toLowerCase()); n += 1) candidate = `${stem}_${n}${ext}`;
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}

function setOriginalHeaders(res, photo, size) {
  res.set({
    // A resize re-encodes in the SOURCE format (resizeToBox), so the stored
    // row's type still describes the bytes that go out.
    'Content-Type': resolvePhotoContentType(photo),
    // Always the original upload name, whatever the gallery's
    // "use original filenames" setting says: an integration wants the name
    // the photographer's files carry, not the renamed storage name.
    'Content-Disposition': buildContentDisposition(pickRawDownloadName(photo, true)),
    'X-Content-Type-Options': 'nosniff'
  });
  // Omitted rather than guessed on a HEAD that asked for a rendition: the
  // rendered length is only known once the resize has run, and answering the
  // ORIGINAL's length there would have clients size a buffer wrongly.
  if (Number.isFinite(size)) res.set('Content-Length', size);
}

const downloadActor = (req) => ({ type: 'admin', id: req.admin.id, name: req.admin.username });

// ?resolution= — `original` (the default) streams the stored bytes; `WxH`
// resizes INTO that box, keeping the aspect ratio, never enlarging, and
// re-encoding in the source format. Deliberately the gallery's own resolution
// vocabulary (#858, `3000x2000`) rather than a second one invented for v1, so
// an integration can offer the same choices a gallery does.
//
// Watermarks stay out. The gallery's watermark is a guest-facing setting, and
// these routes serve an integration that already holds photos.download on the
// originals — so renderPhotoForDownload is always called with null settings.
// A watermarked rendition would be a separate, explicit opt-in.
const RESOLUTION_PATTERN = /^(original|[1-9]\d{0,4}x[1-9]\d{0,4})$/;
const resolutionValidator = query('resolution').optional().matches(RESOLUTION_PATTERN)
  .withMessage('resolution must be `original` or WxH, e.g. 2048x2048');

// Box for this request, or null to serve the stored bytes. Validation has
// already rejected anything malformed, so parseResolution only ever returns
// null here for the literal `original`.
const requestedBox = (req) => parseResolution(req.query.resolution);

// The rendition for one photo, or null when the stored bytes should go out
// unchanged — no box asked for, or a video, which is never resized.
// A storage-level "the file is gone" also comes back as null rather than
// throwing: both callers fall through to the stored-bytes path, which already
// answers 404 (single) or lists the id in the manifest (zip) for a file that
// isn't there, so the two cases converge on the same correct answer.
async function renderPhotoAtBox(event, photo, box) {
  if (!box) return null;
  // The same containment rule the stored-bytes path applies. renderPhotoForDownload
  // resolves the key itself, so without this a row whose key normalises out of
  // events/active/ would be READ on the rendition branch while the original
  // branch answers 404 for it — a guard on one of two paths is not a guard.
  if (!locateOriginal(event, photo)) return null;
  // Gated on the type that will be SENT, so the bytes can never disagree with
  // the Content-Type header. Videos fall out here too.
  // These routes keep the original filename and Content-Type, so a rendition
  // is only offered for the types resizeToBox round-trips. A .dng (an accepted
  // upload type, served as image/x-adobe-dng) would otherwise come back as
  // JPEG bytes under a RAW name — the mislabelling resizeToBox already refuses
  // to do for HEIC.
  if (!RESIZE_PRESERVES_FORMAT.has(resolvePhotoContentType(photo))) return null;
  // No short-circuit on the recorded dimensions here, deliberately. Skipping
  // the render when photos.width/height say the photo already fits saves
  // reading the file — but those columns are not guaranteed to describe the
  // bytes on disk, and when they understate it the caller silently receives an
  // image LARGER than the box it asked for. Measured against a row recorded as
  // 256x171 whose file is 1200x800: ?resolution=800x800 returned 1200x800.
  //
  // resizeToBox makes the same decision from the image's real metadata and
  // returns the input untouched when it genuinely fits, so correctness costs
  // only the read. Delivering more pixels than were asked for is the worse
  // failure: it is silent, and the caller's reason for asking (a bandwidth or
  // storage budget) is exactly what it breaks.
  //
  // This gate keeps the SAME weakness one level down, and knowingly: it reads
  // the row's type, while resizeToBox refuses HEIC from the bytes. A row
  // claiming image/jpeg over HEIC bytes passes here and is served at full size.
  // Closing it means letting resizeToBox report that it declined, which is a
  // shared helper with its own callers — documented on the route instead, and
  // raised in review rather than reshaped inside this change.
  try {
    return await renderPhotoForDownload(event, photo, box, null);
  } catch (err) {
    if (isGoneError(err) || isUnsafeKeyError(err)) return null;
    throw err;
  }
}

const zipTooLarge = (res, photoCount, totalBytes) => res.status(400).json({
  error: `Archive too large (at most ${MAX_ZIP_PHOTOS} photos and ${zipLimits.maxBytes / (1024 ** 3)} GiB per request); split it with ids=`,
  code: 'ZIP_TOO_LARGE',
  photo_count: photoCount,
  total_bytes: totalBytes
});

/**
 * @openapi
 * /events/{id}/photos/download:
 *   get:
 *     summary: Download an event's originals as a ZIP
 *     description: >
 *       Streams a ZIP of the stored originals (photos and videos), or of
 *       resized renditions of them with `resolution`. Never watermarked,
 *       whatever the gallery's watermark setting says. Entries
 *       are stored uncompressed and always named by the original upload
 *       filename, independent of the "use original filenames" setting; `:`
 *       becomes `_`, and duplicates (compared case-insensitively) get `_1`,
 *       `_2` … suffixes. A photo whose file is missing is skipped and listed
 *       by id in a `MISSING_FILES.txt` entry (`MISSING_FILES_1.txt` if a photo
 *       already uses that name). Accepts the same filters as the photo list,
 *       plus `ids`. Not counted as a gallery download. Requires the `read`
 *       scope and the owner's `photos.view` and `photos.download` permissions.
 *
 *
 *       The archive is streamed without a Content-Length. Archives over 4 GiB
 *       are written as ZIP64, which some streaming unzip tools cannot read;
 *       use a tool that reads the central directory (unzip 6, 7-Zip, Python
 *       zipfile) or split the request with `ids`. If a stored file fails to
 *       read after streaming has started, the connection is aborted rather
 *       than ended, so a truncated archive never arrives as a complete
 *       response; treat an incomplete transfer as a failure and retry.
 *
 *
 *       HEAD is a cheap probe: it runs the filter, id and count checks and the
 *       byte check on recorded sizes, then answers with the ZIP headers
 *       without loading rows, statting files or building the archive. Rows
 *       without a recorded size are only sized on GET, so a HEAD can answer
 *       200 where the GET refuses with ZIP_TOO_LARGE; the GET also enforces
 *       the byte cap on the bytes actually streamed. At most 2 archives per
 *       token are built at once; another GET meanwhile gets 429
 *       ZIP_CONCURRENCY.
 *
 *
 *       Every request counts against the general API rate limit (default 300
 *       requests per 15 minutes per client IP, Settings → Security → API rate limiting). For bulk
 *       delivery use this endpoint, or `ids` batches of up to 500, rather than
 *       one single-photo request per photo.
 *     tags: [Photos]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: resolution
 *         schema: { type: string, default: original }
 *         description: >
 *           `original` (the default) packs the stored bytes. `WxH` — for
 *           example `2048x2048` — packs renditions resized into that box
 *           instead, keeping the aspect ratio and never enlarging, and names
 *           the archive after the box rather than `-originals`. Only JPEG,
 *           PNG, WebP and GIF are resized — videos, RAW and HEIC/HEIF are
 *           always packed at original size, and the same "box is a maximum,
 *           not a guarantee" caveat as the single-photo route applies to every
 *           entry. Renditions are
 *           rendered one at a time as the archive streams, so a large resized
 *           archive takes noticeably longer to produce than the same archive
 *           of originals. The size caps are measured against the ORIGINALS,
 *           which for a resized archive is an upper bound — a request can be
 *           refused as too large although its renditions would have fitted.
 *
 *
 *           Failure handling differs from the originals path on purpose. A
 *           storage read that fails mid-archive aborts the connection, so a
 *           truncated ZIP never arrives as a complete 200. A photo that fails
 *           to RENDER does not: it is skipped, listed in `MISSING_FILES.txt`
 *           and the archive still ends 200, because one undecodable file
 *           should not cost an integration the other 499. Read the manifest
 *           and re-request the ids in it rather than assuming a 200 means
 *           every id arrived.
 *       - in: query
 *         name: ids
 *         schema: { type: string }
 *         description: Comma-separated photo ids of this event, at most 500. Every id must belong to the event.
 *       - in: query
 *         name: marked_only
 *         schema: { type: boolean }
 *       - in: query
 *         name: mark_source
 *         schema: { type: string, enum: [client, mine, either], default: either }
 *       - in: query
 *         name: color_labels
 *         schema: { type: string }
 *       - in: query
 *         name: my_color_labels
 *         schema: { type: string }
 *       - in: query
 *         name: min_rating
 *         schema: { type: number, minimum: 0, maximum: 5 }
 *       - in: query
 *         name: my_min_rating
 *         schema: { type: integer, minimum: 1, maximum: 5 }
 *       - in: query
 *         name: logic
 *         schema: { type: string, enum: [AND, OR], default: AND }
 *     responses:
 *       200:
 *         description: ZIP archive of the originals
 *         content:
 *           application/zip:
 *             schema: { type: string, format: binary }
 *       400: { description: "Invalid filter or ids (code INVALID_PHOTO_IDS, TOO_MANY_PHOTO_IDS), or over 5000 photos / 20 GiB (code ZIP_TOO_LARGE)" }
 *       401: { description: Missing, invalid, revoked or expired token }
 *       403: { description: Token lacks scope or permission, or the event belongs to another admin }
 *       404: { description: Event not found, or no photos match (code NO_PHOTOS) }
 *       409: { description: Event is archived (code EVENT_ARCHIVED) }
 *       429: { description: "Rate limit exceeded, or this token already has 2 archives in progress (code ZIP_CONCURRENCY)" }
 *       500: { description: "The archive could not be started. A failure after streaming started aborts the connection instead." }
 */
router.get(
  '/events/:id/photos/download',
  apiTokenAuth,
  requireApiScope('read'),
  requirePermission(['photos.view', 'photos.download'], { requireAll: true }),
  requireNumericEventId,
  requireEventOwnership,
  [
    query('ids').optional().isString(),
    resolutionValidator,
    ...photoFilterValidators
  ],
  async (req, res) => {
    let guard = null;
    let archive = null;
    let cancelled = false;
    // Registered before the preflight: a client that leaves during the
    // selection queries or size stats has closed before any archive exists,
    // and a listener added later would never fire.
    res.on('close', () => {
      // Ended: the archive is fully written, nothing left to abort.
      if (res.writableEnded || cancelled) return;
      cancelled = true;
      if (guard) guard.destroyAll();
      if (archive) archive.abort();
    });
    // Or gone before the handler even ran (during auth and ownership).
    if (res.destroyed) return;
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: safeValidationErrors(errors) });
      }

      const event = await loadDownloadableEvent(req, res);
      if (!event) return;

      const box = requestedBox(req);
      // The name says what is inside: `-originals` only when it really is the
      // stored bytes.
      const archiveName = box
        ? `${event.slug}-${box.width}x${box.height}.zip`
        : `${event.slug}-originals.zip`;

      let ids = null;
      if (req.query.ids !== undefined) {
        const parts = String(req.query.ids).split(',').map((s) => s.trim()).filter(Boolean);
        if (!parts.length || !parts.every(isRowId)) {
          return res.status(400).json({ error: 'ids must be a comma-separated list of photo ids', code: 'INVALID_PHOTO_IDS' });
        }
        ids = [...new Set(parts.map(Number))];
        if (ids.length > MAX_ZIP_IDS) {
          return res.status(400).json({ error: `At most ${MAX_ZIP_IDS} ids per request`, code: 'TOO_MANY_PHOTO_IDS' });
        }
        const owned = await db('photos').where('event_id', event.id).whereIn('id', ids).count('id as count').first();
        if (Number(owned?.count || 0) !== ids.length) {
          // Deliberately not naming the offenders: an id that isn't in this
          // event is either a typo or someone else's photo.
          return res.status(400).json({ error: 'One or more ids do not belong to this event', code: 'INVALID_PHOTO_IDS' });
        }
      }

      // Same filter path, colour-label set and order as GET /events/:id/photos.
      const { identity_mode: identityMode } =
        await feedbackService.getEventFeedbackSettings(event.id);
      const selection = () => {
        const builder = new PhotoFilterBuilder(db('photos'), event.id, identityMode);
        builder.applyFilters(buildPhotoFilters(req));
        if (ids) builder.getQuery().whereIn('photos.id', ids);
        return builder;
      };

      // Size the request before loading a single row. sum() comes back as a
      // string on PostgreSQL (bigint) and skips rows with no recorded size.
      // A row with a recorded size_bytes is trusted as-is here rather than
      // re-statted against the live file: size_bytes is only ever written at
      // import/replace time, so a file swapped afterwards on disk could make
      // this preflight over- or under-count it. Re-verifying every row would
      // mean a stat (an S3 HEAD, for external storage) per photo before this
      // cheap COUNT/SUM check can even run, on top of what the unsized rows
      // below already cost. A stale size is instead caught while streaming:
      // the archive's output is counted and aborted once it passes the cap.
      //
      // With ?resolution= the recorded sizes are the ORIGINALS', which is
      // usually an over-estimate but is not guaranteed to be one: resizeToBox
      // re-encodes at JPEG q90, so a heavily-compressed original that exceeds
      // the box can render larger than it was stored. The preflight is
      // therefore an estimate on this path, and the streamed-bytes check below
      // — which counts what actually goes out — is the real bound, exactly as
      // it already is for a stale size_bytes.
      const totals = await selection().getQuery()
        .count('photos.id as count')
        .sum('photos.size_bytes as bytes')
        .first();
      const photoCount = Number(totals?.count) || 0;
      let totalBytes = Number(totals?.bytes) || 0;
      if (!photoCount) {
        return res.status(404).json({ error: 'No photos found', code: 'NO_PHOTOS' });
      }
      if (photoCount > MAX_ZIP_PHOTOS || totalBytes > zipLimits.maxBytes) {
        return zipTooLarge(res, photoCount, totalBytes);
      }

      // A probe, not a download: answered from the COUNT/SUM above alone. No
      // rows loaded, no per-row storage stat (an S3 HEAD each), no archive,
      // nothing logged. Unsized rows are only sized on GET, below.
      if (req.method === 'HEAD') {
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', buildContentDisposition(archiveName));
        res.setHeader('X-Content-Type-Options', 'nosniff');
        return res.end();
      }

      // Per-token in-flight cap, taken before the row load and size stats so
      // those are bounded too. No await between the check and the listener:
      // a client gone by now has already set `cancelled`.
      if (cancelled || res.destroyed) return;
      const tokenId = req.apiToken.id;
      const inFlight = zipsInFlight.get(tokenId) || 0;
      if (inFlight >= zipLimits.maxConcurrentPerToken) {
        return res.status(429).json({
          error: `At most ${zipLimits.maxConcurrentPerToken} archives per token at once; wait for one to finish`,
          code: 'ZIP_CONCURRENCY'
        });
      }
      zipsInFlight.set(tokenId, inFlight + 1);
      res.once('close', () => {
        const left = (zipsInFlight.get(tokenId) || 1) - 1;
        if (left > 0) zipsInFlight.set(tokenId, left);
        else zipsInFlight.delete(tokenId);
      });

      const photos = await selection().applySorting('filename', 'asc').getQuery().select('photos.*');
      if (!photos.length) {
        return res.status(404).json({ error: 'No photos found', code: 'NO_PHOTOS' });
      }

      // Rows without a recorded size (legacy imports, or a 0 that no real
      // original has) are sized from storage metadata, so they can't slip a
      // large archive past the cap. A missing file counts as zero; it ends up
      // in the manifest below.
      const unsized = photos.filter((p) => !(Number(p.size_bytes) > 0));
      for (let i = 0; i < unsized.length; i += SIZE_STAT_CONCURRENCY) {
        // No more storage requests for a client that has left.
        if (cancelled) return;
        const sizes = await Promise.all(unsized.slice(i, i + SIZE_STAT_CONCURRENCY).map(async (p) => {
          const location = locateOriginal(event, p);
          return location ? (await statOriginal(location)) || 0 : 0;
        }));
        totalBytes += sizes.reduce((sum, size) => sum + size, 0);
      }
      if (photos.length > MAX_ZIP_PHOTOS || totalBytes > zipLimits.maxBytes) {
        return zipTooLarge(res, photos.length, totalBytes);
      }

      // The manifest is named last, so a photo uploaded as MISSING_FILES.txt
      // keeps its name and the manifest becomes MISSING_FILES_1.txt.
      const entryNames = zipEntryNames([
        ...photos.map((p) => pickRawDownloadName(p, true)),
        MISSING_MANIFEST_NAME
      ]);
      const manifestName = entryNames.pop();

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', buildContentDisposition(archiveName));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (cancelled || res.destroyed) return;

      // Photos and videos are already compressed; deflating them again costs
      // CPU for nothing.
      archive = archiver('zip', { store: true });

      // A read that fails after the headers went out can no longer become an
      // error status. Aborting only the archive ends it cleanly — the client
      // then holds a truncated ZIP delivered as a complete 200, or, when the
      // failed read was still queued, a response that never ends at all.
      // Destroying the response breaks the connection instead, which every
      // HTTP client reports as a failed transfer.
      const abortArchive = (err, { level = 'error', ...details } = {}) => {
        if (cancelled) return;
        cancelled = true;
        logger[level]('v1 originals zip aborted', {
          eventId: event.id,
          tokenId: req.apiToken.id,
          error: errorClass(err),
          ...details
        });
        guard.destroyAll();
        archive.unpipe(res);
        archive.abort();
        res.destroy(err instanceof Error ? err : new Error('archive failed'));
      };
      guard = createArchiveStreamGuard({ onFatalError: abortArchive });
      archive.on('error', (err) => abortArchive(err));
      // The preflight trusts recorded sizes, so a file replaced after import
      // can still be larger than its row says. Count what actually goes out
      // and stop at the cap. The 200 headers are already sent, so this can
      // only break the transfer (the client sees a failed download, never a
      // complete-looking truncated ZIP).
      let streamedBytes = 0;
      archive.on('data', (chunk) => {
        streamedBytes += chunk.length;
        if (streamedBytes > zipLimits.maxBytes) {
          const err = new Error('archive over the size cap');
          err.code = 'ZIP_TOO_LARGE';
          abortArchive(err, { level: 'warn', streamedBytes, maxBytes: zipLimits.maxBytes });
        }
      });
      archive.pipe(res);

      const missingIds = [];
      let appended = 0;
      for (let i = 0; i < photos.length; i += 1) {
        if (!await guard.acquire()) break;
        // Rendered entries are buffers, appended whole — the same shape the
        // gallery's own cached zip builder uses. Only the stored-bytes path
        // needs a tracked stream. A render that fails on a photo is treated
        // as a missing file so one unreadable row can't kill the archive.
        let rendered = null;
        if (box) {
          try {
            rendered = await renderPhotoAtBox(event, photos[i], box);
          } catch (err) {
            logger.warn('v1 zip rendition failed, skipping photo', {
              eventId: event.id, photoId: photos[i].id, error: errorClass(err)
            });
            missingIds.push(photos[i].id);
            continue;
          }
        }
        if (rendered) {
          // Tracked like a storage read, so destroyAll() reclaims it on an
          // abort instead of leaving archiver holding the buffer.
          //
          // It is NOT the throttle for this path, and the earlier claim that
          // it was does not survive measurement. acquire() gates on the number
          // of OPEN sources; whether a buffer-backed source stays open depends
          // on whether archiver is free to consume it, which depends on the
          // response. What actually bounds this loop in practice is the cost
          // of the render itself — a large source takes far longer to resize
          // than archiver takes to write the result. See the PR for why the
          // wall-clock test that appeared to prove a throttle was measuring
          // sharp's speed rather than backpressure.
          archive.append(guard.track(Readable.from([rendered])), { name: entryNames[i] });
          appended += 1;
          continue;
        }

        const source = await openOriginal(event, photos[i], { needSize: false });
        if (!source) {
          missingIds.push(photos[i].id);
          continue;
        }
        archive.append(guard.track(source.stream), { name: entryNames[i] });
        appended += 1;
      }
      if (cancelled) return;

      if (missingIds.length) {
        archive.append(
          'These photo ids are not in this archive — their file was missing from '
          + `storage, or could not be prepared:\n${missingIds.join('\n')}\n`,
          { name: manifestName }
        );
      }

      // On close, not finish: a client can hang up as soon as it has read
      // the final chunk, before the response ever finishes. Ended means
      // that chunk was written. An aborted archive still ends the response
      // — truncated — so cancelled rules it out.
      res.on('close', () => {
        if (cancelled || !res.writableEnded) return;
        logActivity('api_photos_zip_downloaded', {
          via: 'api_v1',
          token_id: req.apiToken.id,
          // The bell entry names the token; the admin chose that label.
          token_name: req.apiToken.name,
          photo_count: appended,
          missing_count: missingIds.length,
          resolution: box ? `${box.width}x${box.height}` : 'original'
        }, event.id, downloadActor(req));
      });

      // finalize() settles on the archive's end or error, and an aborted
      // archive may emit neither. The response closing ends the wait too, so
      // the handler can never be left parked on a dead archive.
      const finalized = archive.finalize();
      finalized.catch(() => {}); // handled by abortArchive
      await Promise.race([finalized, new Promise((resolve) => res.once('close', resolve))]);
    } catch (error) {
      if (guard) guard.destroyAll();
      if (archive) {
        archive.unpipe(res);
        archive.abort();
      }
      logger.error('v1 GET /events/:id/photos/download failed', {
        eventId: req.params.id,
        error: errorClass(error)
      });
      if (cancelled || res.headersSent) {
        if (!res.destroyed) res.destroy();
        return;
      }
      // The ZIP headers describe a body that is not coming.
      res.removeHeader('Content-Type');
      res.removeHeader('Content-Disposition');
      res.status(500).json({ error: 'Failed to build archive' });
    }
  }
);

/**
 * @openapi
 * /events/{id}/photos/{photoId}/download:
 *   get:
 *     summary: Download one original photo or video
 *     description: >
 *       Streams the stored original exactly as uploaded, or a resized
 *       rendition of it with `resolution`. Never watermarked, whatever the
 *       gallery's watermark setting says. The filename in
 *       Content-Disposition is always the original upload name (RFC 5987
 *       encoded), independent of the "use original filenames" setting. HEAD
 *       answers the same headers without reading the file — including
 *       Content-Length, except when `resolution` asks for a rendition, whose
 *       length is only known once it has been rendered. Range requests are
 *       not supported. Not counted as a gallery
 *       download. Requires the `read` scope and the owner's `photos.view` and
 *       `photos.download` permissions.
 *
 *
 *       Every request counts against the general API rate limit (default 300
 *       requests per 15 minutes per client IP, Settings → Security → API rate limiting). To
 *       deliver a whole event, use the ZIP endpoint (optionally in `ids`
 *       batches) instead of one request per photo.
 *     tags: [Photos]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: photoId
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: resolution
 *         schema: { type: string, default: original }
 *         description: >
 *           `original` (the default) serves the stored bytes. `WxH` — for
 *           example `2048x2048` — resizes into that box instead, keeping the
 *           aspect ratio, never enlarging, and re-encoding in the source
 *           format. These are the same resolution ids the gallery's own
 *           download menu uses. Only JPEG, PNG, WebP and GIF are resized —
 *           videos, RAW (e.g. DNG) and HEIC/HEIF are always served at original
 *           size, because re-encoding them would ship bytes that disagree with
 *           their filename and Content-Type. A photo already inside the box is
 *           returned byte-for-byte rather than re-encoded. A rendition
 *           is never watermarked, whatever the gallery's watermark setting says.
 *
 *
 *           The box is a maximum, not a guarantee. A rendition is skipped and
 *           the stored bytes are served unchanged when the image cannot be
 *           re-encoded safely: HEIC/HEIF detected from the BYTES (the stored
 *           type is not always right about that), and a source sharp cannot
 *           decode. In each case the response is the
 *           correct bytes under the correct type, but larger than asked for, so
 *           a client that must not exceed a size should check what it received.
 *     responses:
 *       200:
 *         description: The original file
 *         content:
 *           image/*:
 *             schema: { type: string, format: binary }
 *           video/*:
 *             schema: { type: string, format: binary }
 *       401: { description: Missing, invalid, revoked or expired token }
 *       403: { description: Token lacks scope or permission, or the event belongs to another admin }
 *       404: { description: "Event or photo not found (a photo of another event is not found either), or the file is missing from storage (code PHOTO_FILE_MISSING)" }
 *       409: { description: Event is archived (code EVENT_ARCHIVED) }
 *       429: { description: Rate limit exceeded }
 */
router.get(
  '/events/:id/photos/:photoId/download',
  apiTokenAuth,
  requireApiScope('read'),
  requirePermission(['photos.view', 'photos.download'], { requireAll: true }),
  requireNumericEventId,
  requireEventOwnership,
  [resolutionValidator],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: safeValidationErrors(errors) });
      }

      const event = await loadDownloadableEvent(req, res);
      if (!event) return;

      // One answer for unknown, malformed and other-event ids.
      const photo = isRowId(req.params.photoId)
        ? await db('photos').where({ id: Number(req.params.photoId), event_id: event.id }).first()
        : null;
      if (!photo) return res.status(404).json({ error: 'Photo not found' });

      const fileMissing = () => res.status(404)
        .json({ error: 'The photo file is missing from storage', code: 'PHOTO_FILE_MISSING' });

      const box = requestedBox(req);

      // HEAD is answered from the row and a stat: no read is opened, which
      // on S3 would start transferring the whole object. A HEAD that asked
      // for a rendition therefore reports no Content-Length — rendering one
      // just to measure it is exactly the work HEAD exists to avoid.
      if (req.method === 'HEAD') {
        const location = locateOriginal(event, photo);
        const size = location ? await statOriginal(location) : null;
        if (size === null) return fileMissing();
        // A box only costs the length when something will actually be
        // re-encoded. For the types that are always served at original size —
        // videos, RAW, HEIC — the stored size is still exactly what a GET
        // returns, so dropping it would be a lie in the other direction.
        const willRender = Boolean(box) && RESIZE_PRESERVES_FORMAT.has(resolvePhotoContentType(photo));
        setOriginalHeaders(res, photo, willRender ? null : size);
        return res.end();
      }

      // Logged once the whole file is out. 'finish' alone misses a client
      // that hangs up the moment it has Content-Length bytes: its socket can
      // close before the pipe gets to res.end(), so the response closes
      // without ever finishing. Counting the bytes read into the response
      // catches that without logging a transfer the client cut short.
      let streamedBytes = 0;
      let recorded = false;
      const recordDownload = () => {
        if (recorded || res.statusCode >= 400) return;
        recorded = true;
        // The audit row, ids only. The bell leaves these out and shows the
        // token/event/hour summary instead (apiDownloadNotifications).
        logActivity('api_photo_downloaded', {
          via: 'api_v1',
          token_id: req.apiToken.id,
          photo_id: photo.id,
          // Answers "why is my media library full of 2048px files". 'original'
          // rather than null so the two cases read the same way in the log.
          resolution: box ? `${box.width}x${box.height}` : 'original'
        }, event.id, downloadActor(req));
        recordSingleDownload({
          tokenId: req.apiToken.id,
          tokenName: req.apiToken.name,
          eventId: event.id,
          actor: downloadActor(req)
        });
      };
      // A rendition is buffered and written in one go, so 'finish' is the
      // only completion signal there is — none of the partial-transfer
      // accounting below applies. null means nothing was resized (no box, or
      // a video, which is never resized) and the stored bytes go out instead.
      const rendered = await renderPhotoAtBox(event, photo, box);
      if (rendered) {
        if (res.destroyed) return;
        setOriginalHeaders(res, photo, rendered.length);
        res.on('finish', recordDownload);
        return res.end(rendered);
      }

      const source = await openOriginal(event, photo);
      if (!source) return fileMissing();
      // A client that left while the read was opening has already closed,
      // so pipeStreamToResponse's cleanup would never run for this stream.
      if (res.destroyed) {
        source.stream.destroy();
        return;
      }
      setOriginalHeaders(res, photo, source.size);

      res.on('finish', recordDownload);
      res.on('close', () => {
        if (Number.isFinite(source.size) && streamedBytes >= source.size) recordDownload();
      });
      pipeStreamToResponse(source.stream, res, { context: `v1 original ${photo.id}` });
      source.stream.on('data', (chunk) => { streamedBytes += chunk.length; });
    } catch (error) {
      logger.error('v1 GET /events/:id/photos/:photoId/download failed', {
        eventId: req.params.id,
        photoId: req.params.photoId,
        error: errorClass(error)
      });
      if (!res.headersSent) res.status(500).json({ error: 'Failed to download photo' });
    }
  }
);

/**
 * @openapi
 * /events/{id}/photos/{photoId}/preview:
 *   get:
 *     summary: A photo's web-sized preview image
 *     description: >
 *       The same JPEG preview tier the admin gallery grid renders, for
 *       building a picker without pulling originals. Generated on first
 *       request and cached in storage afterwards.
 *
 *
 *       Not a download: it is never the stored original, it carries no
 *       Content-Disposition, and it is left out of the download audit log and
 *       the notification bell — browsing a gallery is not delivering it.
 *       Requires the `read` scope and the owner's `photos.view` permission.
 *
 *
 *       Videos have no preview and answer 404 `PREVIEW_UNAVAILABLE` — ask for
 *       one per row in a listing and the video rows simply come back empty,
 *       they are never generated on demand.
 *
 *
 *       `w` must be exactly one of the generated tiers (640, 1280 or 1920);
 *       any other value, including a non-numeric one, is ignored and the
 *       default preview is served, so read the returned image's own width
 *       rather than assuming `w` was honoured. The preview is JPEG, or WebP
 *       when the source is animated or carries an alpha channel — read the
 *       Content-Type. A photo still being
 *       processed answers 503 with `Retry-After`, and one whose processing
 *       failed answers 422 — poll rather than treating either as fatal.
 *     tags: [Photos]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: photoId
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: w
 *         schema: { type: integer, enum: [640, 1280, 1920] }
 *     responses:
 *       200:
 *         description: The preview image
 *         content:
 *           image/jpeg:
 *             schema: { type: string, format: binary }
 *           image/webp:
 *             schema: { type: string, format: binary }
 *       403: { description: Token lacks scope or permission }
 *       404: { description: Event or photo not found, or no preview exists for it (including every video) }
 *       409: { description: The event is archived }
 *       422: { description: Processing this photo failed }
 *       503: { description: Still processing; retry after the given delay }
 */
router.get(
  '/events/:id/photos/:photoId/preview',
  apiTokenAuth,
  requireApiScope('read'),
  requirePermission('photos.view'),
  requireNumericEventId,
  requireEventOwnership,
  // No validator on `w`: normalizeTierWidth whitelists the generated tiers and
  // falls back to the default preview for anything else, which is what the
  // gallery's preview route does and what this route's docs promise. Rejecting
  // `?w=abc` with a 400 here contradicted both.
  [],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: safeValidationErrors(errors) });
      }

      // Archived the same way the download routes are: once an event's photos
      // live inside its archive there is nothing on disk left to preview.
      const event = await loadDownloadableEvent(req, res);
      if (!event) return;

      const photo = isRowId(req.params.photoId)
        ? await db('photos').where({ id: Number(req.params.photoId), event_id: event.id }).first()
        : null;
      if (!photo) return res.status(404).json({ error: 'Photo not found' });

      // The async worker has not reached this photo yet, or gave up on it.
      // Same two answers the admin grid already polls on.
      if (photo.processing_status === 'pending' || photo.processing_status === 'processing') {
        res.setHeader('Retry-After', '2');
        return res.status(503).json({
          error: 'Preview not ready', code: 'PHOTO_PROCESSING', status: photo.processing_status
        });
      }
      if (photo.processing_status === 'failed') {
        return res.status(422).json({
          error: 'Photo processing failed', code: 'PHOTO_PROCESSING_FAILED'
        });
      }

      const unavailable = () => res.status(404).json({
        error: 'No preview available for this photo', code: 'PREVIEW_UNAVAILABLE'
      });

      // Answered BEFORE any generation is attempted, because failing to
      // generate is not free. A video has no preview tier and never gets one,
      // but ensurePreviewImage would stage the whole source through
      // withLocalCopy first and only then let sharp fail — a full S3 download
      // and temp-disk write per call, twice when ?w misses its tier. A picker
      // that asks for every row in a page would do that for every video on it.
      // The gallery's own preview route redirects videos away for the same
      // reason (gallery/media.js).
      if (isVideo(photo)) return unavailable();

      // The containment rule the rendition path applies, on this third path
      // too — ensurePreviewImage resolves the source key itself, so without
      // this a row whose path normalises out of events/active/ is READ here
      // while both download branches answer 404 for it. A guard on two of
      // three paths is still not a guard.
      if (!locateOriginal(event, photo)) return unavailable();

      const tierWidth = normalizeTierWidth(req.query.w, PREVIEW_WIDTHS);
      let previewPath = null;
      try {
        previewPath = tierWidth
          ? (await ensurePreviewImageAtWidth(photo, tierWidth)) || (await ensurePreviewImage(photo))
          : await ensurePreviewImage(photo);
      } catch (err) {
        // A row naming a file that is gone is a 404 below, not a 500.
        if (!isGoneError(err) && !isUnsafeKeyError(err)) throw err;
      }

      // Nothing to serve and no way to make it: a missing original, or a
      // media type nothing can render a still from.
      if (!previewPath) return unavailable();

      const stat = await getStorage().stat(previewPath);
      if (!stat) return unavailable();

      const stream = await getStorage().get(previewPath);
      // Left while the read was opening: pipeStreamToResponse's cleanup would
      // never run for this stream.
      if (res.destroyed) {
        stream.destroy();
        return;
      }
      res.set({
        // Not assumed: generatePreviewImage writes WebP for an animated or
        // alpha-carrying source and JPEG otherwise, and nosniff means a
        // mislabelled preview simply fails to render.
        'Content-Type': previewPath.endsWith('.webp') ? 'image/webp' : 'image/jpeg',
        'Content-Length': stat.size,
        // Private: a preview is exactly as access-controlled as the gallery it
        // belongs to, and must never be held by a shared cache.
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff'
      });
      pipeStreamToResponse(stream, res, { context: `v1 preview ${photo.id}` });
    } catch (error) {
      logger.error('v1 GET /events/:id/photos/:photoId/preview failed', {
        eventId: req.params.id,
        photoId: req.params.photoId,
        error: errorClass(error)
      });
      if (!res.headersSent) res.status(500).json({ error: 'Failed to serve preview' });
    }
  }
);

module.exports = router;
module.exports.zipLimits = zipLimits;
