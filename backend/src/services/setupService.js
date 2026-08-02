'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { getAppSetting, upsertAppSetting } = require('../utils/appSettings');
const { ValidationError, ConflictError } = require('../utils/errors');
const { validatePassword, getBcryptRounds } = require('../utils/passwordValidation');
const { formatBoolean } = require('../utils/dbCompat');

// First-run bootstrap. The app boots with NO admin account and no
// ADMIN_PASSWORD in the environment; the first browser visit creates the admin.
// That create call is guarded by a one-time setup token, generated at boot
// while no admin exists and written to a 0600 data/SETUP_TOKEN file — and only
// echoed to the logs when that write fails (see ensureSetupToken). The token is
// ALWAYS required and burned on first use, so the endpoint is permanently
// closed once setup is done — safe even on a public IP.
const SETUP_TOKEN_KEY = 'setup_token';

// Path of the token file as ACTUALLY written by the last ensureSetupToken()
// run, or null when that write failed. server.js keys its stdout banner on
// this: it used to re-derive the answer with existsSync(), which reports
// success for a stale, read-only or directory-shaped SETUP_TOKEN that the write
// could not replace — suppressing the token while pointing the operator at
// content that is wrong or unreadable.
let writtenTokenFile = null;
function writtenSetupTokenFile() {
  return writtenTokenFile;
}

// One-way flag flipped when the setup wizard finishes (migration 161 marks it
// completed on installs that predate the wizard's event-types step). While it
// is unset — i.e. only during the first-run wizard — the seeded SYSTEM event
// types may be deleted (eventTypeService.deleteEventType), because nothing
// can reference them yet. Once true, system types are permanently protected.
const SETUP_WIZARD_COMPLETED_KEY = 'setup_wizard_completed';

async function isSetupWizardCompleted() {
  // Fail closed: only an explicit stored `false` (seeded by migration 161 on
  // a fresh, admin-less install) opens the deletion window. A missing row —
  // e.g. app_settings replaced by a portable-backup restore that predates the
  // migration, which will not rerun — means a configured instance, not a
  // first run.
  return (await getAppSetting(SETUP_WIZARD_COMPLETED_KEY)) !== false;
}

async function markSetupWizardCompleted() {
  await upsertAppSetting(SETUP_WIZARD_COMPLETED_KEY, JSON.stringify(true), 'boolean');
}

async function noAdminExists() {
  const row = await db('admin_users').count({ c: '*' }).first();
  return Number(row?.c || 0) === 0;
}

// Public status the /setup gate reads. Deliberately leaks nothing beyond
// "is the instance still waiting for its first admin".
async function getSetupStatus() {
  const needsAdmin = await noAdminExists();
  return { needsAdmin, complete: !needsAdmin };
}

// The file is the source of truth (`cat data/SETUP_TOKEN`); the logs only carry
// the token when this file could not be written.
function setupTokenFilePath() {
  const dir = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
  return path.join(dir, 'SETUP_TOKEN');
}

// Called once at startup. Idempotent: generates + surfaces a token only while
// the instance still needs an admin, and clears any stale token afterwards.
// Clear the token everywhere — the app_settings row AND the on-disk file — so a
// completed (or restored) install leaves no stale token behind.
async function clearSetupToken() {
  await upsertAppSetting(SETUP_TOKEN_KEY, null, 'string');
  try { fs.unlinkSync(setupTokenFilePath()); } catch (_) { /* file may be absent — best-effort */ }
}

async function ensureSetupToken() {
  writtenTokenFile = null;
  if (!(await noAdminExists())) {
    await clearSetupToken();
    return null;
  }
  let token = await getAppSetting(SETUP_TOKEN_KEY);
  if (!token) {
    token = crypto.randomBytes(24).toString('base64url');
    // app_settings.setting_value is JSON on Postgres — store JSON-stringified
    // (getAppSetting JSON.parses on read). A raw string is rejected by jsonb.
    await upsertAppSetting(SETUP_TOKEN_KEY, JSON.stringify(token), 'string');
  }
  // Write the token to a 0600 file first, and only surface it in the logs /
  // stdout when that write FAILED. Previously it was logged unconditionally at
  // `warn`, so every default install (LOG_LEVEL=info) wrote a live
  // first-admin-bootstrap credential into combined.log and security.log —
  // both under the host-bind-mounted ./logs — never rotated out after use.
  // The log line remains as the documented last-resort recovery path.
  //
  // server.js makes the same decision for its stdout banner by reading
  // writtenSetupTokenFile() — the outcome recorded here, not a re-derived
  // existsSync() guess: printing the token there lands it in `docker logs` /
  // journald, which is the very leak this closes, and suppressing it when the
  // file is NOT actually current strands the operator with no token at all.
  let file = null;
  let writeError = null;
  try {
    file = setupTokenFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
    writtenTokenFile = file;
  } catch (err) {
    writeError = err;
    file = null;
  }

  if (writeError) {
    logger.warn(
      `[setup] Could not write the setup token file (${writeError.message}) — `
      + 'falling back to the log. No admin account yet; open /admin to finish setup. '
      + `One-time setup token: ${token}`
    );
  } else {
    logger.warn(
      '[setup] No admin account yet — open /admin to finish setup. '
      + `The one-time setup token is in ${file} (not logged).`
    );
  }
  return token;
}

