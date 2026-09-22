'use strict';

/**
 * Contract signers (#1446): who signs, how they prove it's them, and the
 * links and sessions they sign with.
 *
 * - A contract has up to five customer signers and the issuer, who signs
 *   last. A draft's customer signers can be edited; sending adds the
 *   contract's customer when none were set.
 * - Each customer signer gets their own invitation link. Only the token's
 *   sha256 is stored, so the link can't be read back from the database.
 * - Opening a link needs a six-digit code sent to the signer's email
 *   (bcrypt, short expiry, five attempts, five codes an hour) — or a
 *   customer-portal login with the same email. Either gives a signing
 *   session, again stored as a sha256.
 * - Name and email are stored encrypted (utils/fieldEncryption) with an
 *   email hash for lookups.
 */

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { db } = require('../../database/db');
const { AppError } = require('../../utils/errors');
const { toMillis } = require('../../utils/queueTimestamps');
const fieldEncryption = require('../../utils/fieldEncryption');
const { auditedUpdate } = require('../accountingHistory');
const { maskEmail } = require('../../utils/maskEmail');

const MAX_CUSTOMER_SIGNERS = 5;
const ORDERS = ['parallel', 'sequential'];
const OTP_MAX_ATTEMPTS = 5;
const OTP_PER_HOUR = 5;
// The same numbers as the quote and contract verification code (#1465,
// publicDocumentVerificationService), so a customer meets one set of rules:
// valid for 15 minutes, a minute between codes, five an hour.
const OTP_TTL_MINUTES = 15;
const OTP_RESEND_INTERVAL_MS = 60 * 1000;
const SESSION_TTL_MS = 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_RE = /^[a-f0-9]{64}$/i;

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('hex');
const ts = (value) => (value ? new Date(value) : null);

function customerName(customer) {
  return customer.display_name
    || [customer.first_name, customer.last_name].filter(Boolean).join(' ')
    || customer.company_name
    || String(customer.email || '').split('@')[0];
}

/** A signer for the admin: decrypted name and email, never the evidence. */
function signerToApi(row) {
  return {
    id: row.id,
    position: Number(row.position),
    role: row.role,
    slotKey: row.slot_key,
    name: fieldEncryption.tryDecrypt(row.name_enc),
    email: fieldEncryption.tryDecrypt(row.email_enc),
    status: row.status,
    invitedAt: row.invited_at || null,
    verifiedAt: row.verified_at || null,
    verifiedVia: row.verified_via || null,
    signedAt: row.signed_at || null,
    declinedAt: row.declined_at || null,
    signatureMode: row.signature_mode || null,
    // Reminders sent so far (#1446), and when the last one went out.
    reminderCount: Number(row.reminder_count) || 0,
    remindedAt: row.reminded_at || null,
  };
}

function listSigners(contractId, conn = db) {
  return conn('contract_signers').where({ contract_id: contractId }).orderBy('position', 'asc');
}

/** The customer's columns a contract prints (recipient block, salutation, signer defaults). */
const RECIPIENT_FIELD = /name|email|address|postal|city|country|company|phone|vat|salutation|title|attention/i;
function recipientFields(customer) {
  return customer ? Object.fromEntries(Object.entries(customer)
    .filter(([key]) => RECIPIENT_FIELD.test(key) && !/hash/i.test(key))) : null;
}

/**
 * What a send depends on that no contract lock covers (#1445): the customer's
 * printed fields and whether it is active, the signer rows, the issuer
 * (business profile), the settings the placeholders and dates read and the
 * contract's PDF theme. None
 * of them bumps contracts.lock_version, so the send takes this when it
 * renders and compares it again, rows locked, inside the transaction that
 * marks the contract sent.
 */
const SEND_SETTINGS = [
  'crm_payment_default_net_days', 'crm_invoices_skonto_percent_default',
  'crm_invoices_skonto_business_days', 'general_date_format',
  // The PDF's logo when the business profile names none (resolveLogoFile).
  'branding_logo_path', 'branding_logo_url',
];

