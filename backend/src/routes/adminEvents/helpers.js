// Extracted verbatim from the original routes/adminEvents.js (see ./index.js).
// Shared helpers + module-level caches used across the adminEvents sub-routers.

const { db, logActivity } = require('../../database/db');
const fs = require('fs').promises;
const path = require('path');
const logger = require('../../utils/logger');
const { parseStringInput } = require('../../utils/parsers');

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
const getStoragePath = () => process.env.STORAGE_PATH || path.join(__dirname, '../../../../storage');

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
    const storagePath = process.env.STORAGE_PATH || path.join(__dirname, '../../../../storage');
    for (const sub of ['active', 'archived']) {
      const eventFolderPath = path.join(storagePath, 'events', sub, event.slug);
      try {
        await fs.rm(eventFolderPath, { recursive: true, force: true });
      } catch (fsErr) {
        logger.warn('Failed to delete event folder during cascade delete', { eventId, path: eventFolderPath, error: fsErr.message });
      }
    }

    if (event.archive_path) {
      const storagePath = process.env.STORAGE_PATH || path.join(__dirname, '../../../../storage');
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
module.exports = {
  validateHeroImageAnchor,
  getStoragePath,
  getEventFieldRequirements,
  readBooleanSetting,
  getDownloadProtectionDefaults,
  getBrandingDefaults,
  getCustomerNameFromPayload,
  getCustomerEmailFromPayload,
  getCustomerPhoneFromPayload,
  isPhoneFieldEnabled,
  mapEventForApi,
  hasCustomerContactColumns,
  deleteEventCascade,
  SLIDESHOW_TRANSITIONS,
  SLIDESHOW_COLORFILTERS,
};
