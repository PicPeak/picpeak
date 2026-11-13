'use strict';
/**
 * Gallery embed on another website (issue 1112, migration 359).
 *
 * The embed is /gallery/:slug/embed/:token in an <iframe>. Only a gallery that
 * is already public can be embedded: no password, live (active, published,
 * not archived, not expired, not paused), not hidden until a reveal and not
 * waiting for a booking payment. Its
 * photos are readable without a session today (galleryAccessService grants a
 * public viewer on such a gallery), so the token is not what keeps them
 * private. It is the photographer's consent to the embed and the handle to
 * end it: rotating or removing it stops every page that embeds the old link.
 *
 * Where the embed may be framed is the CSP frame-ancestors list built here
 * from events.embed_allowed_origins. Every other page keeps
 * X-Frame-Options: SAMEORIGIN.
 */
const { db } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const { isGalleryAvailable, requiresGalleryPassword } = require('../utils/galleryLifecycle');
const { isGalleryHidden } = require('../utils/revealMode');
const { isFeatureEnabled } = require('../middleware/requireFeatureFlag');

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
// events.slug is a 255-character column; creation does not shorten it.
const SLUG_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;
const MAX_ORIGINS = 20;
// https://host[:port], or https://*.domain for every subdomain. Lowercase,
// no path, no query, no credentials. http only for localhost (testing).
const ORIGIN_PATTERN = /^https:\/\/(\*\.)?([a-z0-9-]+\.)+[a-z0-9-]{2,63}(:\d{1,5})?$/;
const LOCAL_ORIGIN_PATTERN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

/** The embed is eligible: token, flag and the gallery's public state. */
async function resolveEmbed(slug, token) {
  if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) return null;
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
  if (!(await isFeatureEnabled('embed'))) return null;
  const event = await db('events')
    .where({
      slug,
      embed_token: token,
      is_active: formatBoolean(true),
      is_archived: formatBoolean(false),
      is_draft: formatBoolean(false),
    })
    .first();
  if (!event || !isGalleryAvailable(event)) return null;
  if (requiresGalleryPassword(event) || isGalleryHidden(event)) return null;
  // A booking gallery waiting for payment is closed to guests (issue 2440):
  // its images would all be refused, so it is not embeddable either. Same
  // re-check as galleryAccessService, so a paid deal opens here too.
  if (event.payment_lock && !event.payment_unlocked_at
    && await require('./bookingDeposits').refreshGalleryLock(event)) return null;
  return event;
}

/**
 * Validated, normalised origins from admin input: an array or a string with
 * one origin per line (commas and spaces also separate). Throws a 400-shaped
 * error naming the first bad entry.
 */
function parseAllowedOrigins(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[\s,]+/);
  const origins = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') throw invalidOrigin(String(entry));
    const value = entry.trim().toLowerCase().replace(/\/+$/, '');
    if (!value) continue;
    if (!ORIGIN_PATTERN.test(value) && !LOCAL_ORIGIN_PATTERN.test(value)) throw invalidOrigin(entry.trim());
    if (!origins.includes(value)) origins.push(value);
  }
  if (origins.length > MAX_ORIGINS) {
    const error = new Error(`At most ${MAX_ORIGINS} websites`);
    error.statusCode = 400;
    throw error;
  }
  return origins;
}

function invalidOrigin(value) {
  const error = new Error(`Not a website address: ${value.slice(0, 100)}. Use https://example.com or https://*.example.com`);
  error.statusCode = 400;
  return error;
}

function storedOrigins(event) {
  try {
    const parsed = JSON.parse(event?.embed_allowed_origins || '[]');
    // Re-validated on read: a value restored from elsewhere or written by
    // hand never reaches a header unchecked.
    return Array.isArray(parsed) ? parseAllowedOrigins(parsed) : [];
  } catch (_) {
    return null;
  }
}

/**
 * The frame-ancestors source list for an eligible embed: the allowed origins,
 * or any https/http site when none are set. A stored list that does not
 * parse fails closed to 'none'.
 */
function frameAncestors(event) {
  const origins = storedOrigins(event);
  if (origins === null) return '\'none\'';
  return origins.length > 0 ? origins.join(' ') : 'https: http:';
}

/** slug + token from an /gallery/:slug/embed/:token path (nginx X-Original-URI). */
function embedPathParts(uri) {
  const match = /^\/gallery\/([^/?#]+)\/embed\/([^/?#]+)\/?(?:[?#].*)?$/.exec(String(uri || ''));
  return match ? { slug: match[1], token: match[2] } : null;
}

module.exports = { resolveEmbed, parseAllowedOrigins, storedOrigins, frameAncestors, embedPathParts, TOKEN_PATTERN };