/**
 * The inputs' sha256, read through `conn`. `lock` takes row locks on
 * PostgreSQL (SQLite writes one at a time); `signerRows` stands in for the
 * signer rows when the caller already holds the ones it renders with;
 * `withSigners: false` leaves them out (the review, which shows them itself
 * and runs before a first send creates them).
 */
async function readSendInputsSha256(conn, contract, { lock = false, signerRows = null, withSigners = true } = {}) {
  const locking = lock && conn.client.config.client === 'pg';
  const locked = (query) => (locking ? query.forUpdate() : query);
  const customer = await locked(conn('customer_accounts').where({ id: contract.customer_account_id })).first();
  const rows = !withSigners ? null : signerRows || await locked(listSigners(contract.id, conn));
  const profile = await locked(conn('business_profile').where({ id: 1 })).first();
  const settings = await locked(conn('app_settings').whereIn('setting_key', SEND_SETTINGS)
    .select('setting_key', 'setting_value').orderBy('setting_key', 'asc'));
  // The PDF themes (a contract's footer text, layout): the render reads them.
  const themes = (await conn.schema.hasTable('pdf_themes'))
    ? await locked(conn('pdf_themes').whereIn('scope', ['default', 'contract']).select('scope', 'settings').orderBy('scope', 'asc'))
    : [];
  // Whether an uploaded font a theme names is still usable: archiving one
  // switches the render to the fallback without touching the theme row.
  const fonts = (await conn.schema.hasTable('pdf_fonts'))
    ? await locked(conn('pdf_fonts').select('id', 'is_active').orderBy('id', 'asc'))
    : [];
  const plain = (value) => JSON.parse(JSON.stringify(value === undefined ? null : value));
  const { updated_at: _u, ...issuer } = profile || {};
  return require('../../utils/canonicalJson').canonicalSha256({
    customer: plain(customer ? { ...recipientFields(customer), is_active: !!customer.is_active } : null),
    signers: plain(rows),
    issuer: plain(profile ? issuer : null),
    settings: plain(settings),
    themes: plain(themes),
    fonts: plain(fonts.map((f) => ({ id: Number(f.id), active: !!f.is_active }))),
  });
}

function sanitizeSigners(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_CUSTOMER_SIGNERS) {
    throw new AppError(`A contract needs between 1 and ${MAX_CUSTOMER_SIGNERS} customer signers`, 400, 'SIGNERS_INVALID');
  }
  const seen = new Set();
  return list.map((entry, index) => {
    const name = String((entry && entry.name) || '').trim().slice(0, 255);
    const email = String((entry && entry.email) || '').trim().toLowerCase().slice(0, 255);
    if (!name) throw new AppError(`Signer ${index + 1}: a name is required`, 400, 'SIGNERS_INVALID');
    if (!EMAIL_RE.test(email)) throw new AppError(`Signer ${index + 1}: the email address isn't valid`, 400, 'SIGNERS_INVALID');
    if (seen.has(email)) throw new AppError(`Signer ${index + 1}: each signer needs their own email address`, 400, 'SIGNERS_INVALID');
    seen.add(email);
    return { name, email };
  });
}

/**
 * Every timestamp this module writes goes through here. A bare Date is
 * stored by node-sqlite3 as "[object Object]" when it comes from another
 * realm (which is what Jest gives a service), and an expiry that can't be
 * read is treated as past — so a session or a code would die immediately.
 * ISO strings read back the same on both engines.
 */
const stamp = (date = new Date()) => date.toISOString();

// Times are compared here rather than in SQL: SQLite keeps the dates knex
// writes in more than one form, so a SQL comparison can misread a fresh row.
// A value that isn't a date at all counts as past, so a row written in a
// shape this process can't read is expired rather than valid forever.
const isPast = (value) => {
  const time = toMillis(value);
  return time == null || time <= Date.now();
};

