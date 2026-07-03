const express = require('express');
const { body, validationResult } = require('express-validator');
const { db, logActivity } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const { slugify } = require('../utils/slug');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { IDENTITY_PRESERVING_NORMALIZE_EMAIL } = require('../utils/emailNormalization');
const router = express.Router();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const multer = require('multer');
const { archiveEvent } = require('../services/archiveService');
const { queueEmail } = require('../services/emailProcessor');
const { escapeLikePattern } = require('../utils/sqlSecurity');
// formatDate import removed - dates are formatted by email processor
const { validatePasswordInContext, getBcryptRounds } = require('../utils/passwordValidation');
const logger = require('../utils/logger');
const { buildShareLinkVariants } = require('../services/shareLinkService');
const { parseBooleanInput, parseStringInput } = require('../utils/parsers');
const eventTypeService = require('../services/eventTypeService');
const { normaliseEventTimeTriple } = require('../services/eventService');
const { hasColumnCached } = require('../utils/schemaCache');
const { validateFileType } = require('../utils/fileSecurityUtils');
const { requireEventOwnership } = require('../middleware/ownership');
const { requireFeatureFlag } = require('../middleware/requireFeatureFlag');
const { getAppSetting } = require('../utils/appSettings');
const { getFrontendBaseUrl } = require('../utils/frontendUrl');
const downloadZipService = require('../services/downloadZipService');

// Shared validator for hero_image_anchor – accepts legacy keywords or "X% Y%" focal point
const validateHeroImageAnchor = (value) => {
  if (['top', 'center', 'bottom'].includes(value)) return true;
  if (typeof value === 'string' && /^\d{1,3}%\s+\d{1,3}%$/.test(value)) {
    const [x, y] = value.split(/\s+/).map(v => parseInt(v));
    if (x >= 0 && x <= 100 && y >= 0 && y <= 100) return true;
  }
  throw new Error('Must be top, center, bottom, or "X% Y%" (0-100)');
};

// Get storage path from environment or default
const getStoragePath = () => process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');

// Configure multer for event logo uploads
const eventLogoStorage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = path.join(getStoragePath(), 'uploads/logos/events');
    await fs.mkdir(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `event-${req.params.id}-logo-${Date.now()}${ext}`);
  }
});

const eventLogoUpload = multer({
  storage: eventLogoStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/svg+xml'];
    if (validateFileType(file.originalname, file.mimetype, allowedMimeTypes)) {
      return cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, GIF and SVG image files are allowed'));
    }
  }
});

// Helper to get event field requirements from settings
const getEventFieldRequirements = async () => {
  try {
    const settings = await db('app_settings')
      .whereIn('setting_key', [
        'event_require_customer_name',
        'event_require_customer_email',
        'event_require_admin_email',
        'event_require_event_date',
        'event_require_expiration'
      ])
      .select('setting_key', 'setting_value');

    const requirements = {
      require_customer_name: true,
      require_customer_email: true,
      require_admin_email: true,
      require_event_date: true,
      require_expiration: true
    };

    settings.forEach(s => {
      let value = s.setting_value;
      if (typeof value === 'string') {
        try {
          value = JSON.parse(value);
        } catch (e) {
          value = value === 'true';
        }
      }
      if (s.setting_key === 'event_require_customer_name') requirements.require_customer_name = value;
      if (s.setting_key === 'event_require_customer_email') requirements.require_customer_email = value;
      if (s.setting_key === 'event_require_admin_email') requirements.require_admin_email = value;
      if (s.setting_key === 'event_require_event_date') requirements.require_event_date = value;
      if (s.setting_key === 'event_require_expiration') requirements.require_expiration = value;
    });

    return requirements;
  } catch (error) {
    logger.error('Failed to get event field requirements', { error: error.message });
    return {
      require_customer_name: true,
      require_customer_email: true,
      require_admin_email: true,
      require_event_date: true,
      require_expiration: true
    };
  }
};

// Helper to read app_settings booleans by key, used to inherit per-setting
// defaults onto new events. Returns `undefined` for missing/non-boolean rows
// so callers can fall back to a legacy default.
const readBooleanSetting = async (key) => {
  try {
    const setting = await db('app_settings').where('setting_key', key).first();
    if (!setting) return undefined;
    let value = setting.setting_value;
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { /* keep raw */ }
    }
    return typeof value === 'boolean' ? value : undefined;
  } catch (error) {
    logger.error('Failed to read app setting', { key, error: error.message });
    return undefined;
  }
};

// Helper to read the global "enable_devtools_protection" admin setting so
// new events inherit it instead of always falling back to the DB column default
// (#317 — admin disabled it globally but new events still got it ON).
const getDownloadProtectionDefaults = async () => {
  return { enable_devtools_protection: await readBooleanSetting('enable_devtools_protection') };
};

// Helper to get branding defaults for new events (Feature 7: Branding Inheritance).
//
// Note: `branding_logo_position` (header bar — left/center/right) is a
// different concept from `hero_logo_position` (hero block — top/center/
// bottom) and must NOT be mapped here. A previous version copied the
// branding value over, which wrote 'left'/'right' into per-event
// hero_logo_position columns and broke any subsequent PUT validation
// (#357). Migration 084 heals existing rows.
const getBrandingDefaults = async () => {
  try {
    const settings = await db('app_settings')
      .whereIn('setting_key', [
        'branding_logo_display_hero',
        'branding_logo_size'
      ])
      .select('setting_key', 'setting_value');

    const defaults = {
      hero_logo_visible: true,
      hero_logo_size: 'medium',
      hero_logo_position: 'top'
    };

    settings.forEach(s => {
      let value = s.setting_value;
      if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch (e) { /* use as-is */ }
      }
      if (s.setting_key === 'branding_logo_display_hero') {
        defaults.hero_logo_visible = value !== false;
      }
      if (s.setting_key === 'branding_logo_size' && value) {
        defaults.hero_logo_size = value;
      }
    });

    return defaults;
  } catch (error) {
    logger.error('Failed to get branding defaults', { error: error.message });
    return {
      hero_logo_visible: true,
      hero_logo_size: 'medium',
      hero_logo_position: 'top'
    };
  }
};

// Use parseStringInput from shared parsers for customer data extraction
const getCustomerNameFromPayload = (payload = {}) => parseStringInput(payload.customer_name);
const getCustomerEmailFromPayload = (payload = {}) => parseStringInput(payload.customer_email);
const getCustomerPhoneFromPayload = (payload = {}) => parseStringInput(payload.customer_phone);

// Whether the global "phone field" toggle (#322) is enabled. Cached for
// the request via a module-level read; drift is acceptable since this
// only governs whether to persist the field, not security boundaries.
const isPhoneFieldEnabled = async () => {
  try {
    const row = await db('app_settings').where('setting_key', 'event_phone_field_enabled').first();
    if (!row) return false;
    let value = row.setting_value;
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { /* keep raw */ }
    }
    return value === true;
  } catch (error) {
    logger.debug('Failed to read event_phone_field_enabled', { error: error.message });
    return false;
  }
};

const mapEventForApi = (event) => {
  if (!event || typeof event !== 'object') {
    return event;
  }

  const {
    host_name,
    host_email,
    customer_name,
    customer_email,
    customer_phone,
    password_hash: _ph,
    client_password_hash: _cph,
    ...rest
  } = event;

  return {
    ...rest,
    customer_name: customer_name ?? host_name ?? null,
    customer_email: customer_email ?? host_email ?? null,
    customer_phone: customer_phone ?? null
  };
};

let customerColumnCache = null;
const hasCustomerContactColumns = async () => {
  if (customerColumnCache === true) {
    return true;
  }

  try {
    const hasColumn = await db.schema.hasColumn('events', 'customer_email');
    if (hasColumn) {
      customerColumnCache = true;
    }
    return hasColumn;
  } catch (error) {
    logger.debug('Failed to detect customer_email column', { error: error.message });
    return false;
  }
};

// Cascade-delete a single event: photos, audit/access logs, queued emails,
// the event row itself (in one transaction), then the on-disk folder /
// archive zip / hero logo (best-effort — file failures don't unwind the DB
// changes since the source of truth is the database). Used by both the
// per-event DELETE /:id route and the bulk-delete route to avoid drift.
//
// Throws { code: 'EVENT_NOT_FOUND' } if the event id doesn't exist so the
// bulk-delete loop can report it as a per-id failure without aborting the
// whole batch. Any other error propagates and is the caller's problem.
async function deleteEventCascade(eventId, adminContext) {
  const event = await db('events').where('id', eventId).first();
  if (!event) {
    const err = new Error('Event not found');
    err.code = 'EVENT_NOT_FOUND';
    throw err;
  }

  await db.transaction(async (trx) => {
    // 1. Delete activity logs (audit trail)
    await trx('activity_logs').where('event_id', eventId).del();
    // 2. Delete access logs
    await trx('access_logs').where('event_id', eventId).del();
    // 3. Delete email queue entries
    await trx('email_queue').where('event_id', eventId).del();
    // 4. Delete photos (also handles hero_photo_id foreign key)
    await trx('photos').where('event_id', eventId).del();
    // 5. Finally delete the event row
    await trx('events').where('id', eventId).del();

    // Best-effort filesystem cleanup. Failures are logged but don't unwind
    // the transaction — the canonical state lives in the DB; orphan files
    // are recoverable noise, a half-deleted DB row is a permanent mess.
    //
    // #608 — previous code read `event.folder_path`, but that column is
    // never written anywhere in the codebase (grep confirms: two reads in
    // this function, zero writes). It's always undefined, so the
    // `if (event.folder_path)` branch silently no-op'd and every event
    // delete since this cascade landed left its photos orphaned on disk.
    // jodrmx's Pi report (v3.44.0) was the first surfacing.
    //
    // Files actually live at:
    //   {STORAGE_PATH}/events/active/{slug}/...      (uploaded photos)
    //   {STORAGE_PATH}/events/archived/{slug}/...    (after the event
    //     was archived — folder copy survives the archive flow)
    //
    // `event.slug` is NOT NULL on the events table and is slugify-sanitized
    // on every write (lower-case ASCII + dashes only via utils/slug.js),
    // so path-traversal isn't a concern.
    const storagePath = process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');
    for (const sub of ['active', 'archived']) {
      const eventFolderPath = path.join(storagePath, 'events', sub, event.slug);
      try {
        await fs.rm(eventFolderPath, { recursive: true, force: true });
      } catch (fsErr) {
        logger.warn('Failed to delete event folder during cascade delete', { eventId, path: eventFolderPath, error: fsErr.message });
      }
    }

    if (event.archive_path) {
      const storagePath = process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');
      const archiveFile = path.join(storagePath, event.archive_path);
      try {
        await fs.unlink(archiveFile);
      } catch (fsErr) {
        logger.warn('Failed to delete archive file during cascade delete', { eventId, path: archiveFile, error: fsErr.message });
      }
    }

    if (event.hero_logo_path) {
      try {
        await fs.unlink(event.hero_logo_path);
      } catch (fsErr) {
        logger.warn('Failed to delete event logo during cascade delete', { eventId, path: event.hero_logo_path, error: fsErr.message });
      }
    }
  });

  // Audit trail (outside the transaction so a logging failure can't undo
  // the actual delete).
  await logActivity('event_deleted',
    { event_name: event.event_name },
    null,
    { type: 'admin', id: adminContext.id, name: adminContext.username }
  );

  return { id: event.id, name: event.event_name };
}

