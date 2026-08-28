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
  // Every copy is attempted independently. The canonical one failing while the
  // volume-root copy succeeds still leaves the operator a readable token, and
  // the reverse is the compose case where there is only ever one — so success
  // is "at least one file exists", not "the first one did".
  // One file, in DATA_DIR (#1218). A second copy at the volume root was tried
  // for discoverability and dropped: it carried almost the whole security
  // surface of this function — a second inode to race, to verify, and to
  // revoke — for a convenience the documentation covers better, by pointing
  // NAS users at ADMIN_PASSWORD, which needs no file at all.
  const candidate = setupTokenFilePath();
  let written = null;
  // Set when the file is readable by others AND cannot be deleted: a live
  // credential we do not control. Kept separate from writeError because it
  // must not be cleared by anything else succeeding.
  let leftReadable = null;
  let writeError = null;
  // Written to a private temporary file and published with rename(2)
  // (#1218 review). Every earlier shape raced: unlink-then-create left a
  // window for a symlink, and exclusive-create left two PM2 workers fighting
  // over one inode — the loser could see the winner's file after creation but
  // before its content landed, judge it wrong, and delete it, after which both
  // workers reported nothing written and both printed the live token.
  //
  // rename is atomic and replaces the path entry itself, so: the name is
  // unique to this process and cannot be raced, the file never appears at the
  // final path with the wrong mode or half its content, a symlink sitting
  // there is replaced rather than followed, and concurrent workers simply
  // publish the same value one after another.
  const tmp = `${candidate}.${process.pid}.tmp`;
  let createdTmp = false;
  try {
    fs.mkdirSync(path.dirname(candidate), { recursive: true });

    fs.writeFileSync(tmp, `${token}\n`, { mode: 0o600, flag: 'wx' });
    createdTmp = true;
    try { fs.chmodSync(tmp, 0o600); } catch (_) { /* verified next */ }

    // Checked before publishing, not after. Asking is not the same as
    // succeeding: a CIFS/SMB mount — what a NAS commonly offers — carries no
    // Unix modes, so chmod is a silent no-op and the file keeps whatever
    // file_mode= the mount forces, typically 0644. Verifying here means a
    // credential that cannot be made private never reaches the published path
    // at all. lstat, not stat: it must describe the file, not a link target.
    const mode = fs.lstatSync(tmp).mode & 0o777;
    if (mode & 0o077) {
      throw new Error(
        `refusing to write a group/world-readable setup token (mode ${mode.toString(8)})`
      );
    }

    // rename consumes tmp, so the catch below has nothing left to clean up.
    fs.renameSync(tmp, candidate);
    written = candidate;
  } catch (err) {
    if (createdTmp) {
      try { fs.unlinkSync(tmp); } catch (_) { /* best-effort */ }
    }
    // Publishing failed and something is still sitting at the token path. On a
    // restart the token is reused from the database, so that file may hold the
    // live value — and we could not replace it. Treat it as exposed: the
    // revocation below turns what is there into a dead string rather than
    // leaving a credential we do not control.
    if (fs.existsSync(candidate)) {
      leftReadable = candidate;
    }
    writeError = err;
  }

  // Publish what landed, for server.js's banner. Dropping these assignments
  // is not a cosmetic bug: writtenSetupTokenFile() reading null makes the
  // banner take its failure branch and print the live token to stdout, so a
  // perfectly good 0600 file coexists with the credential in `docker logs` —
  // the exact leak this whole path exists to close.
  writtenTokenFile = written;
  if (written) writeError = null;

  if (leftReadable) {
    // Fail closed (#1218 review). A readable copy that cannot be deleted is a
    // live first-admin credential sitting where anyone on the mount can read
    // it, and /setup/admin would go on accepting it — so the token is revoked
    // instead of merely reported. What is left on disk becomes a dead string.
    //
    // Copies that DID land privately are removed too: they hold the same value,
    // which is about to stop working. The next boot mints a fresh token, and
    // the undeletable file is skipped rather than rewritten because its unlink
    // still fails — so this converges instead of looping on the same exposure.
    if (written) {
      try { fs.unlinkSync(written); } catch (_) { /* best-effort */ }
    }
    await upsertAppSetting(SETUP_TOKEN_KEY, null, 'string');
    writtenTokenFile = null;

    logger.error(
      `[setup] The setup token file at ${leftReadable} is readable by other `
      + 'users and could not be removed, so the token has been revoked and no admin '
      + 'can be created with it. Delete that file, then restart to issue a new one.'
    );
    return null;
  }

  if (writeError) {
    // Deliberately WITHOUT the token (#1218 review). This branch fires when no
    // copy could be written privately — on the all-in-one image that is
    // typically a mount with no Unix modes, and LOG_DIR sits on that same
    // mount, so logger.warn would write the credential into combined.log:
    // exactly as readable as the file we just refused to leave, and it
    // outlives setup. server.js prints the token on stdout instead when no
    // file was written, which reaches `docker logs` without landing on the
    // shared volume.
    logger.warn(
      `[setup] Could not write a private setup token file (${writeError.message}). `
      + 'No admin account yet; open /admin to finish setup. The token is printed '
      + 'on stdout at startup — it is deliberately not written to the log files.'
    );
  } else {
    logger.warn(
      '[setup] No admin account yet — open /admin to finish setup. '
      + `The one-time setup token is in ${written} (not logged).`
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

  // DB token cleared inside the tx; remove the on-disk files too
  // (best-effort). Every copy, not just the canonical one (#1218) — the
  // all-in-one image also keeps one at the volume root, and a burned token
  // left lying there is a live-looking credential that no longer works: an
  // operator would paste it, be rejected, and have nothing to fall back on.
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
