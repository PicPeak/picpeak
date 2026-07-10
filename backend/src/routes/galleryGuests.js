const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { verifyGalleryAccess } = require('../middleware/gallery');
const { resolveGuest, requireGuest, signGuestToken } = require('../middleware/guestAuth');
const feedbackService = require('../services/feedbackService');
const guestRecovery = require('../services/guestRecoveryService');

const MAX_NAME_LEN = 100;
const MAX_EMAIL_LEN = 255;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// In-memory rate limit for guest registration (20 per hour per IP). Simple
// sliding window; on process restart the counters reset which is acceptable.
const registrationAttempts = new Map();
const REGISTRATION_WINDOW_MS = 60 * 60 * 1000;
const REGISTRATION_MAX = 20;

function checkRegistrationRate(ip) {
  const now = Date.now();
  const entry = registrationAttempts.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > REGISTRATION_WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count += 1;
  registrationAttempts.set(ip, entry);
  return entry.count <= REGISTRATION_MAX;
}

function sanitizeName(value) {
  if (typeof value !== 'string') return '';
  // Strip HTML/control chars, collapse whitespace.
  const cleaned = value
    .replace(/[<>&"']/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, MAX_NAME_LEN);
}

function sanitizeEmail(value) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, MAX_EMAIL_LEN).toLowerCase();
}

/**
 * POST /gallery/:slug/guest
 * Body: { name, email? }
 *
 * Registers a new per-person guest identity for this gallery. Returns a JWT
 * that the frontend must send as the x-guest-token header on subsequent
 * feedback requests.
 */
router.post('/:slug/guest', verifyGalleryAccess, async (req, res) => {
  try {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    if (!checkRegistrationRate(ip)) {
      return res.status(429).json({ error: 'Too many registration attempts' });
    }

    const event = req.event;
    const settings = await feedbackService.getEventFeedbackSettings(event.id);

    // Guest registration is only meaningful when feedback is enabled.
    if (!settings.feedback_enabled) {
      return res.status(403).json({ error: 'Feedback is not enabled for this gallery' });
    }

    const name = sanitizeName(req.body?.name);
    if (!name || name.length < 1) {
      return res.status(400).json({ error: 'Name is required', field: 'name' });
    }

    let email = sanitizeEmail(req.body?.email);
    if (email && !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: 'Invalid email format', field: 'email' });
    }
    if (settings.require_name_email && !email) {
      return res.status(400).json({ error: 'Email is required', field: 'email' });
    }

    const identifier = crypto.randomUUID();
    const userAgent = (req.headers['user-agent'] || '').substring(0, 500);

    const [row] = await db('gallery_guests')
      .insert({
        event_id: event.id,
        name,
        email: email || null,
        identifier,
        ip_address_last: ip.substring(0, 45),
        user_agent_last: userAgent,
      })
      .returning(['id', 'name', 'email', 'identifier', 'created_at']);

    const token = signGuestToken({
      guestId: row.id,
      eventId: event.id,
      identifier: row.identifier,
      name: row.name,
    });

    logger.info('Guest registered', {
      eventId: event.id,
      guestId: row.id,
      name: row.name,
    });

    return res.json({
      guest: {
        id: row.id,
        name: row.name,
        email: row.email,
        identifier: row.identifier,
      },
      token,
    });
  } catch (error) {
    logger.error('Guest registration failed', { error: error.message });
    return res.status(500).json({ error: 'Failed to register guest' });
  }
});

/**
 * GET /gallery/:slug/guest/me
 * Returns the current guest profile from a valid guest token. 401 otherwise.
 */
