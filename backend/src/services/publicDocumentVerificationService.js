/**
 * Verification step in front of the public contract and quote pages.
 *
 * The link in a document email used to be the only secret. Whoever held it —
 * a forwarded mail, a shared screen, browser history, a proxy or mail-scanner
 * log — saw the customer's name and email address and the whole document, and
 * could sign the contract or accept the quote. The page now shows nothing
 * personal until the visitor enters a 6-digit code sent to the customer's email
 * address on file. Confirming the code issues a short-lived grant bound to that
 * one link; the view and every action on it require the grant.
 *
 * Codes mirror guestRecoveryService: crypto.randomInt, bcrypt hash, 15-minute
 * lifetime, 5 attempts. The email is composed inline for the same reason that
 * service gives (no template row to seed), and it selects the transport the
 * same way so webhook-only installs work.
 */

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');
const { toTimestamp } = require('../utils/dateNormalize');

const TABLE = 'public_document_verification_codes';
const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_INTERVAL_MS = 60 * 1000;
const SEND_WINDOW_MS = 60 * 60 * 1000;
const MAX_SENDS_PER_WINDOW = 5;
const GRANT_TTL_SECONDS = 30 * 60;
const GRANT_TYPE = 'public_document';
const GRANT_HEADER = 'x-document-access';

/**
 * First 16 hex chars of the token's SHA-256. Binds a grant to the exact link
 * it was issued for without putting the bearer token itself into the grant.
 */
function tokenFingerprint(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16);
}

/** `kunde@example.com` → `k***@example.com`; null when there is nothing to hint. */
function maskEmail(email) {
  if (typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return null;
  return `${email[0]}***${email.slice(at)}`;
}

function issueGrant(kind, tokenRow, token) {
  return jwt.sign(
    { type: GRANT_TYPE, kind, tokenId: tokenRow.id, th: tokenFingerprint(token) },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', issuer: 'picpeak-auth', expiresIn: GRANT_TTL_SECONDS },
  );
}

/**
 * True when the request carries a grant issued for this kind, this token row
 * and this exact token. Anything else — missing, expired, forged, issued for
 * another link or the other document kind — is false.
 */
function hasValidGrant(req, kind, tokenRow, token) {
  const grant = req.headers?.[GRANT_HEADER];
  if (typeof grant !== 'string' || !grant) return false;
  try {
    const payload = jwt.verify(grant, process.env.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'picpeak-auth',
    });
    return payload.type === GRANT_TYPE
      && payload.kind === kind
      && Number(payload.tokenId) === Number(tokenRow.id)
      && payload.th === tokenFingerprint(token);
  } catch (_) {
    return false;
  }
}

async function codeRows(kind, tokenId) {
  return db(TABLE).where({ document_kind: kind, action_token_id: tokenId });
}

/**
 * Seconds until another code may be sent for this token, or 0. One send per
 * minute and five per hour per link: enough for a lost or slow email, not
 * enough to turn the endpoint into a mail cannon aimed at the customer.
 */
async function secondsUntilNextSend(kind, tokenId) {
  const now = Date.now();
  const sentAt = (await codeRows(kind, tokenId))
    .map((row) => toTimestamp(row.created_at))
    .filter((t) => Number.isFinite(t));
  if (sentAt.length === 0) return 0;
  const latest = Math.max(...sentAt);
  if (now - latest < RESEND_INTERVAL_MS) {
    return Math.ceil((latest + RESEND_INTERVAL_MS - now) / 1000);
  }
  const inWindow = sentAt.filter((t) => now - t < SEND_WINDOW_MS);
  if (inWindow.length >= MAX_SENDS_PER_WINDOW) {
    return Math.ceil((Math.min(...inWindow) + SEND_WINDOW_MS - now) / 1000);
  }
  return 0;
}

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const COPY = {
  en: {
    documentLabel: { contract: 'contract', quote: 'quote' },
    subject: (label, number) => `Verification code for your ${label} ${number}`.trim(),
    intro: (label, number, issuer) => `Use this code to open your ${label} ${number}${issuer ? ` from ${issuer}` : ''}:`,
    expiry: 'The code expires in 15 minutes.',
    ignore: 'If you did not request it, you can ignore this email. Nobody can open the document without the code.',
    text: (code) => `Your verification code is ${code}. It expires in 15 minutes.`,
  },
  de: {
    documentLabel: { contract: 'Vertrag', quote: 'Angebot' },
    subject: (label, number) => `Bestätigungscode für Ihren ${label} ${number}`.trim(),
    intro: (label, number, issuer) => `Mit diesem Code öffnen Sie Ihren ${label} ${number}${issuer ? ` von ${issuer}` : ''}:`,
    expiry: 'Der Code ist 15 Minuten gültig.',
    ignore: 'Falls Sie ihn nicht angefordert haben, können Sie diese E-Mail ignorieren. Ohne den Code kann niemand das Dokument öffnen.',
    text: (code) => `Ihr Bestätigungscode lautet ${code}. Er ist 15 Minuten gültig.`,
  },
};

/**
 * Send the code. Called through module.exports so tests can stub the transport
 * and read the code from the call instead of from any log.
 */
