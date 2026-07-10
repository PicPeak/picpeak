/**
 * URL-safe slug generation shared across event, archive, and v1 upload
 * routes (#525 follow-up to #502). Previously every caller had its own
 * inline `name.toLowerCase().replace(/[^a-z0-9]/g, '-')` pipeline, each
 * with the same latent bug: JS's `\w` and the ASCII alphanumeric class
 * silently drop non-ASCII letters instead of transliterating them
 * (`Decoração` → `decorao`, `Família` → `f-mlia`).
 *
 * Fix mirrors #502: NFD-normalize so accented characters split into a
 * base letter + combining mark, then strip the combining-mark range
 * (U+0300–U+036F) so the ASCII base survives. Single regex pass after
 * that — `[^a-z0-9]+` collapses any run of non-alphanumerics into one
 * dash, no separate collapse step needed.
 *
 * For pure-ASCII input the output is byte-identical to the previous
 * inline pipelines, so existing slugs continue to round-trip cleanly
 * via lookups; only new inserts with non-ASCII names start producing
 * the corrected slugs.
 *
 * Not exported as the default category slug — `adminCategories.js`
 * intentionally preserves underscores (the legacy category pipeline
 * used `\w` not `[a-z0-9]`), so changing it here would silently shift
 * "wedding_party" → "wedding-party" on new inserts. Categories keep
 * their own pipeline as fixed in #502.
 */
function slugify(input) {
  return String(input ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

module.exports = { slugify };
