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
// ("anna meier"@kunde.example), which the app accepts as valid, and an
// apostrophe inside the local part after a letter or digit (o'connor@…), so
// a single-quoted 'anna@kunde.example' in free text is still the address.
const EMAIL_ADDRESS = /(?:"[^"\r\n]*"|[^\s<>"'(),;:](?:[^\s<>"'(),;:]|(?<=[\p{L}\p{N}])')*)@[^\s<>"'(),;:]+/gu;

// A match must be a whole address: no local-part character right before it,
// no domain character (or a dot that goes on with one) right after it, so
// ann@… never matches inside joann@… or anna@kunde.example inside
// anna@kunde.example.au. An apostrophe belongs to the local part only after
// a letter or digit (o'connor@…), so 'anna@kunde.example' and an attribute
// such as title='anna@kunde.example' still match, as in EMAIL_ADDRESS.
const BEFORE_ADDRESS = '(?<![\\p{L}\\p{N}.!#$%&*+/=?^_`{|}~-])(?<![\\p{L}\\p{N}]\')';
const AFTER_ADDRESS = '(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}_-])';

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
 * case. A body is not searched for address shapes, and the addresses in
 * `keep` (lower-cased: the studio's own, see studioAddresses) stay.
 */
function redactKnownAddresses(html, values, keep = new Set()) {
  if (!html) return html;
  const found = new Set();
  const collect = (value) => {
    if (typeof value === 'string') {
      for (const address of value.match(EMAIL_ADDRESS) || []) {
        if (!keep.has(address.toLowerCase())) found.add(address);
      }
    } else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(values);
  const forms = [...new Set([...found].flatMap((address) => [address, escapeHtml(address)]))];
  if (!forms.length) return html;
  const whole = `${BEFORE_ADDRESS}(?:${forms.map(escapeRegExp).join('|')})${AFTER_ADDRESS}`;
  return String(html).replace(new RegExp(whole, 'giu'), '…');
}

/**
 * The studio's own addresses, lower-cased: the support address, the mail
 * identities (sender, accounting mailbox, each further mailbox's login and
 * sender), the business contact address and every admin user's. Templates
 * pass them as variables too ({{support_email}}, a gallery's admin_email);
 * they are no customer's address.
 */
async function studioAddresses() {
  // Required here: the mail and profile services load the database.
  const { getSupportEmail, mailIdentities } = require('../services/emailProcessor');
  const { getProfile } = require('../services/businessProfileService');
  const { db } = require('../database/db');
  const [support, identities, { profile }, admins] = await Promise.all([
    getSupportEmail(), mailIdentities(), getProfile(), db('admin_users').pluck('email'),
  ]);
  return new Set([
    support, identities.automated, identities.accounting,
    ...identities.mailboxes.flatMap((mailbox) => [mailbox.login, mailbox.sender]),
    profile?.email, ...admins,
  ].filter(Boolean).map((address) => String(address).trim().toLowerCase()));
}

module.exports = { redactAddresses, redactKnownAddresses, studioAddresses };
