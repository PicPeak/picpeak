'use strict';

/**
 * Mail addresses are customers.view data. The admin mail surfaces (project
 * overview and email preview, the email log, the notification bell) blank
 * the recipient for an admin without that permission; free text that may
 * quote an address — delivery errors, activity metadata — keeps its words
 * and loses the address.
 */

// Anything shaped like an address, including a quoted local part
// ("anna meier"@kunde.example), which the app accepts as valid.
const EMAIL_ADDRESS = /(?:"[^"\r\n]*"|[^\s<>"'(),;:]+)@[^\s<>"'(),;:]+/g;

/**
 * `value` with every address-shaped substring replaced by `…`: a string, or
 * every string inside a plain object or array (a copy). Anything else is
 * returned as is.
 */
function redactAddresses(value) {
  if (typeof value === 'string') return value.replace(EMAIL_ADDRESS, '…');
  if (Array.isArray(value)) return value.map(redactAddresses);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactAddresses(v)]));
  }
  return value;
}

module.exports = { redactAddresses };
