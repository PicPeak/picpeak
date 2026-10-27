'use strict';
const { db } = require('../../database/db');
const { getAppSetting } = require('../../utils/appSettings');
const { encrypt, decrypt, revision, lock } = require('./paymentSettings');
const KEY = 'payments_snipcart_credentials';
const API = 'https://app.snipcart.com/api';
const problem = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

async function credentials(conn = db) {
  const publicKey = (process.env.SNIPCART_API_KEY || '').trim();
  const secretKey = (process.env.SNIPCART_SECRET_API_KEY || '').trim();
  if (publicKey || secretKey) return { publicKey, secretKey, source: 'environment' };
  const stored = await getAppSetting(KEY, null, conn);
  if (!stored) return { publicKey: '', secretKey: '', source: 'none' };
  try {
    return { publicKey: stored.public_key || '', secretKey: decrypt(stored.secret_key, KEY), source: 'settings', stored };
  } catch { return { publicKey: '', secretKey: '', source: 'settings', stored, unreadable: true }; }
}
function configurationOf(value) {
  return { checkout_configured: !!value.publicKey && !!value.secretKey, webhook_configured: !!value.secretKey };
}
function auth(value) { return value.secretKey ? `Basic ${Buffer.from(`${value.secretKey}:`).toString('base64')}` : null; }
async function request(path, options = {}, value) {
  const resolved = value || await credentials();
  if (!resolved.secretKey) throw problem('Snipcart secret API access is not configured.', 503);
  return fetch(`${API}${path}`, { ...options, signal: AbortSignal.timeout(15000), headers: {
    Accept: 'application/json', ...options.headers, Authorization: auth(resolved),
  } });
}
async function settings() {
  const value = await credentials();
  return { ...configurationOf(value), source: value.source, revision: revision(value.stored || null),
    public_key: value.publicKey || '', unreadable: !!value.unreadable, api_verified_at: value.stored?.verified_at || null };
}
async function verifyApi(secretKey) {
  try {
    const response = await request('/orders?limit=1', {}, { secretKey });
    if (!response.ok) throw new Error('Denied');
    return { checked_at: new Date().toISOString() };
  } catch { throw problem('Snipcart API access could not be checked. Check the secret key and selected account/environment.', 422); }
}
async function save(input) {
  const current = await credentials();
  if (current.source === 'environment') throw problem('Snipcart credentials are managed by the server environment.', 409);
  if (input.revision !== revision(current.stored || null)) throw problem('Payment settings changed. Reload before saving.', 409);
  const publicKey = input.public_key?.trim() || current.publicKey;
  const secretKey = input.secret_key?.trim() || current.secretKey;
  if (!publicKey || !secretKey || [publicKey, secretKey].some((value) => value.length > 2048 || Array.from(value).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127))) {
    throw problem('Enter the public and secret Snipcart API keys from the same account and environment.');
  }
  const verified = await verifyApi(secretKey);
  // Keep access to the store that owns existing orders, including orphaned ones.
  const history = await db('photo_purchase_orders').where({ payment_provider: 'snipcart' }).max('id as last_id').first();
  const anchor = await db('photo_purchase_orders').where({ payment_provider: 'snipcart' })
    .whereNotNull('provider_order_id').first('provider_order_id');
  if (anchor) {
    const response = await request(`/orders/${encodeURIComponent(anchor.provider_order_id)}`, {}, { secretKey });
    if (!response.ok) throw problem('The key cannot access this installation’s existing Snipcart orders. Use the same store and environment.', 409);
  }
  await db.transaction(async (trx) => {
    await lock(trx);
    const fresh = await getAppSetting(KEY, null, trx);
    if (input.revision !== revision(fresh || null)) throw problem('Payment settings changed. Reload before saving.', 409);
    const freshHistory = await trx('photo_purchase_orders').where({ payment_provider: 'snipcart' }).max('id as last_id').first();
    if (String(freshHistory.last_id) !== String(history.last_id)) throw problem('A Snipcart order arrived during verification. Reload and try again.', 409);
    if (!anchor && history.last_id && (secretKey !== current.secretKey || publicKey !== current.publicKey)) {
      throw problem('Resolve outstanding Snipcart checkouts before changing store credentials.', 409);
    }
    const next = { public_key: publicKey, secret_key: encrypt(secretKey, KEY), verified_at: verified.checked_at };
    if (fresh) await trx('app_settings').where({ setting_key: KEY }).update({ setting_value: JSON.stringify(next), updated_at: new Date().toISOString() });
    else await trx('app_settings').insert({ setting_key: KEY, setting_type: 'payments', setting_value: JSON.stringify(next) });
  });
  return settings();
}
module.exports = { credentials, configurationOf, request, auth, settings, save, verifyApi };
