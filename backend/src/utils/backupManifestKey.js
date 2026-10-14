'use strict';

// This trust anchor must never be read from app_settings or from a backup.
// Compose provisions it in its backend-only secrets volume; native/AIO
// installations persist it beside the database, outside managed media.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getStoragePath } = require('../config/storage');
const logger = require('./logger');

const idOf = key => crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);

function parseKey(value, name = 'BACKUP_MANIFEST_KEY') {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value.trim())) {
    throw new Error(`${name} must contain a dedicated random 32-byte key encoded as 64 hex digits`);
  }
  return Buffer.from(value.trim(), 'hex');
}

function keyFile() {
  if (process.env.BACKUP_MANIFEST_KEY_FILE) return path.resolve(process.env.BACKUP_MANIFEST_KEY_FILE);
  const secret = '/run/secrets/backup_manifest_key';
  if (fs.existsSync(secret)) return secret;
  return path.resolve(process.env.DATA_DIR || path.join(__dirname, '../../data'), 'backup-manifest.key');
}

function realLocation(file) {
  let parent = path.resolve(file);
  const suffix = [];
  for (;;) {
    try { return path.join(fs.realpathSync(parent), ...suffix.reverse()); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const next = path.dirname(parent);
      if (next === parent) throw error;
      suffix.push(path.basename(parent));
      parent = next;
    }
  }
}

function assertExternal(file) {
  const candidate = realLocation(file);
  for (const root of [getStoragePath(), path.join(process.cwd(), 'storage')]) {
    const location = realLocation(root);
    const rel = path.relative(location, candidate);
    if (!rel || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))) {
      throw new Error('The backup manifest key file must be outside the backed-up storage estate');
    }
  }
}

// Names the file, its mode and the ways out: the admin sees this in System
// Health and in the failed backup run, not only in the server log.
function writableKeyError(file, mode, tightened) {
  const octal = (mode & 0o777).toString(8).padStart(4, '0');
  return new Error(`The backup manifest key file ${file} is group- or world-writable (mode ${octal}), `
    + 'so another account could replace the key that signs backups. '
    + (tightened
      ? 'chmod 600 did not take effect: its filesystem does not keep file modes (some NAS, VM shared folders or bind mounts). '
        + 'Move the key to a filesystem that does and point BACKUP_MANIFEST_KEY_FILE at it, '
      : `Fix it with "chmod 600 ${file}" as the account that owns it, point BACKUP_MANIFEST_KEY_FILE at a private copy, `)
    + 'or set BACKUP_MANIFEST_KEY to its 64 hex digits.');
}

// The key's directory decides who can swap the key, whatever the file's own
// mode says. Only a warning: the same 0777 / foreign owner is what bind mounts
// and NAS volumes report for modes they do not keep, and failing those would
// stop backups that work. Said once per directory state, not on every call.
const directoryWarnings = new Set();
function warnIfDirectoryReplaceable(file) {
  const dir = path.dirname(realLocation(file));
  let stat;
  try { stat = fs.statSync(dir); } catch { return; }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const writable = (stat.mode & 0o022) && !(stat.mode & 0o1000);
  const foreign = uid !== null && stat.uid !== uid && stat.uid !== 0;
  if (!writable && !foreign) return;
  const octal = (stat.mode & 0o7777).toString(8).padStart(4, '0');
  const state = `${dir}:${octal}:${stat.uid}`;
  if (directoryWarnings.has(state)) return;
  directoryWarnings.add(state);
  logger.warn(`The directory ${dir} holding the backup manifest key (mode ${octal}, owner uid ${stat.uid}) `
    + (writable ? 'is group- or world-writable without the sticky bit' : 'belongs to another account')
    + ', so another account could replace the key that signs backups. Restrict it to this account '
    + '(chmod 700) if its filesystem keeps modes, or set BACKUP_MANIFEST_KEY to the key\'s 64 hex digits.');
}

// A key another process has created but not yet written reads empty; give
// its bytes a moment instead of failing that process's backup. Only a file
// that is seconds old: a key that stays short must not stall every caller.
const SHORT_READ_RETRIES = 10;
const SHORT_READ_WAIT_MS = 25;
const FRESH_KEY_MS = 5000;
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function readFileKey(file) {
  for (let attempt = 0; ; attempt++) {
    const { text, mtimeMs } = readKeyText(file);
    if (text.trim().length < 64 && attempt < SHORT_READ_RETRIES && Date.now() - mtimeMs < FRESH_KEY_MS) {
      pause(SHORT_READ_WAIT_MS);
      continue;
    }
    warnIfDirectoryReplaceable(file);
    return parseKey(text, 'BACKUP_MANIFEST_KEY_FILE');
  }
}