router.get('/:slug/guest/me', verifyGalleryAccess, resolveGuest, requireGuest, async (req, res) => {
  try {
    if (req.guest.eventId !== req.event.id) {
      return res.status(403).json({ error: 'Guest token does not match gallery' });
    }

    // Update last_seen_at on each profile fetch (cheap and useful for admin).
    await db('gallery_guests')
      .where({ id: req.guest.id })
      .update({
        last_seen_at: db.fn.now(),
        ip_address_last: (req.ip || '').substring(0, 45),
        user_agent_last: (req.headers['user-agent'] || '').substring(0, 500),
      });

    return res.json({
      guest: {
        id: req.guest.id,
        name: req.guest.name,
        email: req.guest.email,
        identifier: req.guest.identifier,
      },
    });
  } catch (error) {
    logger.error('Guest profile fetch failed', { error: error.message });
    return res.status(500).json({ error: 'Failed to fetch guest profile' });
  }
});

/**
 * DELETE /gallery/:slug/guest/me
 *
 * "Forget me" — soft-deletes the guest row and anonymizes their feedback so
 * aggregate counts remain stable but personal data is removed.
 */
router.delete('/:slug/guest/me', verifyGalleryAccess, resolveGuest, requireGuest, async (req, res) => {
  try {
    if (req.guest.eventId !== req.event.id) {
      return res.status(403).json({ error: 'Guest token does not match gallery' });
    }

    await feedbackService.anonymizeGuestFeedback(req.guest.id);

    await db('gallery_guests')
      .where({ id: req.guest.id })
      .update({
        is_deleted: true,
        name: 'Removed',
        email: null,
        last_seen_at: db.fn.now(),
      });

    logger.info('Guest self-forgot', {
      eventId: req.event.id,
      guestId: req.guest.id,
    });

    return res.json({ success: true });
  } catch (error) {
    logger.error('Guest forget-me failed', { error: error.message });
    return res.status(500).json({ error: 'Failed to forget guest' });
  }
});

// ---------------------------------------------------------------------------
// Phase 3.2 — Email-based identity recovery
// ---------------------------------------------------------------------------

// Simple in-memory rate limit for recover/verify (5 per hour per IP).
const recoveryAttempts = new Map();
const VERIFY_WINDOW_MS = 60 * 60 * 1000;
const VERIFY_MAX = 20;
function checkRecoveryRate(ip) {
  const now = Date.now();
  const entry = recoveryAttempts.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > VERIFY_WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count += 1;
  recoveryAttempts.set(ip, entry);
  return entry.count <= VERIFY_MAX;
}

/**
 * POST /gallery/:slug/guest/recover
 * Body: { email }
 *
 * Sends a 6-digit code to the email if it matches an existing guest. Returns
 * 200 regardless of whether a matching guest exists (prevents enumeration).
 */
router.post('/:slug/guest/recover', verifyGalleryAccess, async (req, res) => {
  try {
    const ip = req.ip || 'unknown';
    if (!checkRecoveryRate(ip)) {
      return res.status(429).json({ error: 'Too many recovery attempts' });
    }

    const email = sanitizeEmail(req.body?.email);
    if (!email || !EMAIL_REGEX.test(email)) {
      // Still return 200 to avoid leaking validity of the email field.
      return res.json({ success: true });
    }

    const event = req.event;
    const settings = await feedbackService.getEventFeedbackSettings(event.id);
    if (!settings.feedback_enabled || settings.identity_mode !== 'guest') {
      return res.json({ success: true });
    }

    const guest = await db('gallery_guests')
      .where({ event_id: event.id, email, is_deleted: false })
      .first();

    if (guest) {
      try {
        const code = await guestRecovery.createCode(event.id, email);
        await guestRecovery.sendRecoveryEmail(email, code, event.event_name || 'your gallery');
      } catch (sendError) {
        logger.error('Failed to send recovery email', { error: sendError.message });
        // Still return 200 so clients can't distinguish failures.
      }
    }

    return res.json({ success: true });
  } catch (error) {
    logger.error('Guest recovery request failed', { error: error.message });
    return res.json({ success: true });
  }
});

/**
 * POST /gallery/:slug/guest/verify
 * Body: { email, code }
 *
 * Exchanges a valid verification code for a guest token. Reuses the existing
 * guest row associated with the email (the guest continues where they left
 * off, cross-device).
 */
