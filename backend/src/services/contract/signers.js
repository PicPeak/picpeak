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
const { getAppSetting } = require('../../utils/appSettings');
const { ensureInt } = require('../../utils/numericHelpers');
const fieldEncryption = require('../../utils/fieldEncryption');

const MAX_CUSTOMER_SIGNERS = 5;
const ORDERS = ['parallel', 'sequential'];
const OTP_MAX_ATTEMPTS = 5;
const OTP_PER_HOUR = 5;
const OTP_DEFAULT_TTL_MINUTES = 10;
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

/** "an***@example.com" */
function maskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  if (!domain) return '';
  return `${local.slice(0, 2)}${'*'.repeat(Math.max(3, local.length - 2))}@${domain}`;
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
  };
}

function listSigners(contractId, conn = db) {
  return conn('contract_signers').where({ contract_id: contractId }).orderBy('position', 'asc');
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

async function insertSigners(trx, contract, customers, issuerName) {
  const now = new Date();
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
    await trx('contract_signers').where({ contract_id: contractId }).del();
    await insertSigners(trx, contract, customers, await issuerName(trx));
    if (order) await trx('contracts').where({ id: contractId }).update({ signing_order: order, updated_at: new Date() });
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

/** A new link for the signer; earlier links stop working. Returns the token (shown once). */
async function createInvitation(trx, signerId, expiresAt) {
  const now = new Date();
  await trx('contract_signer_invitations').where({ signer_id: signerId }).whereNull('revoked_at').update({ revoked_at: now });
  const token = newToken();
  await trx('contract_signer_invitations').insert({
    signer_id: signerId, token_hash: sha256(token), expires_at: expiresAt, created_at: now,
  });
  await trx('contract_signers').where({ id: signerId }).update({ status: 'invited', invited_at: now, updated_at: now });
  return token;
}

async function revokeAccess(trx, contractId) {
  const now = new Date();
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

/** The signer and contract behind an invitation link. */
async function findInvitation(token) {
  if (!TOKEN_RE.test(String(token || ''))) throw new AppError('Signing link not found', 404, 'SIGNING_LINK_INVALID');
  const invitation = await db('contract_signer_invitations').where({ token_hash: sha256(token) }).first();
  if (!invitation) throw new AppError('Signing link not found', 404, 'SIGNING_LINK_INVALID');
  if (invitation.revoked_at) throw new AppError('This signing link has been replaced or withdrawn', 410, 'SIGNING_LINK_REVOKED');
  if (invitation.expires_at && new Date(invitation.expires_at).getTime() < Date.now()) {
    throw new AppError('This signing link has expired', 410, 'SIGNING_LINK_EXPIRED');
  }
  return { invitation, ...(await loadSignerContext(invitation.signer_id)) };
}

// ---------------------------------------------------------------------
// Email codes
// ---------------------------------------------------------------------

async function otpTtlMinutes() {
  const value = ensureInt(await getAppSetting('crm_contracts_signing_otp_ttl_minutes'));
  return value && value >= 2 && value <= 60 ? value : OTP_DEFAULT_TTL_MINUTES;
}

/** A new code for the signer; earlier unused codes stop working. */
// Times are compared here rather than in SQL: SQLite keeps the dates knex
// writes in more than one form, so a SQL comparison can misread a fresh row.
const isPast = (value) => new Date(value).getTime() <= Date.now();

async function issueOtp(signerId) {
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const latest = await db('contract_signing_otps').where({ signer_id: signerId }).orderBy('id', 'desc').limit(OTP_PER_HOUR);
  const recent = latest.filter((row) => new Date(row.created_at).getTime() > hourAgo).length;
  if (recent >= OTP_PER_HOUR) {
    throw new AppError('Too many codes requested. Try again in an hour.', 429, 'OTP_RATE_LIMITED');
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const ttl = await otpTtlMinutes();
  const now = new Date();
  await db('contract_signing_otps').where({ signer_id: signerId }).whereNull('consumed_at').update({ consumed_at: now });
  await db('contract_signing_otps').insert({
    signer_id: signerId,
    code_hash: await bcrypt.hash(code, 10),
    expires_at: new Date(now.getTime() + ttl * 60 * 1000),
    attempts: 0,
    created_at: now,
  });
  return { code, ttlMinutes: ttl };
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
  if (Number(row.attempts) >= OTP_MAX_ATTEMPTS) {
    await db('contract_signing_otps').where({ id: row.id }).update({ consumed_at: new Date() });
    throw new AppError('Too many wrong codes. Request a new one.', 429, 'OTP_LOCKED');
  }
  if (!(await bcrypt.compare(code, row.code_hash))) {
    const attempts = Number(row.attempts) + 1;
    await db('contract_signing_otps').where({ id: row.id }).update({
      attempts, ...(attempts >= OTP_MAX_ATTEMPTS ? { consumed_at: new Date() } : {}),
    });
    const err = new AppError('That code isn\'t right.', 400, 'OTP_WRONG');
    err.details = { remaining: Math.max(0, OTP_MAX_ATTEMPTS - attempts) };
    throw err;
  }
  // Single use: only the request that flips consumed_at gets through.
  const used = await db('contract_signing_otps').where({ id: row.id }).whereNull('consumed_at').update({ consumed_at: new Date() });
  if (!used) throw new AppError('The code has already been used. Request a new one.', 410, 'OTP_EXPIRED');
  return true;
}

// ---------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------

async function createSession(signerId, verifiedVia) {
  const token = newToken();
  const now = new Date();
  await db('contract_signing_sessions').insert({
    signer_id: signerId,
    session_hash: sha256(token),
    verified_via: verifiedVia,
    expires_at: new Date(now.getTime() + SESSION_TTL_MS),
    created_at: now,
  });
  await db('contract_signers').where({ id: signerId }).update({ verified_at: now, verified_via: verifiedVia, updated_at: now });
  return { token, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) };
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
  setSigners,
  ensureSigners,
  signersDue,
  createInvitation,
  revokeAccess,
  findInvitation,
  issueOtp,
  verifyOtp,
  createSession,
  findSession,
  _internal: { sha256, ts },
};