// Create new event
router.post('/', adminAuth, requirePermission('events.create'), [
  body('event_type').notEmpty().trim().custom(async (value) => {
    const isValid = await eventTypeService.isValidEventType(value);
    if (!isValid) {
      throw new Error('Invalid event type');
    }
    return true;
  }),
  body('event_name').notEmpty().trim(),
  body('event_date').optional({ values: 'falsy' }).isDate(),
  // Migration 137 — calendar time fields.
  body('event_time_start').optional({ values: 'falsy' }).matches(/^([01]\d|2[0-3]):[0-5]\d$/)
    .withMessage('event_time_start must be HH:MM 24h'),
  body('event_time_end').optional({ values: 'falsy' }).matches(/^([01]\d|2[0-3]):[0-5]\d$/)
    .withMessage('event_time_end must be HH:MM 24h'),
  body('is_full_day').optional().isBoolean().toBoolean(),
  body('customer_name').optional().trim(),
  body('customer_email').optional({ values: 'falsy' }).isEmail().normalizeEmail(IDENTITY_PRESERVING_NORMALIZE_EMAIL),
  body('customer_phone').optional({ nullable: true, checkFalsy: true })
    .isString().trim()
    .isLength({ max: 32 }).withMessage('Phone number must be at most 32 characters'),
  body('admin_email').optional({ values: 'falsy' }).isEmail().normalizeEmail(IDENTITY_PRESERVING_NORMALIZE_EMAIL),
  body('require_password').optional().isBoolean(),
  body('password').optional().isString().custom((value, { req }) => {
    const input = req.body.require_password;
    const normalizeBoolean = (val, defaultValue = true) => {
      if (val === undefined || val === null) return defaultValue;
      if (typeof val === 'boolean') return val;
      if (typeof val === 'number') return val !== 0;
      if (typeof val === 'string') {
        const normalized = val.trim().toLowerCase();
        if (['false', '0', 'no', 'off'].includes(normalized)) return false;
        if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
      }
      return defaultValue;
    };

    const requirePassword = normalizeBoolean(input, true);
    if (!requirePassword) {
      return true;
    }
    if (typeof value !== 'string' || value.trim().length < 6) {
      throw new Error('Password must be at least 6 characters long');
    }
    return true;
  }),
  body('expiration_days').isInt({ min: 1, max: 365 }).optional(),
  body('welcome_message').optional().trim(),
  body('color_theme').optional().trim(),
  body('allow_user_uploads').optional().isBoolean().toBoolean(),
  body('upload_category_id').optional({ nullable: true, checkFalsy: true }).isInt(),
  body('allow_downloads').optional().isBoolean(),
  body('disable_right_click').optional().isBoolean(),
  body('enable_devtools_protection').optional().isBoolean(),
  body('watermark_downloads').optional().isBoolean(),
  body('watermark_text').optional().trim(),
  // #328 follow-up: per-event opt-in for presigned-URL "Download All".
  // Bypasses watermarks; admin must enable knowingly.
  body('allow_presigned_download').optional().isBoolean(),
  body('css_template_id').optional({ nullable: true, checkFalsy: true }).isInt(),
  // Hero logo settings
  body('hero_logo_visible').optional().isBoolean(),
  body('hero_logo_size').optional().isIn(['small', 'medium', 'large', 'xlarge']),
  body('hero_logo_position').optional().isIn(['top', 'center', 'bottom']),
  // Header style settings (decoupled from layout)
  body('header_style').optional().isIn(['hero', 'standard', 'banner', 'minimal', 'none']),
  body('hero_divider_style').optional().isIn(['wave', 'straight', 'angle', 'curve', 'none']),
  // Hero image anchor position (#162) – accepts legacy keywords or "X% Y%" focal point
  body('hero_image_anchor').optional().custom(validateHeroImageAnchor),
  // Client access settings (#172)
  body('client_access_enabled').optional().isBoolean(),
  body('client_password').optional().isString(),
  body('default_photo_sort').optional().isIn([
    'upload_date_desc', 'upload_date_asc',
    'capture_date_desc', 'capture_date_asc',
    'filename_asc', 'filename_desc'
  ]),
  // Per-event promotional override (#440). Three-way mode:
  //   inherit → fall back to global branding_promo_markdown
  //   custom  → render this event's promo_markdown verbatim
  //   off     → suppress entirely for this event
  body('promo_mode').optional().isIn(['inherit', 'custom', 'off']),
  body('promo_markdown').optional({ nullable: true }).isString(),
  // Per-event opt-in for using hero photo as the social-share preview
  // image (#474). When false (default), galleryOgService falls back to
  // the brand logo for og:image / Twitter Card.
  body('og_image_share_enabled').optional().isBoolean(),
  // Customer accounts assigned to this event (#354). Optional array of
  // customer_accounts.id — many-to-many via event_customer_assignments.
  body('customer_account_ids').optional().isArray(),
  body('customer_account_ids.*').optional().isInt({ min: 1 })
], async (req, res) => {
  try {
    logger.debug('Create event request body', { body: req.body });
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.error('Validation errors:', errors.array());
      return res.status(400).json({ errors: errors.array() });
    }

    // Get field requirements from settings
    const fieldRequirements = await getEventFieldRequirements();

    const {
      event_type,
      event_name,
      event_date,
      // Migration 137 — calendar time fields. is_full_day defaults to
      // true at the service layer when undefined (legacy form payloads).
      event_time_start,
      event_time_end,
      is_full_day,
      admin_email,
      password,
      welcome_message = '',
      color_theme = null,
      expiration_days = 30,
      allow_user_uploads = false,
      upload_category_id = null,
      allow_downloads = true,
      disable_right_click = false,
      enable_devtools_protection: enableDevtoolsProtectionInput,
      watermark_downloads = false,
      watermark_text = null,
      allow_presigned_download = false,
      require_password: requirePasswordInput,
      // Feedback settings
      feedback_enabled: feedbackEnabledInput,
      allow_ratings = true,
      allow_likes = true,
      allow_comments = true,
      allow_favorites = true,
      require_name_email = false,
      moderate_comments = true,
      show_feedback_to_guests = true,
      // CSS Template
      css_template_id = null,
      // Hero logo settings
      hero_logo_visible = true,
      hero_logo_size = 'medium',
      hero_logo_position = 'top',
      // Header style settings
      header_style = 'standard',
      hero_divider_style = 'wave',
      // Hero image anchor position (#162)
      hero_image_anchor = 'center',
      // Photo cap
      photo_cap = null,
      // Client access settings (#172)
      client_access_enabled = false,
      client_password = null,
      // Draft mode
      is_draft = true,
      // Default photo sort
      default_photo_sort = 'upload_date_desc'
    } = req.body;

    const customerName = getCustomerNameFromPayload(req.body);
    const customerEmail = getCustomerEmailFromPayload(req.body);
    // Phone field is opt-in via the global setting (#322). If disabled,
    // ignore whatever the client posted — defence in depth against form
    // bypass.
    const phoneEnabled = await isPhoneFieldEnabled();
    const customerPhone = phoneEnabled ? getCustomerPhoneFromPayload(req.body) : null;

    const customerColumnsAvailable = await hasCustomerContactColumns();

    // Conditional validation based on settings
    const validationErrors = [];
    if (fieldRequirements.require_customer_name && !customerName) {
      validationErrors.push({ path: 'customer_name', msg: 'Customer name is required' });
    }
    if (fieldRequirements.require_customer_email && !customerEmail) {
      validationErrors.push({ path: 'customer_email', msg: 'Customer email is required' });
    }
    if (fieldRequirements.require_admin_email && !admin_email) {
      validationErrors.push({ path: 'admin_email', msg: 'Admin email is required' });
    }
    if (fieldRequirements.require_event_date && !event_date) {
      validationErrors.push({ path: 'event_date', msg: 'Event date is required' });
    }

    if (validationErrors.length > 0) {
      return res.status(400).json({ errors: validationErrors });
    }

    // Default require_password from global "event_default_require_password"
    // setting when the body omits it (#317 — admins want to flip the default).
    let requirePasswordFallback = true;
    if (requirePasswordInput === undefined) {
      const setting = await readBooleanSetting('event_default_require_password');
      if (setting !== undefined) requirePasswordFallback = setting;
    }
    const requirePassword = parseBooleanInput(requirePasswordInput, requirePasswordFallback);

    // Default feedback_enabled from global "event_default_feedback_enabled"
    // setting when the body omits it (#520 — same pattern as require_password
    // above, lets admins make Guest Feedback ON the out-of-box default for
    // new events instead of toggling it on every time).
    let feedbackEnabledFallback = false;
    if (feedbackEnabledInput === undefined) {
      const setting = await readBooleanSetting('event_default_feedback_enabled');
      if (setting !== undefined) feedbackEnabledFallback = setting;
    }
    const feedback_enabled = parseBooleanInput(feedbackEnabledInput, feedbackEnabledFallback);

    // Debug logging
    logger.debug('Download control values', {
      allow_downloads,
      disable_right_click,
      watermark_downloads,
      watermark_text,
      require_password: requirePassword,
      types: {
        allow_downloads: typeof allow_downloads,
        disable_right_click: typeof disable_right_click,
        watermark_downloads: typeof watermark_downloads
      }
    });
    
    let passwordValidation = null;

    if (requirePassword) {
      passwordValidation = await validatePasswordInContext(password, 'gallery', {
        eventName: event_name
      });

      if (!passwordValidation.valid) {
        return res.status(400).json({ 
          error: 'Password does not meet security requirements',
          details: passwordValidation.errors,
          score: passwordValidation.score,
          feedback: passwordValidation.feedback
        });
      }
    }
    
    // Generate unique slug. Uses the shared util so accented names
    // (Família, Decoração, etc.) get transliterated instead of dropped
    // — see backend/src/utils/slug.js for the why (#525).
    const processedEventName = slugify(event_name);

    // Use event_date in slug if provided, otherwise use random suffix
    const slugSuffix = event_date || crypto.randomBytes(3).toString('hex');
    const baseSlug = `${event_type}-${processedEventName}-${slugSuffix}`;
    let slug = baseSlug;
    let counter = 1;

    while (await db('events').where({ slug }).first()) {
      slug = `${baseSlug}-${counter}`;
      counter++;
    }
    
    // Generate share link respecting configured format
    const shareToken = crypto.randomBytes(16).toString('hex');
    const { shareUrl, shareLinkToStore } = await buildShareLinkVariants({ slug, shareToken });
    
    // Hash password with configurable rounds (random placeholder when not required)
    const password_hash = requirePassword
      ? await bcrypt.hash(password, getBcryptRounds())
      : await bcrypt.hash(crypto.randomBytes(32).toString('hex'), getBcryptRounds());
    
    // Calculate expiration date (days after event date)
    // If expiration is not required, expires_at will be null (never expires)
    // If event_date is not provided, use current date as base for expiration
    let expires_at = null;
    if (fieldRequirements.require_expiration) {
      const baseDate = event_date || new Date().toISOString().split('T')[0];
      // Parse YYYY-MM-DD format as local date to avoid timezone issues
      if (baseDate.match(/^\d{4}-\d{2}-\d{2}$/)) {
        const [year, month, day] = baseDate.split('-').map(num => parseInt(num, 10));
        expires_at = new Date(year, month - 1, day);
      } else {
        expires_at = new Date(baseDate);
      }
      expires_at.setDate(expires_at.getDate() + parseInt(expiration_days, 10));
    }
    
    // Create folder structure
    const storagePath = process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');
    const eventPath = path.join(storagePath, 'events/active', slug);
    await fs.mkdir(path.join(eventPath, 'collages'), { recursive: true });
    await fs.mkdir(path.join(eventPath, 'individual'), { recursive: true });
    
    // Sync header_style / hero_divider_style from color_theme JSON when not
    // explicitly provided in the request body (#158).
    let effectiveHeaderStyle = header_style;
    let effectiveDividerStyle = hero_divider_style;
    if (color_theme && (!req.body.header_style || !req.body.hero_divider_style)) {
      try {
        if (typeof color_theme === 'string' && color_theme.startsWith('{')) {
          const parsed = JSON.parse(color_theme);
          if (!req.body.header_style && parsed.headerStyle) {
            effectiveHeaderStyle = parsed.headerStyle;
          }
          if (!req.body.hero_divider_style && parsed.heroDividerStyle) {
            effectiveDividerStyle = parsed.heroDividerStyle;
          }
        }
      } catch (_) {
        // color_theme is not JSON – nothing to extract
      }
    }

    // Get branding defaults for hero logo settings (Feature 7: Branding Inheritance)
    const brandingDefaults = await getBrandingDefaults();
    const effectiveHeroLogoVisible = req.body.hero_logo_visible !== undefined ? hero_logo_visible : brandingDefaults.hero_logo_visible;
    const effectiveHeroLogoSize = req.body.hero_logo_size || brandingDefaults.hero_logo_size;
    const effectiveHeroLogoPosition = req.body.hero_logo_position || brandingDefaults.hero_logo_position;

    // Inherit "Detect dev tools" from the global Image Security setting unless
    // the request explicitly overrides it (#317 — admin disabled it globally
    // but new events still got it ON because the column default is true).
    const protectionDefaults = await getDownloadProtectionDefaults();
    const effectiveEnableDevtoolsProtection =
      enableDevtoolsProtectionInput !== undefined
        ? enableDevtoolsProtectionInput
        : protectionDefaults.enable_devtools_protection !== undefined
          ? protectionDefaults.enable_devtools_protection
          : true;

    // Migration 137 — normalise calendar time triple. Throws AppError
    // 400 when is_full_day=false but times are malformed/inverted.
    const calendarTriple = normaliseEventTimeTriple({
      event_time_start, event_time_end, is_full_day,
    });
    const calendarColumnsExist = await hasColumnCached('events', 'is_full_day');

    // Insert into database
    // Seed the new event's Live Slideshow display style from the PICPEAK-WIDE
    // preset (app_settings, Settings → Slideshow). New events inherit it and the
    // admin can still override per event. Watermark is left NULL = inherit the
    // global watermark; the share token is minted on demand, not seeded. Guarded
    // so un-migrated installs (mid-branch) don't reference missing columns.
    let slideshowSeed = {};
    if (await hasColumnCached('events', 'show_interval_ms')) {
      try {
        const intP = (v, min, max) => (Number.isFinite(+v) ? Math.min(max, Math.max(min, parseInt(v, 10))) : undefined);
        const oneOf = (v, allowed) => (allowed.includes(v) ? v : undefined);
        const i = intP(await getAppSetting('slideshow_interval_ms', undefined), 1000, 120000);
        const tr = oneOf(await getAppSetting('slideshow_transition', undefined), SLIDESHOW_TRANSITIONS);
        const tms = intP(await getAppSetting('slideshow_transition_ms', undefined), 100, 5000);
        const cf = oneOf(await getAppSetting('slideshow_colorfilter', undefined), SLIDESHOW_COLORFILTERS);
        if (i !== undefined) slideshowSeed.show_interval_ms = i;
        if (tr) slideshowSeed.show_transition = tr;
        if (tms !== undefined) slideshowSeed.show_transition_ms = tms;
        if (cf) slideshowSeed.show_colorfilter = cf;
      } catch (e) {
        logger.warn('Failed to seed slideshow settings from global preset', { error: e.message });
      }
    }

    const insertResult = await db('events').insert({
      slug,
      event_type,
      event_name,
      ...slideshowSeed,
      event_date: event_date || null,
      ...(calendarColumnsExist ? {
        event_time_start: calendarTriple.event_time_start,
        event_time_end: calendarTriple.event_time_end,
        is_full_day: formatBoolean(calendarTriple.is_full_day),
      } : {}),
      ...(customerColumnsAvailable ? { customer_name: customerName, customer_email: customerEmail } : {}),
      ...(customerPhone ? { customer_phone: customerPhone } : {}),
      host_name: customerName || null,
      host_email: customerEmail || null,
      admin_email: admin_email || null,
      password_hash,
      welcome_message,
      color_theme,
      share_link: shareLinkToStore,
      share_token: shareToken,
      expires_at: expires_at ? expires_at.toISOString() : null,
      created_at: new Date().toISOString(),
      created_by: req.admin.id,
      allow_user_uploads,
      upload_category_id,
      allow_downloads: formatBoolean(allow_downloads !== undefined ? allow_downloads : true),
      disable_right_click: formatBoolean(disable_right_click !== undefined ? disable_right_click : false),
      enable_devtools_protection: formatBoolean(effectiveEnableDevtoolsProtection),
      watermark_downloads: formatBoolean(watermark_downloads !== undefined ? watermark_downloads : false),
      watermark_text,
      allow_presigned_download: formatBoolean(allow_presigned_download === true || allow_presigned_download === 'true'),
      require_password: formatBoolean(requirePassword),
      css_template_id: css_template_id || null,
      hero_logo_visible: formatBoolean(effectiveHeroLogoVisible),
      hero_logo_size: effectiveHeroLogoSize,
      hero_logo_position: effectiveHeroLogoPosition,
      header_style: effectiveHeaderStyle || 'standard',
      hero_divider_style: effectiveDividerStyle || 'wave',
      hero_image_anchor: hero_image_anchor || 'center',
      photo_cap: photo_cap || null,
      is_draft: formatBoolean(parseBooleanInput(is_draft, true)),
      default_photo_sort: default_photo_sort || 'upload_date_desc',
      // Client access (#172)
      client_access_enabled: formatBoolean(client_access_enabled),
      ...(client_access_enabled && client_password ? {
        client_password_hash: await bcrypt.hash(client_password, getBcryptRounds()),
        client_share_token: crypto.randomBytes(32).toString('hex')
      } : {}),
      // Per-event opt-in for hero-photo OG share image (#474). Defaults
      // false on create — admin opts in from the event detail page once
      // they've picked a hero they're comfortable surfacing publicly.
      og_image_share_enabled: formatBoolean(req.body.og_image_share_enabled === true),
    }).returning('id');
    
    // Handle both PostgreSQL (returns array of objects) and SQLite (returns array of IDs)
    const eventId = insertResult[0]?.id || insertResult[0];

    // Apply customer-account assignments (#354). Skip when the customer
    // portal flag is off — the frontend hides the picker in that case,
    // but a stale tab could still POST customer_account_ids; we ignore
    // them rather than 403 the entire create.
    if (Array.isArray(req.body.customer_account_ids)) {
      try {
        const customerAccountsService = require('../services/customerAccountsService');
        if (await customerAccountsService.isCustomerPortalEnabled()) {
          await customerAccountsService.setAssignmentsForEvent(
            eventId,
            req.body.customer_account_ids,
            req.admin.id
          );
        }
      } catch (e) {
        logger.error('Failed to set customer assignments on event create', {
          eventId, error: e.message,
        });
      }
    }

    // Insert feedback settings if feedback is enabled
    if (feedback_enabled) {
      await db('event_feedback_settings').insert({
        event_id: eventId,
        feedback_enabled: formatBoolean(feedback_enabled),
        allow_ratings: formatBoolean(allow_ratings),
        allow_likes: formatBoolean(allow_likes),
        allow_comments: formatBoolean(allow_comments),
        allow_favorites: formatBoolean(allow_favorites),
        require_name_email: formatBoolean(require_name_email),
        moderate_comments: formatBoolean(moderate_comments),
        show_feedback_to_guests: formatBoolean(show_feedback_to_guests),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
    }
    
    // Log activity
    await logActivity('event_created',
      { event_type, expires_at, require_password: requirePassword, password_strength: passwordValidation?.score },
      eventId,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );

    // Fire event.created webhook (#327). If the event is being published
    // immediately (not a draft), event.published also fires below.
    // Payload uses canonical event subject (#341) so receivers always see
    // the same shape (id/slug/event_name + customer contact + share_*).
    try {
      const webhookService = require('../services/webhookService');
      await webhookService.fire('event.created', {
        event: {
          ...webhookService.buildEventSubject({
            id: eventId,
            slug,
            event_name,
            event_type,
            event_date,
            share_url: shareUrl,
            share_token: shareToken,
            customer_name: customerName,
            customer_email: customerEmail,
            customer_phone: customerPhone,
          }),
          is_draft: parseBooleanInput(is_draft, true),
        },
      });
    } catch (e) { /* webhookService.fire never throws but be defensive */ }

    // Queue creation email (only if there is a recipient and event is not a draft)
    // Language detection is handled by email processor
    const isDraft = parseBooleanInput(is_draft, true);

    if (customerEmail && !isDraft) {
      // Build email data with optional client access info
      const emailData = {
        customer_name: customerName,
        customer_email: customerEmail,
        host_name: customerName || (customerEmail ? customerEmail.split('@')[0] : null),
        event_name,
        event_date: event_date,  // Pass raw date - will be formatted by email processor
        gallery_link: shareUrl,
        gallery_password: requirePassword ? password : 'No password required',
        expiry_date: expires_at ? expires_at.toISOString() : null,  // Pass ISO string - will be formatted by email processor
        welcome_message: welcome_message || ''
      };

      // Include client access info in email when enabled (#172)
      if (client_access_enabled && client_password) {
        const createdEvent = await db('events').where('id', eventId).first();
        const frontendUrl = process.env.FRONTEND_URL || process.env.APP_URL || '';
        emailData.client_link = `${frontendUrl}/gallery/${slug}/client-access?token=${createdEvent.client_share_token}`;
        emailData.client_password = client_password;
      }

      await db('email_queue').insert({
        event_id: eventId,
        recipient_email: customerEmail,
        email_type: 'gallery_created',
        email_data: JSON.stringify(emailData),
        status: 'pending',
        created_at: new Date()
        // scheduled_at will use default value
      });
    }

    // WhatsApp gallery_ready notification (#640D). Fires when the event is
    // created NOT as a draft, the `whatsapp` flag is on, a config exists, and
    // the customer supplied a phone number. Non-fatal: a queue failure should
    // never block gallery creation.
    if (!isDraft && customerPhone) {
      try {
        const { queueWhatsapp, getWhatsAppConfig } = require('../services/whatsappProcessor');
        const waConfig = await getWhatsAppConfig();
        if (waConfig && waConfig.enabled) {
          await queueWhatsapp(eventId, customerPhone, 'gallery_created', {
            customer_name: customerName || '',
            event_name,
            gallery_link: shareUrl,
            gallery_password: requirePassword ? password : '',
            expiry_date: expires_at ? expires_at.toISOString() : null,
            language: null, // resolved by processor via general_default_language
          });
        }
      } catch (waError) {
        logger.warn('Failed to queue WhatsApp notification on create', { error: waError.message });
      }
    }

    // Fire event.published when the event is created NOT as a draft. The
    // separate /publish endpoint fires it for the draft → live transition;
    // this covers the "create-and-publish in one shot" path.
    if (!isDraft) {
      try {
        const webhookService = require('../services/webhookService');
        await webhookService.fire('event.published', {
          event: webhookService.buildEventSubject({
            id: eventId,
            slug,
            event_name,
            event_type,
            event_date,
            share_url: shareUrl,
            share_token: shareToken,
            customer_name: customerName,
            customer_email: customerEmail,
            customer_phone: customerPhone,
          }),
        });
      } catch (e) { /* non-fatal */ }
    }

    res.json({
      id: eventId,
      slug,
      event_name,
      event_type,
      customer_name: customerName,
      customer_email: customerEmail,
      require_password: requirePassword,
      photo_cap: photo_cap || null,
      is_draft: isDraft,
      share_link: shareUrl,
      expires_at: expires_at ? expires_at.toISOString() : null,
      created_at: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error creating event:', error);
    res.status(500).json({ error: 'Failed to create event' });
  }
});

// Get all events with pagination and filters
router.get('/', adminAuth, requirePermission('events.view'), async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const status = req.query.status || 'all';
    const allowedSortBy = ['created_at', 'event_name', 'slug', 'updated_at', 'expires_at', 'capture_date'];
    const sortBy = allowedSortBy.includes(req.query.sortBy) ? req.query.sortBy : 'created_at';
    const sortOrder = ['asc', 'desc'].includes(req.query.sortOrder) ? req.query.sortOrder : 'desc';

    // Build query
    let query = db('events');

    // Editor role can only see their own events
    if (req.admin.roleName === 'editor') {
      query = query.where('created_by', req.admin.id);
    }

    // Apply search filter
    if (search) {
      const escapedSearch = escapeLikePattern(search);
      query = query.where((builder) => {
        builder.where('event_name', 'like', `%${escapedSearch}%`)
          .orWhere('admin_email', 'like', `%${escapedSearch}%`)
          .orWhere('customer_email', 'like', `%${escapedSearch}%`)
          .orWhere('slug', 'like', `%${escapedSearch}%`);
      });
    }

    // Apply status filter
    if (status === 'active') {
      query = query.where('is_active', formatBoolean(true)).where('is_archived', formatBoolean(false));
    } else if (status === 'archived') {
      query = query.where('is_archived', formatBoolean(true));
    } else if (status === 'inactive') {
      query = query.where('is_active', formatBoolean(false)).where('is_archived', formatBoolean(false));
    } else if (status === 'draft') {
      query = query.where('is_draft', formatBoolean(true));
    } else if (status === 'expiring') {
      const sevenDaysFromNow = new Date();
      sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);
      query = query
        .where('is_active', formatBoolean(true))
        .where('is_archived', formatBoolean(false))
        .where('expires_at', '<=', sevenDaysFromNow.toISOString())
        .where('expires_at', '>', new Date().toISOString());
    }

    // Get total count for pagination
    const countQuery = query.clone();
    const [{ count }] = await countQuery.count('* as count');

    // Apply sorting and pagination
    const events = await query
      .orderBy(sortBy, sortOrder)
      .limit(limit)
      .offset(offset);

    // Get photo counts for each event
    const eventIds = events.map(e => e.id);
    const photoCounts = await db('photos')
      .whereIn('event_id', eventIds)
      .groupBy('event_id')
      .select('event_id')
      .count('* as count');

    // Map photo counts to events
    const photoCountMap = photoCounts.reduce((acc, { event_id, count }) => {
      acc[event_id] = parseInt(count);
      return acc;
    }, {});

    // Add photo counts to events and convert dates
    const eventsWithCounts = events.map(event => ({
      ...event,
      photo_count: photoCountMap[event.id] || 0,
      // Convert Unix timestamps to ISO strings
      created_at: event.created_at ? new Date(event.created_at).toISOString() : null,
      expires_at: event.expires_at ? new Date(event.expires_at).toISOString() : null,
      archived_at: event.archived_at ? new Date(event.archived_at).toISOString() : null
    })).map(mapEventForApi);

    res.json({
      events: eventsWithCounts,
      pagination: {
        page,
        limit,
        total: parseInt(count),
        totalPages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching events:', error);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

// Get single event details
router.get('/:id', adminAuth, requirePermission('events.view'), async (req, res) => {
  try {
    const { id } = req.params;

    let query = db('events').where('id', id);

    // Editor role can only see their own events
    if (req.admin.roleName === 'editor') {
      query = query.where('created_by', req.admin.id);
    }

    const event = await query.first();

    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Get photo count
    const [{ count: photoCount }] = await db('photos')
      .where('event_id', id)
      .count('* as count');

    // Get total size
    const [{ totalSize }] = await db('photos')
      .where('event_id', id)
      .sum('size_bytes as totalSize');

    // Get recent photos
    const recentPhotos = await db('photos')
      .where('event_id', id)
      .orderBy('uploaded_at', 'desc')
      .limit(10)
      .select('filename', 'type', 'size_bytes', 'uploaded_at');

    // Get view and download statistics
    const [{ totalViews }] = await db('access_logs')
      .where('event_id', id)
      .where('action', 'view')
      .count('* as totalViews');

    const [{ totalDownloads }] = await db('access_logs')
      .where('event_id', id)
      .where('action', 'download')
      .count('* as totalDownloads');

    const [{ uniqueVisitors }] = await db('access_logs')
      .where('event_id', id)
      .countDistinct('ip_address as uniqueVisitors');

    // Customer accounts assigned to this event (#354). Hydrates the
    // CustomerAccountPicker on the EventDetailsPage admin form. Returns
    // an empty array on installs missing the table (e.g. pre-migrate).
    let customerAccounts = [];
    try {
      const customerAccountsService = require('../services/customerAccountsService');
      customerAccounts = await customerAccountsService.getAssignmentsForEvent(parseInt(id, 10));
    } catch (e) {
      logger.warn('Failed to load customer assignments for event', { eventId: id, error: e.message });
    }

    res.json(mapEventForApi({
      ...event,
      photo_count: parseInt(photoCount) || 0,
      total_size: parseInt(totalSize) || 0,
      total_views: parseInt(totalViews) || 0,
      total_downloads: parseInt(totalDownloads) || 0,
      unique_visitors: parseInt(uniqueVisitors) || 0,
      recent_photos: recentPhotos,
      customer_accounts: customerAccounts.map((c) => ({
        id: c.id,
        email: c.email,
        display_name: c.display_name,
        first_name: c.first_name,
        last_name: c.last_name,
      })),
    }));
  } catch (error) {
    console.error('Error fetching event:', error);
    res.status(500).json({ error: 'Failed to fetch event details' });
  }
});

// Publish a draft event (set is_draft=false and queue creation email)
router.post('/:id/publish', adminAuth, requirePermission('events.edit'), requireEventOwnership, [
  // Optional password the admin re-types in the publish dialog so the
  // gallery_created email can carry the actual plaintext (#627). When the
  // event is password-protected and the body carries a password, picpeak
  // re-hashes + writes `password_hash` (the admin may have mistyped at
  // creation; this guarantees the email content matches the live login
  // password). When omitted, behaviour is the legacy sentinel for backward
  // compat with API-only consumers.
  body('password').optional().isString().isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters long'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { id } = req.params;
    const { password } = req.body;
    const event = await db('events').where('id', id).first();

    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    if (!parseBooleanInput(event.is_draft, false)) {
      return res.status(400).json({ error: 'Event is already published' });
    }

    const requirePassword = parseBooleanInput(event.require_password, true);
    const publishUpdates = { is_draft: formatBoolean(false) };
    if (requirePassword && password) {
      // Re-hash so the stored hash matches what the email carries — even if
      // the admin mistypes vs. what was set at draft creation, the gallery
      // password the customer receives is the one that actually works.
      publishUpdates.password_hash = await bcrypt.hash(password, getBcryptRounds());
    }
    await db('events').where('id', id).update(publishUpdates);

    // Queue creation email
    const customerEmail = event.customer_email || event.host_email;
    const customerName = event.customer_name || event.host_name;
    if (customerEmail) {
      const frontendBase = await getFrontendBaseUrl();
      const { shareUrl } = await buildShareLinkVariants({ slug: event.slug, shareToken: event.share_token });

      let galleryPasswordForEmail;
      if (!requirePassword) {
        galleryPasswordForEmail = 'No password required';
      } else if (password) {
        // Admin re-typed the password in the publish dialog — put it straight
        // into the email so the customer can actually log in (#627).
        galleryPasswordForEmail = password;
      } else {
        // Legacy fallback for API-only publishes that don't carry the password.
        galleryPasswordForEmail = '(set at creation)';
      }

      const emailData = {
        customer_name: customerName,
        customer_email: customerEmail,
        host_name: customerName || (customerEmail ? customerEmail.split('@')[0] : null),
        event_name: event.event_name,
        event_date: event.event_date,
        gallery_link: shareUrl || `${frontendBase}/gallery/${event.slug}`,
        gallery_password: galleryPasswordForEmail,
        expiry_date: event.expires_at ? new Date(event.expires_at).toISOString() : null,
        welcome_message: event.welcome_message || ''
      };

      await db('email_queue').insert({
        event_id: id,
        recipient_email: customerEmail,
        email_type: 'gallery_created',
        email_data: JSON.stringify(emailData),
        status: 'pending',
        created_at: new Date()
      });
    } else {
      // No inline email, but the gallery may be assigned to registered customer
      // account(s). Notify them via the account "your galleries" email
      // (customer_gallery_assigned, in the customer's own language) instead of
      // the gallery_created mail, which needs an inline recipient. Best-effort.
      try {
        const customerAccountsService = require('../services/customerAccountsService');
        const assigned = await customerAccountsService.getAssignmentsForEvent(parseInt(id, 10));
        for (const c of assigned.filter((a) => a.is_active !== false && a.is_active !== 0 && a.email)) {
          await customerAccountsService
            .notifyCustomerOfNewAssignments(c.id, [parseInt(id, 10)])
            .catch((err) => logger.warn('Publish: customer gallery notice failed', { customerId: c.id, error: err.message }));
        }
      } catch (err) {
        logger.warn('Publish: assigned-customer notification skipped', { eventId: id, error: err.message });
      }
    }

    // WhatsApp gallery_ready on publish-from-draft (#640D). The PublishGallery
    // dialog (#627) hands us the password back so we can deliver it via
    // WhatsApp as well. Uses customer_phone from the persisted event row.
    if (event.customer_phone) {
      try {
        const { queueWhatsapp, getWhatsAppConfig } = require('../services/whatsappProcessor');
        const waConfig = await getWhatsAppConfig();
        if (waConfig && waConfig.enabled) {
          const { shareUrl: shareUrlForWa } = await buildShareLinkVariants({
            slug: event.slug, shareToken: event.share_token,
          });
          await queueWhatsapp(parseInt(id, 10), event.customer_phone, 'gallery_created', {
            customer_name: event.customer_name || event.host_name || '',
            event_name: event.event_name,
            gallery_link: shareUrlForWa || `${await getFrontendBaseUrl()}/gallery/${event.slug}`,
            // Plaintext only when the admin re-typed at publish; otherwise
            // omit so the buildComponents() helper renders an empty {{4}}
            // line instead of leaking the "(set at creation)" sentinel.
            gallery_password: requirePassword && password ? password : '',
            expiry_date: event.expires_at ? new Date(event.expires_at).toISOString() : null,
            language: null, // resolved by processor via general_default_language
          });
        }
      } catch (waError) {
        logger.warn('Failed to queue WhatsApp notification on publish', { error: waError.message });
      }
    }

    await logActivity('event_published',
      { event_name: event.event_name },
      id,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );

    // Fire event.published webhook (#327) — draft → live transition.
    // Canonical payload (#341): includes customer contact + share_token.
    try {
      const webhookService = require('../services/webhookService');
      const { shareUrl } = await buildShareLinkVariants({ slug: event.slug, shareToken: event.share_token });
      await webhookService.fire('event.published', {
        event: webhookService.buildEventSubject({
          id: parseInt(id, 10),
          slug: event.slug,
          event_name: event.event_name,
          event_type: event.event_type,
          event_date: event.event_date,
          share_url: shareUrl,
          share_token: event.share_token,
          customer_name: event.customer_name || event.host_name,
          customer_email: event.customer_email || event.host_email,
          customer_phone: event.customer_phone,
        }),
      });
    } catch (e) { /* non-fatal */ }

    res.json({ message: 'Event published successfully', is_draft: false });
  } catch (error) {
    logger.error('Error publishing event:', { error: error.message });
    res.status(500).json({ error: 'Failed to publish event' });
  }
});

// Duplicate an event (#626). Creates a new DRAFT gallery that inherits the
// source event's branding, behaviour, hero/header, feedback, and category
// configuration — admin then fills in customer + publishes via the publish
// dialog (#627), where the password is set. Photos, hero photo selection,
// client-access secrets, customer assignments, archive/sent state are NOT
// carried over.
router.post('/:id/duplicate', adminAuth, requirePermission('events.create'), requireEventOwnership, [
  body('event_name').trim().notEmpty().withMessage('Event name is required'),
  body('event_date').optional({ values: 'falsy' }).isDate(),
  body('customer_name').optional().trim(),
  body('customer_email').optional({ values: 'falsy' }).isEmail().normalizeEmail(IDENTITY_PRESERVING_NORMALIZE_EMAIL),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { id } = req.params;
    const source = await db('events').where('id', id).first();
    if (!source) {
      return res.status(404).json({ error: 'Source event not found' });
    }

    const { event_name, event_date, customer_name, customer_email } = req.body;

    // Generate a fresh unique slug using the same shape as the create path.
    const slugify = require('../utils/slug').slugify;
    const processedEventName = slugify(event_name);
    const slugSuffix = event_date || crypto.randomBytes(3).toString('hex');
    const baseSlug = `${source.event_type}-${processedEventName}-${slugSuffix}`;
    let slug = baseSlug;
    let counter = 1;
    // eslint-disable-next-line no-await-in-loop
    while (await db('events').where({ slug }).first()) {
      slug = `${baseSlug}-${counter}`;
      counter += 1;
    }

    // Recompute expires_at: preserve the source's expiration window (delta
    // between source.expires_at and source.event_date) so the duplicate keeps
    // the same "active for N days" feel. Falls back to 30 days if source had
    // no expiration set.
    let newExpiresAt = null;
    if (event_date) {
      let expirationDays = 30;
      if (source.expires_at && source.event_date) {
        const days = Math.round(
          (new Date(source.expires_at).getTime() - new Date(source.event_date).getTime())
          / (24 * 60 * 60 * 1000),
        );
        if (days > 0) expirationDays = days;
      }
      const [year, month, day] = event_date.split('-').map((s) => parseInt(s, 10));
      const baseDate = new Date(year, month - 1, day);
      baseDate.setDate(baseDate.getDate() + expirationDays);
      newExpiresAt = baseDate;
    }

    const shareToken = crypto.randomBytes(16).toString('hex');
    const { shareLinkToStore } = await buildShareLinkVariants({ slug, shareToken });

    // Random-placeholder password hash. When the admin publishes via the
    // PublishGalleryDialog (#627), the dialog re-hashes whatever they type and
    // overwrites this. Pattern matches the create path at line ~606.
    const password_hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), getBcryptRounds());

    // Create the storage folder structure (same as create path).
    const storagePath = process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');
    const eventPath = path.join(storagePath, 'events/active', slug);
    await fs.mkdir(path.join(eventPath, 'collages'), { recursive: true });
    await fs.mkdir(path.join(eventPath, 'individual'), { recursive: true });

    const customerColumnsAvailable = await hasCustomerContactColumns();
    const calendarColumnsExist = await hasColumnCached('events', 'is_full_day');

    // Build the insert row. Copy behaviour + branding fields from source;
    // leave per-gallery secrets / state / photos blank.
    const insertResult = await db('events').insert({
      slug,
      event_type: source.event_type,
      event_name,
      event_date: event_date || null,
      ...(calendarColumnsExist ? {
        event_time_start: source.event_time_start,
        event_time_end: source.event_time_end,
        is_full_day: source.is_full_day,
      } : {}),
      ...(customerColumnsAvailable ? {
        customer_name: customer_name || null,
        customer_email: customer_email || null,
      } : {}),
      host_name: customer_name || null,
      host_email: customer_email || null,
      admin_email: source.admin_email || null,
      password_hash,
      welcome_message: source.welcome_message || '',
      color_theme: source.color_theme,
      share_link: shareLinkToStore,
      share_token: shareToken,
      expires_at: newExpiresAt ? newExpiresAt.toISOString() : null,
      created_at: new Date().toISOString(),
      created_by: req.admin.id,
      allow_user_uploads: source.allow_user_uploads,
      upload_category_id: source.upload_category_id,
      allow_downloads: source.allow_downloads,
      disable_right_click: source.disable_right_click,
      enable_devtools_protection: source.enable_devtools_protection,
      watermark_downloads: source.watermark_downloads,
      watermark_text: source.watermark_text,
      allow_presigned_download: source.allow_presigned_download,
      require_password: source.require_password,
      css_template_id: source.css_template_id || null,
      hero_logo_visible: source.hero_logo_visible,
      hero_logo_size: source.hero_logo_size,
      hero_logo_position: source.hero_logo_position,
      header_style: source.header_style || 'standard',
      hero_divider_style: source.hero_divider_style || 'wave',
      hero_image_anchor: source.hero_image_anchor || 'center',
      photo_cap: source.photo_cap || null,
      is_draft: formatBoolean(true),
      default_photo_sort: source.default_photo_sort || 'upload_date_desc',
      // Client-access secrets and the OG-share opt-in deliberately do NOT
      // carry over — admin re-decides per gallery.
      client_access_enabled: formatBoolean(false),
      og_image_share_enabled: formatBoolean(false),
    }).returning('id');

    const newEventId = insertResult[0]?.id || insertResult[0];

    // Copy event_feedback_settings if the source had a row (only present when
    // feedback_enabled was true on the source event).
    const sourceFeedback = await db('event_feedback_settings').where({ event_id: id }).first();
    if (sourceFeedback) {
      await db('event_feedback_settings').insert({
        event_id: newEventId,
        feedback_enabled: sourceFeedback.feedback_enabled,
        allow_ratings: sourceFeedback.allow_ratings,
        allow_likes: sourceFeedback.allow_likes,
        allow_comments: sourceFeedback.allow_comments,
        allow_favorites: sourceFeedback.allow_favorites,
        require_name_email: sourceFeedback.require_name_email,
        moderate_comments: sourceFeedback.moderate_comments,
        show_feedback_to_guests: sourceFeedback.show_feedback_to_guests,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }

    // Copy per-event photo categories (global categories are not duplicated —
    // they apply to every event already). Mapping by name; photo_categories
    // has no foreign key into photos here so we just clone the rows.
    if (await db.schema.hasTable('photo_categories')) {
      const sourceCategories = await db('photo_categories')
        .where({ event_id: id })
        .where(function () { this.whereNull('is_global').orWhere('is_global', formatBoolean(false)); })
        .select('name', 'slug', 'is_global');
      if (sourceCategories.length > 0) {
        await db('photo_categories').insert(
          sourceCategories.map((c) => ({
            event_id: newEventId,
            name: c.name,
            slug: c.slug,
            is_global: formatBoolean(false),
          })),
        );
      }
    }

    await logActivity('event_duplicated',
      { source_event_id: parseInt(id, 10), source_event_name: source.event_name },
      newEventId,
      { type: 'admin', id: req.admin.id, name: req.admin.username },
    );

    res.json({
      message: 'Event duplicated successfully',
      id: newEventId,
      slug,
      is_draft: true,
    });
  } catch (error) {
    logger.error('Error duplicating event:', { error: error.message });
    res.status(500).json({ error: 'Failed to duplicate event' });
  }
});

// Update event
router.put('/:id', adminAuth, requirePermission('events.edit'), requireEventOwnership, [
  body('event_name').optional().trim().notEmpty(),
  body('event_date').optional({ values: 'falsy' }).isDate(),
  // Migration 137 — calendar time fields. Same regex/range rule as POST.
  body('event_time_start').optional({ values: 'falsy', nullable: true })
    .matches(/^([01]\d|2[0-3]):[0-5]\d$/)
    .withMessage('event_time_start must be HH:MM 24h'),
  body('event_time_end').optional({ values: 'falsy', nullable: true })
    .matches(/^([01]\d|2[0-3]):[0-5]\d$/)
    .withMessage('event_time_end must be HH:MM 24h'),
  body('is_full_day').optional().isBoolean().toBoolean(),
  body('admin_email').optional().isEmail(),
  body('is_active').optional().isBoolean(),
  body('expires_at').optional({ nullable: true, checkFalsy: true }).isISO8601(),
  body('welcome_message').optional({ nullable: true, checkFalsy: true }).trim(),
  body('color_theme').optional({ nullable: true }),
  body('allow_user_uploads').optional().isBoolean(),
  // Migration 143 — per-event reminder overrides. All three are
  // optional; nullable values are accepted so admins can clear an
  // override (e.g. drop a custom offset back to the global default).
  body('event_reminder_disabled').optional().isBoolean(),
  body('event_reminder_offset_days').optional({ nullable: true })
    .custom((v) => v === null || (Number.isInteger(Number(v)) && Number(v) >= 0))
    .withMessage('event_reminder_offset_days must be a non-negative integer or null'),
  body('event_reminder_body_override').optional({ nullable: true, checkFalsy: true })
    .isString().isLength({ max: 10_000 }),
  body('customer_name').optional({ nullable: true, checkFalsy: true }).trim(),
  body('customer_email').optional().isEmail().normalizeEmail(IDENTITY_PRESERVING_NORMALIZE_EMAIL),
  body('customer_phone').optional({ nullable: true, checkFalsy: true })
    .isString().trim()
    .isLength({ max: 32 }).withMessage('Phone number must be at most 32 characters'),
  body('upload_category_id').optional().custom((value) => {
    // Accept null, undefined, or integer values
    if (value === null || value === undefined) return true;
    return Number.isInteger(Number(value));
  }).withMessage('upload_category_id must be an integer or null'),
  body('hero_photo_id').optional().custom((value) => {
    // Accept null, undefined, or numeric values
    if (value === null || value === undefined) return true;
    // Check if it's a number or can be converted to a valid integer
    const num = Number(value);
    return !isNaN(num) && Number.isInteger(num);
  }).withMessage('hero_photo_id must be an integer or null'),
  body('allow_downloads').optional().isBoolean(),
  body('disable_right_click').optional().isBoolean(),
  body('watermark_downloads').optional().isBoolean(),
  body('watermark_text').optional().trim(),
  body('allow_presigned_download').optional().isBoolean(),
  body('source_mode').optional().isIn(['managed', 'reference']),
  body('external_path').optional({ nullable: true }).isString().trim(),
  body('require_password').optional().isBoolean(),
  // Download protection settings
  body('protection_level').optional().isIn(['basic', 'standard', 'enhanced', 'maximum']),
  body('enable_devtools_protection').optional().isBoolean(),
  body('use_canvas_rendering').optional().isBoolean(),
  body('overlay_protection').optional().isBoolean(),
  body('image_quality').optional().isInt({ min: 1, max: 100 }),
  body('fragmentation_level').optional().isInt({ min: 1, max: 10 }),
  body('password').optional().isString().custom((value) => {
    if (value === undefined || value === null || value === '') {
      return true;
    }
    if (typeof value !== 'string' || value.trim().length < 6) {
      throw new Error('Password must be at least 6 characters long');
    }
    return true;
  }),
  body('css_template_id').optional({ nullable: true, checkFalsy: true }).isInt(),
  // Hero logo settings
  body('hero_logo_visible').optional().isBoolean(),
  body('hero_logo_size').optional().isIn(['small', 'medium', 'large', 'xlarge']),
  body('hero_logo_position').optional().isIn(['top', 'center', 'bottom']),
  // Header style settings (decoupled from layout)
  body('header_style').optional().isIn(['hero', 'standard', 'banner', 'minimal', 'none']),
  body('hero_divider_style').optional().isIn(['wave', 'straight', 'angle', 'curve', 'none']),
  // Hero image anchor position (#162) – accepts legacy keywords or "X% Y%" focal point
  body('hero_image_anchor').optional().custom(validateHeroImageAnchor),
  // Client access settings (#172)
  body('client_access_enabled').optional().isBoolean(),
  body('client_password').optional().isString(),
  body('regenerate_client_token').optional().isBoolean(),
  body('default_photo_sort').optional().isIn([
    'upload_date_desc', 'upload_date_asc',
    'capture_date_desc', 'capture_date_asc',
    'filename_asc', 'filename_desc'
  ]),
  // Per-event promotional override (#440). Three-way mode:
  //   inherit → fall back to global branding_promo_markdown
  //   custom  → render this event's promo_markdown verbatim
  //   off     → suppress entirely for this event
  body('promo_mode').optional().isIn(['inherit', 'custom', 'off']),
  body('promo_markdown').optional({ nullable: true }).isString(),
  // Per-event opt-in for using hero photo as the social-share preview
  // image (#474). When false (default), galleryOgService falls back to
  // the brand logo for og:image / Twitter Card.
  body('og_image_share_enabled').optional().isBoolean(),
  // Customer accounts assigned to this event (#354). Optional array of
  // customer_accounts.id — many-to-many via event_customer_assignments.
  body('customer_account_ids').optional().isArray(),
  body('customer_account_ids.*').optional().isInt({ min: 1 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.debug('Update event validation errors', { errors: errors.array(), body: req.body });
      return res.status(400).json({ errors: errors.array() });
    }

    const { id } = req.params;
    const updates = { ...req.body };
    const customerColumnsAvailable = await hasCustomerContactColumns();

    if (Object.prototype.hasOwnProperty.call(updates, 'host_name') || Object.prototype.hasOwnProperty.call(updates, 'host_email')) {
      return res.status(400).json({ error: 'host_name and host_email are no longer supported. Use customer_name and customer_email instead.' });
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'customer_name')) {
      const nextName = getCustomerNameFromPayload(updates);
      if (nextName) {
        if (customerColumnsAvailable) {
          updates.customer_name = nextName;
        } else {
          delete updates.customer_name;
        }
        updates.host_name = nextName;
      } else {
        delete updates.customer_name;
      }
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'customer_email')) {
      const nextEmail = getCustomerEmailFromPayload(updates);
      if (nextEmail) {
        if (customerColumnsAvailable) {
          updates.customer_email = nextEmail;
        } else {
          delete updates.customer_email;
        }
        updates.host_email = nextEmail;
      } else {
        delete updates.customer_email;
      }
    }

    // Phone is gated on the global toggle (#322). Strip from the update
    // unconditionally if disabled — even null/clear is rejected so an
    // admin can't accidentally write to a field they've turned off.
    if (Object.prototype.hasOwnProperty.call(updates, 'customer_phone')) {
      const phoneEnabled = await isPhoneFieldEnabled();
      if (!phoneEnabled) {
        delete updates.customer_phone;
      } else {
        const nextPhone = getCustomerPhoneFromPayload(updates);
        updates.customer_phone = nextPhone || null;
      }
    }

    const hasRequirePasswordUpdate = Object.prototype.hasOwnProperty.call(updates, 'require_password');
    let requirePasswordUpdate;
    if (hasRequirePasswordUpdate) {
      requirePasswordUpdate = parseBooleanInput(updates.require_password, true);
      updates.require_password = formatBoolean(requirePasswordUpdate);
    }

    let newPasswordPlain;
    if (Object.prototype.hasOwnProperty.call(updates, 'password')) {
      if (updates.password === undefined || updates.password === null || updates.password === '') {
        delete updates.password;
      } else {
        newPasswordPlain = updates.password;
        delete updates.password;
      }
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'source_mode')) {
      updates.source_mode = updates.source_mode === 'reference' ? 'reference' : 'managed';
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'external_path')) {
      const trimmedPath = updates.external_path ? String(updates.external_path).trim() : '';
      updates.external_path = trimmedPath || null;
    }

    if (updates.source_mode === 'managed') {
      updates.external_path = null;
    }

    if (updates.source_mode === 'reference' && (updates.external_path === null || updates.external_path === undefined)) {
      return res.status(400).json({ error: 'external_path is required when source_mode is reference' });
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'client_password') && updates.client_password) {
      updates.client_password_hash = await bcrypt.hash(updates.client_password, getBcryptRounds());
      delete updates.client_password;
    } else {
      delete updates.client_password;
    }
    if (updates.regenerate_client_token) {
      updates.client_share_token = crypto.randomBytes(32).toString('hex');
    }
    delete updates.regenerate_client_token;

    // customer_account_ids (#354) is a body-only field consumed
    // separately below by customerAccountsService.setAssignmentsForEvent
    // — it isn't a column on the events table, so spreading it into
    // the UPDATE statement throws "column does not exist" and crashes
    // the entire edit with 500 Failed to update event.
    delete updates.customer_account_ids;

    // Migration 137 — calendar time triple. Renormalise only when at
    // least one of the three fields was supplied; otherwise leave the
    // row's current values alone. is_full_day=true forces both times
    // to null. Drop the fields silently on un-migrated installs.
    const timeFieldsTouched = (
      Object.prototype.hasOwnProperty.call(updates, 'event_time_start')
      || Object.prototype.hasOwnProperty.call(updates, 'event_time_end')
      || Object.prototype.hasOwnProperty.call(updates, 'is_full_day')
    );
    if (timeFieldsTouched) {
      if (await hasColumnCached('events', 'is_full_day')) {
        const triple = normaliseEventTimeTriple({
          event_time_start: updates.event_time_start,
          event_time_end: updates.event_time_end,
          is_full_day: updates.is_full_day,
        });
        updates.event_time_start = triple.event_time_start;
        updates.event_time_end = triple.event_time_end;
        updates.is_full_day = formatBoolean(triple.is_full_day);
      } else {
        delete updates.event_time_start;
        delete updates.event_time_end;
        delete updates.is_full_day;
      }
    }

    // Log the update request for debugging
    logger.debug('Update event request', {
      id,
      updates,
      color_theme_length: updates.color_theme ? updates.color_theme.length : 0,
      color_theme_type: typeof updates.color_theme,
      hero_photo_id: updates.hero_photo_id,
      hero_photo_id_type: typeof updates.hero_photo_id
    });

    // Check if event exists
    let eventQuery = db('events').where('id', id);
    // Editor role can only edit their own events
    if (req.admin.roleName === 'editor') {
      eventQuery = eventQuery.where('created_by', req.admin.id);
    }
    const event = await eventQuery.first();
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const currentRequirePassword = parseBooleanInput(event.require_password, true);

    if (hasRequirePasswordUpdate && requirePasswordUpdate === true && !currentRequirePassword && !newPasswordPlain) {
      return res.status(400).json({ error: 'Password must be provided when enabling password requirement.' });
    }

    if (newPasswordPlain) {
      updates.password_hash = await bcrypt.hash(newPasswordPlain, getBcryptRounds());
    } else if (hasRequirePasswordUpdate && requirePasswordUpdate === false && currentRequirePassword) {
      updates.password_hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), getBcryptRounds());
    }

    // Enforce expires_at requirement based on app settings
    // Allow admins to clear `expires_at` on edit even when the global
    // `event_require_expiration` setting is ON (#426). The setting now
    // controls only the create-time default — once an event exists, an
    // admin editing it can override and remove the expiration. Empty /
    // null values normalize to NULL in the column ("never expires").
    if (Object.prototype.hasOwnProperty.call(updates, 'expires_at') && !updates.expires_at) {
      updates.expires_at = null;
    }

    // Format hero logo settings if provided
    if (Object.prototype.hasOwnProperty.call(updates, 'hero_logo_visible')) {
      updates.hero_logo_visible = formatBoolean(updates.hero_logo_visible);
    }

    // Per-event opt-in for hero-photo OG share image (#474). Coerce so
    // SQLite stores 0/1 and Postgres stores boolean true/false.
    if (Object.prototype.hasOwnProperty.call(updates, 'og_image_share_enabled')) {
      updates.og_image_share_enabled = formatBoolean(updates.og_image_share_enabled === true);
    }

    // Per-event promotional override (#440). Normalize promo_markdown to
    // NULL when mode is anything other than 'custom' so we don't carry
    // stale text after the admin switches modes. Empty markdown also
    // becomes NULL.
    if (Object.prototype.hasOwnProperty.call(updates, 'promo_mode')
      || Object.prototype.hasOwnProperty.call(updates, 'promo_markdown')) {
      const mode = updates.promo_mode;
      if (mode && mode !== 'custom') {
        updates.promo_markdown = null;
      } else if (Object.prototype.hasOwnProperty.call(updates, 'promo_markdown')) {
        const md = typeof updates.promo_markdown === 'string' ? updates.promo_markdown.trim() : '';
        updates.promo_markdown = md || null;
      }
    }

    // Sync header_style / hero_divider_style from color_theme JSON when not
    // explicitly provided in the request body (#158).  This ensures the
    // database columns stay in sync even if the frontend only sends the
    // serialised theme object.
    if (updates.color_theme && !Object.prototype.hasOwnProperty.call(updates, 'header_style')) {
      try {
        const themeStr = typeof updates.color_theme === 'string' ? updates.color_theme : '';
        if (themeStr.startsWith('{')) {
          const parsed = JSON.parse(themeStr);
          if (parsed.headerStyle) {
            updates.header_style = parsed.headerStyle;
          }
          if (parsed.heroDividerStyle && !Object.prototype.hasOwnProperty.call(updates, 'hero_divider_style')) {
            updates.hero_divider_style = parsed.heroDividerStyle;
          }
        }
      } catch (_) {
        // color_theme is not JSON (e.g. preset name) – nothing to extract
      }
    }

    // Handle client access fields (#172)
    if (Object.prototype.hasOwnProperty.call(updates, 'client_access_enabled')) {
      updates.client_access_enabled = formatBoolean(updates.client_access_enabled);
      // Auto-generate client share token when first enabling
      if (parseBooleanInput(updates.client_access_enabled, false) && !event.client_share_token && !updates.client_share_token) {
        updates.client_share_token = crypto.randomBytes(32).toString('hex');
      }
    }

    // Update event
    await db('events')
      .where('id', id)
      .update(updates);

    // Customer-account assignments (#354). Same skip semantics as POST:
    // ignore when the customer portal flag is off so stale tabs don't
    // 4xx the whole edit.
    if (Array.isArray(req.body.customer_account_ids)) {
      try {
        const customerAccountsService = require('../services/customerAccountsService');
        if (await customerAccountsService.isCustomerPortalEnabled()) {
          await customerAccountsService.setAssignmentsForEvent(
            parseInt(id, 10),
            req.body.customer_account_ids,
            req.admin.id
          );
        }
      } catch (e) {
        logger.error('Failed to set customer assignments on event update', {
          eventId: id, error: e.message,
        });
      }
    }

    // Log activity
    await logActivity('event_updated',
      { changes: Object.keys(updates), eventName: event.event_name },
      id,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );

    // Invalidate download zip if watermark settings changed
    const changeKeys = Object.keys(req.body);
    if (changeKeys.includes('watermark_downloads') || changeKeys.includes('watermark_text')) {
      downloadZipService.invalidate(parseInt(id));
    }

    res.json({ message: 'Event updated successfully' });
  } catch (error) {
    console.error('Error updating event:', error);
    res.status(500).json({ error: 'Failed to update event' });
  }
});

