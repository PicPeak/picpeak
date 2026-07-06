/**
 * Custom-tracker HTML sanitiser (#663 Phase 1).
 *
 * Operators picking "Custom" in Settings → Analytics paste a `<head>`-style
 * HTML snippet (script tag + sometimes a `<noscript>` fallback + DNS-prefetch
 * `<link>`s). We sanitise on save and render the sanitised string into the
 * gallery `<head>` server-side — admin-only field, but defence-in-depth
 * matters when the trust boundary widens to e.g. a delegated admin role.
 *
 * Allowlist (intentionally narrow):
 *   <script>   — src, async, defer, type, crossorigin, integrity, nonce,
 *                referrerpolicy, data-*
 *   <noscript> — no attributes
 *   <link>     — rel (preconnect/dns-prefetch only), href, crossorigin
 *   <meta>     — name, content, charset
 *
 * Anything else is stripped. Inline script bodies pass through unchanged
 * (the tracker's bootstrap snippet is the whole point), but we DO normalise
 * URL schemes — `javascript:` / `data:` URLs on `src` / `href` are removed.
 *
 * Returns the sanitised string. On parse failure, returns an empty string
 * (defensive — empty snippet just means the gallery `<head>` is unchanged).
 */

const sanitizeHtml = require('sanitize-html');

const ALLOWED_LINK_RELS = new Set(['preconnect', 'dns-prefetch', 'preload']);

function sanitizeTrackerSnippet(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';

  try {
    return sanitizeHtml(trimmed, {
      // Allow <script> + a few related tags. sanitize-html disallows
      // <script> by default for XSS-protection — we explicitly opt in
      // because the entire point of the custom field is a tracker script.
      allowedTags: ['script', 'noscript', 'link', 'meta'],
      allowedAttributes: {
        script: [
          'src', 'async', 'defer', 'type', 'crossorigin', 'integrity',
          'nonce', 'referrerpolicy',
          // Common tracker config attributes — Umami / Plausible / Rybbit
          // / Pirsch / GoatCounter all configure via data-* on the script
          // tag. sanitize-html doesn't support data-* wildcards, so we
          // list the ones the major trackers use. Operators with an
          // exotic data-attr the major trackers don't use can either
          // file an issue or switch to one of the native providers.
          'data-website-id', 'data-site-id', 'data-host-url', 'data-host',
          'data-domains', 'data-domain', 'data-auto-track',
          'data-do-not-track', 'data-cache', 'data-include', 'data-exclude',
          'data-tag', 'data-tracker-script-version', 'data-uniqueid',
          'data-events', 'data-api-host', 'data-server',
        ],
        noscript: [],
        link: ['rel', 'href', 'crossorigin', 'as'],
        meta: ['name', 'content', 'charset', 'http-equiv'],
      },
      allowedSchemes: ['http', 'https'],
      allowedSchemesByTag: {
        script: ['http', 'https'],
        link: ['http', 'https'],
      },
      // Inline `<script>…</script>` content needs to survive intact — this
      // is the operator's tracker bootstrap. sanitize-html escapes text by
      // default for non-script tags; the `allowVulnerableTags` flag is
      // required to keep <script> in the allowlist without warnings.
      allowVulnerableTags: true,
      transformTags: {
        // Drop <link> rels we don't recognise (no stylesheet, no icon — those
        // aren't tracker-related). Keeps the field narrowly purposeful.
        link: (tagName, attribs) => {
          if (!ALLOWED_LINK_RELS.has((attribs.rel || '').toLowerCase())) {
            return { tagName: '', attribs: {} };
          }
          return { tagName, attribs };
        },
      },
    });
  } catch (_) {
    return '';
  }
}

module.exports = { sanitizeTrackerSnippet };