async function insertSigners(trx, contract, customers, issuerName) {
  const now = stamp();
  const rows = customers.map((signer, index) => ({
    contract_id: contract.id,
    position: index + 1,
    role: 'customer',
    slot_key: `customer-${index + 1}`,
    name_enc: fieldEncryption.encrypt(signer.name),
    email_enc: fieldEncryption.encrypt(signer.email),
    email_hash: fieldEncryption.hashEmail(signer.email),
    locale: contract.language || 'de',
    status: 'pending',
    created_at: now,
    updated_at: now,
  }));
  rows.push({
    contract_id: contract.id,
    position: customers.length + 1,
    role: 'issuer',
    slot_key: 'issuer',
    name_enc: fieldEncryption.encrypt(issuerName || 'Issuer'),
    locale: contract.language || 'de',
    status: 'pending',
    created_at: now,
    updated_at: now,
  });
  await trx('contract_signers').insert(rows);
}

async function issuerName(conn) {
  const profile = await conn('business_profile').where({ id: 1 }).first();
  return (profile && profile.company_name) || null;
}

/** Replace a draft's customer signers and signing order. */
async function setSigners(contractId, { signers, order }) {
  const contract = await db('contracts').where({ id: contractId }).first();
  if (!contract) throw new AppError('Contract not found', 404);
  if (contract.status !== 'draft') throw new AppError('Signers can only be changed on a draft', 409, 'CONTRACT_NOT_DRAFT');
  const customers = sanitizeSigners(signers);
  if (order !== undefined && !ORDERS.includes(order)) throw new AppError('Unknown signing order', 400, 'SIGNERS_INVALID');
  await db.transaction(async (trx) => {
    // The status check above ran outside this transaction. Re-read the row
    // under a lock before deleting anything: a send committing in between
    // would otherwise lose the signers it had just invited, and the rewritten
    // rows would belong to a contract that is already out.
    const current = await trx('contracts').where({ id: contractId }).forUpdate().first();
    if (!current || current.status !== 'draft') {
      throw new AppError('Signers can only be changed on a draft', 409, 'CONTRACT_NOT_DRAFT');
    }
    await trx('contract_signers').where({ contract_id: contractId }).del();
    await insertSigners(trx, current, customers, await issuerName(trx));
    if (order) {
      await auditedUpdate(trx, 'contracts', { id: contractId },
        { signing_order: order, updated_at: stamp() }, { source: 'contract.signers' });
    }
  });
  return listSigners(contractId);
}

/** The draft's signers, or the contract's customer and the issuer when none were set. */
async function ensureSigners(trx, contract) {
  const existing = await listSigners(contract.id, trx);
  if (existing.length) return existing;
  const customer = await trx('customer_accounts').where({ id: contract.customer_account_id }).first();
  if (!customer || !customer.email) throw new AppError('The customer has no email address to sign with', 409, 'SIGNER_EMAIL_MISSING');
  await insertSigners(trx, contract, [{ name: customerName(customer), email: customer.email.toLowerCase() }], await issuerName(trx));
  return listSigners(contract.id, trx);
}

/** Which customer signers may sign now: all of them, or the next one in a sequential contract. */
function signersDue(contract, signers) {
  const open = signers.filter((s) => s.role === 'customer' && !['signed', 'declined'].includes(s.status));
  if (contract.signing_order === 'sequential') return open.slice(0, 1);
  return open;
}

// ---------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------

/**
 * A new link for the signer; earlier links and sessions stop working.
 * Returns the token (shown once).
 *
 * Only a signer who hasn't finished can be invited: a resend racing a
 * signature used to set the status back to `invited`, re-opening a slot that
 * was already signed. The old session is revoked with the old link, or the
 * replaced link's session would keep working for up to an hour.
 *
 * `fromStatuses: ['pending']` makes it a first invitation only: two runs
 * inviting the same signer at once (replicas sweeping together) can't both
 * pass, and the loser gets SIGNER_NOT_DUE instead of revoking the winner's
 * link.
 */