// Delete event
router.delete('/:id', adminAuth, requirePermission('events.delete'), requireEventOwnership, async (req, res) => {
  try {
    const { id } = req.params;
    await deleteEventCascade(id, { id: req.admin.id, username: req.admin.username });
    res.json({ message: 'Event deleted successfully' });
  } catch (error) {
    if (error.code === 'EVENT_NOT_FOUND') {
      return res.status(404).json({ error: 'Event not found' });
    }
    logger.error('Error deleting event', { eventId: req.params.id, error: error.message });
    if (error.message && error.message.includes('foreign key constraint')) {
      return res.status(500).json({
        error: 'Cannot delete event due to existing references. Please contact support.'
      });
    }
    res.status(500).json({ error: 'Failed to delete event' });
  }
});

// Toggle event status
router.post('/:id/toggle-status', adminAuth, requirePermission('events.edit'), requireEventOwnership, async (req, res) => {
  try {
    const { id } = req.params;

    let eventQuery = db('events').where('id', id);
    // Editor role can only edit their own events
    if (req.admin.roleName === 'editor') {
      eventQuery = eventQuery.where('created_by', req.admin.id);
    }
    const event = await eventQuery.first();
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const newStatus = !event.is_active;
    await db('events')
      .where('id', id)
      .update({
        is_active: newStatus,
        updated_at: new Date()
      });

    // Log activity
    await logActivity(newStatus ? 'event_activated' : 'event_deactivated',
      { eventName: event.event_name },
      id,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );

    res.json({ 
      message: `Event ${newStatus ? 'activated' : 'deactivated'} successfully`,
      is_active: newStatus
    });
  } catch (error) {
    console.error('Error toggling event status:', error);
    res.status(500).json({ error: 'Failed to toggle event status' });
  }
});

