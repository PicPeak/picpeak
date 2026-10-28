'use strict';
const { db } = require('../../database/db');
const { getAppSetting } = require('../../utils/appSettings');
const stripe = require('./paymentSettings');
const snipcart = require('./snipcartSettings');
const KEY = 'payments_provider_availability';
const CONFIGURATION_TTL_MS = 5000;
let cached;
function invalidateConfiguration() { cached = null; }
async function preferences(conn = db) {
  const stored = await getAppSetting(KEY, null, conn);
  return { stripe: stored?.stripe !== false, snipcart: stored?.snipcart !== false, revision: stripe.revision(stored) };
}
async function readConfiguration(conn) {
  const [stripeKeys, snipcartKeys, enabled] = await Promise.all([stripe.credentials(conn), snipcart.credentials(conn), preferences(conn)]);
  const available = [];
  const stripeConfig = stripe.configurationOf(stripeKeys);
  if (enabled.stripe && stripeConfig.checkout_configured && stripeConfig.webhook_configured) available.push('stripe');
  if (enabled.snipcart && snipcart.configurationOf(snipcartKeys).checkout_configured) available.push('snipcart');
  return { available, preferred: available[0] || null, snipcart_public_key: available.includes('snipcart') ? snipcartKeys.publicKey : null };
}
async function configuration(conn = db) {
  // Reservation/configuration transactions must always see current settings.
  if (conn !== db) return readConfiguration(conn);
  const environment = stripe.revision([
    process.env.STRIPE_SECRET_KEY, process.env.STRIPE_WEBHOOK_SECRET,
    process.env.SNIPCART_API_KEY, process.env.SNIPCART_SECRET_API_KEY,
    process.env.PAYMENTS_ENCRYPTION_KEY, process.env.JWT_SECRET,
  ]);
  if (cached && cached.environment === environment && cached.until > Date.now()) return cached.promise;
  const promise = readConfiguration(conn);
  cached = { environment, until: Date.now() + CONFIGURATION_TTL_MS, promise };
  try { return await promise; }
  catch (error) {
    if (cached?.promise === promise) invalidateConfiguration();
    throw error;
  }
}
async function savePreferences(input) {
  await db.transaction(async (trx) => {
    await stripe.lock(trx);
    const stored = await getAppSetting(KEY, null, trx);
    if (input.revision !== stripe.revision(stored)) throw Object.assign(new Error('Payment settings changed. Reload before saving.'), { statusCode: 409 });
    const value = JSON.stringify({ stripe: input.stripe, snipcart: input.snipcart });
    await trx('app_settings').insert({ setting_key: KEY, setting_type: 'payments', setting_value: value })
      .onConflict('setting_key').merge({ setting_value: value, updated_at: new Date().toISOString() });
  });
  invalidateConfiguration();
}
module.exports = { configuration, preferences, savePreferences, invalidateConfiguration };
