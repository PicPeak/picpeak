'use strict';
/**
 * Event codes (issue 2495, migration 367): a short code per gallery that a
 * guest types on the fixed entry page /code, so one printed QR code serves
 * every event.
 *
 * The code is a lookup, not a credential. It resolves to the URL the share
 * link already opens, so a password gallery still asks for its password and
 * nothing the share link would not reach becomes reachable. It stops
 * resolving once the gallery is no longer live (draft, expired, archived,
 * deactivated, paused or deleted); the row keeps its code, so an expired
 * gallery's code is not handed to a new one while that gallery exists.
 *
 * Uniqueness is the database's: events.access_code has a UNIQUE index and a
 * writer that loses a race retries with a fresh code, which holds across
 * replicas. Writes go through the global `db` outside any transaction, since a
 * unique violation inside a PostgreSQL transaction aborts it.
 */
const crypto = require('crypto');
const { db } = require('../database/db');
const { isUniqueViolation } = require('../utils/dbErrors');
const { isGalleryAvailable } = require('../utils/galleryLifecycle');
const { buildShareLinkVariants, getEventShareToken } = require('./shareLinkService');
const logger = require('../utils/logger');

// No 0/O, 1/I/L: nothing a guest can misread off a printed card.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const GENERATED_LENGTH = 6;
const MIN_LENGTH = 4;
const MAX_LENGTH = 12;
const MAX_ATTEMPTS = 8;
const CODE_RE = new RegExp(`^[${ALPHABET}]{${MIN_LENGTH},${MAX_LENGTH}}$`);

function generateAccessCode(length = GENERATED_LENGTH) {
  let code = '';
  for (let i = 0; i < length; i += 1) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return code;
}

/** What a guest or an admin typed, as stored: uppercase, `-` and spaces dropped. */
function normalizeAccessCode(input) {
  if (typeof input !== 'string') return '';
  return input.replace(/[\s-]+/g, '').toUpperCase();
}

/** A normalized code is valid when it uses only the alphabet and has 4 to 12 characters. */
function isValidAccessCode(code) {
  return typeof code === 'string' && CODE_RE.test(code);
}

/** Display form: a 6-character code in two groups (K7M-4QX); other lengths as they are. */
function formatAccessCode(code) {
  if (!code) return null;
  return code.length === GENERATED_LENGTH ? `${code.slice(0, 3)}-${code.slice(3)}` : code;
}

function conflictError() {
  const error = new Error('This code is already in use by another gallery');
  error.statusCode = 409;
  error.code = 'ACCESS_CODE_TAKEN';
  return error;
}

/**
 * Give the event a new generated code, retrying on a collision. With
 * `onlyIfMissing` an event that already has a code keeps it (creation path).
 * Returns the code the row holds afterwards.
 */
async function assignGeneratedAccessCode(eventId, { onlyIfMissing = false } = {}) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const code = generateAccessCode();
    try {
      const query = db('events').where({ id: eventId });
      if (onlyIfMissing) query.whereNull('access_code');
      const updated = await query.update({ access_code: code });
      if (updated) return code;
      const row = await db('events').where({ id: eventId }).first('access_code');
      return row ? row.access_code || null : null;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  throw new Error('Could not find a free event code');
}

/**
 * Creation hook: give a new gallery its code. Best effort: a gallery without
 * a code still works through its share link, and the admin can generate one.
 */
async function ensureAccessCode(eventId) {
  try {
    return await assignGeneratedAccessCode(eventId, { onlyIfMissing: true });
  } catch (error) {
    logger.warn('Failed to assign an event code', { eventId, error: error.message });
    return null;
  }
}

/** Set a code the admin chose. The caller validated it; a taken code throws a 409 error. */
async function setAccessCode(eventId, code) {
  try {
    await db('events').where({ id: eventId }).update({ access_code: code });
    return code;
  } catch (error) {
    if (isUniqueViolation(error)) throw conflictError();
    throw error;
  }
}

/**
 * The gallery path a code opens, or null for anything that should read as
 * "not found": a malformed code, an unknown one, or a gallery that is not
 * live. The path is the share link's, so the redirect carries exactly what
 * the share link carries.
 */
async function resolveAccessCode(input) {
  const code = normalizeAccessCode(input);
  if (!isValidAccessCode(code)) return null;
  const event = await db('events')
    .where({ access_code: code })
    .first('id', 'slug', 'share_link', 'share_token', 'expires_at', 'is_active', 'is_archived', 'is_draft', 'temporarily_disabled');
  if (!event || !isGalleryAvailable(event)) return null;
  return sharePathFor(event);
}

async function sharePathFor(event) {
  // The stored share_link is what the admin copies and the QR encodes; a
  // legacy absolute link contributes only its path, so the redirect stays on
  // this site.
  const stored = typeof event.share_link === 'string' ? event.share_link.trim() : '';
  const storedPath = stored.replace(/^https?:\/\/[^/]+/i, '');
  if (storedPath.startsWith('/gallery/')) return storedPath;
  const shareToken = getEventShareToken(event);
  if (!shareToken) return null;
  const { sharePath } = await buildShareLinkVariants({ slug: event.slug, shareToken });
  return sharePath;
}

module.exports = {
  ALPHABET,
  MIN_LENGTH,
  MAX_LENGTH,
  generateAccessCode,
  normalizeAccessCode,
  isValidAccessCode,
  formatAccessCode,
  assignGeneratedAccessCode,
  ensureAccessCode,
  setAccessCode,
  resolveAccessCode,
};
