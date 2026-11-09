'use strict';

/**
 * The date format a document uses when Settings → General has none stored
 * (`general_date_format`): DD/MM/YYYY for a business in the United Kingdom,
 * where "09.11.2026" reads as German, and DD.MM.YYYY everywhere else, as the
 * documents always printed. A stored setting always wins over this.
 */

const { isUnitedKingdom } = require('./postalAddress');

function defaultDocumentDateFormat(issuerCountryCode) {
  return isUnitedKingdom(issuerCountryCode) ? { format: 'DD/MM/YYYY' } : { format: 'DD.MM.YYYY' };
}

/**
 * The stored setting, or the business country's default. For callers that
 * have neither at hand (the signature stamps). Reads the global connection,
 * so call it before a transaction opens. A failed read falls back to
 * DD.MM.YYYY rather than failing the signature.
 */
async function readDocumentDateFormat() {
  // Required here so pdfService can load this module without a database.
  const { getAppSetting } = require('./appSettings');
  const { db } = require('../database/db');
  try {
    const raw = await getAppSetting('general_date_format');
    if (raw && typeof raw === 'object' && raw.format) return raw;
    if (typeof raw === 'string' && raw.trim()) return { format: raw.trim() };
    const profile = await db('business_profile').where({ id: 1 }).first('country_code');
    return defaultDocumentDateFormat(profile && profile.country_code);
  } catch (_) {
    return defaultDocumentDateFormat(null);
  }
}

module.exports = { defaultDocumentDateFormat, readDocumentDateFormat };
