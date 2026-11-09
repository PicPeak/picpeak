'use strict';

/**
 * UK VAT registration numbers (HMRC design pattern "VAT registration number";
 * Enquiry Manual EM3058).
 *
 * A standard number is 9 digits, often written with a "GB" prefix and spaces
 * ("GB 123 4567 89"), or "XI" for goods trade under the Windsor Framework in
 * Northern Ireland; a branch trader adds a 3-digit branch suffix. The last
 * two digits are a check: weight the first seven digits 8..2, add the check
 * number, and the sum is divisible by 97 (old series) or is after adding 55
 * (series issued since 2010). Government departments (GD000–GD499) and health
 * authorities (HA500–HA999) carry 5-character numbers with no check digits.
 */

function compact(value) {
  return String(value || '').replace(/[\s.-]/g, '').toUpperCase().replace(/^(GB|XI)/, '');
}

function checkDigitsValid(nine) {
  const digits = nine.split('').map(Number);
  let sum = 0;
  for (let i = 0; i < 7; i += 1) sum += digits[i] * (8 - i);
  sum += digits[7] * 10 + digits[8];
  return sum % 97 === 0 || (sum + 55) % 97 === 0;
}

/** Is `value` a well-formed UK VAT registration number? */
function isValidUkVatNumber(value) {
  const v = compact(value);
  if (/^GD[0-4]\d{2}$/.test(v)) return true;
  if (/^HA[5-9]\d{2}$/.test(v)) return true;
  // All zeros passes the check (0 is divisible by 97) but is no number.
  if (/^\d{9}$/.test(v) || /^\d{12}$/.test(v)) return !/^0{9}/.test(v) && checkDigitsValid(v.slice(0, 9));
  return false;
}

module.exports = { isValidUkVatNumber };