// ---------------------------------------------------------------------------
// Live Slideshow ("Diashow") — a token-only fullscreen kiosk link for live
// events that auto-picks-up new uploads (migration 138). Mirrors the
// client-access second-token pattern: the link is minted on demand, rotatable
// and disable-able, independent of the gallery password / share link.
// ---------------------------------------------------------------------------

// Allowed slide transition styles (kept in sync with the SlideshowPage).
// dipwhite/dipblack = fade through highlights / lowlights between images.
const SLIDESHOW_TRANSITIONS = ['crossfade', 'cut', 'slide', 'kenburns', 'dipwhite', 'dipblack'];
// Allowed per-slide color filters.
const SLIDESHOW_COLORFILTERS = ['none', 'bw', 'sepia', 'warm', 'cool', 'vignette'];
// The watermark LOOK (source/position/opacity/style/size) is global-only
// (app_settings, Settings → Slideshow); events only carry the show_watermark
// mode (NULL=inherit / true / false), so no per-event look enums live here.

// Build the public slideshow URL for a freshly-minted/existing token.
async function buildSlideshowUrl(slug, token) {
  if (!token) return null;
  const base = await getFrontendBaseUrl();
  return `${base.replace(/\/$/, '')}/gallery/${slug}/show/${token}`;
}

