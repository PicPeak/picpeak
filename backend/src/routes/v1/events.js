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
const { db, logActivity } = require('../../database/db');
const { apiTokenAuth, requireApiScope } = require('../../middleware/apiTokenAuth');
const { buildShareLinkVariants } = require('../../services/shareLinkService');
const { generateThumbnail } = require('../../services/imageProcessor');
const logger = require('../../utils/logger');
const { slugify } = require('../../utils/slug');
const { formatBoolean } = require('../../utils/dbCompat');
const { parseBooleanInput } = require('../../utils/parsers');

const router = express.Router();

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
const photoUpload = multer({
  storage: photoStorage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB per file for v1
  fileFilter: (_req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image uploads are accepted on this endpoint'));
  }
});

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
 *                 enum: [wedding, birthday, corporate, other, family]
 *               event_date: { type: string, format: date, nullable: true }
 *               customer_name: { type: string, nullable: true }
 *               customer_email: { type: string, format: email, nullable: true }
 *               customer_phone: { type: string, nullable: true, description: "Only persisted when the global phone-field setting is enabled." }
 *               admin_email: { type: string, format: email, nullable: true }
 *               require_password: { type: boolean, default: true }
 *               password: { type: string, nullable: true, description: "Required when require_password is true." }
 *               expires_at: { type: string, format: date-time, nullable: true }
 *               color_theme: { type: string, nullable: true, description: "Preset name (e.g. 'default') or JSON-encoded ThemeConfig. Persisted as-is on the event row." }
 *               feedback_enabled: { type: boolean, nullable: true, description: "Enable guest feedback for this gallery. When omitted, falls back to the global event_default_feedback_enabled setting." }
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
  [
    body('event_name').isString().trim().notEmpty(),
    body('event_type').isIn(['wedding', 'birthday', 'corporate', 'other', 'family']),
    body('event_date').optional({ nullable: true, checkFalsy: true }).isISO8601(),
    body('customer_name').optional({ nullable: true }).isString(),
    body('customer_email').optional({ nullable: true, checkFalsy: true }).isEmail(),
    body('customer_phone').optional({ nullable: true, checkFalsy: true }).isString().isLength({ max: 32 }),
    body('admin_email').optional({ nullable: true, checkFalsy: true }).isEmail(),
    body('require_password').optional().isBoolean(),
    body('password').optional({ nullable: true }).isString().isLength({ min: 6 }),
    body('expires_at').optional({ nullable: true, checkFalsy: true }).isISO8601(),
    body('color_theme').optional({ nullable: true }).isString().trim(),
    body('feedback_enabled').optional().isBoolean()
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const {
        event_name, event_type, event_date,
        customer_name = null, customer_email = null, customer_phone = null,
        admin_email = null, require_password = true, password,
        expires_at = null,
        color_theme = null,
        feedback_enabled: feedbackEnabledInput
      } = req.body;

      // Issue #550 — mirror the admin POST path so API-created events
      // pick up the global "Enable Guest Feedback by default" toggle
      // (event_default_feedback_enabled). Without this, the UI reads
      // a missing event_feedback_settings row as "feedback off"
      // regardless of the admin's chosen default.
      let feedbackEnabledFallback = false;
      if (feedbackEnabledInput === undefined) {
        const setting = await db('app_settings').where('setting_key', 'event_default_feedback_enabled').first();
        if (setting) {
          try {
            const parsed = JSON.parse(setting.setting_value);
            if (typeof parsed === 'boolean') feedbackEnabledFallback = parsed;
          } catch { /* keep false */ }
        }
      }
      const feedback_enabled = parseBooleanInput(feedbackEnabledInput, feedbackEnabledFallback);

      if (require_password && (!password || password.length < 6)) {
        return res.status(400).json({ error: 'Password is required when require_password is true (min 6 chars)' });
      }

      // Honour global phone-field toggle (#322).
      let persistPhone = null;
      if (customer_phone) {
        const setting = await db('app_settings').where('setting_key', 'event_phone_field_enabled').first();
        const enabled = setting ? JSON.parse(setting.setting_value) === true : false;
        persistPhone = enabled ? customer_phone : null;
      }

      // Generate unique slug.
      const baseSlug = `${event_type}-${slugify(event_name)}-${event_date || crypto.randomBytes(3).toString('hex')}`;
      let slug = baseSlug;
      let counter = 1;
      while (await db('events').where({ slug }).first()) slug = `${baseSlug}-${counter++}`;

      const shareToken = crypto.randomBytes(16).toString('hex');
      const { shareUrl, shareLinkToStore } = await buildShareLinkVariants({ slug, shareToken });

      // password_hash is NOT NULL; use a random placeholder when no
      // password is required so the column constraint is satisfied.
      const bcrypt = require('bcrypt');
      const passwordHash = require_password
        ? await bcrypt.hash(password, 10)
        : await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);

      const insertResult = await db('events').insert({
        slug,
        event_type,
        event_name,
        event_date: event_date || null,
        host_name: customer_name,
        host_email: customer_email,
        admin_email,
        password_hash: passwordHash,
        require_password,
        share_link: shareLinkToStore,
        share_token: shareToken,
        expires_at: expires_at || null,
        created_at: new Date().toISOString(),
        created_by: req.admin.id,
        is_draft: false,
        // Issue #550 — without this, editing an API-created event in the
        // admin UI snaps the theme picker to GALLERY_THEME_PRESETS.default
        // and saving overwrites whatever theme was inherited visually.
        color_theme,
        ...(customer_name ? { customer_name } : {}),
        ...(customer_email ? { customer_email } : {}),
        ...(persistPhone ? { customer_phone: persistPhone } : {})
      }).returning('id');
      const id = insertResult[0]?.id || insertResult[0];

      // Issue #550 — mirror adminEvents.js: create event_feedback_settings
      // row when feedback is enabled, so the gallery actually shows
      // feedback UI. Sub-flags default to the same values the admin form
      // ships with (everything on except require_name_email).
      if (feedback_enabled) {
        await db('event_feedback_settings').insert({
          event_id: id,
          feedback_enabled: formatBoolean(true),
          allow_ratings: formatBoolean(true),
          allow_likes: formatBoolean(true),
          allow_comments: formatBoolean(true),
          allow_favorites: formatBoolean(true),
          require_name_email: formatBoolean(false),
          moderate_comments: formatBoolean(true),
          show_feedback_to_guests: formatBoolean(true),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
      }

      await logActivity('event_created', { via: 'api_v1', event_type }, id, {
        type: 'admin', id: req.admin.id, name: req.admin.username
      });

      // Webhook lifecycle (#327). v1 events are not draft-aware, so they're
      // both created AND published in the same call. Canonical event
      // subject (#341) — customer contact + share_token always included.
      try {
        const webhookService = require('../../services/webhookService');
        const eventSubject = webhookService.buildEventSubject({
          id,
          slug,
          event_name,
          event_type,
          event_date,
          share_url: shareUrl,
          share_token: shareToken,
          customer_name,
          customer_email,
          customer_phone,
        });
        await webhookService.fire('event.created', { event: eventSubject });
        await webhookService.fire('event.published', { event: eventSubject });
      } catch (e) { /* non-fatal */ }

      res.status(201).json({ id, slug, share_url: shareUrl, share_token: shareToken });
    } catch (error) {
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
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt()
  ],
  async (req, res) => {
    try {
      const page = req.query.page || 1;
      const limit = req.query.limit || 25;
      const offset = (page - 1) * limit;

      const [events, totalRow] = await Promise.all([
        db('events')
          .select('id', 'slug', 'event_name', 'event_type', 'event_date', 'expires_at',
            'is_active', 'is_archived', 'is_draft', 'created_at')
          .orderBy('created_at', 'desc')
          .limit(limit)
          .offset(offset),
        db('events').count('id as count').first()
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
router.get('/events/:id', apiTokenAuth, requireApiScope('read'), async (req, res) => {
  try {
    const event = await db('events').where({ id: req.params.id }).first();
    if (!event) return res.status(404).json({ error: 'Event not found' });
    delete event.password_hash;
    delete event.client_password_hash;
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
 *       404: { description: Event not found }
 */
router.post(
  '/events/:id/photos',
  apiTokenAuth,
  requireApiScope('write'),
  photoUpload.single('photo'),
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
        width = meta.width || null;
        height = meta.height || null;
      } catch { /* non-fatal */ }

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
        path: relPath,
        thumbnail_path: thumbRel,
        type: photoType,
        category_id: categoryId,
        size_bytes: stat.size,
        width,
        height,
        media_type: 'image',
        mime_type: req.file.mimetype,
        uploaded_at: new Date().toISOString()
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
router.get('/events/:id/share-link', apiTokenAuth, requireApiScope('read'), async (req, res) => {
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

module.exports = router;