function readKeyText(file) {
  assertExternal(file);
  if (!fs.lstatSync(file).isFile()) throw new Error('The backup manifest key must be a regular file, not a symlink');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    let stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 128) {
      throw new Error('The backup manifest key must be a regular, non-group/world-writable private file');
    }
    if (stat.mode & 0o022) {
      // Our own key file (made by hand, copied in, a permissive tool): tighten
      // it in place. A file another account owns stays that owner's call.
      const ours = typeof process.getuid === 'function' && stat.uid === process.getuid();
      if (!ours) throw writableKeyError(file, stat.mode, false);
      try { fs.fchmodSync(fd, 0o600); } catch { /* re-checked below */ }
      const before = stat.mode;
      stat = fs.fstatSync(fd);
      // A filesystem that cannot hold modes cannot keep the key private either.
      if (stat.mode & 0o022) throw writableKeyError(file, stat.mode, true);
      logger.warn(`The backup manifest key file ${file} was group- or world-writable `
        + `(mode ${(before & 0o777).toString(8).padStart(4, '0')}); restricted it to 0600.`);
    }
    return { text: fs.readFileSync(fd, 'utf8'), mtimeMs: stat.mtimeMs };
  } finally { fs.closeSync(fd); }
}

// Write the key beside its final name, then hard-link it into place: link()
// never replaces an existing key and a reader never sees a partial file.
// Filesystems without hard links fall back to an exclusive create, removed
// again if its write fails so no empty key is left in place.
function publishKey(file, hex) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(fd, hex);
      // Durability only; a share that cannot fsync still links a complete file.
      try { fs.fsyncSync(fd); } catch { /* see above */ }
    } finally { fs.closeSync(fd); }
    try { fs.linkSync(temp, file); } catch (error) {
      if (error.code === 'EEXIST') throw error;
      const out = fs.openSync(file, 'wx', 0o600);
      try {
        try { fs.writeFileSync(out, hex); } finally { fs.closeSync(out); }
      } catch (writeError) { fs.rmSync(file, { force: true }); throw writeError; }
    }
  } finally { fs.rmSync(temp, { force: true }); }
}

function loadKey({ create = false } = {}) {
  if (process.env.BACKUP_MANIFEST_KEY) {
    const key = parseKey(process.env.BACKUP_MANIFEST_KEY);
    return { key, keyId: idOf(key), source: 'env' };
  }
  const file = keyFile();
  assertExternal(file);
  let key;
  try { key = readFileKey(file); } catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    assertExternal(file);
    const fresh = crypto.randomBytes(32);
    try {
      publishKey(file, fresh.toString('hex'));
      // Said once, at creation: the only copy is on the host it protects.
      logger.warn(`Created the backup manifest signing key at ${file}. Copy it OFF this host and keep it with `
        + 'whoever keeps the backups: a backup cannot be verified or restored on a replacement host without it.');
      // Read it back the way signing will: on a filesystem that ignores the
      // 0600 the backup must stop here, not after the copy when it signs.
      key = readFileKey(file);
    } catch (writeError) {
      if (writeError.code !== 'EEXIST') throw writeError;
      key = readFileKey(file);
    }
  }
  return { key, keyId: idOf(key), source: 'file' };
}

function keyRing() {
  const keys = new Map();
  // An unusable current key must not hide the retained ones: a backup they
  // signed stays verifiable. Signing goes through loadKey and still fails,
  // and keyStatus reports why.
  try {
    const current = loadKey();
    keys.set(current.keyId, current.key);
  } catch { /* verify with the retained keys alone */ }
  for (const [index, value] of (process.env.BACKUP_MANIFEST_KEYS_OLD || '').split(',').entries()) {
    if (!value.trim()) continue;
    const key = parseKey(value, `BACKUP_MANIFEST_KEYS_OLD entry ${index + 1}`);
    keys.set(idOf(key), key);
  }
  return keys;
}

function keyStatus() {
  try {
    const { keyId, source } = loadKey();
    return { ready: true, keyId, source };
  } catch (error) {
    if (error.code === 'ENOENT') return { ready: false, keyId: null, source: 'missing' };
    // The message names the key file and the fix; it never carries key material.
    return { ready: false, keyId: null, source: 'invalid', reason: error.message };
  }
}

module.exports = { loadKey, keyRing, keyStatus, idOf, parseKey, keyFile };
