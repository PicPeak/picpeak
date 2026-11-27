'use strict';

/**
 * The number format a business's country fixes, whatever language a document
 * or email is in. FL/CH/DE/AT businesses write 1'000.00 (de-CH is the only
 * Intl locale that does — per maintainer: "in FL, CH, DE we write 1'000.00 not
 * 1,000.00"), a US business writes $1,000.00 (en-US) and a Brazilian one
 * R$ 1.000,00 (pt-BR). Null for every other
 * country, where the document language decides.
 */
function issuerIntlLocale(countryCode) {
  const cc = String(countryCode || '').trim().toUpperCase();
  if (['CH', 'LI', 'DE', 'AT'].includes(cc)) return 'de-CH';
  if (cc === 'US') return 'en-US';
  if (cc === 'BR') return 'pt-BR';
  return null;
}

/**
 * The number format a document or email language implies when the business's
 * country does not fix one: German documents write 1'000.00 like the DACH
 * businesses they mostly come from, Portuguese ones 1.000,00 (pt is
 * Brazilian Portuguese), everything else en-GB.
 */
function languageIntlLocale(language) {
  if (language === 'de') return 'de-CH';
  if (language === 'pt') return 'pt-BR';
  return 'en-GB';
}

module.exports = { issuerIntlLocale, languageIntlLocale };
