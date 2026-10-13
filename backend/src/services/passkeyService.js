/**
 * Passkeys (WebAuthn) for admin login, issue 1733.
 *
 * Attestation and assertion verification is @simplewebauthn/server's job;
 * this module owns what surrounds it: which relying party the install is, the
 * challenge that crosses the browser round-trip, and the credential rows.
 *
 * Relying party. The RP ID is the hostname of the CONFIGURED public address
 * (FRONTEND_URL or the Site URL setting) and the expected origin is that
 * address's origin. It is never derived from the request: a Host header is
 * caller-controlled, and an RP ID that followed it would let any name that
 * resolves to the install mint its own credential scope. An install reached
 * by IP address, or over plain http on anything but localhost, has no valid
 * RP ID, so passkeys are unavailable there rather than falling back.
 *
 * Challenge. Signed, httpOnly, five minutes, bound to a purpose (and to the
 * account where one is known), and single-use: consuming it writes its jti to
 * revoked_tokens, whose unique index makes the second use fail on every
 * replica. Nothing is kept in process memory.
 */
const crypto = require('crypto');
const net = require('net');
const jwt = require('jsonwebtoken');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const { db } = require('../database/db');
const logger = require('../utils/logger');
const { getFrontendBaseUrl } = require('../utils/frontendUrl');
const { buildCookieOptionsWithExpiry, buildClearCookieOptions } = require('../utils/tokenUtils');
const { readSessionsValidAfter } = require('../utils/sessionCutoff');
const { isEnrolled } = require('./mfaService');

const TABLE = 'admin_webauthn_credentials';
const RP_NAME = 'PicPeak';
const MAX_PASSKEYS_PER_ADMIN = 10;
const MAX_NAME_LENGTH = 100;
const CHALLENGE_COOKIE = 'passkey_challenge';
const CHALLENGE_TTL_SECONDS = 5 * 60;
const CHALLENGE_TOKEN_TYPE = 'passkey_challenge';
const PURPOSES = ['register', 'login', 'mfa'];

class PasskeyError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * The relying party this install is, or why it has none.
 * `req` is only used to compare the browser's Origin header against the
 * configured origin; it never contributes to the RP ID.
 */
async function getRelyingParty(req) {
  const base = await getFrontendBaseUrl();
  let url;
  try {
    url = new URL(base);
  } catch (_) {
    return { available: false, reason: 'not_configured' };
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname)) {
    return { available: false, reason: 'ip_address' };
  }
  const isLocalhost = hostname === 'localhost';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalhost)) {
    return { available: false, reason: 'insecure_origin' };
  }
  const rp = { available: true, rpID: hostname, origin: url.origin };
  const requestOrigin = req && typeof req.get === 'function' ? req.get('origin') : null;
  if (requestOrigin && requestOrigin !== url.origin) {
    return { ...rp, available: false, reason: 'origin_mismatch' };
  }
  return rp;
}

async function requireRelyingParty(req) {
  const rp = await getRelyingParty(req);
  if (!rp.available) {
    throw new PasskeyError('PASSKEY_UNAVAILABLE', 'Passkeys are not available on this address');
  }
  return rp;
}

// ── challenge cookie ───────────────────────────────────────────────────────

// One path covers both the registration routes (/api/admin/auth/passkeys) and
// the login routes (/api/auth/admin/passkey).
const CHALLENGE_COOKIE_PATH = '/api';

// What a registration challenge is bound to besides the account: the
// credentials that authorized it, the password and, where the account has
// two-factor authentication, its secret. Keyed, so the cookie says nothing
// about the stored values.
function authState(admin) {
  const enrolled = isEnrolled(admin);
  return crypto.createHmac('sha256', process.env.JWT_SECRET)
    .update(`passkey-auth-state:${admin.password_hash || ''}:${enrolled ? admin.two_factor_secret || 'on' : ''}`)
    .digest('base64url');
}

