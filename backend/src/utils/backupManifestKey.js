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

function readFileKey(file) {
  assertExternal(file);
  if (!fs.lstatSync(file).isFile()) throw new Error('The backup manifest key must be a regular file, not a symlink');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 128 || (stat.mode & 0o022)) {
      throw new Error('The backup manifest key must be a regular, non-group/world-writable private file');
    }
    return parseKey(fs.readFileSync(fd, 'utf8'), 'BACKUP_MANIFEST_KEY_FILE');
  } finally { fs.closeSync(fd); }
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
      fs.writeFileSync(file, fresh.toString('hex'), { flag: 'wx', mode: 0o600 });
      key = fresh;
      // Said once, at creation: the only copy is on the host it protects.
      logger.warn(`Created the backup manifest signing key at ${file}. Copy it OFF this host and keep it with `
        + 'whoever keeps the backups: a backup cannot be verified or restored on a replacement host without it.');
    } catch (writeError) {
      if (writeError.code !== 'EEXIST') throw writeError;
      key = readFileKey(file);
    }
  }
  return { key, keyId: idOf(key), source: 'file' };
}

function keyRing() {
  const keys = new Map();
  try {
    const current = loadKey();
    keys.set(current.keyId, current.key);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
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
    return { ready: false, keyId: null, source: error.code === 'ENOENT' ? 'missing' : 'invalid' };
  }
}

module.exports = { loadKey, keyRing, keyStatus, idOf, parseKey, keyFile };
