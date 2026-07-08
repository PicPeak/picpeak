const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { body, validationResult } = require('express-validator');
const { db, logActivity } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { clearMaintenanceCache } = require('../middleware/maintenance');
const { clearSettingsCache } = require('../services/rateLimitService');
const {
  DEFAULT_PUBLIC_SITE_HTML,
  DEFAULT_PUBLIC_SITE_CSS,
} = require('../constants/publicSiteDefaults');
const {
  clearPublicSiteCache,
  getDefaultPublicSitePayload,
  getRawPublicSiteSettings,
} = require('../services/publicSiteService');
const { sanitizeCss } = require('../utils/cssSanitizer');
const { upsertAppSetting } = require('../utils/appSettings');
const { clearShareLinkSettingsCache } = require('../services/shareLinkService');
const { resetSecurityConfigCache } = require('../utils/authSecurity');
const { errorResponse } = require('../utils/routeHelpers');
const logger = require('../utils/logger');
const router = express.Router();
const { clearMaxFilesPerUploadCache, MAX_ALLOWED_FILES_PER_UPLOAD } = require('../services/uploadSettings');
const watermarkService = require('../services/watermarkService');
const watermarkGeneratorService = require('../services/watermarkGeneratorService');

const getStoragePath = () => process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');

// Configure multer for logo uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = path.join(getStoragePath(), 'uploads/logos');
    await fs.mkdir(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `logo-${Date.now()}${ext}`);
  }
});

const { validateFileType } = require('../utils/fileSecurityUtils');

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    // Note: SVG files are excluded from magic number validation for logos
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/svg+xml'];
    
    if (validateFileType(file.originalname, file.mimetype, allowedMimeTypes)) {
      return cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, GIF and SVG image files are allowed'));
    }
  }
});

// Configure multer for favicon uploads
const faviconStorage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = path.join(getStoragePath(), 'uploads/favicons');
    await fs.mkdir(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `favicon-${Date.now()}${ext}`);
  }
});

const faviconUpload = multer({
  storage: faviconStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB — roomy enough for a 512×512+ square PNG
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = ['image/png', 'image/x-icon', 'image/vnd.microsoft.icon'];
    const name = file.originalname.toLowerCase();

    // For ICO files, we can't use the standard validateFileType
    if (file.mimetype === 'image/png') {
      if (validateFileType(file.originalname, file.mimetype, ['image/png'])) {
        cb(null, true);
      } else {
        cb(new Error('Invalid PNG file'));
      }
    } else if (file.mimetype === 'image/svg+xml' && name.endsWith('.svg')) {
      // SVG favicons are supported by modern browsers and are crisp at any
      // size. Served SVGs are CSP-locked (no script execution) by the
      // secureStatic middleware, so an admin-uploaded SVG is render-only.
      cb(null, true);
    } else if (allowedMimeTypes.includes(file.mimetype) &&
               (name.endsWith('.ico') || name.endsWith('.png'))) {
      cb(null, true);
    } else {
      cb(new Error('Favicon must be PNG, ICO, or SVG format'));
    }
  }
});

// Get all settings, or a subset when ?keys=k1,k2,… is supplied.
// Many caller pages only need a handful of keys (e.g. ReminderTemplates
// reads 2 of the ~100 rows). The keys filter is allowlist-bounded by
// what's stored, so passing unknown keys just returns them as `null`
// — no enumeration risk beyond what GET / returned already.
router.get('/', adminAuth, requirePermission('settings.view'), async (req, res) => {
  try {
    const keysParam = typeof req.query.keys === 'string' ? req.query.keys : null;
    const keysFilter = keysParam
      ? keysParam.split(',').map((k) => k.trim()).filter(Boolean).slice(0, 100)
      : null;

    const query = db('app_settings').select('*');
    if (keysFilter && keysFilter.length > 0) {
      query.whereIn('setting_key', keysFilter);
    }
    const settings = await query;

    // Convert to object format
    const settingsObject = {};
    settings.forEach(setting => {
      // Check for null/undefined explicitly to handle boolean false and 0 values
      // PostgreSQL json column returns parsed values (false as boolean, not string)
      if (setting.setting_value !== null && setting.setting_value !== undefined) {
        // If the value is already parsed (from json column), use it directly
        if (typeof setting.setting_value !== 'string') {
          settingsObject[setting.setting_key] = setting.setting_value;
        } else {
          try {
            // Try to parse as JSON first
            settingsObject[setting.setting_key] = JSON.parse(setting.setting_value);
          } catch (e) {
            // If it's not valid JSON, use the raw value
            settingsObject[setting.setting_key] = setting.setting_value;
          }
        }
      } else {
        settingsObject[setting.setting_key] = null;
      }
    });

    // Mask sensitive secrets before sending to client
    if (settingsObject.security_recaptcha_secret_key) {
      settingsObject.security_recaptcha_secret_key = '••••••••';
    }
    // Umami v2 API key (#661 Bug C) — read-write secret that authenticates
    // outbound calls to the operator's Umami instance for the device
    // breakdown. Masked on GET, same pattern as the recaptcha secret.
    if (settingsObject.analytics_umami_api_key) {
      settingsObject.analytics_umami_api_key = '••••••••';
    }
    // Rybbit API key (#663 Phase 1) — same pattern.
    if (settingsObject.analytics_rybbit_api_key) {
      settingsObject.analytics_rybbit_api_key = '••••••••';
    }

    res.json(settingsObject);
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to fetch settings');
  }
});

/**
 * Customer-surface branding settings (#354 follow-up).
 *
 * Two toggles control what shows in the customer dashboard header:
 *   customer_show_logo          (default true)
 *   customer_show_company_name  (default true)
 *
 * The Calendar / Quotes / Bills feature globals that used to live here
 * have moved to the maintainer's Features tab (feature_flags table).
 *
 * IMPORTANT: both routes MUST be registered before the generic
 * `router.get('/:type', ...)` below — Express matches routes in
 * registration order.
 */
router.get('/customer-surface', adminAuth, requirePermission('settings.view'), async (req, res) => {
  try {
    const rows = await db('app_settings')
      .where('setting_type', 'customer_surface')
      .select('setting_key', 'setting_value');

    const settings = {};
    for (const r of rows) {
      let value = r.setting_value;
      if (value === null || value === undefined) {
        settings[r.setting_key] = null;
        continue;
      }
      if (typeof value !== 'string') {
        settings[r.setting_key] = value;
      } else {
        try { settings[r.setting_key] = JSON.parse(value); }
        catch { settings[r.setting_key] = value; }
      }
    }

    res.json(settings);
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to fetch customer surface settings');
  }
});