async function createInvitation(trx, signerId, expiresAt, { fromStatuses = ['pending', 'invited'] } = {}) {
  const now = stamp();
  const reopened = await trx('contract_signers')
    .where({ id: signerId })
    .whereIn('status', fromStatuses)
    .update({ status: 'invited', invited_at: now, updated_at: now });
  if (!reopened) {
    throw new AppError('This signer has already answered this contract', 409, 'SIGNER_NOT_DUE');
  }
  await trx('contract_signer_invitations').where({ signer_id: signerId }).whereNull('revoked_at').update({ revoked_at: now });
  await trx('contract_signing_sessions').where({ signer_id: signerId }).whereNull('revoked_at').update({ revoked_at: now });
  const token = newToken();
  await trx('contract_signer_invitations').insert({
    signer_id: signerId,
    token_hash: sha256(token),
    expires_at: expiresAt instanceof Date ? stamp(expiresAt) : expiresAt,
    created_at: now,
  });
  return token;
}

/**
 * Undo an invitation whose email never went out: the link is revoked and the
 * signer goes back to `pending`, so the next send — or the admin's resend —
 * reaches them instead of leaving a signer nobody can invite again.
 */
async function undoInvitation(signerId) {
  const now = stamp();
  await db.transaction(async (trx) => {
    await trx('contract_signer_invitations').where({ signer_id: signerId }).whereNull('revoked_at').update({ revoked_at: now });
    await trx('contract_signers').where({ id: signerId, status: 'invited' })
      .update({ status: 'pending', invited_at: null, updated_at: now });
  });
}

async function revokeAccess(trx, contractId) {
  const now = stamp();
  const ids = (await trx('contract_signers').where({ contract_id: contractId }).select('id')).map((r) => r.id);
  if (!ids.length) return;
  await trx('contract_signer_invitations').whereIn('signer_id', ids).whereNull('revoked_at').update({ revoked_at: now });
  await trx('contract_signing_sessions').whereIn('signer_id', ids).whereNull('revoked_at').update({ revoked_at: now });
}

async function loadSignerContext(signerId) {
  const signer = await db('contract_signers').where({ id: signerId }).first();
  if (!signer) throw new AppError('Signing link not found', 404, 'SIGNING_LINK_INVALID');
  const contract = await db('contracts').where({ id: signer.contract_id }).first();
  if (!contract) throw new AppError('Signing link not found', 404, 'SIGNING_LINK_INVALID');
  return { signer, contract };
}

const contractExpired = () => new AppError(
  'The time to sign this contract has run out. Ask the sender for a new one.', 410, 'CONTRACT_EXPIRED',
);

/** The signer and contract behind an invitation link. */
async function findInvitation(token) {
  if (!TOKEN_RE.test(String(token || ''))) throw new AppError('Signing link not found', 404, 'SIGNING_LINK_INVALID');
  const invitation = await db('contract_signer_invitations').where({ token_hash: sha256(token) }).first();
  if (!invitation) throw new AppError('Signing link not found', 404, 'SIGNING_LINK_INVALID');
  const expired = invitation.expires_at && isPast(invitation.expires_at);
  if (invitation.revoked_at || expired) {
    // Expiry revokes every link of the contract; the signer holding one
    // should hear that the signing period ended, not that it was replaced.
    const context = await loadSignerContext(invitation.signer_id).catch(() => null);
    if (context && context.contract.status === 'expired') throw contractExpired();
  }
  if (invitation.revoked_at) throw new AppError('This signing link has been replaced or withdrawn', 410, 'SIGNING_LINK_REVOKED');
  if (expired) throw new AppError('This signing link has expired', 410, 'SIGNING_LINK_EXPIRED');
  return { invitation, ...(await loadSignerContext(invitation.signer_id)) };
}

