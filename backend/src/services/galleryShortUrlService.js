/**
 * Branded URL shortener for gallery share links (#699).
 *
 * Admins create `/s/<short_slug>` URLs that resolve to a gallery's full
 * link AND answer social-crawler scrapes with the gallery's OG preview.
 * The short URL is what photographers actually paste into chat — the
 * og:url canonical points back at the short URL itself, so each social
 * platform's cache is keyed on the slug the operator chose, not the
 * underlying gallery URL that may rotate.
 *
 * Behaviour decisions worth pinning here (and in the migration comment):
 *   - Soft-delete with `deleted_at` so an accidental delete is recoverable.
 *     Public route serves 410 Gone (not 404) on a soft-deleted slug so
 *     the admin sees their delete was intentional in scrapes/logs.
 *   - Re-creating a soft-deleted slug rotates ownership: the old row is
 *     hard-deleted, the new row is created. The UNIQUE constraint on
 *     short_slug enforces this — you can't have two live rows for the
 *     same public path.
 *   - target_path is captured AT CREATE TIME from the event's current
 *     state (slug + share_token + the global "Use short gallery URLs"
 *     toggle). A later flip of that toggle doesn't silently change
 *     where existing short URLs resolve. Same principle as quote PDFs
 *     snapshotting at issuance time.
 */
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { getAppSetting } = require('../utils/appSettings');

// Slug rules:
//   - Lowercase a-z, digits, hyphens only
//   - Must start with a letter or digit (no leading hyphen, no double-hyphen-leading)
//   - 1-64 chars
//   - Trailing hyphen disallowed to keep URLs tidy
const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

// Reserved top-level paths the application already uses. Allowing a
// short URL to shadow any of these would break either the app itself
// (admin/api/auth) or future routes we may add (assets/static). The
// public route is mounted at `/s/<slug>` so technically the only real
// risk is shadowing other things mounted at `/s/...` — but operators
// occasionally point Cloudflare rules at top-level paths, and keeping
// a sane blocklist costs nothing.
const RESERVED_SLUGS = new Set([
  'admin', 'api', 'auth', 'assets', 'static', 'public', 'gallery',
  'og', 'health', 'metrics', 'robots.txt', 's', 'docs', 'login',
  'logout', 'signup', 'register', 'reset', 'reset-password', 'app',
  'manifest.json', 'favicon.ico', 'sitemap.xml',
]);

/**
 * Validate a candidate short slug.
 * @returns {string|null} null if valid; otherwise a human-readable reason.
 */
function validateSlug(slug) {
  if (typeof slug !== 'string') return 'short_slug must be a string';
  const trimmed = slug.trim();
  if (!trimmed) return 'short_slug cannot be empty';
  if (trimmed.length > 64) return 'short_slug must be at most 64 characters';
  if (!SLUG_REGEX.test(trimmed)) {
    return 'short_slug must be lowercase letters, digits, and hyphens, starting and ending with a letter or digit';
  }
  if (RESERVED_SLUGS.has(trimmed)) return 'short_slug is reserved';
  return null;
}

/**
 * Compute the target path for a gallery short URL based on the event's
 * current state + the global "Use short gallery URLs" setting. Snapshot
 * this value at create time so future toggle flips don't silently
 * change what existing short URLs resolve to.
 */
async function targetPathForEvent(event) {
  if (!event) throw new Error('event required');
  const useShortGallery = (await getAppSetting('general_use_short_gallery_urls', false)) === true;
  if (useShortGallery && event.share_token) {
    return `/gallery/${event.share_token}`;
  }
  return `/gallery/${event.slug}`;
}

/**
 * Build candidate auto-generated slugs in preference order. Walks each
 * candidate against the UNIQUE constraint and returns the first that's
 * free. Falls back to a 6-char random alphanum if every shaped
 * candidate collides.
 *
 *   <slug>           — when short and clean
 *   <slug>-<year>    — e.g. senior-2026
 *   <slug>-<random>  — last-ditch
 */
async function autoGenerateSlug(event) {
  const base = String(event.slug || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48); // leave headroom for suffix
  const year = event.event_date
    ? new Date(event.event_date).getFullYear()
    : new Date().getFullYear();

  const candidates = [];
  if (base) candidates.push(base);
  if (base) candidates.push(`${base}-${year}`);

  for (const cand of candidates) {
    const validity = validateSlug(cand);
    if (validity) continue; // skip if it'd fail validation (e.g. trailing hyphen)
    const taken = await db('gallery_short_urls')
      .where({ short_slug: cand })
      .whereNull('deleted_at')
      .first();
    if (!taken) return cand;
  }

  // Random fallback. Six alphanum chars = ~31 bits of entropy; for a
  // namespace of at-most-N-galleries-per-instance this is more than
  // enough to avoid collisions in practice.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const random = Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, '');
    if (random.length < 6) continue;
    const taken = await db('gallery_short_urls')
      .where({ short_slug: random })
      .whereNull('deleted_at')
      .first();
    if (!taken) return random;
  }
  throw new Error('Failed to auto-generate a unique short slug after 5 attempts');
}

