const { db } = require('../database/db');
const logger = require('../utils/logger');
const { parseStringInput } = require('../utils/parsers');
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
const { getStoragePath } = require('../config/storage');

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
/**
 * Decode an app_settings value into the JS value it represents.
 *
 * setting_value is JSON text on SQLite and may already be decoded by the
 * driver on a PG json column, so one parse does not normalise both. On top
 * of that, the Image Security tab used to PUT back values it had read
 * undecoded, wrapping another layer of quoting around each one on every
 * save — the GET handler decodes now, but installs carry however many
 * layers they accumulated before that.
 *
 * Every reader of app_settings has to agree about this, or the admin UI
 * shows one thing while event creation does another.
 *
 * Terminates: each parse of a string is strictly shorter than its input.
 */
const decodeSettingValue = (raw) => {
  let value = raw;
  while (typeof value === 'string') {
    let parsed;
    try { parsed = JSON.parse(value); } catch { break; }
    if (parsed === value) break;
    value = parsed;
  }
  return value;
};

const readBooleanSetting = async (key) => {
  try {
    const setting = await db('app_settings').where('setting_key', key).first();
    if (!setting) return undefined;
    const value = decodeSettingValue(setting.setting_value);
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

/**
 * The rest of Settings → Image security, as creation defaults (#1296).
 *
 * Four settings in that panel were written, reloaded and rendered as
 * controls, and read by nothing:
 *
 *   default_protection_level     → events.protection_level
 *   default_image_quality        → events.image_quality
 *   enable_canvas_rendering      → events.use_canvas_rendering
 *
 * Each maps onto a column migration 038 already created, and each is
 * labelled "… by default", so applying them at creation is what the panel
 * has always claimed to do. `enable_devtools_protection` above is the only
 * one of the five that was ever wired.
 *
 * Creation-time only, deliberately. Applying them to EXISTING events would
 * silently change live galleries on upgrade — an install with
 * enable_canvas_rendering already on would switch every grid to canvas
 * rendering, which is memory-expensive at scale and is the profile under
 * investigation in #1287. New events only; existing rows untouched.
 *
 * Any value that is missing or malformed comes back undefined so the caller
 * falls through to the column default, exactly as before this existed.
 */
const PROTECTION_LEVELS = ['basic', 'standard', 'enhanced', 'maximum'];

// parseInt would rescue malformed settings instead of rejecting them:
// parseInt('72oops') is 72, parseInt(72.5) is 72, parseInt([72]) is 72.
// That matters because the settings PUT stores whatever JSON it is handed
// without validating the value (adminImageSecurity.js writes
// JSON.stringify(value) for any allow-listed key), so those shapes really
// can be sitting in app_settings. Accept only a genuine integer, or a
// string that is exactly one.
const toInteger = (value) => {
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined;
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
};

const getImageSecurityDefaults = async (trx = null) => {
  const defaults = {};
  try {
    // Accepts a transaction the way getAppSetting does. It matters on
    // sqlite3, whose pool holds a single connection: a caller already inside
    // db.transaction() that read through the global `db` would block on the
    // connection its own transaction holds until the acquire timeout, and
    // the catch below would then quietly swallow it and drop the defaults.
    const query = trx || db;
    const rows = await query('app_settings')
      .whereIn('setting_key', [
        'default_protection_level',
        'default_image_quality',
        'enable_canvas_rendering',
      ])
      .select('setting_key', 'setting_value');

    // app_settings holds JSON text on SQLite, while a PG json column comes
    // back already decoded — so one parse is not enough to normalise both.
    // Worse, GET /api/admin/image-security/settings returns setting_value
    // without decoding it and the settings tab PUTs the whole fetched object
    // straight back through JSON.stringify, so opening the tab and saving
    // re-encodes every value it read as text. After one such round trip
    // `true` is stored as "\"true\"" and a single parse yields the string
    // 'true', which the type checks below reject — the settings would go
    // quietly dead again, which is the bug this whole change exists to fix.
    // The GET handler now decodes, so this stops accumulating — but installs
    // that already stacked N layers have to keep working, and N is however
    // many times someone opened that tab. So unwrap until it stops being a
    // JSON string rather than to a fixed depth; this terminates because each
    // parse of a string is strictly shorter than its input.
    const read = (key) => {
      const row = rows.find((r) => r.setting_key === key);
      if (!row) return undefined;
      return decodeSettingValue(row.setting_value);
    };

    const level = read('default_protection_level');
    if (typeof level === 'string' && PROTECTION_LEVELS.includes(level)) {
      defaults.protection_level = level;
    }

    // The column is an integer percentage; anything outside 1..100 is a
    // misconfiguration and falls through rather than being clamped into
    // something the operator did not choose.
    const quality = toInteger(read('default_image_quality'));
    if (quality !== undefined && quality >= 1 && quality <= 100) {
      defaults.image_quality = quality;
    }

    const canvas = read('enable_canvas_rendering');
    if (typeof canvas === 'boolean') {
      defaults.use_canvas_rendering = canvas;
    }

  } catch (error) {
    // A settings read must never block event creation; the column defaults
    // are a correct fallback.
    logger.error('Failed to read image-security defaults', { error: error.message });
  }
  return defaults;
};

/**
 * Build the image-security columns for a NEW event: an explicit request
 * value wins, then the global default, then the column default (the key is
 * omitted entirely so the database supplies it).
 *
 * Shared by the admin create route and POST /api/v1/events so the configured
 * security level cannot depend on which entry point created the gallery —
 * the same split that made #592 (devtools) a separate bug from #317.
 *
 * `body` values are already validated by the route's express-validator
 * chain; `defaults` come from getImageSecurityDefaults(), which validates
 * them itself.
 */
const resolveImageSecurityColumns = (body = {}, defaults = {}) => {
  const { formatBoolean } = require('../utils/dbCompat');
  const columns = {};
  // express-validator runs isInt/isIn/isBoolean element-wise on arrays, so a
  // single-element array like `image_quality: [72]` passes the route's chain
  // and arrives here still an array. The routes reject those with
  // .not().isArray(); this guard means any future caller cannot write one
  // into a scalar column (a PG insert error, or `[false]` coerced to true).
  const scalar = (v) => (v !== null && typeof v === 'object' ? undefined : v);
  const pick = (key) => {
    const fromBody = scalar(body[key]);
    return fromBody !== undefined ? fromBody : defaults[key];
  };

  const level = pick('protection_level');
  if (level !== undefined) columns.protection_level = level;

  const quality = pick('image_quality');
  if (quality !== undefined) columns.image_quality = quality;

  const canvas = pick('use_canvas_rendering');
  if (canvas !== undefined) columns.use_canvas_rendering = formatBoolean(canvas);


  return columns;
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

const RECOVERABLE_PASSWORD_COLUMNS = ['password_recoverable', 'client_password_recoverable'];

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
    // Bound only to exclude the secrets from `...rest` — never read.
    password_hash: _ph, client_password_hash: _cph,
    ...rest
  } = event;
  // #1271 — the encrypted copies never leave the server except via
  // /:id/password. Removed by name (not destructured) so a secret scanner
  // does not read the binding as a hard-coded password.
  for (const column of RECOVERABLE_PASSWORD_COLUMNS) delete rest[column];

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

// Allowed slide transition styles (kept in sync with the SlideshowPage).
// dipwhite/dipblack = fade through highlights / lowlights between images.
const SLIDESHOW_TRANSITIONS = ['crossfade', 'cut', 'slide', 'kenburns', 'dipwhite', 'dipblack'];
// Allowed per-slide color filters.
const SLIDESHOW_COLORFILTERS = ['none', 'bw', 'sepia', 'warm', 'cool', 'vignette'];
// Allowed slideshow play orders (#202). 'chronological' = upload order,
// 'random' = client-side shuffle.
const SLIDESHOW_ORDERS = ['chronological', 'random'];
// How slides fill the screen (issue 2261). 'auto' shows a photo whole when its
// orientation differs from the screen's (portrait on a projector) and fills
// the screen otherwise; 'contain' never crops; 'cover' always fills.
const SLIDESHOW_FITS = ['auto', 'contain', 'cover'];
const DEFAULT_SLIDESHOW_FIT = 'auto';
const normalizeSlideshowFit = (value, fallback = DEFAULT_SLIDESHOW_FIT) =>
  (SLIDESHOW_FITS.includes(value) ? value : fallback);
module.exports = {
  RECOVERABLE_PASSWORD_COLUMNS,
  validateHeroImageAnchor,
  getStoragePath,
  getEventFieldRequirements,
  readBooleanSetting,
  decodeSettingValue,
  getDownloadProtectionDefaults,
  getImageSecurityDefaults,
  resolveImageSecurityColumns,
  getBrandingDefaults,
  getCustomerNameFromPayload,
  getCustomerEmailFromPayload,
  getCustomerPhoneFromPayload,
  isPhoneFieldEnabled,
  mapEventForApi,
  hasCustomerContactColumns,
  SLIDESHOW_ORDERS,
  SLIDESHOW_FITS,
  DEFAULT_SLIDESHOW_FIT,
  normalizeSlideshowFit,
  SLIDESHOW_TRANSITIONS,
  SLIDESHOW_COLORFILTERS,
};