function setChallenge(res, { purpose, challenge, adminId = null, rememberMe = false, pw = null }) {
  const token = jwt.sign({
    type: CHALLENGE_TOKEN_TYPE,
    purpose,
    c: challenge,
    uid: adminId,
    pw,
    rememberMe: rememberMe === true,
  }, process.env.JWT_SECRET, {
    expiresIn: CHALLENGE_TTL_SECONDS,
    issuer: 'picpeak-auth',
    jwtid: `pkc:${crypto.randomUUID()}`,
  });
  res.cookie(CHALLENGE_COOKIE, token, {
    ...buildCookieOptionsWithExpiry(res, CHALLENGE_TTL_SECONDS * 1000),
    path: CHALLENGE_COOKIE_PATH,
  });
}

/**
 * Read, clear and consume the challenge for `purpose`. Throws PasskeyError
 * when there is none, it is expired, it was minted for another purpose, or it
 * has been used before. The cookie is cleared whatever the outcome.
 */
async function takeChallenge(req, res, purpose) {
  const token = req.cookies?.[CHALLENGE_COOKIE];
  res.clearCookie(CHALLENGE_COOKIE, { ...buildClearCookieOptions(), path: CHALLENGE_COOKIE_PATH });
  const invalid = () => new PasskeyError('PASSKEY_CHALLENGE_INVALID',
    'The passkey request expired. Please try again.');
  if (!token || !PURPOSES.includes(purpose)) throw invalid();

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'], issuer: 'picpeak-auth' });
  } catch (_) {
    throw invalid();
  }
  if (payload.type !== CHALLENGE_TOKEN_TYPE || payload.purpose !== purpose
    || typeof payload.c !== 'string' || !payload.jti) {
    throw invalid();
  }
  // A restore or rollback replaces revoked_tokens, so a challenge spent before
  // it may no longer be on record. The cutoff it publishes refuses those, like
  // every session issued before it. Read from the database, not the 30 s
  // cache the session checks use: a replica that did not run the restore
  // would otherwise accept the spent challenge once more and hand out a
  // session issued after the cutoff. Fails closed, like the insert below.
  let cutoff;
  try {
    cutoff = await readSessionsValidAfter();
  } catch (error) {
    logger.warn('Passkey challenge refused: session cutoff not readable', { purpose, error: error.message });
    throw invalid();
  }
  if (cutoff && payload.iat < cutoff) throw invalid();

  // Single use on every replica: the unique index on token_id refuses the
  // second insert. Any failure here fails closed.
  try {
    await db('revoked_tokens').insert({
      token_id: payload.jti,
      user_id: Number.isInteger(payload.uid) ? payload.uid : null,
      token_type: 'passkey',
      revoked_at: new Date().toISOString(),
      expires_at: new Date(payload.exp * 1000).toISOString(),
      reason: 'passkey_challenge_used',
    });
  } catch (error) {
    logger.warn('Passkey challenge refused: already used or not recordable', { purpose, error: error.message });
    throw invalid();
  }

  return {
    challenge: payload.c,
    adminId: payload.uid ?? null,
    rememberMe: payload.rememberMe === true,
    pw: typeof payload.pw === 'string' ? payload.pw : null,
  };
}

// ── credential rows ────────────────────────────────────────────────────────

function parseTransports(raw) {
  if (!raw) return undefined;
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) && list.length ? list.filter((item) => typeof item === 'string') : undefined;
  } catch (_) {
    return undefined;
  }
}

// PostgreSQL returns bigint as a string.
const toCounter = (value) => Number(value) || 0;

function publicView(row) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at || null,
  };
}

async function listForAdmin(adminId) {
  return db(TABLE).where('admin_user_id', adminId).orderBy('id', 'asc');
}

async function countForAdmin(adminId, conn = db) {
  const row = await conn(TABLE).where('admin_user_id', adminId).count('id as count').first();
  return Number(row?.count) || 0;
}

// Every passkey of one account, e.g. when somebody else resets its password:
// a passkey signs in without the password, so one that survived would defeat
// the reset. Returns how many were removed.
async function deleteAllForAdmin(adminId, conn = db) {
  if (!(await conn.schema.hasTable(TABLE))) return 0;
  return conn(TABLE).where('admin_user_id', adminId).del();
}

async function anyRegistered() {
  return Boolean(await db(TABLE).select('id').first());
}

