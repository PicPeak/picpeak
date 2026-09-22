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
 *     used as they are; a passphrase goes through scrypt. A value that looks
 *     like a key but isn't one — 63 hex digits, a truncated base64 key — is
 *     refused rather than quietly derived, because deriving would produce a
 *     different key and the evidence already on disk would stop opening
 *     (and new evidence would be written under a key nobody meant to use);
 *   - otherwise a random key created on first use at
 *     <storage>/business-docs/keys/evidence.key (mode 0600). business-docs
 *     is part of the backup export, so a restored install can still read
 *     its evidence.
 * Losing the key makes the stored evidence unreadable; the signatures, the
 * PDFs and the event log stay valid.
 *
 * The key ring (key rotation): `encrypt` always uses the current key;
 * `decrypt` picks the key by the id in the value, from the current key,
 * PICPEAK_EVIDENCE_KEYS_OLD (comma-separated, the same accepted forms) and
 * any `evidence.key.<keyId>` file next to the key file. A generated
 * `evidence.key` that PICPEAK_EVIDENCE_KEY has replaced is not read:
 * scripts/rotate-evidence-key.js renames it to `evidence.key.<keyId>` on its
 * first run and then re-encrypts everything under the current key; the old
 * keys can go once it reports no rows left under them.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getStoragePath } = require('../config/storage');

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const KEY_FILE = path.join('business-docs', 'keys', 'evidence.key');

let cache = null;

/**
 * A near-miss: text that was plainly meant to be one of the two key forms and
 * is a character or two off — 60-68 hex digits where 64 were meant, or 41-45
 * base64 characters where 43 were meant. Refused, so a copy-and-paste that
 * dropped a character is an error instead of a silently different key.
 *
 * A passphrase is not a near-miss: `openssl rand -base64 48` is 64 base64
 * characters and goes through scrypt as intended, because it is nowhere near
 * the 43 that decode to 32 bytes.
 */
function looksLikeABrokenKey(value) {
  if (/^[0-9a-f]+$/i.test(value)) return value.length >= 60 && value.length <= 68 && value.length !== 64;
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
    const body = value.replace(/=+$/, '');
    return body.length >= 41 && body.length <= 45 && body.length !== 43;
  }
  return false;
}

function keyFromEnv(raw, name = 'PICPEAK_EVIDENCE_KEY') {
  const value = String(raw).trim();
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(value)) {
    const decoded = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (decoded.length === 32) return decoded;
  }
  if (looksLikeABrokenKey(value)) {
    throw new Error(
      `${name} looks like a 32-byte key with a character missing `
      + `(${value.length} characters). Use 64 hex digits or 43 characters of base64, `
      + 'or a passphrase long enough that it could not be mistaken for a key.',
    );
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
  const keyId = idOf(key);
  cache = { cacheKey, key, keyId, source: env ? 'env' : 'file' };
  return cache;
}

const idOf = (key) => crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);

/** The keys PICPEAK_EVIDENCE_KEYS_OLD names; throws on a malformed entry. */
function oldKeysFromEnv() {
  const raw = process.env.PICPEAK_EVIDENCE_KEYS_OLD;
  if (!raw || !raw.trim()) return [];
  return raw.split(',').map((part) => part.trim()).filter(Boolean)
    .map((part, index) => keyFromEnv(part, `PICPEAK_EVIDENCE_KEYS_OLD (entry ${index + 1})`));
}

let ringCache = null;

/**
 * Every key a stored value may have been written under, by key id. Built on
 * demand and rebuilt once when a value names an id it doesn't hold, so a key
 * file added while the server runs is found.
 */
function keyRing({ refresh = false } = {}) {
  const current = loadKey();
  const cacheKey = `${current.cacheKey}|${process.env.PICPEAK_EVIDENCE_KEYS_OLD || ''}`;
  if (!refresh && ringCache && ringCache.cacheKey === cacheKey) return ringCache.keys;
  const keys = new Map([[current.keyId, current.key]]);
  for (const key of oldKeysFromEnv()) keys.set(idOf(key), key);
  const dir = path.join(getStoragePath(), path.dirname(KEY_FILE));
  const base = path.basename(KEY_FILE);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (_) { /* no key directory yet */ }
  for (const name of names) {
    if (!name.startsWith(`${base}.`)) continue;
    try {
      const key = readKeyFile(path.join(dir, name));
      keys.set(idOf(key), key);
    } catch (_) { /* not a key file: ignored, and the value it would open stays unreadable */ }
  }
  ringCache = { cacheKey, keys };
  return keys;
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

/** Decrypt a value from encrypt(). Throws on tampering or a key the ring doesn't hold. */
function decrypt(stored) {
  if (!stored) return null;
  const [version, keyId, body] = String(stored).split(':');
  if (version !== VERSION || !keyId || !body) throw new Error('fieldEncryption: not an encrypted value');
  const key = keyRing().get(keyId) || keyRing({ refresh: true }).get(keyId);
  if (!key) throw new Error('fieldEncryption: encrypted with a different evidence key');
  const [iv, tag, ct] = body.split('.').map((part) => Buffer.from(part || '', 'base64url'));
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
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

/** The key a stored value was encrypted under, or null if it isn't one. */
function keyIdOf(value) {
  const match = /^v1:([0-9a-f]{8}):/.exec(String(value || ''));
  return match ? match[1] : null;
}

/**
 * Read the key once at boot, so a broken PICPEAK_EVIDENCE_KEY is a startup
 * error rather than a failed contract send hours later. Returns the problem
 * as a string, or null when the key is fine (or not created yet, which is
 * normal until the first signature).
 */
function keyProblemAtBoot() {
  try {
    // The old keys are checked as strictly as the current one: a malformed
    // entry would otherwise leave the evidence it should open unreadable.
    oldKeysFromEnv();
    if (process.env.PICPEAK_EVIDENCE_KEY) loadKey();
    return null;
  } catch (err) {
    return err.message;
  }
}

/** The key ids decrypt() can open, the current one first (rotation script, health). */
function ringKeyIds() {
  const current = loadKey().keyId;
  return [current, ...[...keyRing({ refresh: true }).keys()].filter((id) => id !== current).sort()];
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
  keyIdOf,
  keyProblemAtBoot,
  ringKeyIds,
  hashEmail,
  KEY_FILE,
  _resetForTests: () => { cache = null; ringCache = null; },
};
