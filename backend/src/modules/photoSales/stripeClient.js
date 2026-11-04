'use strict';

const { credentials, configurationOf, clientFor } = require('./paymentSettings');

async function stripeConfiguration() {
  return configurationOf(await credentials());
}

async function stripeClient(value) {
  value = value || await credentials();
  const configuration = configurationOf(value);
  if (!configuration.checkout_configured) throw new Error('Stripe is not configured');
  return clientFor(value.secretKey);
}

module.exports = { stripeClient, stripeConfiguration };