// Fetch the event respecting the editor-role ownership scope (requireEventOwnership
// already gates the route; this re-applies the created_by filter for editors so the
// 404 is identical to the rest of this file).
async function loadOwnedEvent(req) {
  let q = db('events').where('id', req.params.id);
  if (req.admin.roleName === 'editor') {
    q = q.where('created_by', req.admin.id);
  }
  return q.first();
}

// Generate (or rotate) the slideshow share token. Idempotent in intent: each
// call mints a fresh token, which both "Generate" (first time) and "Regenerate"
// (rotate, kills the old link) use.
router.post('/:id/slideshow/generate', adminAuth, requirePermission('events.edit'), requireFeatureFlag('slideshow'), requireEventOwnership, async (req, res) => {
  try {
    const event = await loadOwnedEvent(req);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    // NB: the events table has no updated_at column (only created_at), so we
    // must not set it here or the UPDATE throws.
    await db('events').where('id', req.params.id).update({
      show_share_token: token
    });

    await logActivity('slideshow_link_generated',
      { eventName: event.event_name, rotated: Boolean(event.show_share_token) },
      req.params.id,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );

    res.json({
      show_share_token: token,
      slideshow_url: await buildSlideshowUrl(event.slug, token)
    });
  } catch (error) {
    logger.error('Error generating slideshow link', { error: error.message });
    res.status(500).json({ error: 'Failed to generate slideshow link' });
  }
});

