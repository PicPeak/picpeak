'use strict';

/**
 * Hour and day rates for quote lines (#1451).
 *
 * Same chain the hours logging uses for its hourly rate
 * (customerHoursService.resolveEffectiveRate), extended with a day rate:
 *   1. the customer's own rate  (customer_accounts.hourly_rate_minor / day_rate_minor)
 *   2. the business default     (business_profile.default_hourly_rate_minor /
 *                                default_day_rate_minor, migrations 113 + 215)
 *
 * Unlike the hours path this never throws: a missing rate is returned as
 * `null` so the quote editor can ask the admin to set one.
 */

const { db } = require('../database/db');

const RATE_COLUMNS = {
  hour: { customer: 'hourly_rate_minor', profile: 'default_hourly_rate_minor' },
  day: { customer: 'day_rate_minor', profile: 'default_day_rate_minor' },
};

function toMinor(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * Load both rate chains in two small queries.
 * @returns {{hour: {customer: number|null, default: number|null},
 *            day: {customer: number|null, default: number|null}}}
 */
async function loadRates(customerId, conn = db) {
  const customer = customerId
    ? await conn('customer_accounts').where({ id: customerId }).first('hourly_rate_minor', 'day_rate_minor')
    : null;
  const profile = await conn('business_profile').where({ id: 1 })
    .first('default_hourly_rate_minor', 'default_day_rate_minor');
  const pick = (kind) => ({
    customer: toMinor(customer && customer[RATE_COLUMNS[kind].customer]),
    default: toMinor(profile && profile[RATE_COLUMNS[kind].profile]),
  });
  return { hour: pick('hour'), day: pick('day') };
}

/**
 * Resolve a rate from loaded chains.
 * @param {object} rates result of loadRates
 * @param {'hour'|'day'} priceMode
 * @returns {{rateMinor: number, source: 'customer'|'default'}|null}
 */
function pickRate(rates, priceMode) {
  const chain = rates && rates[priceMode];
  if (!chain) return null;
  if (chain.customer != null) return { rateMinor: chain.customer, source: 'customer' };
  if (chain.default != null) return { rateMinor: chain.default, source: 'default' };
  return null;
}

module.exports = { loadRates, pickRate };
