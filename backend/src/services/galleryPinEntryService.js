const { db, logActivity } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const { parseBooleanInput } = require('../utils/parsers');
const { getSecurityConfig, assertAuthSecuritySchema } = require('../utils/authSecurity');
const { assertGalleryAvailable } = require('../utils/galleryLifecycle');
const { AppError } = require('../utils/errors');
const { MAX_PASSWORD_LENGTH } = require('../utils/passwordValidation');

const MIN_PIN_LENGTH = 8;
const identifierFor = (eventId) => `client-pin:${eventId}`;
const lockIdentifierFor = (eventId) => `client-pin-lock:${eventId}`;

function validateEnrollment({ enabled, clientAccessEnabled, wasEnabled = false, password }) {
  if (!enabled) return;
  if (!clientAccessEnabled) throw new AppError('Enable Client Access before gallery PIN entry', 400, 'CLIENT_ACCESS_REQUIRED');
  if ((!wasEnabled || password) && (typeof password !== 'string' || Array.from(password.trim()).length < MIN_PIN_LENGTH
    || password.length > MAX_PASSWORD_LENGTH)) {
    throw new AppError(`Enter a client PIN of at least ${MIN_PIN_LENGTH} characters to enable gallery PIN entry`, 400, 'CLIENT_PIN_ENTRY_PASSWORD_REQUIRED');
  }
}

function assertEnabled(event) {
  assertGalleryAvailable(event);
  if (!parseBooleanInput(event.client_access_enabled, false)
    || !parseBooleanInput(event.client_pin_entry_enabled, false) || !event.client_password_hash)
    throw new AppError('Gallery PIN entry is not enabled', 403, 'CLIENT_ACCESS_UNAVAILABLE');
}

async function lockedEvent(tx, eventId) {
  const event = await tx('events').where({ id: eventId }).forUpdate().first();
  if (!event) throw new AppError('Gallery unavailable', 404, 'GALLERY_NOT_FOUND');
  return event;
}

async function windowState(tx, eventId, config, now) {
  const lastLock = await tx('login_attempts').where({ identifier: lockIdentifierFor(eventId) }).orderBy('id', 'desc').first();
  const until = lastLock ? new Date(lastLock.attempt_time).getTime() + config.lockoutDurationMs : 0;
  const since = new Date(Math.max(now - config.attemptWindowMs, until)).toISOString();
  return { until, since };
}

const attempts = (tx, eventId, since) => tx('login_attempts').where({ identifier: identifierFor(eventId) })
  .where('attempt_time', '>=', since);

async function pause(tx, event, config, now, ip) {
  await tx('login_attempts').insert({ identifier: lockIdentifierFor(event.id), ip_address: ip,
    attempt_time: new Date(now).toISOString(), success: formatBoolean(false) });
  await logActivity('gallery_pin_entry_paused', {
    failedAttempts: config.maxAttempts, resumesAt: new Date(now + config.lockoutDurationMs).toISOString(),
  }, event.id, { type: 'system' }, tx);
  return { until: now + config.lockoutDurationMs };
}

/** Reserve a durable slot before bcrypt; concurrent/rotating IPs share one budget. */
async function reserve(eventId, ip, userAgent) {
  await assertAuthSecuritySchema();
  const config = await getSecurityConfig();
  const result = await db.transaction(async (tx) => {
    const event = await lockedEvent(tx, eventId);
    assertEnabled(event);
    const now = Date.now();
    const state = await windowState(tx, eventId, config, now);
    if (state.until > now) return { denied: true, until: state.until };
    const [{ count }] = await attempts(tx, eventId, state.since)
      .where((q) => q.whereNull('success').orWhere('success', formatBoolean(false))).count('id as count');
    if (Number(count) >= config.maxAttempts) {
      const [{ count: failed }] = await attempts(tx, eventId, state.since).where('success', formatBoolean(false)).count('id as count');
      // Commit a missing pause marker before returning its refusal. Throwing
      // inside this transaction would undo both the marker and owner notice.
      if (Number(failed) >= config.maxAttempts) return { denied: true, ...await pause(tx, event, config, now, ip) };
      return { busy: true };
    }
    const [inserted] = await tx('login_attempts').insert({ identifier: identifierFor(eventId), ip_address: ip,
      user_agent: userAgent, attempt_time: new Date(now).toISOString(), success: null }).returning('id');
    return { id: inserted.id ?? inserted, eventId, passwordHash: event.client_password_hash, ip };
  });
  if (result.denied) {
    const error = new AppError('Gallery PIN entry is temporarily paused', 423, 'CLIENT_PIN_ENTRY_LOCKED');
    error.retryAfter = Math.max(1, Math.ceil((result.until - Date.now()) / 1000));
    throw error;
  }
  if (result.busy) {
    const error = new AppError('PIN checks are already in progress. Please try again shortly.', 429, 'CLIENT_PIN_ENTRY_BUSY');
    error.retryAfter = 2;
    throw error;
  }
  return result;
}

/** Finish the reserved attempt without resetting failures from other addresses. */
async function complete(attempt, valid) {
  const config = await getSecurityConfig();
  return db.transaction(async (tx) => {
    const event = await lockedEvent(tx, attempt.eventId);
    if (valid) {
      assertEnabled(event);
      if (event.client_password_hash !== attempt.passwordHash)
        throw new AppError('The client PIN changed. Please try again.', 409, 'CLIENT_PIN_CHANGED');
    }
    const changed = await tx('login_attempts').where({ id: attempt.id, identifier: identifierFor(event.id) })
      .whereNull('success').update({ success: formatBoolean(valid) });
    if (changed !== 1) throw new AppError('Could not verify this PIN attempt', 503, 'CLIENT_PIN_ATTEMPT_CHANGED');
    if (!valid) {
      const now = Date.now();
      const state = await windowState(tx, event.id, config, now);
      if (state.until <= now) {
        const [{ count }] = await attempts(tx, event.id, state.since).where('success', formatBoolean(false)).count('id as count');
        if (Number(count) >= config.maxAttempts) await pause(tx, event, config, now, attempt.ip);
      }
    }
    return event;
  });
}

module.exports = { MIN_PIN_LENGTH, validateEnrollment, reserve, complete, identifierFor };
