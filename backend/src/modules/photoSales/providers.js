'use strict';
const { db } = require('../../database/db');
const { getAppSetting } = require('../../utils/appSettings');
const stripe = require('./paymentSettings');
const snipcart = require('./snipcartSettings');
const KEY = 'payments_provider_availability';
async function preferences(conn = db) {
  const stored = await getAppSetting(KEY, null, conn);
  return { stripe: stored?.stripe !== false, snipcart: stored?.snipcart !== false, revision: stripe.revision(stored) };
}
async function configuration(conn = db) {
  const [stripeKeys, snipcartKeys, enabled] = await Promise.all([stripe.credentials(conn), snipcart.credentials(conn), preferences(conn)]);
  const available = [];
  const stripeConfig = stripe.configurationOf(stripeKeys);
  if (enabled.stripe && stripeConfig.checkout_configured && stripeConfig.webhook_configured) available.push('stripe');
  if (enabled.snipcart && snipcart.configurationOf(snipcartKeys).checkout_configured) available.push('snipcart');
  return { available, preferred: available[0] || null, snipcart_public_key: available.includes('snipcart') ? snipcartKeys.publicKey : null };
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
}
module.exports = { configuration, preferences, savePreferences };