/**
 * Create a short URL for an event. `customSlug` is optional — when
 * absent, we auto-generate from the event slug + year.
 *
 * Returns { id, short_slug, target_path, ... }.
 *
 * Throws on collision with a structured error:
 *   { code: 'SLUG_TAKEN', suggested: 'sofia-graduation-2' }
 */
async function createShortUrl({ eventId, customSlug = null, createdBy = null }) {
  const event = await db('events').where({ id: eventId }).first();
  if (!event) {
    const err = new Error('Event not found');
    err.code = 'EVENT_NOT_FOUND';
    throw err;
  }

  let slug;
  if (customSlug != null) {
    const lowered = String(customSlug).toLowerCase().trim();
    const validityError = validateSlug(lowered);
    if (validityError) {
      const err = new Error(validityError);
      err.code = 'INVALID_SLUG';
      throw err;
    }
    // Collision check (only against live rows; soft-deleted rows are
    // hard-deleted on conflict to keep the UNIQUE constraint sane).
    const existing = await db('gallery_short_urls')
      .where({ short_slug: lowered })
      .first();
    if (existing && !existing.deleted_at) {
      const err = new Error(`Short slug '${lowered}' is already in use`);
      err.code = 'SLUG_TAKEN';
      err.suggested = await autoGenerateSlug({ ...event, slug: lowered });
      throw err;
    }
    if (existing && existing.deleted_at) {
      // Soft-deleted row in the way of the UNIQUE constraint — purge
      // it so the admin can re-claim the slug. This is the intended
      // "yes, replace the old link" path; if the admin wanted the old
      // link back, they'd restore the soft-deleted row, not create a
      // new one.
      await db('gallery_short_urls').where({ id: existing.id }).delete();
    }
    slug = lowered;
  } else {
    slug = await autoGenerateSlug(event);
  }

  const targetPath = await targetPathForEvent(event);

  const inserted = await db('gallery_short_urls').insert({
    short_slug: slug,
    event_id: event.id,
    target_path: targetPath,
    created_by: createdBy,
    created_at: new Date(),
    hit_count: 0,
  }).returning(['id', 'short_slug', 'target_path', 'created_at']);

  const row = inserted[0] || {};
  logger.info('gallery_short_urls: created', {
    shortSlug: slug, eventId: event.id, createdBy,
  });
  return {
    id: row.id,
    short_slug: row.short_slug || slug,
    event_id: event.id,
    target_path: row.target_path || targetPath,
    created_at: row.created_at,
    hit_count: 0,
    last_hit_at: null,
  };
}

/**
 * Look up a short URL by its public slug. Returns null if not found.
 * Soft-deleted rows are NOT filtered out here — callers decide how to
 * present them (the public route uses presence-of-deleted_at to send
 * 410 Gone instead of 404).
 */
async function findByShortSlug(slug) {
  if (!slug || typeof slug !== 'string') return null;
  const lowered = slug.toLowerCase().trim();
  if (validateSlug(lowered)) return null; // malformed input — no lookup
  const row = await db('gallery_short_urls').where({ short_slug: lowered }).first();
  return row || null;
}

/**
 * List all live short URLs for an event, newest first.
 */
async function listForEvent(eventId) {
  const rows = await db('gallery_short_urls')
    .where({ event_id: eventId })
    .whereNull('deleted_at')
    .orderBy('created_at', 'desc')
    .select('id', 'short_slug', 'target_path', 'hit_count', 'last_hit_at', 'created_at', 'created_by');
  return rows;
}

/**
 * Soft-delete a short URL. Returns true if a row was affected, false
 * otherwise (caller can map false → 404).
 */
async function softDelete(id, deletedBy = null) {
  const affected = await db('gallery_short_urls')
    .where({ id })
    .whereNull('deleted_at')
    .update({ deleted_at: new Date(), deleted_by: deletedBy });
  if (affected) {
    logger.info('gallery_short_urls: soft-deleted', { id, deletedBy });
  }
  return affected > 0;
}

/**
 * Increment hit_count + stamp last_hit_at. Called from the public route
 * AFTER the response has been queued so the user doesn't wait on the
 * write. Wrapped in try/catch so a DB blip can't 500 the redirect.
 */
async function recordHit(id) {
  try {
    await db('gallery_short_urls').where({ id }).update({
      hit_count: db.raw('hit_count + 1'),
      last_hit_at: new Date(),
    });
  } catch (err) {
    logger.warn('gallery_short_urls: recordHit failed (non-fatal)', {
      id, error: err.message,
    });
  }
}

module.exports = {
  validateSlug,
  targetPathForEvent,
  autoGenerateSlug,
  createShortUrl,
  findByShortSlug,
  listForEvent,
  softDelete,
  recordHit,
  // Exposed for tests
  _RESERVED_SLUGS: RESERVED_SLUGS,
};