// Disable the slideshow link (null the token). The public /show/ route dies on
// its next poll, killing any projector currently pointed at the old link.
router.post('/:id/slideshow/disable', adminAuth, requirePermission('events.edit'), requireEventOwnership, async (req, res) => {
  try {
    const event = await loadOwnedEvent(req);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    await db('events').where('id', req.params.id).update({
      show_share_token: null
    });

    await logActivity('slideshow_link_disabled',
      { eventName: event.event_name },
      req.params.id,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );

    res.json({ show_share_token: null });
  } catch (error) {
    logger.error('Error disabling slideshow link', { error: error.message });
    res.status(500).json({ error: 'Failed to disable slideshow link' });
  }
});

// Update the LIVE slideshow settings (display time / transition style / speed).
// A running projector picks these up via the show-page settings poll within a
// few seconds — no need to regenerate the link.
router.patch('/:id/slideshow', adminAuth, requirePermission('events.edit'), requireFeatureFlag('slideshow'), requireEventOwnership, [
  body('show_interval_ms').optional().isInt({ min: 1000, max: 120000 }),
  body('show_transition').optional().isIn(SLIDESHOW_TRANSITIONS),
  body('show_transition_ms').optional().isInt({ min: 100, max: 5000 }),
  body('show_watermark').optional({ nullable: true }),
  body('show_colorfilter').optional().isIn(SLIDESHOW_COLORFILTERS)
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Invalid slideshow settings', details: errors.array() });
    }

    const event = await loadOwnedEvent(req);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // events has no updated_at column — don't set it.
    const updates = {};
    if (req.body.show_interval_ms !== undefined) updates.show_interval_ms = parseInt(req.body.show_interval_ms, 10);
    if (req.body.show_transition !== undefined) updates.show_transition = req.body.show_transition;
    if (req.body.show_transition_ms !== undefined) updates.show_transition_ms = parseInt(req.body.show_transition_ms, 10);
    // Tri-state: explicit null = inherit the global default.
    if (req.body.show_watermark !== undefined) {
      updates.show_watermark = req.body.show_watermark === null
        ? null
        : formatBoolean(parseBooleanInput(req.body.show_watermark, false));
    }
    if (req.body.show_colorfilter !== undefined) updates.show_colorfilter = req.body.show_colorfilter;

    // Knex throws on an empty update; only write if something changed.
    if (Object.keys(updates).length > 0) {
      await db('events').where('id', req.params.id).update(updates);
    }

    res.json({
      show_interval_ms: updates.show_interval_ms ?? event.show_interval_ms ?? 5000,
      show_transition: updates.show_transition ?? event.show_transition ?? 'crossfade',
      show_transition_ms: updates.show_transition_ms ?? event.show_transition_ms ?? 800,
      show_watermark: updates.show_watermark ?? event.show_watermark ?? null,
      show_colorfilter: updates.show_colorfilter ?? event.show_colorfilter ?? 'none'
    });
  } catch (error) {
    logger.error('Error updating slideshow settings', { error: error.message });
    res.status(500).json({ error: 'Failed to update slideshow settings' });
  }
});

