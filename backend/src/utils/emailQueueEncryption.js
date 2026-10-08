/**
 * Authenticated encryption for account-recovery email variables while a row
 * is pending. Database-only backups must not contain a working invitation,
 * reset link, or temporary admin password.
 */
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_SALT = 'picpeak-email-queue-account-recovery-v1';
const ENVELOPE_KEY = '__picpeak_encrypted_email_v1';
const PROTECTED_PENDING_STATUS = 'protected_pending';
const PROTECTED_TYPES = new Set([
  'admin_invitation',
  'admin_password_reset',
  'customer_invitation',
  'customer_password_reset',
]);

let keyCache = null;
function encryptionKey() {
  const material = process.env.EMAIL_QUEUE_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!material) {
    throw new Error('emailQueueEncryption: EMAIL_QUEUE_ENCRYPTION_KEY or JWT_SECRET must be set');
  }
  if (keyCache && keyCache.material === material) return keyCache.key;
  keyCache = { material, key: crypto.scryptSync(material, KEY_SALT, 32) };
  return keyCache.key;
}

function isProtectedEmailType(emailType) {
  return PROTECTED_TYPES.has(String(emailType));
}

function envelopeParts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== ENVELOPE_KEY || typeof value[ENVELOPE_KEY] !== 'string') return null;
  const encoded = value[ENVELOPE_KEY].split('.');
  if (encoded.length !== 3 || encoded.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
  const parts = encoded.map((part) => Buffer.from(part, 'base64url'));
  if (parts.some((part, index) => part.toString('base64url') !== encoded[index])) return null;
  const [iv, tag, ciphertext] = parts;
  return iv.length === 12 && tag.length === 16 && ciphertext.length > 0 ? parts : null;
}

function isEncryptedEmailData(value) {
  return envelopeParts(value) !== null;
}

function authenticatedContext(emailType, recipientEmail) {
  return Buffer.from([
    ENVELOPE_KEY,
    String(emailType || ''),
    String(recipientEmail || '').trim().toLowerCase(),
  ].join('\0'), 'utf8');
}

function encryptEmailData(emailType, emailData, recipientEmail) {
  if (!isProtectedEmailType(emailType)) return emailData;
  if (emailData && typeof emailData === 'object'
    && Object.prototype.hasOwnProperty.call(emailData, ENVELOPE_KEY)) {
    const failure = new Error('The encrypted email envelope field is reserved');
    failure.code = 'EMAIL_QUEUE_RESERVED_ENVELOPE';
    throw failure;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(), iv);
  cipher.setAAD(authenticatedContext(emailType, recipientEmail));
  const plaintext = JSON.stringify(emailData || {});
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const envelope = [iv, cipher.getAuthTag(), ciphertext]
    .map((part) => part.toString('base64url')).join('.');
  return { [ENVELOPE_KEY]: envelope };
}

function decryptEmailData(emailType, emailData, recipientEmail) {
  if (!isEncryptedEmailData(emailData)) {
    if (emailData && typeof emailData === 'object'
      && Object.prototype.hasOwnProperty.call(emailData, ENVELOPE_KEY)) {
      const failure = new Error('Account-recovery email data could not be decrypted');
      failure.code = 'EMAIL_QUEUE_DECRYPTION_FAILED';
      throw failure;
    }
    if (isProtectedEmailType(emailType)) {
      const failure = new Error('Pending account-recovery email data is not encrypted');
      failure.code = 'EMAIL_QUEUE_ENCRYPTION_REQUIRED';
      throw failure;
    }
    return emailData;
  }
  const parts = envelopeParts(emailData);
  if (!parts) {
    throw new Error('emailQueueEncryption: malformed encrypted email data');
  }
  try {
    const [iv, tag, ciphertext] = parts;
    const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey(), iv);
    decipher.setAAD(authenticatedContext(emailType, recipientEmail));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(plaintext);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid payload');
    return parsed;
  } catch (error) {
    const failure = new Error('Account-recovery email data could not be decrypted');
    failure.code = 'EMAIL_QUEUE_DECRYPTION_FAILED';
    throw failure;
  }
}

module.exports = {
  decryptEmailData,
  encryptEmailData,
  isEncryptedEmailData,
  isProtectedEmailType,
  PROTECTED_PENDING_STATUS,
};