/**
 * When the time to sign a contract runs out, in epoch ms: the invitation
 * rule (signingV2's `invitationExpiry`) applied to the whole contract —
 * `valid_until` plus 14 days, or, with no `valid_until`, the expiry of the
 * newest link it sent (a sequential signer invited late gets their full
 * window), falling back to 60 days after it was sent. Null when none of
 * those can be read.
 */
async function signingDeadline(contract, conn = db) {
  if (contract.valid_until) {
    const until = new Date(contract.valid_until).getTime();
    if (Number.isFinite(until)) return until + 14 * 24 * 60 * 60 * 1000;
  }
  const latest = await conn('contract_signer_invitations as i')
    .join('contract_signers as s', 's.id', 'i.signer_id')
    .where('s.contract_id', contract.id)
    .orderBy('i.id', 'desc')
    .first('i.expires_at');
  const linkExpiry = latest ? toMillis(latest.expires_at) : null;
  if (linkExpiry != null) return linkExpiry;
  const sent = toMillis(contract.sent_at);
  return sent == null ? null : sent + 60 * 24 * 60 * 60 * 1000;
}

/**
 * How far the customer signers have got, per contract: `{ signed, total }`.
 * One grouped read for a list, so a "partly signed (1 of 2)" label needs no
 * query per row. Contracts without signers are absent from the map.
 */
async function customerSignerProgress(contractIds, conn = db) {
  const map = new Map();
  if (!contractIds.length) return map;
  const rows = await conn('contract_signers')
    .whereIn('contract_id', contractIds)
    .where({ role: 'customer' })
    .select('contract_id', 'status');
  for (const row of rows) {
    const id = Number(row.contract_id);
    const entry = map.get(id) || { signed: 0, total: 0 };
    entry.total += 1;
    if (row.status === 'signed') entry.signed += 1;
    map.set(id, entry);
  }
  return map;
}

/**
 * Is the signer on the page right now? A session that is still open, or
 * one that opened the contract within the last day. A reminder mints a new
 * link and so ends every session — it must not cut off someone signing.
 */
async function hasActiveSession(signerId, now = Date.now()) {
  const rows = await db('contract_signing_sessions').where({ signer_id: signerId }).whereNull('revoked_at')
    .select('expires_at', 'viewed_at');
  return rows.some((row) => {
    const expires = toMillis(row.expires_at);
    const viewed = toMillis(row.viewed_at);
    return (expires != null && expires > now) || (viewed != null && now - viewed < 24 * 60 * 60 * 1000);
  });
}

/**
 * Codes and sessions that ended more than `olderThanMs` ago are removed:
 * nothing reads them once they are past, and the signing log keeps the
 * record of every code sent and every verification. Compared in JS — SQLite
 * keeps knex-written dates in more than one form. A row whose expiry can't
 * be read is kept. Returns the counts removed.
 */
async function purgeEndedAccess(olderThanMs, now = Date.now()) {
  const cutoff = now - olderThanMs;
  const removed = {};
  for (const table of ['contract_signing_otps', 'contract_signing_sessions']) {
    const rows = await db(table).select('id', 'expires_at');
    const ids = rows.filter((row) => {
      const at = toMillis(row.expires_at);
      return at != null && at <= cutoff;
    }).map((row) => row.id);
    removed[table] = 0;
    for (let i = 0; i < ids.length; i += 500) {
      removed[table] += await db(table).whereIn('id', ids.slice(i, i + 500)).del();
    }
  }
  return removed;
}

// ---------------------------------------------------------------------
// Email codes
// ---------------------------------------------------------------------

