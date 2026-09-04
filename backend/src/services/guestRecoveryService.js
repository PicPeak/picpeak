/**
 * Guest identity recovery service (Phase 3.2).
 *
 * Sends a short-lived 6-digit verification code to a guest's email address
 * so they can re-link their identity across devices. The code is stored as
 * a bcrypt hash in `guest_verification_codes` with a 15-minute expiry.
 *
 * Uses the email transporter from emailProcessor — no new template row is
 * needed; the email body is built inline so this works out of the box.
 */

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { initializeTransporter, wrapEmailHtml, resolveFromIdentity } = require('./emailProcessor');
const emailWebhookTransport = require('./emailWebhookTransport');

const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function generateCode() {
  // 6 digits, zero-padded.
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

async function createCode(eventId, email) {
  const code = generateCode();
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);

  // Invalidate any previous unconsumed codes for this email+event.
  await db('guest_verification_codes')
    .where({ event_id: eventId, email: email.toLowerCase() })
    .whereNull('consumed_at')
    .update({ consumed_at: db.fn.now() });

  await db('guest_verification_codes').insert({
    event_id: eventId,
    email: email.toLowerCase(),
    code_hash: codeHash,
    expires_at: expiresAt,
  });

  return code;
}

async function sendRecoveryEmail(toEmail, code, eventName = 'your gallery') {
  // This composes its own message rather than going through a template, so it
  // has to select the transport itself (#1225). Without this it called
  // initializeTransporter() unconditionally and dereferenced the null it
  // returns on a webhook-only install — recovery codes failed outright on
  // exactly the deploys the webhook transport exists for.
  const viaWebhook = emailWebhookTransport.isEnabled();
  let transporter = null;
  if (!viaWebhook) {
    transporter = await initializeTransporter();
    if (!transporter) {
      throw new Error('Email service not configured');
    }
  }

  const identity = await resolveFromIdentity();
  if (!identity) {
    throw new Error('Email configuration not found');
  }

  const subject = `Your verification code: ${code}`;
  const htmlBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 600px;">
      <h2>Welcome back to ${eventName}</h2>
      <p>Enter this code to recover your picks in the gallery:</p>
      <div style="font-size: 32px; font-weight: bold; letter-spacing: 8px; background: #f5f5f5; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;">
        ${code}
      </div>
      <p style="color: #666; font-size: 14px;">
        This code expires in 15 minutes. If you did not request it, you can safely ignore this email.
      </p>
    </div>
  `;
  const styledHtml = await wrapEmailHtml(htmlBody, subject, 'en');

  const mail = {
    from: `${identity.fromName} <${identity.fromEmail}>`,
    to: toEmail,
    subject,
    html: styledHtml,
    // wrapEmailHtml gives the HTML part the signature; the text
    // alternative needs it appended explicitly (#1264 review).
    text: `Your verification code is ${code}. It expires in 15 minutes.`
      + await require('./emailProcessor').buildSignatureTextFor('en'),
  };
  if (viaWebhook) {
    await emailWebhookTransport.send(mail);
  } else {
    await transporter.sendMail(mail);
  }

  logger.info('Guest recovery code sent', { email: toEmail });
}

/**
 * Verify a code. Returns true if valid + marks it consumed.
 * Increments attempts on failure. Rejects after MAX_ATTEMPTS.
 */
async function verifyCode(eventId, email, submittedCode) {
  const normalized = String(submittedCode || '').trim();
  if (!/^\d{6}$/.test(normalized)) {
    return { ok: false, reason: 'invalid_format' };
  }

  const row = await db('guest_verification_codes')
    .where({ event_id: eventId, email: email.toLowerCase() })
    .whereNull('consumed_at')
    .andWhere('expires_at', '>', new Date())
    .orderBy('created_at', 'desc')
    .first();

  if (!row) {
    return { ok: false, reason: 'expired_or_missing' };
  }

  if (row.attempts >= MAX_ATTEMPTS) {
    await db('guest_verification_codes').where('id', row.id).update({ consumed_at: db.fn.now() });
    return { ok: false, reason: 'too_many_attempts' };
  }

  const matches = await bcrypt.compare(normalized, row.code_hash);
  if (!matches) {
    await db('guest_verification_codes')
      .where('id', row.id)
      .update({ attempts: row.attempts + 1 });
    return { ok: false, reason: 'wrong_code' };
  }

  await db('guest_verification_codes')
    .where('id', row.id)
    .update({ consumed_at: db.fn.now() });

  return { ok: true };
}

module.exports = {
  createCode,
  sendRecoveryEmail,
  verifyCode,
  CODE_TTL_MS,
  MAX_ATTEMPTS,
};
