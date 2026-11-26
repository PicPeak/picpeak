'use strict';

const { escapeHtml } = require('./formatters');
const { escapeRegExp } = require('./emailSecretRedaction');

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

/**
 * A mail body with the addresses that mail carries replaced by `…`: every
 * address-shaped part of `values` (the recipient, cc, the template
 * variables), as written and as the template engine HTML-escapes it, in any
 * case. A body is not searched for address shapes: the studio's own address
 * and its mailto: links stay unless the mail carries them as a value.
 */
function redactKnownAddresses(html, values) {
  if (!html) return html;
  const found = new Set();
  const collect = (value) => {
    if (typeof value === 'string') for (const address of value.match(EMAIL_ADDRESS) || []) found.add(address);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(values);
  // Longest first, so a longer address is not cut by one inside it.
  const forms = [...new Set([...found].flatMap((address) => [address, escapeHtml(address)]))]
    .sort((a, b) => b.length - a.length);
  if (!forms.length) return html;
  return String(html).replace(new RegExp(forms.map(escapeRegExp).join('|'), 'gi'), '…');
}

module.exports = { redactAddresses, redactKnownAddresses };
