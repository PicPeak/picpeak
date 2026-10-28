'use strict';

const crypto = require('crypto');
const Stripe = require('stripe');
const { db } = require('../../database/db');
const { getAppSetting } = require('../../utils/appSettings');
const logger = require('../../utils/logger');

const KEY = 'payments_stripe_credentials';
const WEBHOOK_STATUS_KEY = 'payments_stripe_webhook_status';
const WEBHOOK_EVENTS = [
  'checkout.session.completed', 'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed', 'checkout.session.expired',
  'charge.refunded', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed',
  'refund.updated', 'refund.failed',
];
let encryptionKey;

function problem(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }

// Same AES-GCM/scrypt approach as the existing OIDC and MFA secret stores,
// with a separate purpose and optional key so JWT rotation need not affect it.
function key() {
  const material = process.env.PAYMENTS_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!material) throw new Error('Payment credential encryption is unavailable');
  if (encryptionKey?.material !== material) {
    encryptionKey = { material, value: crypto.scryptSync(material, 'picpeak-payments-secrets-v1', 32) };
  }
  return encryptionKey.value;
}
function encrypt(value, purpose = KEY) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(purpose));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((v) => v.toString('base64url')).join('.');
}
function decrypt(value, purpose = KEY) {
  const [iv, tag, ciphertext] = String(value).split('.').map((v) => Buffer.from(v, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAAD(Buffer.from(purpose));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
function revision(stored) { return crypto.createHash('sha256').update(JSON.stringify(stored || null)).digest('hex'); }
function reportUnreadableCredentials(provider) {
  // Never log the ciphertext, key material or crypto error details.
  logger.error('Saved payment credentials could not be decrypted. Restore the original PAYMENTS_ENCRYPTION_KEY (or JWT_SECRET fallback), or re-enter credentials for the same merchant in Settings → Payments.', { provider });
}
function fingerprint(credentials) {
  return crypto.createHash('sha256').update(`${credentials.secretKey}\0${credentials.webhookSecret}`).digest('hex');
}
function clientFor(secretKey) {
  return new Stripe(secretKey, { apiVersion: Stripe.API_VERSION, maxNetworkRetries: 2, timeout: 15000 });
}

async function credentials(conn = db) {
  const secretKey = (process.env.STRIPE_SECRET_KEY || '').trim();
  const webhookSecret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  // Treat environment credentials as a pair. Never silently combine a key
  // from one source/account/mode with the other source's signing secret.
  if (secretKey || webhookSecret) return { secretKey, webhookSecret, source: 'environment' };
  const stored = await getAppSetting(KEY, null, conn);
  if (!stored) return { secretKey: '', webhookSecret: '', source: 'none' };
  try {
    return { secretKey: decrypt(stored.secret_key), webhookSecret: decrypt(stored.webhook_secret), source: 'settings', stored };
  } catch {
    reportUnreadableCredentials('stripe');
    return { secretKey: '', webhookSecret: '', source: 'settings', stored, unreadable: true };
  }
}
function configurationOf(value) {
  return {
    checkout_configured: /^(rk|sk)_(test|live)_/.test(value.secretKey),
    webhook_configured: !!value.webhookSecret,
    test_mode: /^(rk|sk)_test_/.test(value.secretKey),
  };
}

async function settings() {
  const value = await credentials();
  const stored = value.stored || await getAppSetting(KEY);
  const webhook = await getAppSetting(WEBHOOK_STATUS_KEY);
  return {
    ...configurationOf(value), source: value.source, revision: revision(stored),
    unreadable: !!value.unreadable,
    account_id: value.source === 'settings' ? stored?.account_id || null : null,
    api_verified_at: value.source === 'settings' ? stored?.verified_at || null : null,
    webhook_verified_at: !value.unreadable && webhook?.fingerprint === fingerprint(value) ? webhook.received_at : null,
  };
}

async function verifyApi(secretKey) {
  try {
    const client = clientFor(secretKey);
    const account = await client.accounts.retrieve();
    await client.checkout.sessions.list({ limit: 1 });
    if (!/^acct_/.test(account.id)) throw new Error('Invalid account');
    return { account_id: account.id, test_mode: /^(rk|sk)_test_/.test(secretKey) };
  } catch {
    // SDK messages may contain the supplied key or merchant/customer data.
    throw problem('Stripe API access could not be verified. Check the key and its Account and Checkout Sessions read permissions.', 422);
  }
}

function readOrderQuote(order) {
  try { return JSON.parse(order.checkout_quote); }
  catch { throw problem('An existing Stripe order needs attention before credentials can be changed.', 409); }
}

async function save(input) {
  const current = await credentials();
  if (current.source === 'environment') throw problem('Stripe credentials are managed by the server environment.', 409);
  const stored = current.stored || null;
  if (input.revision !== revision(stored)) throw problem('Payment settings changed. Reload before saving.', 409);
  const secretKey = input.secret_key?.trim() || current.secretKey;
  const webhookSecret = input.webhook_secret?.trim() || current.webhookSecret;
  if (!/^(rk|sk)_(test|live)_[A-Za-z0-9]+$/.test(secretKey) || secretKey.length > 512) throw problem('Enter a valid restricted or secret Stripe API key.');
  if (!/^whsec_[A-Za-z0-9]+$/.test(webhookSecret) || webhookSecret.length > 512) throw problem('Enter the Stripe endpoint signing secret.');
  const testMode = /^(rk|sk)_test_/.test(secretKey);
  if (stored && stored.test_mode !== testMode && !input.webhook_secret?.trim()) {
    throw problem('Changing payment mode requires the matching webhook signing secret.');
  }
  const verified = await verifyApi(secretKey);
  if (stored?.account_id && stored.account_id !== verified.account_id && !input.webhook_secret?.trim()) {
    throw problem('Changing Stripe accounts requires the matching webhook signing secret.');
  }
  const orders = await db('photo_purchase_orders').where({ payment_provider: 'stripe' }).select('checkout_quote', 'status', 'checkout_session_id');
  if (!stored?.account_id) {
    const sameMode = orders.filter((order) => readOrderQuote(order).testMode === testMode);
    const anchor = sameMode.find((order) => order.checkout_session_id);
    if (sameMode.length && !anchor) throw problem('Resolve existing checkouts using the current server credentials before moving them into Settings.', 409);
    if (anchor) {
      try { await clientFor(secretKey).checkout.sessions.retrieve(anchor.checkout_session_id); }
      catch { throw problem('The key cannot access this installation\'s existing Stripe orders. Use credentials for the same account.', 409); }
    }
  }
  const next = {
    secret_key: encrypt(secretKey), webhook_secret: encrypt(webhookSecret),
    account_id: verified.account_id, test_mode: testMode, verified_at: new Date().toISOString(),
  };
  // Serialise configuration changes with checkout reservation on both
  // SQLite and PostgreSQL; do not hold this lock during provider calls.
  await db.transaction(async (trx) => {
    await lock(trx);
    const fresh = await getAppSetting(KEY, null, trx);
    if (input.revision !== revision(fresh)) throw problem('Payment settings changed. Reload before saving.', 409);
    const orders = await trx('photo_purchase_orders').where({ payment_provider: 'stripe' }).select('checkout_quote', 'status');
    if (orders.length && fresh?.account_id && fresh.account_id !== verified.account_id) {
      throw problem('This installation already has Stripe orders. Rotate a key for the same merchant account; changing accounts requires a migration.', 409);
    }
    if (orders.some((order) => {
      const quote = readOrderQuote(order);
      return quote.testMode !== testMode && (!quote.testMode || ['pending', 'creation_unknown', 'processing', 'refund_pending', 'refund_failed'].includes(order.status));
    })) throw problem('Resolve outstanding checkouts before changing mode. An installation with live orders must retain live payment access.', 409);
    if (fresh) {
      await trx('app_settings').where({ setting_key: KEY }).update({ setting_value: JSON.stringify(next), updated_at: new Date().toISOString() });
    } else {
      await trx('app_settings').insert({ setting_key: KEY, setting_value: JSON.stringify(next), setting_type: 'payments', updated_at: new Date().toISOString() });
    }
  }).catch((error) => {
    if (['23505', 'SQLITE_CONSTRAINT'].includes(error.code)) throw problem('Payment settings changed. Reload before saving.', 409);
    throw error;
  });
  // Lazy import: providers reads this module to resolve credentials.
  require('./providers').invalidateConfiguration();
  return settings();
}

async function lock(trx) {
  await trx('app_settings').insert({ setting_key: 'payments_configuration_lock', setting_type: 'payments', setting_value: '0' })
    .onConflict('setting_key').ignore();
  await trx('app_settings').where({ setting_key: 'payments_configuration_lock' }).update({ setting_value: trx.ref('setting_value') });
}

async function recordWebhook(value) {
  const next = JSON.stringify({ fingerprint: fingerprint(value), received_at: new Date().toISOString() });
  await db('app_settings').insert({ setting_key: WEBHOOK_STATUS_KEY, setting_value: next, setting_type: 'payments' })
    .onConflict('setting_key').merge({ setting_value: next, updated_at: new Date().toISOString() });
}

module.exports = { credentials, configurationOf, settings, save, verifyApi, clientFor, recordWebhook, lock,
  encrypt, decrypt, revision, reportUnreadableCredentials, WEBHOOK_EVENTS };
