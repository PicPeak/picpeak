'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { db } = require('../../database/db');
const { lock } = require('./paymentSettings');
const logger = require('../../utils/logger');

const TABLE = 'photo_checkout_verifications';
const CODE_TTL_MS = 15 * 60e3;
const GRANT_TTL_SECONDS = 30 * 60;
const HOUR_MS = 60 * 60e3;
const MAX_ATTEMPTS = 5;
const TYPE = 'photo_checkout_promo';
const failure = (message, statusCode, code) => Object.assign(new Error(message), { statusCode, code });
const browserHash = (key) => crypto.createHash('sha256').update(key).digest('hex');
const validBrowserKey = (key) => typeof key === 'string' && /^[0-9a-f]{64}$/.test(key);
const emailHash = (email) => crypto.createHmac('sha256', process.env.JWT_SECRET)
  .update(`photo-promo-email-v1\0${email.trim().toLowerCase()}`).digest('hex');

function issueGrant(row) {
  return jwt.sign({ type: TYPE, galleryId: row.gallery_id, browser: row.browser_hash, identity: row.email_hash },
    process.env.JWT_SECRET, { algorithm: 'HS256', issuer: 'picpeak-auth', audience: TYPE, expiresIn: GRANT_TTL_SECONDS });
}

function verifiedIdentity(grant, galleryId, browserKey) {
  try {
    if (typeof grant !== 'string' || grant.length > 2048 || !validBrowserKey(browserKey)) return null;
    const payload = jwt.verify(grant, process.env.JWT_SECRET, { algorithms: ['HS256'], issuer: 'picpeak-auth', audience: TYPE });
    if (payload.type !== TYPE || Number(payload.galleryId) !== Number(galleryId)
        || payload.browser !== browserHash(browserKey) || typeof payload.identity !== 'string' || !/^[0-9a-f]{64}$/.test(payload.identity)) return null;
    return payload.identity;
  } catch { return null; }
}

// Matches the existing document/guest OTP transport, including webhook-only
// installations. This is checkout verification, never feedback registration.
async function sendCodeEmail({ to, code, language }) {
  const mailer = require('../../services/emailProcessor');
  const webhook = require('../../services/emailWebhookTransport');
  const de = language === 'de';
  const subject = de ? 'E-Mail für Ihren Galerie-Rabatt bestätigen' : 'Verify your email for your gallery promo';
  const intro = de ? 'Geben Sie diesen Code in PicPeak ein, um Ihren Galerie-Rabatt zu verwenden.'
    : 'Enter this code in PicPeak to use your gallery promo.';
  const expiry = de ? 'Der Code ist 15 Minuten gültig. Falls Sie ihn nicht angefordert haben, ignorieren Sie diese E-Mail.'
    : 'The code expires in 15 minutes. If you did not request it, ignore this email.';
  const identity = await mailer.resolveFromIdentity();
  if (!identity) throw new Error('Email configuration unavailable');
  const mail = {
    from: `${identity.fromName} <${identity.fromEmail}>`, to, subject,
    html: await mailer.wrapEmailHtml(`<p>${intro}</p><p style="font-size:32px;letter-spacing:8px"><strong>${code}</strong></p><p>${expiry}</p>`, subject, de ? 'de' : 'en'),
    text: `${intro}\n\n${code}\n\n${expiry}${await mailer.buildSignatureTextFor(de ? 'de' : 'en')}`,
  };
  if (webhook.isEnabled()) await webhook.send(mail);
  else {
    const transporter = await mailer.initializeTransporter();
    if (!transporter) throw new Error('Email service unavailable');
    await transporter.sendMail(mail);
  }
}

async function sendCode(galleryId, body) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !validBrowserKey(body.browserKey)) {
    throw failure('Enter a valid email address.', 400, 'CHECKOUT_PROMO_EMAIL_INVALID');
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const row = {
    challenge: crypto.randomBytes(24).toString('hex'), gallery_id: galleryId,
    email_hash: emailHash(email), browser_hash: browserHash(body.browserKey),
    code_hash: await bcrypt.hash(code, 10), created_at: new Date(Date.now()).toISOString(),
    expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
  };
  const wait = await db.transaction(async (trx) => {
    // Same persistent lock used by checkout admission: the address budget is
    // shared across galleries and replicas, including concurrent sends.
    await lock(trx);
    const recent = await trx(TABLE).where({ email_hash: row.email_hash })
      .where('created_at', '>', new Date(Date.now() - HOUR_MS).toISOString()).orderBy('created_at');
    const last = recent[recent.length - 1];
    const until = Math.max(last ? Date.parse(last.created_at) + 60000 : 0,
      recent.length >= 5 ? Date.parse(recent[0].created_at) + HOUR_MS : 0);
    if (until > Date.now()) return Math.ceil((until - Date.now()) / 1000);
    await trx(TABLE).insert(row);
    return 0;
  });
  if (wait) throw Object.assign(failure('Please wait before requesting another code.', 429, 'CHECKOUT_PROMO_RATE_LIMITED'), { retryAfterSeconds: wait });
  try {
    await module.exports.sendCodeEmail({ to: email, code, language: typeof body.language === 'string' && body.language.startsWith('de') ? 'de' : 'en' });
  } catch (error) {
    await db(TABLE).where({ challenge: row.challenge }).del();
    logger.warn('Photo promo verification email could not be sent', { gallery_id: galleryId, type: error.name });
    throw failure('The verification email could not be sent. Please try again later.', 503, 'CHECKOUT_PROMO_EMAIL_UNAVAILABLE');
  }
  // Do not invalidate another device's code, nor a newer successful send.
  await db(TABLE).where({ gallery_id: galleryId, browser_hash: row.browser_hash, email_hash: row.email_hash })
    .where('created_at', '<', row.created_at).whereNull('consumed_at').update({ consumed_at: new Date(Date.now()).toISOString() });
  return { challenge: row.challenge, resendAfterSeconds: 60 };
}

async function confirmCode(galleryId, body) {
  const invalid = () => failure('The code is incorrect or has expired. Request a new code if needed.', 400, 'CHECKOUT_PROMO_CODE_INVALID');
  if (!validBrowserKey(body.browserKey) || typeof body.challenge !== 'string' || !/^[0-9a-f]{48}$/.test(body.challenge)
      || typeof body.code !== 'string' || !/^\d{6}$/.test(body.code)) throw invalid();
  const query = () => db(TABLE).where({ challenge: body.challenge, gallery_id: galleryId, browser_hash: browserHash(body.browserKey) })
    .whereNull('consumed_at').where('expires_at', '>', new Date(Date.now()).toISOString());
  const row = await query().first();
  if (!row || !(await query().where('attempts', '<', MAX_ATTEMPTS).increment('attempts', 1))) throw invalid();
  if (!(await bcrypt.compare(body.code, row.code_hash))) throw invalid();
  // The conditional claim and redemption each have an expiry check. Parallel
  // correct requests can issue only one grant; a late compare cannot revive it.
  if (!(await query().update({ consumed_at: new Date(Date.now()).toISOString() }))) throw invalid();
  return { grant: issueGrant(row), expiresInSeconds: GRANT_TTL_SECONDS };
}

async function prune() {
  // Keep the complete hourly send budget, then erase spent challenge hashes.
  await db(TABLE).where('expires_at', '<', new Date(Date.now() - HOUR_MS).toISOString()).del();
}

module.exports = { sendCode, sendCodeEmail, confirmCode, verifiedIdentity, issueGrant, emailHash, browserHash, prune };