function cleanName(name) {
  const value = typeof name === 'string' ? name.trim().slice(0, MAX_NAME_LENGTH) : '';
  return value || 'Passkey';
}

// ── registration ───────────────────────────────────────────────────────────

// The id alone is not an account's identity across a portable restore, which
// can move the operator to another row and give their old id to an archived
// account: with the same handle, that account registering on the operator's
// authenticator would replace the passkey the restore preserved. The row's
// creation time tells the two apart.
function userHandle(admin) {
  const created = new Date(admin.created_at).getTime();
  return `picpeak-admin-${admin.id}-${Number.isFinite(created) ? created : 0}`;
}

// `authorize`, when given, is the caller's last word before a challenge
// exists: it runs once everything that could still refuse the request has
// passed, and a rejection from it leaves no challenge behind.
async function beginRegistration(req, res, admin, { authorize } = {}) {
  const rp = await requireRelyingParty(req);
  const existing = await listForAdmin(admin.id);
  if (existing.length >= MAX_PASSKEYS_PER_ADMIN) {
    throw new PasskeyError('PASSKEY_LIMIT', `You can register at most ${MAX_PASSKEYS_PER_ADMIN} passkeys`, 409);
  }
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp.rpID,
    userName: admin.username,
    userDisplayName: admin.email || admin.username,
    // Stable per account, so registering again on the same authenticator
    // replaces its entry instead of piling up duplicates. No personal data.
    userID: new Uint8Array(Buffer.from(userHandle(admin), 'utf8')),
    attestationType: 'none',
    excludeCredentials: existing.map((row) => ({
      id: row.credential_id,
      transports: parseTransports(row.transports),
    })),
    // Discoverable, so the login page needs no username, and user-verified,
    // so one gesture is possession plus PIN/biometric.
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  if (authorize) await authorize();
  setChallenge(res, {
    purpose: 'register', challenge: options.challenge, adminId: admin.id, pw: authState(admin),
  });
  return options;
}

async function finishRegistration(req, res, admin, response, name) {
  const { challenge, adminId, pw } = await takeChallenge(req, res, 'register');
  if (adminId !== admin.id) {
    throw new PasskeyError('PASSKEY_CHALLENGE_INVALID', 'The passkey request expired. Please try again.');
  }
  const rp = await requireRelyingParty(req);

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
    });
  } catch (error) {
    logger.warn('Passkey registration rejected', { adminId: admin.id, error: error.message });
    throw new PasskeyError('PASSKEY_VERIFICATION_FAILED', 'The passkey could not be verified');
  }
  if (!verification.verified || !verification.registrationInfo) {
    throw new PasskeyError('PASSKEY_VERIFICATION_FAILED', 'The passkey could not be verified');
  }

  const { credential, aaguid } = verification.registrationInfo;
  const row = {
    admin_user_id: admin.id,
    credential_id: credential.id,
    public_key: Buffer.from(credential.publicKey).toString('base64url'),
    counter: toCounter(credential.counter),
    transports: Array.isArray(credential.transports) ? JSON.stringify(credential.transports) : null,
    aaguid: aaguid || null,
    name: cleanName(name),
    created_at: new Date().toISOString(),
  };

  let id;
  try {
    id = await db.transaction(async (trx) => {
      // Re-checked with the insert: two verify calls must not both pass a cap
      // that was only read at the options step. The count alone does not
      // serialize them on PostgreSQL (READ COMMITTED: both would count nine
      // and both insert), so they queue on the account row first. SQLite has
      // one writer, and knex drops the lock clause there.
      const current = await trx('admin_users').where('id', admin.id).forUpdate().first();
      // The ceremony was authorized with the password (and second factor) at
      // the options step. A reset by somebody else since then removed the
      // account's passkeys, and this one must not land after it; nor may a
      // challenge issued for the password alone finish once two-factor
      // authentication is on. Read under the lock the reset's own update
      // takes, so the two cannot interleave.
      if (!current || authState(current) !== pw) {
        throw new PasskeyError('PASSKEY_CHALLENGE_INVALID', 'The passkey request expired. Please try again.');
      }
      if (await countForAdmin(admin.id, trx) >= MAX_PASSKEYS_PER_ADMIN) {
        throw new PasskeyError('PASSKEY_LIMIT', `You can register at most ${MAX_PASSKEYS_PER_ADMIN} passkeys`, 409);
      }
      const inserted = await trx(TABLE).insert(row).returning('id');
      return inserted[0]?.id ?? inserted[0];
    });
  } catch (error) {
    if (error instanceof PasskeyError) throw error;
    // The unique index on credential_id: this authenticator is registered
    // already (to this account or another one).
    logger.warn('Passkey registration not stored', { adminId: admin.id, error: error.message });
    throw new PasskeyError('PASSKEY_ALREADY_REGISTERED', 'This passkey is already registered', 409);
  }
  return publicView({ ...row, id });
}