async function sendCodeEmail({ to, code, kind, documentNumber, issuerName, language }) {
  const emailProcessor = require('./emailProcessor');
  const emailWebhookTransport = require('./emailWebhookTransport');
  const locale = language === 'de' ? 'de' : 'en';
  const copy = COPY[locale];
  const label = copy.documentLabel[kind];
  const number = documentNumber || '';

  const viaWebhook = emailWebhookTransport.isEnabled();
  let transporter = null;
  if (!viaWebhook) {
    transporter = await emailProcessor.initializeTransporter();
    if (!transporter) throw new Error('Email service not configured');
  }
  const identity = await emailProcessor.resolveFromIdentity();
  if (!identity) throw new Error('Email configuration not found');

  // The subject never carries the code: subjects show up in notification
  // previews and mailbox listings that the body does not.
  const subject = copy.subject(label, number);
  const htmlBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 600px;">
      <p>${escapeHtml(copy.intro(label, number, issuerName))}</p>
      <div style="font-size: 32px; font-weight: bold; letter-spacing: 8px; background: #f5f5f5; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;">
        ${escapeHtml(code)}
      </div>
      <p style="color: #666; font-size: 14px;">${escapeHtml(copy.expiry)} ${escapeHtml(copy.ignore)}</p>
    </div>
  `;
  const mail = {
    from: `${identity.fromName} <${identity.fromEmail}>`,
    to,
    subject,
    html: await emailProcessor.wrapEmailHtml(htmlBody, subject, locale),
    text: `${copy.intro(label, number, issuerName)}\n\n${copy.text(code)}\n${copy.ignore}`
      + await emailProcessor.buildSignatureTextFor(locale),
  };
  if (viaWebhook) {
    await emailWebhookTransport.send(mail);
  } else {
    await transporter.sendMail(mail);
  }
}

/**
 * Create a code for this token and email it. Earlier unconsumed codes for the
 * same token stop working. The row is written only after the email went out,
 * so a failed send neither leaves a live code nobody received nor counts
 * against the resend throttle.
 */
async function sendCode({ kind, tokenRow, recipientEmail, documentNumber, issuerName, language }) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const codeHash = await bcrypt.hash(code, 10);
  try {
    await module.exports.sendCodeEmail({
      to: recipientEmail, code, kind, documentNumber, issuerName, language,
    });
  } catch (err) {
    // No address and no code in the log line: the token id is enough to
    // correlate, and both of those would be exactly what this step protects.
    logger.warn('Public document verification email failed', { kind, tokenId: tokenRow.id, err: err.message });
    throw new AppError('The verification email could not be sent. Please try again later.', 503, 'EMAIL_UNAVAILABLE');
  }
  const nowIso = new Date().toISOString();
  await db(TABLE)
    .where({ document_kind: kind, action_token_id: tokenRow.id })
    .whereNull('consumed_at')
    .update({ consumed_at: nowIso });
  await db(TABLE).insert({
    document_kind: kind,
    action_token_id: tokenRow.id,
    code_hash: codeHash,
    attempts: 0,
    expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
    created_at: nowIso,
  });
  logger.info('Public document verification code sent', { kind, tokenId: tokenRow.id });
}

/**
 * Check a submitted code against the newest live code for this token.
 * Returns `{ ok: true }` or `{ ok: false, reason, attemptsRemaining? }` with
 * reason one of 'expired' | 'invalid' | 'too_many_attempts'.
 */
async function confirmCode(kind, tokenId, submitted) {
  const now = Date.now();
  const live = (await codeRows(kind, tokenId))
    .filter((row) => !row.consumed_at && toTimestamp(row.expires_at) > now)
    .sort((a, b) => toTimestamp(b.created_at) - toTimestamp(a.created_at) || b.id - a.id)[0];
  if (!live) return { ok: false, reason: 'expired' };

  const consume = () => db(TABLE).where({ id: live.id }).update({ consumed_at: new Date().toISOString() });

  // Claim the attempt atomically before comparing. Reading the count and
  // writing it back after the compare let parallel requests all see the same
  // count and each get a compare, so a burst of guesses was not capped at
  // MAX_ATTEMPTS. The conditional increment lets at most MAX_ATTEMPTS
  // requests through per code, however many arrive at once.
  const claimed = await db(TABLE)
    .where({ id: live.id })
    .whereNull('consumed_at')
    .where('attempts', '<', MAX_ATTEMPTS)
    .increment('attempts', 1);
  if (!claimed) {
    await consume();
    return { ok: false, reason: 'too_many_attempts' };
  }

  if (!(await bcrypt.compare(String(submitted), live.code_hash))) {
    const current = await db(TABLE).where({ id: live.id }).first();
    const used = Number(current?.attempts) || MAX_ATTEMPTS;
    if (used >= MAX_ATTEMPTS) {
      await consume();
      return { ok: false, reason: 'too_many_attempts' };
    }
    return { ok: false, reason: 'invalid', attemptsRemaining: MAX_ATTEMPTS - used };
  }
  await consume();
  return { ok: true };
}

module.exports = {
  GRANT_HEADER,
  GRANT_TTL_SECONDS,
  MAX_ATTEMPTS,
  maskEmail,
  tokenFingerprint,
  issueGrant,
  hasValidGrant,
  secondsUntilNextSend,
  sendCode,
  sendCodeEmail,
  confirmCode,
};