router.put('/customer-surface', adminAuth, requirePermission('settings.edit'), async (req, res) => {
  try {
    // Branding-only whitelist (calendar/quotes/bills feature globals
    // moved to the Features tab / feature_flags table).
    const allowed = [
      'customer_show_logo',
      'customer_show_company_name',
    ];
    const updates = [];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) {
        const value = !!req.body[key];
        updates.push({ setting_key: key, setting_value: JSON.stringify(value), setting_type: 'customer_surface' });
      }
    }

    for (const u of updates) {
      await upsertAppSetting(u.setting_key, u.setting_value, u.setting_type);
    }

    // Clear the public-site cache so any consumer relying on it
    // (e.g. customer login footer if it picks these up) refetches.
    clearPublicSiteCache();

    res.json({ message: 'Customer surface settings updated', updated: updates.map((u) => u.setting_key) });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to save customer surface settings');
  }
});

// Accounting settings (km rate, per-diem rate, require-proof). Read via the
// generic GET /:type ('accounting'); this is the typed write. Rates are
// integer minor units; verify legal/tax guidance with a Treuhaender.
router.put('/accounting', adminAuth, requirePermission('settings.edit'), async (req, res) => {
  try {
    const updates = [];
    const setInt = (key) => {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) {
        const n = Math.max(0, Math.round(Number(req.body[key]) || 0));
        updates.push({ setting_key: key, setting_value: JSON.stringify(n), setting_type: 'accounting' });
      }
    };
    setInt('accounting_km_rate_minor');
    setInt('accounting_per_diem_rate_minor');
    if (Object.prototype.hasOwnProperty.call(req.body, 'accounting_require_proof')) {
      updates.push({
        setting_key: 'accounting_require_proof',
        setting_value: JSON.stringify(!!req.body.accounting_require_proof),
        setting_type: 'accounting',
      });
    }
    // VAT registration + reclaim. `registered` drives whether output VAT applies
    // + whether input VAT is deductible; `reclaim_countries` = the ISO-2 list of
    // countries whose input VAT can be reclaimed (drives cost tax-treatment +
    // the report's VAT-payable).
    if (Object.prototype.hasOwnProperty.call(req.body, 'accounting_vat_registered')) {
      updates.push({
        setting_key: 'accounting_vat_registered',
        setting_value: JSON.stringify(!!req.body.accounting_vat_registered),
        setting_type: 'accounting',
      });
    }
    // Default OUTPUT VAT code stamped onto NEW invoices/quotes (the editor
    // seeds its VAT picker from it). Stored as the code string; '' clears it.
    if (Object.prototype.hasOwnProperty.call(req.body, 'accounting_default_output_vat_code')) {
      const code = String(req.body.accounting_default_output_vat_code || '').trim().slice(0, 16);
      updates.push({
        setting_key: 'accounting_default_output_vat_code',
        setting_value: JSON.stringify(code),
        setting_type: 'accounting',
      });
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'accounting_vat_reclaim_countries')) {
      const arr = Array.isArray(req.body.accounting_vat_reclaim_countries)
        ? req.body.accounting_vat_reclaim_countries
          .map((c) => String(c || '').toUpperCase().trim())
          .filter((c) => /^[A-Z]{2}$/.test(c))
        : [];
      updates.push({
        setting_key: 'accounting_vat_reclaim_countries',
        setting_value: JSON.stringify(arr),
        setting_type: 'accounting',
      });
    }
    for (const u of updates) {
      await upsertAppSetting(u.setting_key, u.setting_value, u.setting_type);
    }
    res.json({ message: 'Accounting settings updated', updated: updates.map((u) => u.setting_key) });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to save accounting settings');
  }
});

// Global Live Slideshow defaults (migration 139). The per-event watermark is
// tri-state (events.show_watermark NULL = inherit these). Read via the generic
// GET /:type ('slideshow'); this is the typed write.
router.put('/slideshow', adminAuth, requirePermission('settings.edit'), async (req, res) => {
  try {
    const updates = [];
    const push = (key, value) => updates.push({ setting_key: key, setting_value: JSON.stringify(value), setting_type: 'slideshow' });
    const has = (k) => Object.prototype.hasOwnProperty.call(req.body, k);

    if (has('slideshow_fit')) {
      push('slideshow_fit', req.body.slideshow_fit === 'contain' ? 'contain' : 'cover');
    }
    // Picpeak-wide display preset (default style new events inherit).
    if (has('slideshow_interval_ms')) {
      const n = Math.min(120000, Math.max(1000, Math.round(Number(req.body.slideshow_interval_ms) || 5000)));
      push('slideshow_interval_ms', n);
    }
    if (has('slideshow_transition')) {
      const allowed = ['crossfade', 'cut', 'slide', 'kenburns', 'dipwhite', 'dipblack'];
      push('slideshow_transition', allowed.includes(req.body.slideshow_transition) ? req.body.slideshow_transition : 'crossfade');
    }
    if (has('slideshow_transition_ms')) {
      const n = Math.min(5000, Math.max(100, Math.round(Number(req.body.slideshow_transition_ms) || 800)));
      push('slideshow_transition_ms', n);
    }
    if (has('slideshow_colorfilter')) {
      const allowed = ['none', 'bw', 'sepia', 'warm', 'cool', 'vignette'];
      push('slideshow_colorfilter', allowed.includes(req.body.slideshow_colorfilter) ? req.body.slideshow_colorfilter : 'none');
    }
    if (has('slideshow_watermark_enabled')) push('slideshow_watermark_enabled', !!req.body.slideshow_watermark_enabled);
    if (has('slideshow_watermark_source')) {
      const v = ['logo', 'logo_dark', 'favicon', 'event'].includes(req.body.slideshow_watermark_source) ? req.body.slideshow_watermark_source : 'logo';
      push('slideshow_watermark_source', v);
    }
    if (has('slideshow_watermark_position')) {
      const allowed = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
      const v = allowed.includes(req.body.slideshow_watermark_position) ? req.body.slideshow_watermark_position : 'bottom-right';
      push('slideshow_watermark_position', v);
    }
    if (has('slideshow_watermark_opacity')) {
      const n = Math.min(100, Math.max(0, Math.round(Number(req.body.slideshow_watermark_opacity) || 0)));
      push('slideshow_watermark_opacity', n);
    }
    if (has('slideshow_watermark_style')) {
      const v = ['white', 'original'].includes(req.body.slideshow_watermark_style) ? req.body.slideshow_watermark_style : 'white';
      push('slideshow_watermark_style', v);
    }
    if (has('slideshow_watermark_size')) {
      const n = Math.min(40, Math.max(3, Math.round(Number(req.body.slideshow_watermark_size) || 12)));
      push('slideshow_watermark_size', n);
    }

    for (const u of updates) {
      await upsertAppSetting(u.setting_key, u.setting_value, u.setting_type);
    }
    // Drop the slideshow-globals cache so a running projector picks up the
    // change on its next poll rather than after the 5s TTL.
    require('../utils/slideshowGlobals').invalidateSlideshowGlobals();
    res.json({ message: 'Slideshow settings updated', updated: updates.map((u) => u.setting_key) });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to save slideshow settings');
  }
});

