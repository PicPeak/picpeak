/**
 * Authenticated encryption for account-recovery email variables while a row
 * is pending. Database-only backups must not contain a working invitation,
 * reset link, or temporary admin password.
 *
 * Every other queued message gets the same protection for its password
 * fields only (gallery password, client PIN; the archive-redaction rule in
 * emailSecretRedaction): each such value is replaced by its own envelope, so
 * the rest of the variables stay readable for the queue's other readers and
 * a database-only backup holds no live gallery password.
 */
const crypto = require('crypto');
const { isSecretKey, isRealSecret } = require('./emailSecretRedaction');

const ALGORITHM = 'aes-256-gcm';
const KEY_SALT = 'picpeak-email-queue-account-recovery-v1';
const ENVELOPE_KEY = '__picpeak_encrypted_email_v1';
const FIELD_ENVELOPE_KEY = '__picpeak_encrypted_secret_v1';
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

function envelopeParts(value, envelopeKey = ENVELOPE_KEY) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== envelopeKey || typeof value[envelopeKey] !== 'string') return null;
  const encoded = value[envelopeKey].split('.');
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

function fieldContext(emailType, recipientEmail, fieldPath) {
  return Buffer.from([
    FIELD_ENVELOPE_KEY,
    String(emailType || ''),
    String(recipientEmail || '').trim().toLowerCase(),
    fieldPath,
  ].join('\0'), 'utf8');
}

function isFieldEnvelope(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, FIELD_ENVELOPE_KEY);
}

function encryptField(emailType, recipientEmail, fieldPath, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(), iv);
  cipher.setAAD(fieldContext(emailType, recipientEmail, fieldPath));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    [FIELD_ENVELOPE_KEY]: [iv, cipher.getAuthTag(), ciphertext]
      .map((part) => part.toString('base64url')).join('.'),
  };
}

function decryptField(emailType, recipientEmail, fieldPath, envelope) {
  const parts = envelopeParts(envelope, FIELD_ENVELOPE_KEY);
  try {
    if (!parts) throw new Error('malformed');
    const [iv, tag, ciphertext] = parts;
    const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey(), iv);
    decipher.setAAD(fieldContext(emailType, recipientEmail, fieldPath));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (_) {
    const failure = new Error('A queued password could not be decrypted');
    failure.code = 'EMAIL_QUEUE_DECRYPTION_FAILED';
    throw failure;
  }
}

// Rebuild only when something changes, so a message without a password
// field comes back as the very object it went in as.
function mapSecretFields(value, transform, fieldPath = '') {
  if (!value || typeof value !== 'object') return value;
  let changed = false;
  const out = Array.isArray(value) ? [] : {};
  for (const [key, child] of Object.entries(value)) {
    const childPath = fieldPath ? `${fieldPath}.${key}` : key;
    const next = transform(key, child, childPath)
      ?? (child && typeof child === 'object' ? mapSecretFields(child, transform, childPath) : child);
    if (next !== child) changed = true;
    out[key] = next;
  }
  return changed ? out : value;
}

/** Password fields of an ordinary message, each sealed in its own envelope. */
function encryptSecretFields(emailType, emailData, recipientEmail) {
  return mapSecretFields(emailData, (key, value, fieldPath) => (
    isSecretKey(key) && isRealSecret(value)
      ? encryptField(emailType, recipientEmail, fieldPath, value) : undefined));
}

/** Reverse of encryptSecretFields; tamper or a rotated key fails closed. */
function decryptSecretFields(emailType, emailData, recipientEmail) {
  return mapSecretFields(emailData, (key, value, fieldPath) => (
    isFieldEnvelope(value) ? decryptField(emailType, recipientEmail, fieldPath, value) : undefined));
}

/** A copy for display: every sealed password shown as the given mask. */
function maskSecretFields(emailData, mask) {
  return mapSecretFields(emailData, (key, value) => (isFieldEnvelope(value) ? mask : undefined));
}

/** The type a queued WhatsApp message is sealed under (recipient: the phone). */
function whatsappSealType(messageType) {
  return `whatsapp:${messageType}`;
}

function encryptEmailData(emailType, emailData, recipientEmail) {
  if (!isProtectedEmailType(emailType)) return encryptSecretFields(emailType, emailData, recipientEmail);
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
    return decryptSecretFields(emailType, emailData, recipientEmail);
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
  maskSecretFields,
  PROTECTED_PENDING_STATUS,
  whatsappSealType,
};
