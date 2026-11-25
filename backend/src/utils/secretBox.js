'use strict';

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

/**
 * AES-256-GCM encryption of a stored secret ("iv.tag.ciphertext", all
 * base64url) under a key derived with scrypt from an environment variable,
 * falling back to JWT_SECRET. `salt` and `envKey` decide which secrets can be
 * read back, so each caller keeps its own; `label` prefixes the error
 * messages. `memoize` keeps the derived key per key material, because scrypt
 * is deliberately slow.
 */
function createSecretBox({ envKey, salt, label, memoize = false }) {
  let cache = null; // { material, key }

  function getEncryptionKey() {
    const material = process.env[envKey] || process.env.JWT_SECRET;
    if (!material) {
      throw new Error(`${label}: ${envKey} or JWT_SECRET must be set`);
    }
    if (memoize && cache && cache.material === material) return cache.key;
    const key = crypto.scryptSync(material, salt, 32);
    if (memoize) cache = { material, key };
    return key;
  }

  /** Encrypt → "iv.tag.ciphertext" (all base64url). */
  function encryptSecret(plainSecret) {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const ct = Buffer.concat([cipher.update(plainSecret, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv, tag, ct].map((b) => b.toString('base64url')).join('.');
  }

  /** Reverse of encryptSecret. Throws on tamper/wrong key. */
  function decryptSecret(stored) {
    const key = getEncryptionKey();
    const [ivB64, tagB64, ctB64] = String(stored).split('.');
    if (!ivB64 || !tagB64 || !ctB64) {
      throw new Error(`${label}: malformed encrypted secret`);
    }
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]);
    return pt.toString('utf8');
  }

  return { encryptSecret, decryptSecret };
}

module.exports = { createSecretBox };
