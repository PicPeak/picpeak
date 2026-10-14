const jwt = require('jsonwebtoken');
const { db } = require('../database/db');
const access = require('./galleryAccessService');
const {
  GALLERY_COOKIE_NAME,
  GALLERY_COOKIE_PREFIX,
  sanitizeSlugForCookie,
  setGalleryAuthCookies,
  buildClearCookieOptions,
} = require('../utils/tokenUtils');

function verifyGalleryJwt(token) {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'], issuer: 'picpeak-auth' });
    return decoded?.type === 'gallery' ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * Carry a gallery session over a rename.
 *
 * Renaming a gallery changes its slug, but a visitor's gallery token names the
 * old slug (`eventSlug`) and sits in the `gallery_token_<old-slug>` cookie, so
 * opening the gallery at its new slug found no session and asked for the
 * password again.
 *
 * Called by the session check for `slug`. When the request holds no token for
 * that slug but does hold one for the same gallery under an earlier slug, the
 * token is checked exactly like a live session for this gallery (lifecycle,
 * revocation, cutoff, gallery password change, customer assignment) and then
 * signed again with only `eventSlug` changed: same jti, iat and exp, so it
 * lives no longer than the original, a revocation of either revokes both, and
 * a later password change still refuses it. The new token is set the way the
 * login routes set one and the old slug's cookie is cleared. The session
 * check also hands it back in its answer, so the page replaces a stale token
 * it may still keep for this slug (a Bearer header wins over the cookie).
 *
 * The same search also looks past a dead token that already names the slug
 * (revoked, cut off, another gallery's): the first candidate that authorizes
 * for this gallery wins, and is handed back like a carried one.
 *
 * Returns the token to use for this request, or null to keep `current`.
 */
async function carryRenamedGallerySession(req, res, slug, current) {
  if (typeof slug !== 'string' || !slug) return null;

  const cookies = req.cookies || {};
  const candidates = [...new Set([
    current,
    cookies[GALLERY_COOKIE_NAME],
    ...Object.keys(cookies).filter((name) => name.startsWith(GALLERY_COOKIE_PREFIX)).map((name) => cookies[name]),
  ].filter((token) => typeof token === 'string' && token))];
  const sessions = candidates.map((token) => ({ token, decoded: verifyGalleryJwt(token) }))
    .filter(({ decoded }) => decoded);
  // Nothing to carry over (every token names this slug) and nothing to look
  // past (no token besides the one in use). Tokens that all name this slug
  // still go through the search below, so a revoked one the page keeps
  // sending as a Bearer does not hide a live cookie.
  if (!sessions.some(({ token, decoded }) => decoded.eventSlug !== slug || token !== current)) return null;

  const event = await db('events').where({ slug }).select('*').first();
  if (!event) return null;

  // The first live session of this gallery wins; one already naming this slug
  // is used as it is. A revoked token, or one of another gallery that held
  // this slug before, does not stop the search.
  for (const { token, decoded } of sessions) {
    if (Number(decoded.eventId) !== Number(event.id)) continue;
    try {
      await access.authorize(event, access.grant(event, 'gallery', decoded));
    } catch {
      continue;
    }
    if (decoded.eventSlug === slug) return token === current ? null : token;

    const renewed = jwt.sign({ ...decoded, eventSlug: event.slug }, process.env.JWT_SECRET, { algorithm: 'HS256' });
    // Only the cookie holding this very token: another gallery may own the
    // old slug's cookie name by now (slug reuse, sanitized-name collision).
    const oldCookie = typeof decoded.eventSlug === 'string'
      ? `${GALLERY_COOKIE_PREFIX}${sanitizeSlugForCookie(decoded.eventSlug)}` : null;
    if (oldCookie && oldCookie !== `${GALLERY_COOKIE_PREFIX}${sanitizeSlugForCookie(event.slug)}`
      && cookies[oldCookie] === token) {
      res.clearCookie(oldCookie, buildClearCookieOptions());
    }
    setGalleryAuthCookies(res, renewed, event.slug);
    return renewed;
  }
  return null;
}

module.exports = { carryRenamedGallerySession };
