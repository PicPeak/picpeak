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
const { initializeTransporter, wrapEmailHtml, resolveFromIdentity, getRecipientLanguage } = require('./emailProcessor');
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

// The recovery mail is composed here rather than from a template, so it
// carries its own copy per language. Languages without an entry fall back to
// English, as the template-based emails do.
const RECOVERY_COPY = {
  en: {
    defaultEvent: 'your gallery',
    subject: (code) => `Your verification code: ${code}`,
    heading: (name) => `Welcome back to ${name}`,
    intro: 'Enter this code to recover your picks in the gallery:',
    expiry: 'This code expires in 15 minutes. If you did not request it, you can safely ignore this email.',
    text: (code) => `Your verification code is ${code}. It expires in 15 minutes.`,
  },
  de: {
    defaultEvent: 'Ihre Galerie',
    subject: (code) => `Ihr Bestätigungscode: ${code}`,
    heading: (name) => `Willkommen zurück bei ${name}`,
    intro: 'Geben Sie diesen Code ein, um Ihre Auswahl in der Galerie wiederherzustellen:',
    expiry: 'Der Code ist 15 Minuten gültig. Falls Sie ihn nicht angefordert haben, können Sie diese E-Mail ignorieren.',
    text: (code) => `Ihr Bestätigungscode lautet ${code}. Er ist 15 Minuten gültig.`,
  },
  pt: {
    defaultEvent: 'sua galeria',
    subject: (code) => `Seu código de verificação: ${code}`,
    heading: (name) => `Que bom ver você de novo em ${name}`,
    intro: 'Digite este código para recuperar suas seleções na galeria:',
    expiry: 'Este código expira em 15 minutos. Se você não o solicitou, pode ignorar este e-mail com segurança.',
    text: (code) => `Seu código de verificação é ${code}. Ele expira em 15 minutos.`,
  },
};

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

async function sendRecoveryEmail(toEmail, code, eventName = '', { eventId = null } = {}) {
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

  // The gallery's language first, then the guest's customer account, then
  // the app default — the order every other gallery mail uses.
  const recipientLanguage = await getRecipientLanguage(toEmail, eventId);
  const language = RECOVERY_COPY[recipientLanguage] ? recipientLanguage : 'en';
  const copy = RECOVERY_COPY[language];
  const subject = copy.subject(code);
  const htmlBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 600px;">
      <h2>${escapeHtml(copy.heading(eventName || copy.defaultEvent))}</h2>
      <p>${copy.intro}</p>
      <div style="font-size: 32px; font-weight: bold; letter-spacing: 8px; background: #f5f5f5; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;">
        ${code}
      </div>
      <p style="color: #666; font-size: 14px;">
        ${copy.expiry}
      </p>
    </div>
  `;
  const styledHtml = await wrapEmailHtml(htmlBody, subject, language);

  const mail = {
    from: `${identity.fromName} <${identity.fromEmail}>`,
    to: toEmail,
    subject,
    html: styledHtml,
    // wrapEmailHtml gives the HTML part the signature; the text
    // alternative needs it appended explicitly (#1264 review).
    text: copy.text(code)
      + await require('./emailProcessor').buildSignatureTextFor(language),
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

  // Claim an attempt before the (slow) bcrypt compare, in one conditional
  // UPDATE. Reading the counter and writing `attempts + 1` afterwards let
  // concurrent guesses all pass the limit and overwrite each other's count.
  const claimed = await db('guest_verification_codes')
    .where('id', row.id)
    .whereNull('consumed_at')
    .andWhere('attempts', '<', MAX_ATTEMPTS)
    .increment('attempts', 1);
  if (!claimed) {
    // Do not consume the code here: a request that claimed the last allowed
    // attempt may still be comparing, and consuming it would reject that
    // valid guess. With no attempts left the claim can never succeed again,
    // so the code is dead without being consumed.
    const current = await db('guest_verification_codes').where('id', row.id).first('consumed_at');
    return { ok: false, reason: current && !current.consumed_at ? 'too_many_attempts' : 'expired_or_missing' };
  }

  const matches = await bcrypt.compare(normalized, row.code_hash);
  if (!matches) {
    return { ok: false, reason: 'wrong_code' };
  }

  // Consume once: a second correct request racing this one gets nothing.
  const consumed = await db('guest_verification_codes')
    .where('id', row.id)
    .whereNull('consumed_at')
    .update({ consumed_at: db.fn.now() });
  if (!consumed) return { ok: false, reason: 'expired_or_missing' };

  return { ok: true };
}

module.exports = {
  createCode,
  sendRecoveryEmail,
  verifyCode,
  CODE_TTL_MS,
  MAX_ATTEMPTS,
};