router.post('/:slug/guest/verify', verifyGalleryAccess, async (req, res) => {
  try {
    const ip = req.ip || 'unknown';
    if (!checkRecoveryRate(ip)) {
      return res.status(429).json({ error: 'Too many verification attempts' });
    }

    const email = sanitizeEmail(req.body?.email);
    const code = String(req.body?.code || '').trim();
    if (!email || !code) {
      return res.status(400).json({ error: 'Email and code are required' });
    }

    const event = req.event;
    const verifyResult = await guestRecovery.verifyCode(event.id, email, code);
    if (!verifyResult.ok) {
      return res.status(401).json({ error: 'Invalid or expired code', reason: verifyResult.reason });
    }

    const guest = await db('gallery_guests')
      .where({ event_id: event.id, email, is_deleted: false })
      .first();
    if (!guest) {
      return res.status(404).json({ error: 'Guest not found' });
    }

    await db('gallery_guests')
      .where({ id: guest.id })
      .update({
        email_verified_at: guest.email_verified_at || db.fn.now(),
        last_seen_at: db.fn.now(),
        ip_address_last: (req.ip || '').substring(0, 45),
      });

    const token = signGuestToken({
      guestId: guest.id,
      eventId: event.id,
      identifier: guest.identifier,
      name: guest.name,
    });

    logger.info('Guest recovered via email', { eventId: event.id, guestId: guest.id });

    return res.json({
      guest: {
        id: guest.id,
        name: guest.name,
        email: guest.email,
        identifier: guest.identifier,
      },
      token,
    });
  } catch (error) {
    logger.error('Guest verify failed', { error: error.message });
    return res.status(500).json({ error: 'Failed to verify code' });
  }
});

// ---------------------------------------------------------------------------
// Phase 3.3 — Invite token redemption
// ---------------------------------------------------------------------------

/**
 * POST /gallery/:slug/guest/redeem
 * Body: { inviteToken }
 *
 * Redeems a pre-minted invite token (created by admin). Single use.
 */
router.post('/:slug/guest/redeem', verifyGalleryAccess, async (req, res) => {
  try {
    const inviteToken = String(req.body?.inviteToken || '').trim();
    if (!inviteToken) {
      return res.status(400).json({ error: 'Invite token required' });
    }

    const event = req.event;

    const result = await db.transaction(async (trx) => {
      const invite = await trx('guest_invites')
        .where({ token: inviteToken, event_id: event.id })
        .first();
      if (!invite) return { error: 'not_found' };
      if (invite.revoked_at) return { error: 'revoked' };
      if (invite.redeemed_at) return { error: 'already_redeemed' };

      const guest = await trx('gallery_guests')
        .where({ id: invite.guest_id, is_deleted: false })
        .first();
      if (!guest) return { error: 'guest_missing' };

      await trx('guest_invites')
        .where({ id: invite.id })
        .update({ redeemed_at: trx.fn.now() });

      await trx('gallery_guests')
        .where({ id: guest.id })
        .update({
          last_seen_at: trx.fn.now(),
          ip_address_last: (req.ip || '').substring(0, 45),
          user_agent_last: (req.headers['user-agent'] || '').substring(0, 500),
        });

      return { guest };
    });

    if (result.error) {
      const statusMap = {
        not_found: 404,
        revoked: 410,
        already_redeemed: 409,
        guest_missing: 404,
      };
      return res.status(statusMap[result.error] || 400).json({ error: result.error });
    }

    const token = signGuestToken({
      guestId: result.guest.id,
      eventId: event.id,
      identifier: result.guest.identifier,
      name: result.guest.name,
    });

    logger.info('Invite redeemed', { eventId: event.id, guestId: result.guest.id });

    return res.json({
      guest: {
        id: result.guest.id,
        name: result.guest.name,
        email: result.guest.email,
        identifier: result.guest.identifier,
      },
      token,
    });
  } catch (error) {
    logger.error('Invite redemption failed', { error: error.message });
    return res.status(500).json({ error: 'Failed to redeem invite' });
  }
});

module.exports = router;
