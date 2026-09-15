'use strict';

/**
 * Field encryption for signing evidence (#1446).
 *
 * A signer's name, email, IP address, user agent and decline reason are
 * stored encrypted — not hashed — so that in a dispute the operator can show
 * who signed, from where, with what. AES-256-GCM; a value looks like
 * `v1:<keyId>:<iv>.<tag>.<ciphertext>` (base64url), where keyId is the first
 * eight hex digits of the key's sha256, so a value encrypted under another
 * key is recognised instead of failing obscurely.
 *
 * The key (the "evidence key"):
 *   - PICPEAK_EVIDENCE_KEY, when set: 64 hex digits or 32 bytes of base64 are
 *     used as they are; any other text goes through scrypt;
 *   - otherwise a random key created on first use at
 *     <storage>/business-docs/keys/evidence.key (mode 0600). business-docs
 *     is part of the backup export, so a restored install can still read
 *     its evidence.
 * Losing the key makes the stored evidence unreadable; the signatures, the
 * PDFs and the event log stay valid.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getStoragePath } = require('../config/storage');

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const KEY_FILE = path.join('business-docs', 'keys', 'evidence.key');

let cache = null;

function keyFromEnv(raw) {
  const value = String(raw).trim();
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(value)) {
    const decoded = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (decoded.length === 32) return decoded;
  }
  return crypto.scryptSync(value, 'picpeak-evidence-key-v1', 32);
}

function readKeyFile(file) {
  const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  if (key.length !== 32) throw new Error('fieldEncryption: the evidence key file does not hold a 32-byte hex key');
  return key;
}

function loadKey() {
  const env = process.env.PICPEAK_EVIDENCE_KEY;
  const file = path.join(getStoragePath(), KEY_FILE);
  const cacheKey = env ? `env:${env}` : `file:${file}`;
  if (cache && cache.cacheKey === cacheKey) return cache;

  let key;
  if (env) {
    key = keyFromEnv(env);
  } else if (fs.existsSync(file)) {
    key = readKeyFile(file);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const fresh = crypto.randomBytes(32);
    try {
      // `wx`: two processes starting at once — the second reads the first's key.
      fs.writeFileSync(file, fresh.toString('hex'), { flag: 'wx', mode: 0o600 });
      key = fresh;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      key = readKeyFile(file);
    }
  }
  const keyId = crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
  cache = { cacheKey, key, keyId, source: env ? 'env' : 'file' };
  return cache;
}

/** Encrypt a value; null and '' stay null. */
function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const { key, keyId } = loadKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const body = [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
  return `${VERSION}:${keyId}:${body}`;
}

/** Decrypt a value from encrypt(). Throws on tampering or another key. */
function decrypt(stored) {
  if (!stored) return null;
  const [version, keyId, body] = String(stored).split(':');
  if (version !== VERSION || !keyId || !body) throw new Error('fieldEncryption: not an encrypted value');
  const current = loadKey();
  if (keyId !== current.keyId) throw new Error('fieldEncryption: encrypted with a different evidence key');
  const [iv, tag, ct] = body.split('.').map((part) => Buffer.from(part || '', 'base64url'));
  const decipher = crypto.createDecipheriv(ALGORITHM, current.key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** decrypt(), or null when the value can't be read (a lost or rotated key). */
function tryDecrypt(stored) {
  try {
    return decrypt(stored);
  } catch (_) {
    return null;
  }
}

/** Where the key comes from, for System Health — never the key itself. */
function keyInfo() {
  const { keyId, source } = loadKey();
  return { keyId, source };
}

/**
 * Where the key comes from, without creating one (System Health):
 * `env`, `file`, `none` (created with the first signature) or `unreadable`.
 */
function keyStatus() {
  const env = !!process.env.PICPEAK_EVIDENCE_KEY;
  if (!env && !fs.existsSync(path.join(getStoragePath(), KEY_FILE))) return { source: 'none', keyId: null };
  try {
    const { keyId, source } = loadKey();
    return { source, keyId };
  } catch (_) {
    return { source: 'unreadable', keyId: null };
  }
}

/** The lookup hash of an email address. */
function hashEmail(email) {
  return crypto.createHash('sha256').update(String(email || '').trim().toLowerCase()).digest('hex');
}

module.exports = {
  encrypt,
  decrypt,
  tryDecrypt,
  keyInfo,
  keyStatus,
  hashEmail,
  _resetForTests: () => { cache = null; },
};