// ── authentication ─────────────────────────────────────────────────────────

/**
 * Options for a login ceremony. `admin` is only passed at the second-factor
 * step, after the password was verified; the primary (passwordless) flow
 * takes no identifier at all, so its response cannot depend on whether an
 * account exists.
 */
async function beginAuthentication(req, res, { admin = null, rememberMe = false } = {}) {
  const rp = await requireRelyingParty(req);
  const allowCredentials = admin
    ? (await listForAdmin(admin.id)).map((row) => ({
      id: row.credential_id,
      transports: parseTransports(row.transports),
    }))
    : undefined;
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    allowCredentials,
    userVerification: 'required',
  });
  setChallenge(res, {
    purpose: admin ? 'mfa' : 'login',
    challenge: options.challenge,
    adminId: admin ? admin.id : null,
    rememberMe,
  });
  return options;
}

async function findCredential(credentialId) {
  if (typeof credentialId !== 'string' || !credentialId || credentialId.length > 1024) return null;
  return (await db(TABLE).where('credential_id', credentialId).first()) || null;
}

/**
 * Verify an assertion against a stored credential and advance its counter.
 * Returns { ok: true } or { ok: false, reason } and never throws for a
 * rejected assertion, so the caller answers every failure the same way.
 */
async function verifyAssertion(req, row, response, challenge) {
  const rp = await getRelyingParty(req);
  if (!rp.available) return { ok: false, reason: 'unavailable' };

  const storedCounter = toCounter(row.counter);
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      credential: {
        id: row.credential_id,
        publicKey: new Uint8Array(Buffer.from(row.public_key, 'base64url')),
        counter: storedCounter,
        transports: parseTransports(row.transports),
      },
      requireUserVerification: true,
    });
  } catch (error) {
    // The library reports a counter that did not advance as an error too.
    const regression = /counter/i.test(error.message || '');
    return { ok: false, reason: regression ? 'counter_regression' : 'rejected', detail: error.message };
  }
  if (!verification.verified) return { ok: false, reason: 'rejected' };

  // A signature counter that fails to advance means the credential was
  // cloned or the assertion replayed. Authenticators that keep no counter
  // (synced passkeys) report 0 forever; for those the single-use challenge
  // is the replay protection.
  const newCounter = toCounter(verification.authenticationInfo?.newCounter);
  if ((newCounter > 0 || storedCounter > 0) && newCounter <= storedCounter) {
    return { ok: false, reason: 'counter_regression', detail: `${newCounter} <= ${storedCounter}` };
  }

  // Compare-and-set on the counter this request read: of two concurrent
  // requests carrying the same assertion only one moves it forward.
  const updated = await db(TABLE)
    .where('id', row.id)
    .where('counter', row.counter)
    .update({ counter: newCounter, last_used_at: new Date().toISOString() });
  if (updated !== 1) return { ok: false, reason: 'counter_regression', detail: 'concurrent use' };

  return { ok: true };
}

module.exports = {
  PasskeyError,
  MAX_PASSKEYS_PER_ADMIN,
  MAX_NAME_LENGTH,
  CHALLENGE_COOKIE,
  getRelyingParty,
  listForAdmin,
  countForAdmin,
  deleteAllForAdmin,
  anyRegistered,
  publicView,
  cleanName,
  beginRegistration,
  finishRegistration,
  beginAuthentication,
  takeChallenge,
  findCredential,
  verifyAssertion,
};