/**
 * Reserve a new code for the signer, or refuse with how long to wait.
 *
 * Reserve, send, then retire — the order publicDocumentVerificationService
 * uses: the row is written before the email so a burst can't all pass the
 * throttle, the caller deletes it again with `discardOtp` if the email
 * fails (no live code nobody received, and a failed send doesn't count
 * against the cap), and only after a successful send do earlier codes stop
 * working (`retireEarlierOtps`).
 */
async function issueOtp(signerId) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const now = new Date();
  const codeHash = await bcrypt.hash(code, 10);
  // Count and insert inside one transaction, with the SIGNER's row locked
  // rather than their code rows: locking the codes locks nothing when there
  // are none yet, and Postgres doesn't re-scan for rows a parallel request
  // inserted meanwhile — so the first few requests could all pass the cap.
  // The hourly cap is also what stops a held link mail-bombing the signer.
  const otpId = await db.transaction(async (trx) => {
    const signer = await trx('contract_signers').where({ id: signerId }).forUpdate().first('id');
    if (!signer) throw new AppError('Signing link not found', 404, 'SIGNING_LINK_INVALID');
    const latest = await trx('contract_signing_otps')
      .where({ signer_id: signerId })
      .orderBy('id', 'desc')
      .limit(OTP_PER_HOUR);
    // A timestamp that can't be read counts as just now rather than as long
    // ago: an unreadable row must not buy another code.
    const sentAt = latest.map((row) => toMillis(row.created_at) ?? now.getTime());
    const retryAfterSeconds = secondsUntilNextCode(sentAt, now.getTime());
    if (retryAfterSeconds > 0) {
      throw Object.assign(
        new AppError('A code was sent recently. Please wait before requesting another one.', 429, 'VERIFICATION_RATE_LIMITED'),
        { retryAfterSeconds },
      );
    }
    const [inserted] = await trx('contract_signing_otps').insert({
      signer_id: signerId,
      code_hash: codeHash,
      expires_at: stamp(new Date(now.getTime() + OTP_TTL_MINUTES * 60 * 1000)),
      attempts: 0,
      created_at: stamp(now),
    }).returning('id');
    return typeof inserted === 'object' ? inserted.id : inserted;
  });
  return { code, otpId, ttlMinutes: OTP_TTL_MINUTES, resendAfterSeconds: OTP_RESEND_INTERVAL_MS / 1000 };
}

/** Seconds until the next code may go out: a minute between codes, five an hour. */
function secondsUntilNextCode(sentAt, now) {
  if (!sentAt.length) return 0;
  const latest = Math.max(...sentAt);
  if (now - latest < OTP_RESEND_INTERVAL_MS) return Math.ceil((latest + OTP_RESEND_INTERVAL_MS - now) / 1000);
  const hour = 60 * 60 * 1000;
  const inWindow = sentAt.filter((at) => now - at < hour);
  if (inWindow.length >= OTP_PER_HOUR) return Math.ceil((Math.min(...inWindow) + hour - now) / 1000);
  return 0;
}

/**
 * The email for a reserved code failed: the code never existed.
 *
 * Deleting it also means a failed send doesn't count against the five an
 * hour — deliberately, the same as #1465: a mail server that is down must
 * not lock the signer out once it is back. Repeated attempts while it is
 * down are bounded by the route's `codeLimiter`: five per ten minutes per
 * client address (routes/publicContractSigning).
 */
async function discardOtp(otpId) {
  await db('contract_signing_otps').where({ id: otpId }).del();
}

/**
 * The code went out: earlier unused codes stop working. Only codes reserved
 * before this one, so a slow send can't retire a newer code that went out
 * in the meantime.
 */
async function retireEarlierOtps(signerId, otpId) {
  await db('contract_signing_otps')
    .where({ signer_id: signerId })
    .where('id', '<', otpId)
    .whereNull('consumed_at')
    .update({ consumed_at: stamp() });
}