// Get settings by type
router.get('/:type', adminAuth, requirePermission('settings.view'), async (req, res) => {
  try {
    const { type } = req.params;
    const settings = await db('app_settings')
      .where('setting_type', type)
      .select('*');

    // Convert to object format
    const settingsObject = {};
    settings.forEach(setting => {
      // Check for null/undefined explicitly to handle boolean false and 0 values
      // PostgreSQL json column returns parsed values (false as boolean, not string)
      if (setting.setting_value !== null && setting.setting_value !== undefined) {
        // If the value is already parsed (from json column), use it directly
        if (typeof setting.setting_value !== 'string') {
          settingsObject[setting.setting_key] = setting.setting_value;
        } else {
          try {
            // Try to parse as JSON first
            settingsObject[setting.setting_key] = JSON.parse(setting.setting_value);
          } catch (e) {
            // If it's not valid JSON, use the raw value
            settingsObject[setting.setting_key] = setting.setting_value;
          }
        }
      } else {
        settingsObject[setting.setting_key] = null;
      }
    });

    // Mask sensitive secrets before sending to client
    if (settingsObject.security_recaptcha_secret_key) {
      settingsObject.security_recaptcha_secret_key = '••••••••';
    }
    // Umami v2 API key (#661 Bug C) — read-write secret that authenticates
    // outbound calls to the operator's Umami instance for the device
    // breakdown. Masked on GET, same pattern as the recaptcha secret.
    if (settingsObject.analytics_umami_api_key) {
      settingsObject.analytics_umami_api_key = '••••••••';
    }
    // Rybbit API key (#663 Phase 1) — same pattern.
    if (settingsObject.analytics_rybbit_api_key) {
      settingsObject.analytics_rybbit_api_key = '••••••••';
    }

    res.json(settingsObject);
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to fetch settings');
  }
});

