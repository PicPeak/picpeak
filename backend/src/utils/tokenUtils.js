const ADMIN_COOKIE_NAME = 'admin_token';
const GALLERY_COOKIE_NAME = 'gallery_token';
const GALLERY_COOKIE_PREFIX = 'gallery_token_';
const GUEST_COOKIE_PREFIX = 'guest_token_';
// Customer-account session cookie (#354). Distinct name from the admin
// cookie so a single browser can hold both an admin and a customer
// session without one clobbering the other (e.g. for the admin
// dogfooding the customer dashboard).
const CUSTOMER_COOKIE_NAME = 'customer_token';

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Cookie "Secure" flag mode:
 *   - true   → always set Secure (HTTPS-only — cookie won't be sent over HTTP at all)
 *   - false  → never set Secure (allow plain HTTP — cookie has no in-flight protection)
 *   - 'auto' → decide per-request based on req.secure (X-Forwarded-Proto
 *              via Express `trust proxy`). Emits Secure when actual HTTPS is
 *              detected, omits it on plain HTTP. This is the right default
 *              for deployments reachable via both HTTPS (reverse proxy) and
 *              LAN HTTP, and for first-time installs that haven't set up a
 *              reverse proxy yet.
 *
 * Default:
 *   - production → 'auto'  (#427: previously hard `true`, which caused silent
 *                  login loops over HTTP because the browser drops the
 *                  Secure cookie. 'auto' is strictly more lenient than `true`
 *                  on real HTTPS — req.secure is true → Secure flag still
 *                  emitted — so this is not a security regression for
 *                  reverse-proxy deployments. Users who explicitly want the
 *                  HTTPS-only behaviour can still set COOKIE_SECURE=true.)
 *   - dev → false (allow http://localhost in browsers without HSTS gymnastics)
 */
const secureCookieMode = (() => {
  const raw = typeof process.env.COOKIE_SECURE === 'string'
    ? process.env.COOKIE_SECURE.toLowerCase()
    : '';
  if (raw === 'auto') return 'auto';
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  // No env var set → infer from NODE_ENV. Production defaults to 'auto'
  // (per-request) rather than hard `true` so first-time HTTP installs don't
  // silently fail (#427).
  return process.env.NODE_ENV === 'production' ? 'auto' : false;
})();
const sameSiteDefault = process.env.COOKIE_SAMESITE || 'Lax';
const cookieDomain = process.env.COOKIE_DOMAIN;

/**
 * Resolve the Secure flag for a specific response. When in 'auto' mode,
 * checks req.secure (which reflects the X-Forwarded-Proto header when the
 * proxy is in the trust list set by `app.set('trust proxy', ...)`). When
 * called without a `res`, falls back to false — this only happens in code
 * paths that don't yet have a response object, which we avoid.
 */
function resolveSecureFlag(res) {
  if (secureCookieMode === 'auto') {
    return Boolean(res?.req?.secure);
  }
  return secureCookieMode;
}

function buildCookieBaseOptions(res) {
  const options = {
    httpOnly: true,
    secure: resolveSecureFlag(res),
    sameSite: sameSiteDefault,
    path: '/',
  };

  if (cookieDomain) {
    options.domain = cookieDomain;
  }

  return options;
}

function buildCookieOptionsWithExpiry(res, maxAgeMs = DEFAULT_MAX_AGE_MS) {
  return {
    ...buildCookieBaseOptions(res),
    maxAge: maxAgeMs,
  };
}

/**
 * Options for clearing a cookie. We deliberately omit `secure` here: when
 * a cookie was set over HTTPS (Secure=true) and we later need to clear it
 * from a response on an HTTP path (or vice versa, in mixed-protocol
 * deployments with COOKIE_SECURE=auto), specifying `secure` in the clear
 * options causes some browsers to reject the Set-Cookie delete header.
 * Browsers match the cookie by (name, domain, path) for deletion, so
 * leaving Secure off produces a header the browser always accepts.
 */
function buildClearCookieOptions() {
  const options = {
    httpOnly: true,
    sameSite: sameSiteDefault,
    path: '/',
  };

  if (cookieDomain) {
    options.domain = cookieDomain;
  }

  return options;
}

function sanitizeSlugForCookie(slug = '') {
  return String(slug).replace(/[^A-Za-z0-9_-]/g, '_');
}

function setAdminAuthCookie(res, token) {
  if (!token) return;
  res.cookie(ADMIN_COOKIE_NAME, token, buildCookieOptionsWithExpiry(res));
}

function clearAdminAuthCookie(res) {
  res.clearCookie(ADMIN_COOKIE_NAME, buildClearCookieOptions());
}

function setCustomerAuthCookie(res, token) {
  if (!token) return;
  res.cookie(CUSTOMER_COOKIE_NAME, token, buildCookieOptionsWithExpiry(res));
}

function clearCustomerAuthCookie(res) {
  res.clearCookie(CUSTOMER_COOKIE_NAME, buildClearCookieOptions());
}

function setGalleryAuthCookies(res, token, slug) {
  if (!token) return;
  const options = buildCookieOptionsWithExpiry(res);
  res.cookie(GALLERY_COOKIE_NAME, token, options);
  if (slug) {
    const cookieName = `${GALLERY_COOKIE_PREFIX}${sanitizeSlugForCookie(slug)}`;
    res.cookie(cookieName, token, options);
  }
}

function clearGalleryAuthCookies(res, slug) {
  const clearOptions = buildClearCookieOptions();
  res.clearCookie(GALLERY_COOKIE_NAME, clearOptions);

  const cookies = res.req?.cookies || {};

  if (slug) {
    const cookieName = `${GALLERY_COOKIE_PREFIX}${sanitizeSlugForCookie(slug)}`;
    res.clearCookie(cookieName, clearOptions);
  } else {
    Object.keys(cookies).forEach((name) => {
      if (name.startsWith(GALLERY_COOKIE_PREFIX)) {
        res.clearCookie(name, clearOptions);
      }
    });
  }
}

function getAdminTokenFromRequest(req) {
  const header = req.headers?.authorization;
  if (header && header.startsWith('Bearer ')) {
    return header.substring(7);
  }
  return req.cookies?.[ADMIN_COOKIE_NAME] || null;
}

/**
 * Customer JWT (#354). Cookie-only — deliberately no Authorization
 * header fallback so an admin Bearer token attached by the shared
 * events.service.ts auto-auth path can't accidentally satisfy a
 * customer-only endpoint and trigger "wrong token type" downstream.
 */
function getCustomerTokenFromRequest(req) {
  return req.cookies?.[CUSTOMER_COOKIE_NAME] || null;
}

function getGalleryTokenFromRequest(req, slug) {
  const header = req.headers?.authorization;
  if (header && header.startsWith('Bearer ')) {
    return header.substring(7);
  }

  if (!req.cookies) {
    return null;
  }

  if (slug) {
    const cookieName = `${GALLERY_COOKIE_PREFIX}${sanitizeSlugForCookie(slug)}`;
    if (req.cookies[cookieName]) {
      return req.cookies[cookieName];
    }
  }

  if (req.cookies[GALLERY_COOKIE_NAME]) {
    return req.cookies[GALLERY_COOKIE_NAME];
  }

  const prefixed = Object.keys(req.cookies).find((name) => name.startsWith(GALLERY_COOKIE_PREFIX));
  if (prefixed) {
    return req.cookies[prefixed];
  }

  return null;
}

function getGuestTokenFromRequest(req, slug) {
  // Primary transport: custom header (set by frontend axios interceptor).
  const headerToken = req.headers?.['x-guest-token'];
  if (headerToken) {
    return headerToken;
  }

  if (!req.cookies) {
    return null;
  }

  if (slug) {
    const cookieName = `${GUEST_COOKIE_PREFIX}${sanitizeSlugForCookie(slug)}`;
    if (req.cookies[cookieName]) {
      return req.cookies[cookieName];
    }
  }

  const prefixed = Object.keys(req.cookies).find((name) => name.startsWith(GUEST_COOKIE_PREFIX));
  if (prefixed) {
    return req.cookies[prefixed];
  }

  return null;
}

module.exports = {
  ADMIN_COOKIE_NAME,
  GALLERY_COOKIE_NAME,
  GALLERY_COOKIE_PREFIX,
  GUEST_COOKIE_PREFIX,
  CUSTOMER_COOKIE_NAME,
  sanitizeSlugForCookie,
  setAdminAuthCookie,
  clearAdminAuthCookie,
  setCustomerAuthCookie,
  clearCustomerAuthCookie,
  setGalleryAuthCookies,
  clearGalleryAuthCookies,
  getAdminTokenFromRequest,
  getCustomerTokenFromRequest,
  getGalleryTokenFromRequest,
  getGuestTokenFromRequest,
};