/** Check a code. Single use; five wrong tries use it up. */
async function verifyOtp(signerId, submitted) {
  const code = String(submitted || '').trim();
  if (!/^\d{6}$/.test(code)) throw new AppError('Enter the six-digit code from the email', 400, 'OTP_WRONG');
  const row = await db('contract_signing_otps')
    .where({ signer_id: signerId })
    .whereNull('consumed_at')
    .orderBy('id', 'desc')
    .first();
  if (!row || isPast(row.expires_at)) throw new AppError('The code has expired. Request a new one.', 410, 'OTP_EXPIRED');
  const consume = () => db('contract_signing_otps').where({ id: row.id }).update({ consumed_at: stamp() });
  // Claim the attempt before comparing, the same shape the emailed document
  // code uses (publicDocumentVerificationService.confirmCode). Reading the
  // count and writing it back after the compare let parallel guesses all see
  // the same count, so a burst was not capped at five: the conditional
  // increment lets at most five requests through per code.
  const claimed = await db('contract_signing_otps')
    .where({ id: row.id })
    .whereNull('consumed_at')
    .where('attempts', '<', OTP_MAX_ATTEMPTS)
    .increment('attempts', 1);
  if (!claimed) {
    await consume();
    throw new AppError('Too many wrong codes. Request a new one.', 429, 'OTP_LOCKED');
  }
  if (!(await bcrypt.compare(code, row.code_hash))) {
    const current = await db('contract_signing_otps').where({ id: row.id }).first();
    const attempts = Number(current && current.attempts) || OTP_MAX_ATTEMPTS;
    if (attempts >= OTP_MAX_ATTEMPTS) {
      await consume();
      throw new AppError('Too many wrong codes. Request a new one.', 429, 'OTP_LOCKED');
    }
    const err = new AppError('That code isn\'t right.', 400, 'OTP_WRONG');
    err.details = { remaining: Math.max(0, OTP_MAX_ATTEMPTS - attempts) };
    throw err;
  }
  // Single use: only the request that flips consumed_at gets through.
  const used = await db('contract_signing_otps').where({ id: row.id }).whereNull('consumed_at')
    .update({ consumed_at: stamp() });
  if (!used) throw new AppError('The code has already been used. Request a new one.', 410, 'OTP_EXPIRED');
  return true;
}

// ---------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------

async function createSession(signerId, verifiedVia, conn = db) {
  const token = newToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await conn('contract_signing_sessions').insert({
    signer_id: signerId,
    session_hash: sha256(token),
    verified_via: verifiedVia,
    expires_at: stamp(expiresAt),
    created_at: stamp(now),
  });
  await conn('contract_signers').where({ id: signerId })
    .update({ verified_at: stamp(now), verified_via: verifiedVia, updated_at: stamp(now) });
  return { token, expiresAt };
}

/** The signer and contract behind a signing session. */
async function findSession(token) {
  const invalid = () => new AppError('Your signing session has ended. Open the link from your email again.', 401, 'SIGNING_SESSION_INVALID');
  if (!TOKEN_RE.test(String(token || ''))) throw invalid();
  const session = await db('contract_signing_sessions').where({ session_hash: sha256(token) }).first();
  if (!session || session.revoked_at || isPast(session.expires_at)) throw invalid();
  return { session, ...(await loadSignerContext(session.signer_id)) };
}

module.exports = {
  MAX_CUSTOMER_SIGNERS,
  ORDERS,
  OTP_MAX_ATTEMPTS,
  maskEmail,
  customerName,
  signerToApi,
  listSigners,
  recipientFields,
  readSendInputsSha256,
  setSigners,
  ensureSigners,
  signersDue,
  createInvitation,
  undoInvitation,
  revokeAccess,
  findInvitation,
  signingDeadline,
  customerSignerProgress,
  purgeEndedAccess,
  hasActiveSession,
  issueOtp,
  discardOtp,
  retireEarlierOtps,
  verifyOtp,
  createSession,
  findSession,
  _internal: { sha256, ts },
};