// Get password complexity settings for frontend
router.get('/password/complexity', adminAuth, requirePermission('settings.view'), async (req, res) => {
  try {
    const { getPasswordComplexitySettings, getPasswordConfigForComplexity } = require('../utils/passwordValidation');
    
    // Get current complexity level from database
    const complexityLevel = await getPasswordComplexitySettings();
    
    // Get configuration for the complexity level
    const config = getPasswordConfigForComplexity(complexityLevel);
    
    res.json({
      complexityLevel,
      config
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to fetch password complexity settings');
  }
});

// Update branding settings
router.put('/branding', adminAuth, requirePermission('settings.edit'), async (req, res) => {
  try {
    const {
      company_name,
      company_tagline,
      support_email,
      footer_text,
      watermark_enabled,
      watermark_position,
      watermark_opacity,
      watermark_size,
      favicon_url,
      logo_url,
      watermark_logo_url,
      logo_size,
      logo_max_height,
      logo_position,
      logo_display_header,
      logo_display_hero,
      logo_display_mode,
      hide_powered_by,
      force_color_mode,
      // Login-page-only branding (#354 follow-up). Both toggles apply
      // exclusively to /admin/login and /customer/login — the gallery
      // and admin chrome use their own logo_size / logo_max_height.
      // - login_logo_frame_enabled: true (default) renders the tinted
      //   square behind the logo; false drops it.
      // - login_logo_size: 'small' | 'medium' | 'large' | 'xlarge'
      //   matches the gallery logo_size token set but applies only to
      //   the two login screens.
      login_logo_frame_enabled,
      login_logo_size,
      // Footer overhaul (#441 + #440). Socials are URL strings (empty
      // hides the icon). Promo content is markdown (rendered via
      // marked → DOMPurify on the frontend, no raw HTML accepted).
      facebook_url,
      instagram_url,
      whatsapp_url,
      twitter_url,
      youtube_url,
      promo_markdown,
      promo_position,
      promo_alignment
    } = req.body;

    // Normalize force_color_mode: only 'dark' | 'light' | null are valid.
    const normalizedForceColorMode = force_color_mode === 'dark'
      ? 'dark'
      : force_color_mode === 'light'
        ? 'light'
        : null;

    // Get current watermark settings hash for change detection
    const oldSettingsHash = await watermarkService.getSettingsHash();

    // Normalize promo_position: only 'above_footer' | 'below_footer' valid.
    const normalizedPromoPosition = promo_position === 'below_footer'
      ? 'below_footer'
      : 'above_footer';

    // Normalize promo_alignment: 'left' | 'center' | 'right'. Defaults
    // to 'center' to match the gallery footer's full-width centering
    // (#482 — the previous default left the markdown left-aligned in
    // a max-w-3xl block, which read as visually offset from the footer).
    const allowedPromoAlignments = ['left', 'center', 'right'];
    const normalizedPromoAlignment = allowedPromoAlignments.includes(promo_alignment)
      ? promo_alignment
      : 'center';

    // Normalize login_logo_size to the same token set as logo_size.
    // Anything else falls back to 'medium' on the next render.
    const allowedLoginLogoSizes = ['small', 'medium', 'large', 'xlarge'];
    const normalizedLoginLogoSize = allowedLoginLogoSizes.includes(login_logo_size)
      ? login_logo_size
      : undefined;

    const brandingSettings = {
      company_name,
      company_tagline,
      support_email,
      footer_text,
      watermark_enabled,
      watermark_position,
      watermark_opacity,
      watermark_size,
      favicon_url,
      logo_url,
      watermark_logo_url,
      logo_size,
      logo_max_height,
      logo_position,
      logo_display_header,
      logo_display_hero,
      logo_display_mode,
      hide_powered_by,
      force_color_mode: normalizedForceColorMode,
      // Login-only knobs (only persist when the request actually
      // included the key, so a partial PUT from another tab doesn't
      // accidentally clear them).
      ...(login_logo_frame_enabled !== undefined && { login_logo_frame_enabled }),
      ...(normalizedLoginLogoSize !== undefined && { login_logo_size: normalizedLoginLogoSize }),
      // Footer overhaul (#441 + #440). String fields normalize empty/
      // undefined → '' so the column is always a known type. Only persist
      // when the request actually included the key (partial PUTs).
      ...(facebook_url !== undefined  && { facebook_url:  String(facebook_url  || '').trim() }),
      ...(instagram_url !== undefined && { instagram_url: String(instagram_url || '').trim() }),
      ...(whatsapp_url !== undefined  && { whatsapp_url:  String(whatsapp_url  || '').trim() }),
      ...(twitter_url !== undefined   && { twitter_url:   String(twitter_url   || '').trim() }),
      ...(youtube_url !== undefined   && { youtube_url:   String(youtube_url   || '').trim() }),
      ...(promo_markdown !== undefined && { promo_markdown: typeof promo_markdown === 'string' ? promo_markdown : '' }),
      ...(promo_position !== undefined && { promo_position: normalizedPromoPosition }),
      ...(promo_alignment !== undefined && { promo_alignment: normalizedPromoAlignment })
    };

    // Handle favicon deletion if empty string or null is provided
    if (favicon_url === '' || favicon_url === null || favicon_url === undefined) {
      // Get current favicon path to delete file
      const currentFaviconSetting = await db('app_settings')
        .where('setting_key', 'branding_favicon_url')
        .first();
      
      if (currentFaviconSetting && currentFaviconSetting.setting_value) {
        let currentFaviconUrl;
        try {
          // Try to parse as JSON first
          currentFaviconUrl = JSON.parse(currentFaviconSetting.setting_value);
        } catch (e) {
          // If it's not valid JSON, use the raw value
          currentFaviconUrl = currentFaviconSetting.setting_value;
        }
        
        if (currentFaviconUrl && typeof currentFaviconUrl === 'string' && currentFaviconUrl.startsWith('/uploads/favicons/')) {
          // Delete the file from filesystem
          const relativePath = currentFaviconUrl.replace(/^\//, '');
          const faviconPath = path.join(getStoragePath(), relativePath);
          try {
            await fs.unlink(faviconPath);
            logger.info('Deleted favicon file:', faviconPath);
          } catch (err) {
            logger.error('Error deleting favicon file:', err);
          }
        }
      }
    }

    // Handle logo deletion if empty string or null is provided
    if (logo_url === '' || logo_url === null || logo_url === undefined) {
      // Get current logo path to delete file
      const currentLogoSetting = await db('app_settings')
        .where('setting_key', 'branding_logo_url')
        .first();
      
      if (currentLogoSetting && currentLogoSetting.setting_value) {
        let currentLogoUrl;
        try {
          // Try to parse as JSON first
          currentLogoUrl = JSON.parse(currentLogoSetting.setting_value);
        } catch (e) {
          // If it's not valid JSON, use the raw value
          currentLogoUrl = currentLogoSetting.setting_value;
        }
        
        if (currentLogoUrl && typeof currentLogoUrl === 'string' && currentLogoUrl.startsWith('/uploads/logos/')) {
          // Delete the file from filesystem
          const relativePath = currentLogoUrl.replace(/^\//, '');
          const logoPath = path.join(getStoragePath(), relativePath);
          try {
            await fs.unlink(logoPath);
            logger.info('Deleted logo file:', logoPath);
          } catch (err) {
            logger.error('Error deleting logo file:', err);
          }
        }
      }
    }

    // Update or insert each setting
    for (const [key, value] of Object.entries(brandingSettings)) {
      await db('app_settings')
        .insert({
          setting_key: `branding_${key}`,
          setting_value: JSON.stringify(value),
          setting_type: 'branding',
          updated_at: new Date()
        })
        .onConflict('setting_key')
        .merge({
          setting_value: JSON.stringify(value),
          updated_at: new Date()
        });
    }

    // Log activity
    await db('activity_logs').insert({
      activity_type: 'branding_updated',
      actor_type: 'admin',
      actor_id: req.admin.id,
      actor_name: req.admin.username,
      metadata: JSON.stringify({ company_name })
    });

    clearPublicSiteCache();

    // Check if watermark settings changed and trigger regeneration
    const newSettingsHash = await watermarkService.getSettingsHash();
    let watermarkRegenerationStarted = false;

    if (oldSettingsHash !== newSettingsHash) {
      // Clear watermark cache
      watermarkService.clearCache();

      // Check if watermarking is now enabled or settings changed
      const currentSettings = await watermarkService.getWatermarkSettings();

      if (currentSettings && currentSettings.enabled) {
        // Start background regeneration of all watermarks
        logger.info('Watermark settings changed, starting background regeneration');
        watermarkGeneratorService.regenerateAll()
          .then(result => {
            logger.info(`Watermark regeneration completed: ${result.success}/${result.total} successful`);
          })
          .catch(err => {
            logger.error('Watermark regeneration failed:', err);
          });
        watermarkRegenerationStarted = true;
      } else {
        // Watermarking was disabled, clear all pre-generated watermarks
        logger.info('Watermarking disabled, clearing pre-generated watermarks');
        watermarkGeneratorService.clearAllWatermarks()
          .catch(err => logger.error('Failed to clear watermarks:', err));
      }
    }

    res.json({
      message: 'Branding settings updated successfully',
      watermarkRegenerationStarted
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to update branding settings');
  }
});

// Upload logo
router.post('/logo', adminAuth, requirePermission('settings.edit'), upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No logo file uploaded' });
    }

    // ?variant=dark stores a separate dark-mode logo (branding_logo_*_dark);
    // anything else is the default (light) logo. Consumers pick the dark
    // variant when the active theme is dark, falling back to the light one.
    const isDark = req.query.variant === 'dark' || req.body.variant === 'dark';
    const pathKey = isDark ? 'branding_logo_path_dark' : 'branding_logo_path';
    const urlKey = isDark ? 'branding_logo_url_dark' : 'branding_logo_url';

    // Get old logo to delete
    const oldLogoSetting = await db('app_settings')
      .where('setting_key', pathKey)
      .first();

    if (oldLogoSetting && oldLogoSetting.setting_value) {
      try {
        // Handle both JSON-serialized and legacy raw path values
        let oldPath = oldLogoSetting.setting_value;
        if (oldPath.startsWith('"')) {
          oldPath = JSON.parse(oldPath);
        }
        await fs.unlink(oldPath);
      } catch (error) {
        logger.error('Failed to delete old logo:', error);
      }
    }

    // Save new logo path
    const logoPath = req.file.path;
    const publicPath = `/uploads/logos/${req.file.filename}`;

    await db('app_settings')
      .insert({
        setting_key: pathKey,
        setting_value: JSON.stringify(logoPath),
        setting_type: 'branding',
        updated_at: new Date()
      })
      .onConflict('setting_key')
      .merge({
        setting_value: JSON.stringify(logoPath),
        updated_at: new Date()
      });

    // Save public URL
    await db('app_settings')
      .insert({
        setting_key: urlKey,
        setting_value: JSON.stringify(publicPath),
        setting_type: 'branding',
        updated_at: new Date()
      })
      .onConflict('setting_key')
      .merge({
        setting_value: JSON.stringify(publicPath),
        updated_at: new Date()
      });

    res.json({ 
      message: 'Logo uploaded successfully',
      logoUrl: publicPath
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to upload logo');
  }
});

// Remove a logo. ?variant=dark clears the dark-mode logo
// (branding_logo_*_dark); otherwise the default logo. Best-effort file
// unlink, then blanks the url + path settings.
router.delete('/logo', adminAuth, requirePermission('settings.edit'), async (req, res) => {
  try {
    const isDark = req.query.variant === 'dark';
    const pathKey = isDark ? 'branding_logo_path_dark' : 'branding_logo_path';
    const urlKey = isDark ? 'branding_logo_url_dark' : 'branding_logo_url';

    const pathSetting = await db('app_settings').where('setting_key', pathKey).first();
    if (pathSetting && pathSetting.setting_value) {
      try {
        let p = pathSetting.setting_value;
        if (p.startsWith('"')) p = JSON.parse(p);
        await fs.unlink(p);
      } catch (error) {
        logger.error('Failed to delete logo file:', error);
      }
    }
    await db('app_settings')
      .whereIn('setting_key', [pathKey, urlKey])
      .update({ setting_value: JSON.stringify(''), updated_at: new Date() });

    res.json({ message: 'Logo removed' });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to remove logo');
  }
});

// Upload watermark logo
router.post('/branding/watermark-logo', adminAuth, requirePermission('settings.edit'), upload.single('watermarkLogo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Delete old watermark logo if exists
    const oldWatermarkLogoSetting = await db('app_settings')
      .where('setting_key', 'branding_watermark_logo_path')
      .first();

    if (oldWatermarkLogoSetting && oldWatermarkLogoSetting.setting_value) {
      let oldPath;
      try {
        // Try to parse as JSON first (for JSON-stringified paths)
        oldPath = JSON.parse(oldWatermarkLogoSetting.setting_value);
      } catch (e) {
        // If it's not valid JSON, use the raw value
        oldPath = oldWatermarkLogoSetting.setting_value;
      }

      if (oldPath && typeof oldPath === 'string') {
        try {
          await fs.unlink(oldPath);
        } catch (error) {
          logger.error('Failed to delete old watermark logo:', error);
        }
      }
    }

    // Save new watermark logo path
    const logoPath = req.file.path;
    const publicPath = `/uploads/logos/${req.file.filename}`;

    await db('app_settings')
      .insert({
        setting_key: 'branding_watermark_logo_path',
        setting_value: JSON.stringify(logoPath),
        setting_type: 'branding',
        updated_at: new Date()
      })
      .onConflict('setting_key')
      .merge({
        setting_value: JSON.stringify(logoPath),
        updated_at: new Date()
      });

    // Save public URL
    await db('app_settings')
      .insert({
        setting_key: 'branding_watermark_logo_url',
        setting_value: JSON.stringify(publicPath),
        setting_type: 'branding',
        updated_at: new Date()
      })
      .onConflict('setting_key')
      .merge({
        setting_value: JSON.stringify(publicPath),
        updated_at: new Date()
      });

    // Trigger watermark regeneration since the logo changed
    watermarkService.clearCache();
    const currentSettings = await watermarkService.getWatermarkSettings();
    let watermarkRegenerationStarted = false;

    if (currentSettings && currentSettings.enabled) {
      logger.info('Watermark logo changed, starting background regeneration');
      watermarkGeneratorService.regenerateAll()
        .then(result => {
          logger.info(`Watermark regeneration completed: ${result.success}/${result.total} successful`);
        })
        .catch(err => {
          logger.error('Watermark regeneration failed:', err);
        });
      watermarkRegenerationStarted = true;
    }

    res.json({
      message: 'Watermark logo uploaded successfully',
      watermarkLogoUrl: publicPath,
      watermarkRegenerationStarted
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to upload watermark logo');
  }
});

// Update theme settings
router.put('/theme', adminAuth, requirePermission('settings.edit'), async (req, res) => {
  try {
    const themeSettings = req.body;

    // Save theme settings
    await db('app_settings')
      .insert({
        setting_key: 'theme_config',
        setting_value: JSON.stringify(themeSettings),
        setting_type: 'theme',
        updated_at: new Date()
      })
      .onConflict('setting_key')
      .merge({
        setting_value: JSON.stringify(themeSettings),
        updated_at: new Date()
      });

    // Log activity
    await db('activity_logs').insert({
      activity_type: 'theme_updated',
      actor_type: 'admin',
      actor_id: req.admin.id,
      actor_name: req.admin.username,
      metadata: JSON.stringify({ theme_name: themeSettings.name || 'custom' })
    });

    clearPublicSiteCache();

    res.json({ message: 'Theme settings updated successfully' });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to update theme settings');
  }
});

// Update general settings
router.put('/general', adminAuth, requirePermission('settings.edit'), async (req, res) => {
  try {
    const settings = { ...req.body };
    let uploadLimitTouched = false;

    const publicSiteKeysTouched = Object.keys(settings).some((key) => key.startsWith('general_public_site_'));

    if (Object.prototype.hasOwnProperty.call(settings, 'general_max_files_per_upload')) {
      uploadLimitTouched = true;
      const rawValue = Number(settings.general_max_files_per_upload);
      const normalizedValue = Number.isFinite(rawValue) ? Math.floor(rawValue) : NaN;

      if (!Number.isInteger(normalizedValue) || normalizedValue < 1 || normalizedValue > MAX_ALLOWED_FILES_PER_UPLOAD) {
        return res.status(400).json({
          error: `general_max_files_per_upload must be an integer between 1 and ${MAX_ALLOWED_FILES_PER_UPLOAD}`
        });
      }

      settings.general_max_files_per_upload = normalizedValue;
    }

    if (publicSiteKeysTouched) {
      if (Object.prototype.hasOwnProperty.call(settings, 'general_public_site_custom_css')) {
        settings.general_public_site_custom_css = sanitizeCss(settings.general_public_site_custom_css || '');
      }

      if (Object.prototype.hasOwnProperty.call(settings, 'general_public_site_html') && typeof settings.general_public_site_html === 'string') {
        settings.general_public_site_html = settings.general_public_site_html.trim();
      }

      if (Object.prototype.hasOwnProperty.call(settings, 'general_public_site_enabled')) {
        settings.general_public_site_enabled = formatBoolean(settings.general_public_site_enabled);
      }

      const enableToggle = settings.general_public_site_enabled;
      if (enableToggle === true) {
        let htmlValue = settings.general_public_site_html;

        if (htmlValue === undefined) {
          const currentSettings = await getRawPublicSiteSettings();
          htmlValue = currentSettings.general_public_site_html;
        }

        if (!htmlValue || !String(htmlValue).trim()) {
          return res.status(400).json({
            error: 'Public site HTML must be provided before enabling the public landing page.'
          });
        }
      }
    }

    // Update or insert each setting
    for (const [key, value] of Object.entries(settings)) {
      await db('app_settings')
        .insert({
          setting_key: key,
          setting_value: JSON.stringify(value),
          setting_type: 'general',
          updated_at: new Date()
        })
        .onConflict('setting_key')
        .merge({
          setting_value: JSON.stringify(value),
          updated_at: new Date()
        });
    }
    
    // Clear maintenance mode cache if it was updated
    if ('general_maintenance_mode' in settings) {
      clearMaintenanceCache();
    }

    if (publicSiteKeysTouched) {
      clearPublicSiteCache();
    }
    if (uploadLimitTouched) {
      clearMaxFilesPerUploadCache();
    }
    if (Object.prototype.hasOwnProperty.call(settings, 'general_short_gallery_urls')) {
      clearShareLinkSettingsCache();
    }
    // Toggling the original-filenames setting (#493) requires busting the
    // per-event pre-generated zips so the next download-all rebuilds with the
    // new entry names. Single-photo downloads pick up the change as soon as
    // the in-memory cache TTL in downloadFilenameService expires (cleared
    // here for immediacy).
    if (Object.prototype.hasOwnProperty.call(settings, 'general_use_original_filenames_for_downloads')) {
      try {
        require('../services/downloadFilenameService').clearCache();
        require('../services/downloadZipService').invalidateAll();
      } catch (e) {
        logger.warn('Failed to invalidate download caches after filename setting change:', e.message);
      }
    }

    // Log activity
    await db('activity_logs').insert({
      activity_type: 'general_settings_updated',
      actor_type: 'admin',
      actor_id: req.admin.id,
      actor_name: req.admin.username,
      metadata: JSON.stringify({ settings_count: Object.keys(settings).length })
    });

    res.json({ message: 'General settings updated successfully' });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to update general settings');
  }
});

// Update security settings
router.put('/security', adminAuth, requirePermission('settings.edit'), async (req, res) => {
  try {
    const settings = req.body;

    // Update or insert each setting
    for (const [key, value] of Object.entries(settings)) {
      await db('app_settings')
        .insert({
          setting_key: key,
          setting_value: JSON.stringify(value),
          setting_type: 'security',
          updated_at: new Date()
        })
        .onConflict('setting_key')
        .merge({
          setting_value: JSON.stringify(value),
          updated_at: new Date()
        });
    }

    resetSecurityConfigCache();

    // Log activity
    await db('activity_logs').insert({
      activity_type: 'security_settings_updated',
      actor_type: 'admin',
      actor_id: req.admin.id,
      actor_name: req.admin.username,
      metadata: JSON.stringify({ settings_count: Object.keys(settings).length })
    });

    res.json({ message: 'Security settings updated successfully' });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to update security settings');
  }
});

// Update analytics settings
router.put('/analytics', adminAuth, requirePermission('settings.edit'), async (req, res) => {
  try {
    const settings = req.body;

    // Validate the provider switch (#663 Phase 1). Reject unknown values
    // so the dashboard route's factory doesn't have to defensively guard.
    if (Object.prototype.hasOwnProperty.call(settings, 'analytics_tracker_provider')) {
      const valid = ['none', 'umami', 'rybbit', 'custom'];
      if (!valid.includes(settings.analytics_tracker_provider)) {
        return res.status(400).json({
          error: `analytics_tracker_provider must be one of: ${valid.join(', ')}`,
        });
      }
    }

    // Sanitise the custom-mode HTML snippet on save (#663 Phase 1). Stored
    // pre-sanitised so the publicSettings endpoint surfaces it as-is on
    // every gallery request — never re-running sanitize-html on the hot path.
    if (Object.prototype.hasOwnProperty.call(settings, 'analytics_custom_head_html')) {
      const { sanitizeTrackerSnippet } = require('../services/trackers/customScriptSanitiser');
      settings.analytics_custom_head_html = sanitizeTrackerSnippet(settings.analytics_custom_head_html);
    }

    // Update or insert each setting
    for (const [key, value] of Object.entries(settings)) {
      await db('app_settings')
        .insert({
          setting_key: key,
          setting_value: JSON.stringify(value),
          setting_type: 'analytics',
          updated_at: new Date()
        })
        .onConflict('setting_key')
        .merge({
          setting_value: JSON.stringify(value),
          updated_at: new Date()
        });
    }

    // Log activity
    await db('activity_logs').insert({
      activity_type: 'analytics_settings_updated',
      actor_type: 'admin',
      actor_id: req.admin.id,
      actor_name: req.admin.username,
      metadata: JSON.stringify({ settings_count: Object.keys(settings).length })
    });

    res.json({ message: 'Analytics settings updated successfully' });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to update analytics settings');
  }
});

// Update SEO settings
router.put('/seo', adminAuth, requirePermission('settings.edit'), async (req, res) => {
  try {
    const settings = req.body;

    // Validate seo_blocked_ai_agents is an array of strings
    if (settings.seo_blocked_ai_agents !== undefined) {
      if (!Array.isArray(settings.seo_blocked_ai_agents) ||
          !settings.seo_blocked_ai_agents.every(a => typeof a === 'string')) {
        return res.status(400).json({ error: 'seo_blocked_ai_agents must be an array of strings' });
      }
    }

    // Validate seo_custom_rules structure
    if (settings.seo_custom_rules !== undefined) {
      if (!Array.isArray(settings.seo_custom_rules)) {
        return res.status(400).json({ error: 'seo_custom_rules must be an array' });
      }
      for (const rule of settings.seo_custom_rules) {
        if (!rule.userAgent || typeof rule.userAgent !== 'string') {
          return res.status(400).json({ error: 'Each custom rule must have a userAgent string' });
        }
        if (!Array.isArray(rule.disallow) || !rule.disallow.every(d => typeof d === 'string')) {
          return res.status(400).json({ error: 'Each custom rule must have a disallow array of strings' });
        }
      }
    }

    // Update or insert each setting
    for (const [key, value] of Object.entries(settings)) {
      await db('app_settings')
        .insert({
          setting_key: key,
          setting_value: JSON.stringify(value),
          setting_type: 'seo',
          updated_at: new Date()
        })
        .onConflict('setting_key')
        .merge({
          setting_value: JSON.stringify(value),
          updated_at: new Date()
        });
    }

    // Clear robots.txt cache
    const { clearRobotsTxtCache } = require('../services/robotsTxtService');
    clearRobotsTxtCache();

    // Log activity
    await db('activity_logs').insert({
      activity_type: 'seo_settings_updated',
      actor_type: 'admin',
      actor_id: req.admin.id,
      actor_name: req.admin.username,
      metadata: JSON.stringify({ settings_count: Object.keys(settings).length })
    });

    res.json({ message: 'SEO settings updated successfully' });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to update SEO settings');
  }
});

// Get storage info
router.get('/storage/info', adminAuth, requirePermission('settings.view'), async (req, res) => {
  try {
    // Get total storage used
    const totalStorage = await db('photos')
      .sum('size_bytes as total')
      .first();

    // Get storage by event
    const storageByEvent = await db('photos')
      .select('events.event_name', 'events.id')
      .sum('photos.size_bytes as size')
      .join('events', 'photos.event_id', 'events.id')
      .groupBy('events.id')
      .orderBy('size', 'desc')
      .limit(10);

    // Get archive storage
    const archives = await db('events')
      .where('is_archived', formatBoolean(true))
      .whereNotNull('archive_path')
      .select('archive_path');

    let archiveStorage = 0;
    for (const archive of archives) {
      if (archive.archive_path) {
        try {
          const storagePath = getStoragePath();
          const fullArchivePath = path.join(storagePath, archive.archive_path);
          const stats = await fs.stat(fullArchivePath);
          archiveStorage += stats.size;
        } catch (error) {
          logger.error('Archive file not found:', archive.archive_path, error.message);
        }
      }
    }

    const DEFAULT_SOFT_LIMIT_BYTES = 10 * 1024 * 1024 * 1024; // 10GB fallback
    const storagePath = getStoragePath();

    let diskStats = null;
    let rawDiskTotal = null;
    let rawDiskFree = null;
    let rawDiskAvailable = null;
    try {
      diskStats = await fs.statfs(storagePath);
      rawDiskTotal = Number(diskStats.bsize) * Number(diskStats.blocks);
      rawDiskFree = Number(diskStats.bsize) * Number(diskStats.bfree);
      rawDiskAvailable = Number(diskStats.bsize) * Number(diskStats.bavail);
    } catch (diskError) {
      logger.error('Disk stats error:', diskError.message);
    }

    const clampDiskValue = (value) => {
      if (!Number.isFinite(value) || value <= 0) {
        return null;
      }

      // Treat unusually large virtualised values as unreliable (>50TB)
      const MAX_REASONABLE_BYTES = 50 * 1024 * 1024 * 1024 * 1024;
      if (value > MAX_REASONABLE_BYTES) {
        return null;
      }

      return value;
    };

    let diskTotal = null;
    let diskFree = null;
    let diskAvailable = null;

    if (diskStats) {
      diskTotal = clampDiskValue(rawDiskTotal);
      diskFree = clampDiskValue(rawDiskFree);
      diskAvailable = clampDiskValue(rawDiskAvailable);

      if (diskTotal && diskAvailable && diskAvailable > diskTotal) {
        diskAvailable = null;
      }
      if (diskTotal && diskFree && diskFree > diskTotal) {
        diskFree = null;
      }
    }

    const totalUsed = totalStorage?.total || 0;

    const parseBytesValue = (value) => {
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric <= 0) {
        return null;
      }
      return Math.floor(numeric);
    };

    const parseEnvOverride = (bytesVar, gbVar) => {
      if (process.env[bytesVar]) {
        return parseBytesValue(process.env[bytesVar]);
      }
      if (process.env[gbVar]) {
        const value = parseBytesValue(process.env[gbVar]);
        return value ? value * 1024 * 1024 * 1024 : null;
      }
      return null;
    };

    let configuredSoftLimit = null;
    let capacityOverrideDb = null;
    let availableOverrideDb = null;

    try {
      const storageSettings = await db('app_settings')
        .whereIn('setting_key', [
          'general_storage_soft_limit_bytes',
          'general_storage_capacity_override_bytes',
          'general_storage_available_override_bytes'
        ])
        .select('setting_key', 'setting_value');

      storageSettings.forEach((setting) => {
        let parsedValue = null;
        if (setting.setting_value) {
          try {
            parsedValue = JSON.parse(setting.setting_value);
          } catch (error) {
            parsedValue = setting.setting_value;
          }
        }

        switch (setting.setting_key) {
        case 'general_storage_soft_limit_bytes':
          if (typeof parsedValue === 'number' && !Number.isNaN(parsedValue)) {
            configuredSoftLimit = parsedValue;
          }
          break;
        case 'general_storage_capacity_override_bytes':
          if (typeof parsedValue === 'number' && !Number.isNaN(parsedValue)) {
            capacityOverrideDb = parsedValue;
          }
          break;
        case 'general_storage_available_override_bytes':
          if (typeof parsedValue === 'number' && !Number.isNaN(parsedValue)) {
            availableOverrideDb = parsedValue;
          }
          break;
        default:
          break;
        }
      });
    } catch (error) {
      logger.error('Storage settings read error:', error.message);
    }

    const capacityOverrideEnv = parseEnvOverride('STORAGE_CAPACITY_OVERRIDE_BYTES', 'STORAGE_CAPACITY_OVERRIDE_GB');
    const availableOverrideEnv = parseEnvOverride('STORAGE_AVAILABLE_OVERRIDE_BYTES', 'STORAGE_AVAILABLE_OVERRIDE_GB');

    let capacityOverrideBytes = null;
    let availableOverrideBytes = null;
    let overrideSource = null;

    if (capacityOverrideEnv != null || availableOverrideEnv != null) {
      capacityOverrideBytes = capacityOverrideEnv;
      availableOverrideBytes = availableOverrideEnv;
      overrideSource = 'env';
    } else if (capacityOverrideDb != null || availableOverrideDb != null) {
      capacityOverrideBytes = capacityOverrideDb;
      availableOverrideBytes = availableOverrideDb;
      overrideSource = 'settings';
    }

    if (capacityOverrideBytes != null) {
      diskTotal = capacityOverrideBytes;
      if (availableOverrideBytes == null) {
        diskAvailable = Math.max(capacityOverrideBytes - totalUsed, 0);
      } else {
        diskAvailable = Math.min(Math.max(availableOverrideBytes, 0), capacityOverrideBytes);
      }
      diskFree = diskAvailable;
    } else if (availableOverrideBytes != null) {
      diskAvailable = Math.max(availableOverrideBytes, 0);
      diskFree = diskAvailable;
    }

    let recommendedSoftLimit = null;
    if (diskTotal && diskAvailable) {
      const projected = totalUsed + Math.floor(diskAvailable * 0.8);
      recommendedSoftLimit = Math.min(diskTotal, Math.max(projected, Math.floor(diskTotal * 0.5)));
    } else if (diskTotal) {
      recommendedSoftLimit = Math.floor(diskTotal * 0.8);
    } else if (diskAvailable) {
      recommendedSoftLimit = Math.max(totalUsed, totalUsed + Math.floor(diskAvailable * 0.8));
    }

    if (recommendedSoftLimit && totalUsed > 0 && recommendedSoftLimit < totalUsed) {
      recommendedSoftLimit = totalUsed;
    }

    const fallbackSoftLimit = recommendedSoftLimit || diskTotal || DEFAULT_SOFT_LIMIT_BYTES;
    if (!recommendedSoftLimit && fallbackSoftLimit) {
      recommendedSoftLimit = fallbackSoftLimit;
    }
    const effectiveSoftLimit = configuredSoftLimit || fallbackSoftLimit || DEFAULT_SOFT_LIMIT_BYTES;

    const diskMetricsReliable = Boolean(diskTotal);

    res.json({
      total_used: totalUsed,
      archive_storage: archiveStorage,
      storage_by_event: storageByEvent,
      storage_limit: effectiveSoftLimit,
      storage_soft_limit: effectiveSoftLimit,
      configured_soft_limit: configuredSoftLimit,
      recommended_soft_limit: recommendedSoftLimit,
      soft_limit_configured: Boolean(configuredSoftLimit),
      disk_total: diskTotal,
      disk_free: diskFree,
      disk_available: diskAvailable,
      disk_total_raw: rawDiskTotal,
      disk_free_raw: rawDiskFree,
      disk_available_raw: rawDiskAvailable,
      disk_metrics_reliable: diskMetricsReliable,
      disk_override_source: overrideSource
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to fetch storage information');
  }
});

// Upload favicon endpoint
router.post('/favicon', adminAuth, requirePermission('settings.edit'), faviconUpload.single('favicon'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No favicon file provided' });
    }

    // The file is already in the correct location from multer
    const faviconUrl = `/uploads/favicons/${req.file.filename}`;
    
    // Save to database
    await db('app_settings')
      .insert({
        setting_key: 'branding_favicon_url',
        setting_value: JSON.stringify(faviconUrl),
        setting_type: 'branding',
        updated_at: new Date()
      })
      .onConflict('setting_key')
      .merge({
        setting_value: JSON.stringify(faviconUrl),
        updated_at: new Date()
      });

    // Log activity
    await logActivity('favicon_uploaded', 
      { faviconUrl }, 
      null,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );

    res.json({ faviconUrl });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to upload favicon');
  }
});

// Update rate limit settings
router.put('/security/rate-limit', adminAuth, requirePermission('settings.edit'), [
  body('rate_limit_enabled').isBoolean().withMessage('Enabled must be a boolean'),
  body('rate_limit_window_minutes').isInt({ min: 1, max: 60 }).withMessage('Window must be between 1 and 60 minutes'),
  body('rate_limit_max_requests').isInt({ min: 10, max: 10000 }).withMessage('Max requests must be between 10 and 10000'),
  body('rate_limit_auth_max_requests').isInt({ min: 1, max: 100 }).withMessage('Auth max requests must be between 1 and 100'),
  body('rate_limit_skip_authenticated').isBoolean().withMessage('Skip authenticated must be a boolean'),
  body('rate_limit_public_endpoints_only').isBoolean().withMessage('Public endpoints only must be a boolean')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      rate_limit_enabled,
      rate_limit_window_minutes,
      rate_limit_max_requests,
      rate_limit_auth_max_requests,
      rate_limit_skip_authenticated,
      rate_limit_public_endpoints_only
    } = req.body;

    // Update each setting
    const settings = [
      { key: 'rate_limit_enabled', value: rate_limit_enabled },
      { key: 'rate_limit_window_minutes', value: rate_limit_window_minutes },
      { key: 'rate_limit_max_requests', value: rate_limit_max_requests },
      { key: 'rate_limit_auth_max_requests', value: rate_limit_auth_max_requests },
      { key: 'rate_limit_skip_authenticated', value: rate_limit_skip_authenticated },
      { key: 'rate_limit_public_endpoints_only', value: rate_limit_public_endpoints_only }
    ];

    for (const { key, value } of settings) {
      await db('app_settings')
        .where('setting_key', key)
        .update({
          setting_value: JSON.stringify(value),
          updated_at: new Date()
        });
    }

    // Clear the rate limit settings cache to apply changes immediately
    clearSettingsCache();

    // Log activity
    await logActivity('settings_updated', 
      { 
        category: 'security',
        subcategory: 'rate_limit',
        changes: settings.length
      },
      null,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );

    res.json({ message: 'Rate limit settings updated successfully' });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to update rate limit settings');
  }
});

// Get default public site template
router.get('/public-site/default', adminAuth, requirePermission('settings.view'), async (req, res) => {
  try {
    const defaults = await getDefaultPublicSitePayload();

    res.json({
      enabled: false,
      html: DEFAULT_PUBLIC_SITE_HTML.trim(),
      css: '',
      baseCss: DEFAULT_PUBLIC_SITE_CSS.trim(),
      branding: defaults.branding,
      meta: {
        title: defaults.title,
      }
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to load defaults');
  }
});

// Reset public site template to defaults
router.post('/public-site/reset', adminAuth, requirePermission('settings.edit'), async (req, res) => {
  try {
    const entries = [
      {
        key: 'general_public_site_html',
        value: DEFAULT_PUBLIC_SITE_HTML.trim()
      },
      {
        key: 'general_public_site_custom_css',
        value: ''
      }
    ];

    for (const { key, value } of entries) {
      await db('app_settings')
        .insert({
          setting_key: key,
          setting_value: JSON.stringify(value),
          setting_type: 'general',
          updated_at: new Date()
        })
        .onConflict('setting_key')
        .merge({
          setting_value: JSON.stringify(value),
          updated_at: new Date()
        });
    }

    clearPublicSiteCache();

    const defaults = await getDefaultPublicSitePayload();

    await logActivity('public_site_reset_to_default',
      {
        template_length: DEFAULT_PUBLIC_SITE_HTML.length,
      },
      null,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );

    res.json({
      message: 'Public site template reset to defaults',
      html: DEFAULT_PUBLIC_SITE_HTML.trim(),
      css: '',
      baseCss: DEFAULT_PUBLIC_SITE_CSS.trim(),
      branding: defaults.branding
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to reset template');
  }
});

module.exports = router;