// Reset event password
router.post('/:id/reset-password', adminAuth, requirePermission('events.edit'), requireEventOwnership, async (req, res) => {
  try {
    const { id } = req.params;
    const { sendEmail = true, password: clientPassword } = req.body;

    let eventQuery = db('events').where('id', id);
    // Editor role can only edit their own events
    if (req.admin.roleName === 'editor') {
      eventQuery = eventQuery.where('created_by', req.admin.id);
    }
    const event = await eventQuery.first();
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    if (event.is_archived) {
      return res.status(400).json({ error: 'Cannot reset password for archived event' });
    }

    // Use the admin-supplied password when provided; otherwise auto-generate
    // (preserves the previous one-click behaviour for callers/cron that don't
    // pass a body). Validation matches the create-event flow so the same
    // strength rules apply both ways.
    let newPassword;
    if (typeof clientPassword === 'string' && clientPassword.length > 0) {
      const passwordValidation = await validatePasswordInContext(clientPassword, 'gallery', {
        eventName: event.event_name
      });
      if (!passwordValidation.valid) {
        return res.status(400).json({
          error: 'Password does not meet security requirements',
          details: passwordValidation.errors,
          score: passwordValidation.score,
          feedback: passwordValidation.feedback
        });
      }
      newPassword = clientPassword;
    } else {
      const { generateReadablePassword } = require('../utils/passwordGenerator');
      newPassword = generateReadablePassword();
    }
    const passwordHash = await bcrypt.hash(newPassword, getBcryptRounds());

    // Update event with new password
    await db('events')
      .where('id', id)
      .update({
        password_hash: passwordHash
      });

    // Log activity
    await logActivity('password_reset',
      { eventName: event.event_name, emailSent: sendEmail },
      id,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );

    // Queue email notification if requested
    if (sendEmail) {
      const recipientEmail = event.customer_email || event.host_email;
      const recipientName = event.customer_name || event.host_name || (recipientEmail ? recipientEmail.split('@')[0] : null);
      // event.share_link is the path-only form (`/gallery/<slug>/<token>`).
      // Use the full URL so customers can click straight from the email.
      const { shareUrl } = await buildShareLinkVariants({ slug: event.slug, shareToken: event.share_token });

      await queueEmail(id, recipientEmail, 'gallery_created', {
        customer_name: recipientName,
        customer_email: recipientEmail,
        host_name: recipientName,
        event_name: event.event_name,
        event_date: event.event_date,  // Pass raw date - will be formatted by email processor
        gallery_link: shareUrl,
        gallery_password: newPassword,
        expiry_date: event.expires_at  // Pass raw date - will be formatted by email processor
      });
    }

    res.json({
      message: 'Password reset successfully',
      newPassword: newPassword,
      emailSent: sendEmail
    });
  } catch (error) {
    console.error('Error resetting password:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// Resend creation email
router.post('/:id/resend-email', adminAuth, requirePermission('events.edit'), requireEventOwnership, async (req, res) => {
  try {
    const { id } = req.params;

    // Get event details
    let eventQuery = db('events').where('id', id);
    // Editor role can only edit their own events
    if (req.admin.roleName === 'editor') {
      eventQuery = eventQuery.where('created_by', req.admin.id);
    }
    const event = await eventQuery.first();

    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    // The email processor will determine the language based on:
    // 1. Event language setting
    // 2. App settings general_default_language  
    // 3. Email config default language
    // 4. Domain-based detection
    // So we don't need to determine it here
    
    // For resending creation email, we need the actual password
    // First, try to get it from the request body if provided
    // Use optional chaining to handle cases where req.body might be undefined
    let galleryPassword = req.body?.password;
    
    // If no password provided, we can't decrypt the existing one
    // So we'll show a security message
    if (!galleryPassword) {
      // We'll let the email processor determine the language for the security message
      galleryPassword = '{{password_security_message}}';
    }
    
    // Dates will be formatted by the email processor based on recipient language
    
    // Queue the email
    const recipientEmail = event.customer_email || event.host_email;
    const recipientName = event.customer_name || event.host_name || (recipientEmail ? recipientEmail.split('@')[0] : null);
    // event.share_link is the path-only form; use the full URL so the
    // customer's mail client renders a clickable absolute link.
    const { shareUrl } = await buildShareLinkVariants({ slug: event.slug, shareToken: event.share_token });

    await queueEmail(id, recipientEmail, 'gallery_created', {
      customer_name: recipientName,
      customer_email: recipientEmail,
      host_name: recipientName,
      event_name: event.event_name,
      event_date: event.event_date,  // Pass raw date - will be formatted by email processor
      gallery_link: shareUrl,
      gallery_password: galleryPassword,
      expiry_date: event.expires_at,  // Pass raw date - will be formatted by email processor
      welcome_message: event.welcome_message || '',
      eventId: id,
      isResend: true // Flag to indicate this is a resend
    });
    
    // Log the activity using the proper schema
    try {
      await logActivity('email_resent', {
        email_type: 'gallery_created',
        recipient: recipientEmail,
        ip_address: req.ip || '0.0.0.0',
        user_agent: req.get('user-agent') || 'Unknown'
      }, id, {
        type: 'admin',
        id: req.admin.id,
        name: req.admin.username
      });
    } catch (logError) {
      console.error('Warning: Failed to log activity:', logError);
      // Don't fail the request if activity logging fails
    }
    
    res.json({ 
      success: true,
      message: 'Creation email has been queued for sending'
    });
  } catch (error) {
    console.error('Error resending creation email:', error);
    console.error('Stack trace:', error.stack);
    res.status(500).json({ error: 'Failed to resend creation email' });
  }
});

// Archive event
router.post('/:id/archive', adminAuth, requirePermission('events.archive'), requireEventOwnership, async (req, res) => {
  try {
    const { id } = req.params;

    const event = await db('events').where('id', id).first();
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    if (event.is_archived) {
      return res.status(400).json({ error: 'Event is already archived' });
    }

    // Use the archive service to create ZIP archive
    await archiveEvent(event);

    // Log activity
    await logActivity('event_archived',
      { eventName: event.event_name },
      id,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );

    res.json({ message: 'Event archived successfully' });
  } catch (error) {
    console.error('Error archiving event:', error);
    res.status(500).json({ error: 'Failed to archive event' });
  }
});

// Bulk archive events
router.post('/bulk-archive', adminAuth, requirePermission('events.archive'), [
  body('eventIds').isArray().withMessage('eventIds must be an array'),
  body('eventIds.*').isInt().withMessage('Each eventId must be an integer')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { eventIds } = req.body;
    
    if (eventIds.length === 0) {
      return res.status(400).json({ error: 'No events selected for archiving' });
    }

    // Get all events to archive
    const events = await db('events')
      .whereIn('id', eventIds)
      .where('is_archived', formatBoolean(false));

    if (events.length === 0) {
      return res.status(400).json({ error: 'No valid events found to archive' });
    }

    const results = {
      successful: [],
      failed: []
    };

    // Process each event
    for (const event of events) {
      try {
        // Use the archive service to create ZIP archive
        await archiveEvent(event);
        
        // Log activity
        await logActivity('event_archived',
          { eventName: event.event_name, bulkOperation: true },
          event.id,
          { type: 'admin', id: req.admin.id, name: req.admin.username }
        );
        
        results.successful.push({
          id: event.id,
          name: event.event_name
        });
      } catch (error) {
        console.error(`Failed to archive event ${event.id}:`, error);
        results.failed.push({
          id: event.id,
          name: event.event_name,
          error: 'Failed to archive event. Check server logs for details.'
        });
      }
    }

    // Log bulk archive activity
    await logActivity('bulk_archive_completed',
      { 
        totalEvents: eventIds.length,
        successfulCount: results.successful.length,
        failedCount: results.failed.length
      },
      null,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );

    res.json({
      message: `Bulk archive completed: ${results.successful.length} succeeded, ${results.failed.length} failed`,
      results
    });
  } catch (error) {
    console.error('Error in bulk archive:', error);
    res.status(500).json({ error: 'Failed to perform bulk archive' });
  }
});

// Bulk delete — destructive, irreversible. Caps at 100 events per request
// to keep request time bounded; the per-event cascade touches 5 DB tables
// + 3 filesystem paths so 1000 events would risk timing out the request.
// Loops via deleteEventCascade so the per-event delete behaviour stays in
// lock-step with DELETE /:id.
//
// Confirmation is enforced client-side via the typed-DELETE pattern in
// BulkDeleteModal (#417). The previous server-side bcrypt-password gate
// was dropped because the destructive single-event DELETE /:id has never
// required a password either — events.delete permission + admin session
// is the auth boundary for both. The typed-literal client gate is the
// "accidental click" safeguard, and unlike a password input it isn't
// affected by passkey/Windows Hello autofill that auto-submits the form.
const BULK_DELETE_MAX = 100;
router.post('/bulk-delete', adminAuth, requirePermission('events.delete'), [
  body('eventIds').isArray({ min: 1, max: BULK_DELETE_MAX }).withMessage(`eventIds must be an array of 1-${BULK_DELETE_MAX} ids`),
  body('eventIds.*').isInt().withMessage('Each eventId must be an integer')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { eventIds } = req.body;

    // Editor-role events.delete permission is already gated by the route
    // middleware. We do NOT additionally filter to created_by here because
    // the per-event delete-cascade is global (matches DELETE /:id which
    // also has no role-based filter — that's why events.delete is a
    // sensitive permission).

    const results = { successful: [], failed: [] };
    const adminContext = { id: req.admin.id, username: req.admin.username };

    for (const eventId of eventIds) {
      try {
        const deleted = await deleteEventCascade(eventId, adminContext);
        results.successful.push(deleted);
      } catch (err) {
        results.failed.push({
          id: eventId,
          name: null,
          error: err.code === 'EVENT_NOT_FOUND' ? 'Event not found' : 'Failed to delete event'
        });
        logger.warn('Bulk-delete: per-event failure', { eventId, error: err.message });
      }
    }

    await logActivity('bulk_delete_completed',
      {
        totalEvents: eventIds.length,
        successfulCount: results.successful.length,
        failedCount: results.failed.length
      },
      null,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );

    res.json({
      message: `Bulk delete completed: ${results.successful.length} succeeded, ${results.failed.length} failed`,
      results
    });
  } catch (error) {
    logger.error('Error in bulk delete', { error: error.message });
    res.status(500).json({ error: 'Failed to perform bulk delete' });
  }
});

// Upload event custom logo
router.post('/:id/logo', adminAuth, requirePermission('events.edit'), requireEventOwnership, eventLogoUpload.single('logo'), async (req, res) => {
  try {
    const { id } = req.params;

    // Check if event exists
    let eventQuery = db('events').where('id', id);
    if (req.admin.roleName === 'editor') {
      eventQuery = eventQuery.where('created_by', req.admin.id);
    }
    const event = await eventQuery.first();
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No logo file provided' });
    }

    // Delete old logo file if exists
    if (event.hero_logo_path) {
      try {
        await fs.unlink(event.hero_logo_path);
        logger.debug('Deleted old event logo file', { path: event.hero_logo_path });
      } catch (err) {
        logger.warn('Failed to delete old event logo file', { path: event.hero_logo_path, error: err.message });
      }
    }

    const logoUrl = `/uploads/logos/events/${req.file.filename}`;
    const logoPath = req.file.path;

    await db('events')
      .where('id', id)
      .update({
        hero_logo_url: logoUrl,
        hero_logo_path: logoPath
      });

    await logActivity('event_logo_uploaded',
      { eventName: event.event_name, filename: req.file.filename },
      id,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );

    res.json({
      message: 'Event logo uploaded successfully',
      hero_logo_url: logoUrl
    });
  } catch (error) {
    logger.error('Error uploading event logo:', { error: error.message, eventId: req.params.id });
    res.status(500).json({ error: 'Failed to upload event logo' });
  }
});

// Delete event custom logo
router.delete('/:id/logo', adminAuth, requirePermission('events.edit'), requireEventOwnership, async (req, res) => {
  try {
    const { id } = req.params;

    let eventQuery = db('events').where('id', id);
    if (req.admin.roleName === 'editor') {
      eventQuery = eventQuery.where('created_by', req.admin.id);
    }
    const event = await eventQuery.first();
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Delete logo file if exists
    if (event.hero_logo_path) {
      try {
        await fs.unlink(event.hero_logo_path);
        logger.debug('Deleted event logo file', { path: event.hero_logo_path });
      } catch (err) {
        logger.warn('Failed to delete event logo file', { path: event.hero_logo_path, error: err.message });
      }
    }

    await db('events')
      .where('id', id)
      .update({
        hero_logo_url: null,
        hero_logo_path: null
      });

    await logActivity('event_logo_removed',
      { eventName: event.event_name },
      id,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );

    res.json({ message: 'Event logo removed successfully' });
  } catch (error) {
    logger.error('Error deleting event logo:', { error: error.message, eventId: req.params.id });
    res.status(500).json({ error: 'Failed to delete event logo' });
  }
});

module.exports = router;
