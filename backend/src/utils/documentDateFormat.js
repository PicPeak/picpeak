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

module.exports = { defaultDocumentDateFormat };