// Constant-time compare so the token can't be recovered by timing the response.
function tokensMatch(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Pre-flight check for the two-step wizard: lets step 1 confirm the token is
// valid before advancing to the account step, so a wrong token is caught at
// "Continue" rather than after the user has filled in email + password. Does
// NOT burn the token — createInitialAdmin still claims it atomically on submit.
// Rate-limited at the mount point (same as /admin) so it can't be used to
// brute-force the token; the token is also 24 random bytes, so guessing is
// infeasible regardless.
async function verifySetupToken(token) {
  if (!(await noAdminExists())) {
    // Setup already finished — treat the endpoint as closed (the client
    // redirects to login on a 409).
    throw new ConflictError('Setup already completed — an admin account exists');
  }
  const expected = await getAppSetting(SETUP_TOKEN_KEY);
  return tokensMatch(token, expected);
}

// Creates the first admin as super_admin (the highest role) and returns a
// ready-to-set admin JWT so the browser flows straight into the wizard.
async function createInitialAdmin({ token, email, password, ip }) {
  if (!(await noAdminExists())) {
    throw new ConflictError('Setup already completed — an admin account exists');
  }
  const expected = await getAppSetting(SETUP_TOKEN_KEY);
  if (!tokensMatch(token, expected)) {
    throw new ValidationError('Invalid setup token', 'token');
  }

  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) {
    throw new ValidationError('A valid email address is required', 'email');
  }
  const strength = validatePassword(password);
  if (!strength.valid) {
    throw new ValidationError(strength.errors[0] || 'Password does not meet requirements', 'password');
  }

  const role = await db('roles').where('name', 'super_admin').first();
  if (!role) {
    throw new ConflictError('super_admin role missing — database not initialised');
  }
  const passwordHash = await bcrypt.hash(password, getBcryptRounds());

  // Create the admin and burn the token ATOMICALLY. The claim (null the token
  // row expecting exactly one match) serialises concurrent valid-token submits,
  // so a double-submit can't create two super_admins. All writes use `trx`
  // (never the global db) to avoid the SQLite in-transaction deadlock.
  const id = await db.transaction(async (trx) => {
    const claimed = await trx('app_settings')
      .where({ setting_key: SETUP_TOKEN_KEY })
      .whereNotNull('setting_value')
      .update({ setting_value: null, updated_at: new Date() });
    if (claimed !== 1) {
      throw new ConflictError('Setup already completed — an admin account exists');
    }
    const cnt = await trx('admin_users').count({ c: '*' }).first();
    if (Number(cnt?.c || 0) !== 0) {
      throw new ConflictError('Setup already completed — an admin account exists');
    }
    const inserted = await trx('admin_users').insert({
      username: cleanEmail,
      email: cleanEmail,
      password_hash: passwordHash,
      role_id: role.id,
      is_active: formatBoolean(true),
      must_change_password: formatBoolean(false),
      created_at: new Date(),
      updated_at: new Date(),
    }).returning('id');
    return inserted[0]?.id || inserted[0];
  });

  // DB token cleared inside the tx; remove the on-disk file too (best-effort).
  try { fs.unlinkSync(setupTokenFilePath()); } catch (_) { /* best-effort */ }
  logger.info(`[setup] Initial super_admin created (id=${id}, email=${cleanEmail})`);

  const authToken = jwt.sign(
    { id, username: cleanEmail, type: 'admin', role: role.name, ip: ip || null, loginTime: Date.now() },
    process.env.JWT_SECRET,
    { expiresIn: '24h', issuer: 'picpeak-auth' }
  );

  return {
    token: authToken,
    user: {
      id,
      username: cleanEmail,
      email: cleanEmail,
      role: { name: role.name, displayName: role.display_name },
    },
  };
}

module.exports = {
  getSetupStatus,
  ensureSetupToken,
  setupTokenFilePath,
  writtenSetupTokenFile,
  verifySetupToken,
  createInitialAdmin,
  isSetupWizardCompleted,
  markSetupWizardCompleted,
};
