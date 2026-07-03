/**
 * Identity-preserving email normalization options for express-validator.
 *
 * express-validator's `.normalizeEmail()` defaults to provider-specific
 * "canonicalization" — Gmail dot-stripping, +tag stripping, googlemail
 * → gmail domain folding, etc. That's appropriate for *deduplication*
 * (treating the same mailbox as the same identity for, say, a free-tier
 * abuse check) but it's wrong for *identity* (the user expects to log
 * in with the exact address they were invited with).
 *
 * PicPeak uses email as a login identifier across admin users, customer
 * accounts, and customer-portal invitations. Stripping dots/+tags
 * silently means an invitation sent to `john.doe@gmail.com` is stored
 * as `johndoe@gmail.com`, and the user then can't log in with the
 * address they were given — see #574.
 *
 * Use this options object on every `.normalizeEmail()` call. The only
 * default left enabled is `all_lowercase` (true by default), which is
 * safe — local-parts are case-insensitive in practice on every major
 * provider, and lowercasing keeps login lookup consistent.
 */
// NOT Object.frozen — validator.js's `merge()` mutates the options
// object to add its own defaults (notably `all_lowercase: true`).
// Freezing would crash at the first call site. The mutation is
// idempotent (validator only adds keys it has defaults for, not ones
// we already set), so subsequent calls reuse the same enriched object.
const IDENTITY_PRESERVING_NORMALIZE_EMAIL = {
  gmail_remove_dots: false,
  gmail_remove_subaddress: false,
  gmail_convert_googlemaildotcom: false,
  outlookdotcom_remove_subaddress: false,
  yahoo_remove_subaddress: false,
  icloud_remove_subaddress: false,
};

module.exports = { IDENTITY_PRESERVING_NORMALIZE_EMAIL };
