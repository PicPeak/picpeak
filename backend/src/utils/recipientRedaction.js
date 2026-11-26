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
// The parts are bounded (local part 64, domain 255, as RFC 5321 allows), so
// a long unbroken text costs a linear scan, not a quadratic one; callers
// also skip any string without an @.
const EMAIL_ADDRESS = /(?:"[^"\r\n]{0,64}"|[^\s<>"'(),;:](?:[^\s<>"'(),;:]|(?<=[\p{L}\p{N}])'){0,63})@[^\s<>"'(),;:]{1,255}/gu;

// A carried address is replaced only as a whole address: the character
// before it is no local-part character ([A-Za-z0-9._%+-], or an apostrophe
// right after a letter or digit as in o'connor@…), the one after it no
// domain character (nor a dot that goes on with one). So ann@… never matches
// inside joann@…, anna@kunde.example not inside studio.anna@… or
// anna@kunde.example.au, while =, ?, /, &, ;, quotes, < and : delimit it
// (…?cc=anna@…, title=anna@…). Known limit: = and / are valid in a local
// part too, so a carried b@… also matches the tail of an a=b@… or a/b@….
const WHOLE_BEFORE = '(?<![A-Za-z0-9._%+-])(?<![A-Za-z0-9]\')';
const WHOLE_AFTER = '(?![A-Za-z0-9-]|\\.[A-Za-z0-9])';
// Prose punctuation a template variable may carry after an address.
const TRAILING_PROSE = /[.,;:!?)\]}]+$/;

/**
 * `value` with every address-shaped substring replaced by `…`: a string, or
 * every string inside a plain object or array (a copy). Anything else is
 * returned as is.
 */
function redactAddresses(value) {
  if (typeof value === 'string') return value.includes('@') ? value.replace(EMAIL_ADDRESS, '…') : value;
  if (Array.isArray(value)) return value.map(redactAddresses);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactAddresses(v)]));
  }
  return value;
}

/**
 * A mail body with the addresses that mail carries replaced by `…`: every
 * address in `values` (the recipient, cc, the template variables), as
 * written and as the template engine HTML-escapes it, in any case. A body is
 * not searched for address shapes. The addresses in `keep` (lower-cased: the
 * studio's own, see studioAddresses) stay: they are matched in the same pass
 * and written back, so a carried address never cuts into a kept one, nor a
 * kept one into a longer carried address that ends in it.
 */
function redactKnownAddresses(html, values, keep = new Set()) {
  if (!html) return html;
  const carried = new Set();
  const collect = (value) => {
    if (typeof value === 'string') {
      if (!value.includes('@')) return;
      for (const match of value.match(EMAIL_ADDRESS) || []) {
        const address = match.replace(TRAILING_PROSE, '').toLowerCase();
        if (!keep.has(address)) carried.add(address);
      }
    } else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(values);
  if (!carried.size) return html;
  const formsOf = (address) => [address, escapeHtml(address).toLowerCase()];
  const keptForms = new Set([...keep].filter((address) => address.includes('@')).flatMap(formsOf));
  // Longest first: of two forms starting at the same place, the longer wins.
  const forms = [...new Set([...[...carried].flatMap(formsOf), ...keptForms])].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`${WHOLE_BEFORE}(?:${forms.map(escapeRegExp).join('|')})${WHOLE_AFTER}`, 'gi');
  return String(html).replace(pattern, (match) => (keptForms.has(match.toLowerCase()) ? match : '…'));
}

/**
 * The studio's configured addresses, lower-cased: the support address, the
 * mail identities (sender, accounting mailbox, each further mailbox's login
 * and sender) and the business contact address. Templates pass them as
 * variables too ({{support_email}}); they are no customer's address. Admin
 * users' addresses are not among them: an admin sets their own without
 * verification, and could otherwise keep a guessed customer address.
 */
async function studioAddresses() {
  // Required here: the mail and profile services load the database.
  const { getSupportEmail, mailIdentities } = require('../services/emailProcessor');
  const { getProfile } = require('../services/businessProfileService');
  const [support, identities, { profile }] = await Promise.all([
    getSupportEmail(), mailIdentities(), getProfile(),
  ]);
  return new Set([
    support, identities.automated, identities.accounting,
    ...identities.mailboxes.flatMap((mailbox) => [mailbox.login, mailbox.sender]),
    profile?.email,
  ].filter(Boolean).map((address) => String(address).trim().toLowerCase()));
}

module.exports = { redactAddresses, redactKnownAddresses, studioAddresses };
