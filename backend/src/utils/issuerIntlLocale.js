'use strict';

/**
 * The number format a business's country fixes, whatever language a document
 * or email is in. FL/CH/DE/AT businesses write 1'000.00 (de-CH is the only
 * Intl locale that does — per maintainer: "in FL, CH, DE we write 1'000.00 not
 * 1,000.00"), and a US business writes $1,000.00 (en-US). Null for every other
 * country, where the document language decides.
 */
function issuerIntlLocale(countryCode) {
  const cc = String(countryCode || '').trim().toUpperCase();
  if (['CH', 'LI', 'DE', 'AT'].includes(cc)) return 'de-CH';
  if (cc === 'US') return 'en-US';
  return null;
}

module.exports = { issuerIntlLocale };
