'use strict';

/**
 * The VAT amount of a document, in minor units.
 *
 * Everywhere but the United Kingdom the VAT total is rounded to the nearest
 * cent, as it always was. HMRC only allows the invoice-level VAT total to be
 * rounded DOWN to a whole penny (VAT Notice 700 s.17.5), so a business in the
 * UK truncates instead. Every place that computes the VAT of an outgoing
 * quote or invoice goes through here, so the editor preview, the stored row
 * and the PDF agree.
 */

const { db } = require('../database/db');
const { isUnitedKingdom } = require('./postalAddress');

function vatMinorFor(netMinor, ratePercent, { roundDown = false } = {}) {
  const raw = (Number(netMinor) || 0) * (Number(ratePercent) || 0) / 100;
  if (!roundDown) return Math.round(raw);
  // net × rate / 100 is floating point: a product that is a whole penny in
  // exact arithmetic can land a hair below it. Settling it to six decimals
  // first keeps that penny at any amount, before rounding down.
  const settled = Math.round(raw * 1e6) / 1e6;
  // Down means towards zero: a negative amount (a credit) shrinks too.
  return settled < 0 ? -Math.floor(-settled) : Math.floor(settled);
}

/**
 * The VAT total of a UK invoice in another currency, in pence: the stored VAT
 * (minor units of the invoice currency) at `gbpRate` GBP per unit, rounded
 * down like any UK VAT total. Null without a usable rate or without VAT.
 */
function vatGbpMinorFor(vatMinor, gbpRate) {
  const rate = Number(gbpRate);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  // No VAT, no sterling VAT row.
  if (!Number(vatMinor)) return null;
  return vatMinorFor(vatMinor, rate * 100, { roundDown: true });
}

/**
 * The GBP rate an invoice keeps: a positive number with at most six decimals,
 * and only for a UK business invoicing in another currency. Anything else is
 * null, so the sterling row never appears where it doesn't belong.
 */
function normaliseVatGbpRate(value, { countryCode, currency }) {
  if (!isUnitedKingdom(countryCode)) return null;
  if (String(currency || '').trim().toUpperCase() === 'GBP') return null;
  if (value === null || value === undefined || value === '') return null;
  const rate = Number(String(value).trim().replace(',', '.'));
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1e6) return null;
  return Math.round(rate * 1e6) / 1e6;
}

/**
 * The fixed sum a supplier may claim on a late commercial debt (Late Payment
 * of Commercial Debts (Interest) Act 1998 s.5A): £40 under £1,000, £70 under
 * £10,000, £100 above. Only known for a debt in sterling; null otherwise.
 */
function latePaymentCompensationPounds(totalMinor, currency) {
  if (String(currency || '').trim().toUpperCase() !== 'GBP') return null;
  const total = Math.abs(Number(totalMinor) || 0);
  if (total < 100000) return 40;
  if (total < 1000000) return 70;
  return 100;
}

/**
 * Is the business in the United Kingdom? A failed read throws: a document's
 * tax is never computed, and its send never checked, under a guess.
 */
async function isUkBusiness(conn = db) {
  const row = await conn('business_profile').where({ id: 1 }).first('country_code');
  return isUnitedKingdom(row && row.country_code);
}

/** Does this business round its VAT total down? A UK business does. */
const roundsVatDown = isUkBusiness;

/**
 * Does this invoice still need its GBP rate before it can be issued? A UK
 * business's invoice in another currency that carries VAT states the VAT in
 * GBP too (VAT Notice 700/21 s.4.1). The row's half of the rule; the caller
 * knows whether the business is in the UK. The scheduler's query mirrors it
 * in SQL, and the frontend's bills list in utils/vatGbpRate.ts.
 */
function lacksGbpRate(invoice) {
  return !!invoice && Number(invoice.vat_amount_minor) !== 0
    && String(invoice.currency || '').toUpperCase() !== 'GBP'
    && !(Number(invoice.vat_gbp_rate) > 0);
}

/** Refuse with 409 VAT_GBP_RATE_REQUIRED while a UK invoice lacks its GBP rate. */
async function assertGbpRateEntered(invoice, conn = db) {
  if (!lacksGbpRate(invoice) || !(await isUkBusiness(conn))) return;
  const { AppError } = require('./errors');
  throw new AppError(
    `Enter the GBP exchange rate before sending: a UK VAT invoice in ${invoice.currency} must also state its VAT in GBP.`,
    409, 'VAT_GBP_RATE_REQUIRED',
  );
}

module.exports = {
  vatMinorFor, vatGbpMinorFor, normaliseVatGbpRate, latePaymentCompensationPounds, roundsVatDown, isUkBusiness,
  lacksGbpRate, assertGbpRateEntered,
};
