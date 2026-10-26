'use strict';

const Stripe = require('stripe');

function stripeConfiguration() {
  const key = (process.env.STRIPE_SECRET_KEY || '').trim();
  const webhook = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  return {
    checkout_configured: /^(rk|sk)_(test|live)_/.test(key),
    webhook_configured: !!webhook,
    test_mode: /^(rk|sk)_test_/.test(key),
  };
}

function stripeClient() {
  const configuration = stripeConfiguration();
  if (!configuration.checkout_configured) throw new Error('Stripe is not configured');
  return new Stripe(process.env.STRIPE_SECRET_KEY.trim(), {
    // Use the API version pinned by the installed SDK, rather than silently
    // inheriting whichever version the merchant's account currently uses.
    apiVersion: Stripe.API_VERSION,
    maxNetworkRetries: 2,
    timeout: 15000,
  });
}

module.exports = { stripeClient, stripeConfiguration };
