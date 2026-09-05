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

/**
 * The rest of Settings → Image security, as creation defaults (#1296).
 *
 * Four settings in that panel were written, reloaded and rendered as
 * controls, and read by nothing:
 *
 *   default_protection_level     → events.protection_level
 *   default_image_quality        → events.image_quality
 *   enable_canvas_rendering      → events.use_canvas_rendering
 *   default_fragmentation_level  → events.fragmentation_level
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

const getImageSecurityDefaults = async () => {
  const defaults = {};
  try {
    const rows = await db('app_settings')
      .whereIn('setting_key', [
        'default_protection_level',
        'default_image_quality',
        'enable_canvas_rendering',
        'default_fragmentation_level',
      ])
      .select('setting_key', 'setting_value');

    const read = (key) => {
      const row = rows.find((r) => r.setting_key === key);
      if (!row) return undefined;
      let value = row.setting_value;
      if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { /* keep raw */ }
      }
      return value;
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

    const fragmentation = toInteger(read('default_fragmentation_level'));
    if (fragmentation !== undefined && fragmentation >= 1 && fragmentation <= 10) {
      defaults.fragmentation_level = fragmentation;
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
  const { formatBoolean } = require('../../utils/dbCompat');
  const columns = {};
  const pick = (key) => (body[key] !== undefined ? body[key] : defaults[key]);

  const level = pick('protection_level');
  if (level !== undefined) columns.protection_level = level;

  const quality = pick('image_quality');
  if (quality !== undefined) columns.image_quality = quality;

  const canvas = pick('use_canvas_rendering');
  if (canvas !== undefined) columns.use_canvas_rendering = formatBoolean(canvas);

  const fragmentation = pick('fragmentation_level');
  if (fragmentation !== undefined) columns.fragmentation_level = fragmentation;

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

  // Responsive tiers (#1095 / #492) live in the top-level thumbnails/ and
  // previews/ directories, not under the event folder the filesystem sweep
  // below removes, and their keys are derived from the photo rows — which the
  // transaction is about to delete. So they are read here, while the rows
  // still exist, and swept after the commit; miss that window and every tier
  // this event generated is orphaned with nothing left to derive its key from.
  //
  // The managed objects themselves need exactly the same window (#1051), so
  // one query serves both. On an S3/R2 backend the filesystem sweep below
  // removes nothing at all — those paths don't exist locally, `fs.rm` happily
  // succeeds against them, and every originally-uploaded photo stays in the
  // bucket unreferenced and billable. Measured on a 403-photo event: object
  // count unchanged, 679 rows gone.
  const tieredPhotos = await db('photos')
    .where('event_id', eventId)
    .select('id', 'path', 'filename', 'source_origin', 'external_relpath',
      'thumbnail_path', 'hero_path', 'preview_path', 'watermark_path');

  // A Set because a photo can carry the same key in two columns (an unresized
  // gallery's hero and preview can resolve to one object) and deleting it
  // twice would log a spurious failure for the second attempt.
  const storageKeys = new Set();
  // Derived keys separately: unlike the originals, whose keys embed the event
  // slug, these are not event-scoped and need a shared-ownership check below.
  const derivedKeys = new Set();
  try {
    const { resolvePhotoStorageKey } = require('../../services/photoResolver');
    for (const photo of tieredPhotos) {
      try {
        // Returns null for reference/external photos, which live on a mount
        // outside the managed backend and must NOT be deleted — PicPeak does
        // not own those bytes.
        const originalKey = resolvePhotoStorageKey(event, photo);
        if (originalKey) storageKeys.add(originalKey);
      } catch (keyErr) {
        logger.warn('Could not resolve storage key during cascade delete', {
          eventId, photoId: photo.id, error: keyErr.message
        });
      }
      // Derived tiers are stored as canonical keys and pass through verbatim,
      // the same list adminPhotoDimensions.js:801 sweeps on a re-render.
      for (const derived of [photo.thumbnail_path, photo.hero_path, photo.preview_path, photo.watermark_path]) {
        if (derived) {
          storageKeys.add(derived);
          derivedKeys.add(derived);
        }
      }
    }
  } catch (collectErr) {
    logger.warn('Could not enumerate stored objects before cascade delete', {
      eventId, error: collectErr.message
    });
  }

  // A canonical derivative can belong to more than one gallery. Its basename
  // comes from the photo's filename — imageProcessor passes no outputBasename
  // for managed photos, so the key is `thumbnails/thumb_w300_<filename>` with
  // nothing event-scoped in it — and filenames are not unique across events.
  // The responsive-tier code says exactly that, which is why THOSE keys carry
  // a p{id}_ prefix; the canonical ones predate it. Deleting a shared key here
  // would blank a surviving gallery's tile until something regenerated it, so
  // anything another event still points at is left alone. Originals need no
  // such check: their keys embed the slug.
  const derived = Array.from(derivedKeys);
  try {
    // Chunked: SQLite caps bind variables at 999 and this is four columns wide.
    for (let i = 0; i < derived.length; i += 200) {
      const chunk = derived.slice(i, i + 200);
      const shared = await db('photos')
        .whereNot('event_id', eventId)
        .where((qb) => qb
          .whereIn('thumbnail_path', chunk)
          .orWhereIn('hero_path', chunk)
          .orWhereIn('preview_path', chunk)
          .orWhereIn('watermark_path', chunk))
        .select('thumbnail_path', 'hero_path', 'preview_path', 'watermark_path');
      for (const row of shared) {
        for (const key of [row.thumbnail_path, row.hero_path, row.preview_path, row.watermark_path]) {
          if (key && derivedKeys.has(key)) storageKeys.delete(key);
        }
      }
    }
  } catch (sharedErr) {
    // Can't prove ownership — keep the objects. An orphan costs storage; a
    // deleted derivative costs someone else's gallery.
    logger.warn('Could not check for shared derivatives; leaving them in place', {
      eventId, error: sharedErr.message
    });
    for (const key of derivedKeys) storageKeys.delete(key);
  }

  // The archive zip is typically the largest single object an event owns, and
  // archiveService writes it through the backend (`storage.putFromFile`, see
  // archiveService.js:160) — so the `fs.unlink` below is a no-op on S3 and the
  // zip outlives the event it belongs to.
  if (event.archive_path) storageKeys.add(event.archive_path);

  // The download caches are the subtle ones: they live UNDER
  // events/active/{slug}/.download-cache/, so the recursive fs.rm below covers
  // them on local disk and nothing covers them on S3, where the prefix is not
  // a directory. Both are gallery-sized.
  //
  //   - the pre-built "Download All" zip (downloadZipService.js:44)
  //   - one zip per custom-resolution download job (downloadJobService.js:77)
  //
  // The job rows must be read BEFORE the transaction for the same reason the
  // photo rows are: download_jobs.event_id is ON DELETE CASCADE, so on
  // Postgres the rows vanish with the event and their keys with them.
  // NOTE: an in-flight "Download All" build that started before this delete
  // can still upload its zip after the sweep and write the path onto a row
  // that no longer exists, orphaning it. downloadZipService.cleanup() is the
  // service's cancel primitive, but calling it here made the stable twin's
  // backend CI job exceed its 10-minute budget: _cleanup() reaches
  // getStorage(), and where the S3 backend is configured but unreachable
  // every cascade delete pays the adapter's retry backoff — in the request
  // path, not just in tests. Left as a follow-up rather than shipped behind a
  // timeout: the race costs one orphaned object, this cost the whole suite.
  if (event.download_zip_path) storageKeys.add(event.download_zip_path);
  try {
    if (await db.schema.hasTable('download_jobs')) {
      const jobs = await db('download_jobs')
        .where('event_id', eventId)
        .whereNotNull('zip_path')
        .select('zip_path');
      for (const job of jobs) storageKeys.add(job.zip_path);
    }
  } catch (jobErr) {
    logger.warn('Could not enumerate download job archives before cascade delete', {
      eventId, error: jobErr.message
    });
  }

  await db.transaction(async (trx) => {
    // 1. Delete activity logs (audit trail)
    await trx('activity_logs').where('event_id', eventId).del();
    // 2. Delete access logs
    await trx('access_logs').where('event_id', eventId).del();
    // 3. Delete email queue entries
    await trx('email_queue').where('event_id', eventId).del();
    // 4. Delete photos (also handles hero_photo_id foreign key)
    // Face data (#1074). The FK declares ON DELETE CASCADE, but SQLite only
    // honours that when `PRAGMA foreign_keys = ON`, which PicPeak does not set
    // — so on the SQLite path the cascade is inert and biometric embeddings
    // would outlive the gallery they belong to. Delete explicitly, before the
    // photos, so the guarantee holds on both engines.
    await trx('photo_faces').where('event_id', eventId).del();
    await trx('event_people').where('event_id', eventId).del();
    // Separations carry a COPY of each side's centroid since #1132, so this
    // table holds biometric data too — and it deliberately has no event FK, so
    // nothing else would ever reach it. hasTable rather than a catch: a failed
    // statement aborts the surrounding transaction on Postgres, which would
    // take the whole delete down on a pre-migration install.
    if (await trx.schema.hasTable('event_people_merge_dismissals')) {
      await trx('event_people_merge_dismissals').where('event_id', eventId).del();
    }

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

  // Tier sweep, post-commit and best-effort for the same reason as the folder
  // removal above: an orphaned derivative is recoverable noise, a rolled-back
  // delete is not.
  try {
    const { deleteThumbnailTiers, deletePreviewTiers } = require('../../services/imageProcessor');
    for (const photo of tieredPhotos) {
      await deleteThumbnailTiers(photo);
      await deletePreviewTiers(photo);
    }
  } catch (tierErr) {
    logger.warn('Failed to delete responsive tiers during cascade delete', { eventId, error: tierErr.message });
  }

  // Managed objects, post-commit for the same reason: a rolled-back
  // transaction must never leave files destroyed for an event that still
  // exists. Every key here goes through the backend on both engines — on
  // local disk the folder sweep above already covers the originals, but the
  // tiers, watermarks and the archive live outside the event folder and would
  // otherwise leak there too.
  if (storageKeys.size > 0) {
    const { getStorage } = require('../../services/storage');
    let removed = 0;
    try {
      const storage = getStorage();
      const keys = Array.from(storageKeys);

      // Bounded concurrency rather than one await per key. A 400-photo gallery
      // owns ~1600 objects once the derived tiers are counted, and on S3 that
      // many sequential DeleteObject round trips runs to minutes — long enough
      // for a proxy to time the request out AFTER the commit, leaving the
      // event deleted and the sweep half-finished. Deleting is idempotent and
      // order-independent, so there is nothing to serialise for.
      //
      // A pool, not Promise.all over every key: an unbounded fan-out would
      // open one socket per object and exhaust the S3 client's connection
      // pool, which is what #1049 just finished making failures survivable.
      const CONCURRENCY = 16;
      let cursor = 0;
      const worker = async () => {
        while (cursor < keys.length) {
          const key = keys[cursor++];
          try {
            await storage.delete(key);
            removed++;
          } catch (delErr) {
            logger.warn('Failed to delete stored object during cascade delete', {
              eventId, key, error: delErr.message
            });
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, keys.length) }, worker)
      );
    } catch (storageErr) {
      logger.warn('Storage backend unavailable during cascade delete', {
        eventId, error: storageErr.message
      });
    }
    logger.info('Cascade delete removed stored objects', {
      eventId, removed, total: storageKeys.size
    });
  }

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
// Allowed slideshow play orders (#202). 'chronological' = upload order,
// 'random' = client-side shuffle.
const SLIDESHOW_ORDERS = ['chronological', 'random'];
module.exports = {
  validateHeroImageAnchor,
  getStoragePath,
  getEventFieldRequirements,
  readBooleanSetting,
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
  deleteEventCascade,
  SLIDESHOW_ORDERS,
  SLIDESHOW_TRANSITIONS,
  SLIDESHOW_COLORFILTERS,
};
