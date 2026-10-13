const { requestLogPath } = require('../utils/requestLogPath');
const rateLimit = require('express-rate-limit');
const { MemoryStore } = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { getAdminTokenFromRequest, getGalleryTokenFromRequest } = require('../utils/tokenUtils');
const { rateLimitKey } = require('../utils/rateLimitKey');
const { verifyLiveAdminJwt } = require('../utils/liveAdminSession');

// What applies when app_settings has no row for a key — a fresh install has
// none. Keyed by setting name so the admin settings read can surface the
// same values (#1337): the Security tab must show the budget that is in
// force, not an empty field that hides it.
const RATE_LIMIT_DEFAULTS = Object.freeze({
  rate_limit_enabled: true,
  rate_limit_window_minutes: 15,
  rate_limit_max_requests: 300,
  rate_limit_auth_max_requests: 5,
  rate_limit_skip_authenticated: true,
  rate_limit_public_endpoints_only: false
});

// Cache for rate limit settings
let settingsCache = null;
let cacheExpiry = 0;
const CACHE_DURATION = 60000; // 1 minute cache

/**
 * Get rate limit settings from database with caching
 */
async function getRateLimitSettings() {
  try {
    // Check cache
    if (settingsCache && Date.now() < cacheExpiry) {
      return settingsCache;
    }

    // Fetch from database
    const settings = await db('app_settings')
      .whereIn('setting_key', [
        'rate_limit_enabled',
        'rate_limit_window_minutes',
        'rate_limit_max_requests',
        'rate_limit_auth_max_requests',
        'rate_limit_skip_authenticated',
        'rate_limit_public_endpoints_only'
      ]);

    // Parse settings into object.
    //
    // maxRequests: 300 per 15-minute window, per IP, counting only requests
    // that carry no admin/gallery token (skipAuthenticated). The general
    // limiter was inert from the day it was written (see apiRateLimitGate),
    // so its original 100 had never been exercised against real traffic. A
    // gallery landing page makes a handful of unauthenticated calls before
    // the password is typed; at 100, a venue wifi NAT reached 429 after
    // roughly twenty guests per window. An explicit app_settings value still
    // wins over this fallback.
    const config = {
      enabled: RATE_LIMIT_DEFAULTS.rate_limit_enabled,
      windowMinutes: RATE_LIMIT_DEFAULTS.rate_limit_window_minutes,
      maxRequests: RATE_LIMIT_DEFAULTS.rate_limit_max_requests,
      authMaxRequests: RATE_LIMIT_DEFAULTS.rate_limit_auth_max_requests,
      skipAuthenticated: RATE_LIMIT_DEFAULTS.rate_limit_skip_authenticated,
      publicEndpointsOnly: RATE_LIMIT_DEFAULTS.rate_limit_public_endpoints_only
    };

    settings.forEach(setting => {
      const value = JSON.parse(setting.setting_value);
      switch (setting.setting_key) {
      case 'rate_limit_enabled':
        config.enabled = value;
        break;
      case 'rate_limit_window_minutes':
        config.windowMinutes = value;
        break;
      case 'rate_limit_max_requests':
        config.maxRequests = value;
        break;
      case 'rate_limit_auth_max_requests':
        config.authMaxRequests = value;
        break;
      case 'rate_limit_skip_authenticated':
        config.skipAuthenticated = value;
        break;
      case 'rate_limit_public_endpoints_only':
        config.publicEndpointsOnly = value;
        break;
      }
    });

    // Update cache
    settingsCache = config;
    cacheExpiry = Date.now() + CACHE_DURATION;

    return config;
  } catch (error) {
    logger.error('Failed to fetch rate limit settings:', error);
    // Return defaults on error
    return {
      enabled: true,
      windowMinutes: 15,
      maxRequests: 300,
      authMaxRequests: 5,
      skipAuthenticated: true,
      publicEndpointsOnly: false
    };
  }
}

/**
 * Clear settings cache (call when settings are updated)
 */
function clearSettingsCache() {
  settingsCache = null;
  cacheExpiry = 0;
}

/**
 * Check if request has valid authentication
 */
async function isAuthenticated(req) {
  try {
    const slugMatch = req.path.match(/\/api\/gallery\/([^/]+)/);
    const slug = slugMatch ? slugMatch[1] : req.requestedSlug;
    const token = getAdminTokenFromRequest(req) || getGalleryTokenFromRequest(req, slug);
    // Same checks the auth middleware applies — signature, revocation,
    // cutoff, active account, password change, idle timeout: a token that
    // would not pass adminAuth must not buy an unlimited budget either.
    //
    // Only an admin session earns the skip. A gallery token is minted for
    // free on password-less galleries and slideshow links, so treating it as
    // "authenticated" handed anyone an unlimited budget on every /api route.
    // The one thing a gallery token does buy is its own gallery's images —
    // see isOwnGalleryImageRequest below.
    const decoded = await verifyLiveAdminJwt(token);
    if (!decoded) {
      return false;
    }
    req.tokenType = decoded.type;
    req.tokenPayload = decoded;

    return true;
  } catch (error) {
    return false;
  }
}

// The routes a gallery viewer fetches once per tile: thumbnail, preview,
// hero, photo. Downloads, the photo list, feedback and everything else stay
// on the budget. An adaptive stream (issue 1733) is one video fetched as a
// playlist and a segment every six seconds: the same playback the photo
// route serves in one request, so it is exempt the same way.
const GALLERY_IMAGE_RE = /^\/api\/gallery\/([^/]+)\/(?:(?:thumbnail|preview|hero|photo)\/[^/]+|hls\/\d+\/(?:master\.m3u8|[^/]+\/[^/]+))$/i;

/**
 * A verified gallery viewer fetching that gallery's own images (#1287).
 *
 * Since gallery tokens stopped earning the authenticated skip, every guest
 * has been spending the anonymous per-IP budget — 300 requests per 15
 * minutes by default — on the gallery's thumbnails. A 546-photo grid runs
 * out of budget mid-scroll: the remaining tiles come back 429, which the
 * frontend rendered as blank tiles with no error, and the next refresh
 * finds the photo list rate-limited too. A per-IP limit that one legitimate
 * viewer exhausts on one gallery protects nothing.
 *
 * So a token that verifies AND names the gallery in the path is exempt on
 * the image routes only. The token proves the viewer passed whatever gate
 * the gallery has (the gate itself is still limited), the slug check stops a
 * token for one gallery buying images from another, and GET-only keeps every
 * write on the budget. The bandwidth these routes cost was never something a
 * 300-request budget bounded — a viewer can refetch a cached thumbnail 300
 * times too — so nothing is given up here that the budget actually held.
 */
function isOwnGalleryImageRequest(req) {
  if (req.method && req.method !== 'GET') return false;
  const match = (req.path || '').match(GALLERY_IMAGE_RE);
  return Boolean(match) && hasOwnGalleryToken(req, match[1]);
}

/** A gallery token that verifies and names `slug`. */
function hasOwnGalleryToken(req, slug) {
  try {
    const token = getGalleryTokenFromRequest(req, slug);
    if (!token) return false;
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'], issuer: 'picpeak-auth' });
    return Boolean(decoded) && typeof decoded === 'object'
      && decoded.type === 'gallery' && decoded.eventSlug === slug;
  } catch (error) {
    return false;
  }
}

// What a viewer's browser asks for while they look through a gallery and pick
// photos: the photo list, per-photo feedback (reads and writes), the bulk
// rating of a selection, their own picks, the gallery's info, and the view
// beacon the lightbox posts for every slide. Downloads, uploads and the
// password check are not in the list and stay on the ordinary budget.
const GALLERY_VIEWER_RE = /^\/api\/gallery\/([^/]+)\/(?:(?:photos|my-feedback|feedback-summary|feedback-settings|info|stats|people)(?:\/|$)|photo\/[^/]+\/view\/?$|feedback\/bulk\/?$)/i;
const GALLERY_VIEWER_BUDGET_FACTOR = 10;
// The live-refresh poll (issue 1733, C5) counts in a bucket of its own, the
// same size: every open tab behind one address polls every 20 seconds, and in
// the viewer bucket a full venue on one WiFi address spent the budget that
// likes and reloads need. Here an exhausted budget only slows the polling.
const GALLERY_POLL_RE = /^\/api\/gallery\/[^/]+\/photos\/state\/?$/i;

/**
 * A verified gallery viewer working in that gallery (issue 1891).
 *
 * The lightbox reads one photo's feedback per slide and a like is a write
 * plus a read, so one guest choosing from a 1,500-photo gallery spends the
 * default 300 requests per 15 minutes on their own. After that every request
 * answers 429 until the window ends, the next like and the next sign-in
 * included, and the guest sees a heart that does nothing.
 *
 * Unlike the image routes these include writes, so they are not exempt: they
 * count against a budget of their own, GALLERY_VIEWER_BUDGET_FACTOR times
 * rate_limit_max_requests, in a bucket of their own (the limiter's keyGenerator). The
 * per-action limits in feedbackRateLimit.js stay the real guard on writes.
 * Same token and slug rule as isOwnGalleryImageRequest. Memoized: the limiter
 * asks twice per request.
 */
function isOwnGalleryViewerRequest(req) {
  if (req.ownGalleryViewerRequest === undefined) {
    const match = (req.path || '').match(GALLERY_VIEWER_RE);
    req.ownGalleryViewerRequest = Boolean(match) && hasOwnGalleryToken(req, match[1]);
  }
  return req.ownGalleryViewerRequest;
}

/**
 * Whether this request counts against the viewer budget. Rides on the same
 * switch as the image exemption: with skip_authenticated off, a guest's
 * requests are ordinary requests again.
 */
function usesGalleryViewerBudget(req, config) {
  return Boolean(config.skipAuthenticated) && isOwnGalleryViewerRequest(req);
}

/**
 * Determine if rate limiting should be applied to this request
 */
async function shouldSkipRateLimit(req, config) {
  // If rate limiting is disabled globally
  if (!config.enabled) {
    return true;
  }

  // Never skip rate limiting for auth endpoints
  const isAuthEndpoint = req.path.match(/\/(auth|login|gallery\/[^/]+\/verify)$/);
  if (isAuthEndpoint) {
    return false;
  }

  // Check if we should skip authenticated requests. A gallery viewer's own
  // image fetches ride on the same switch: an operator who turns the skip
  // off gets every request counted, guests included.
  if (config.skipAuthenticated && (isOwnGalleryImageRequest(req) || await isAuthenticated(req))) {
    return true;
  }

  // Check if we only rate limit public endpoints
  if (config.publicEndpointsOnly) {
    // Lower-cased: Express routing is case-insensitive by default, so an
    // upper-cased path reaches the same handler and must classify the same way.
    const lowerPath = req.path.toLowerCase();
    const isPublicEndpoint = lowerPath.startsWith('/api/public/') ||
                           lowerPath.startsWith('/api/gallery/') ||
                           isAuthEndpoint;
    return !isPublicEndpoint;
  }

  return false;
}

/**
 * Create dynamic rate limiter
 */
async function createRateLimiter(store = new MemoryStore()) {
  const config = await getRateLimitSettings();
  
  return rateLimit({
    store,
    windowMs: config.windowMinutes * 60 * 1000,
    max: async (req) => {
      // Refresh config for each request
      const currentConfig = await getRateLimitSettings();
      
      // Different limits for auth endpoints
      const isAuthEndpoint = req.path.match(/\/(auth|login|gallery\/[^/]+\/verify)$/);
      if (isAuthEndpoint) return currentConfig.authMaxRequests;
      return usesGalleryViewerBudget(req, currentConfig)
        ? currentConfig.maxRequests * GALLERY_VIEWER_BUDGET_FACTOR
        : currentConfig.maxRequests;
    },
    // A bucket of its own, or the viewer budget would be spent by the
    // anonymous requests of everyone else behind the same address.
    keyGenerator: async (req) => {
      const key = usesGalleryViewerBudget(req, await getRateLimitSettings())
        ? `${GALLERY_POLL_RE.test(req.path || '') ? 'gallery-poll' : 'gallery-viewer'}:${rateLimitKey(req)}` : rateLimitKey(req);
      // Only a counted request gets here, and this is what it was counted
      // under: refundRateLimit gives exactly that back.
      req.rateLimitRefund = () => store.decrement(key);
      return key;
    },
    skip: async (req) => {
      const currentConfig = await getRateLimitSettings();
      return await shouldSkipRateLimit(req, currentConfig);
    },
    handler: (req, res) => {
      const clientIp = req.ip;
      
      // Enhanced logging for production analysis
      logger.warn('Rate limit exceeded', {
        ip: clientIp,
        path: requestLogPath(req.originalUrl || req.path),
        method: req.method,
        // Set by isAuthenticated during the skip check; a limited request
        // never carried a live admin session.
        authenticated: req.tokenType === 'admin',
        tokenType: req.tokenType,
        userAgent: req.headers['user-agent'],
        origin: req.headers['origin'],
        timestamp: new Date().toISOString(),
        headers: {
          'x-forwarded-for': req.headers['x-forwarded-for'],
          'x-real-ip': req.headers['x-real-ip']
        },
        requestUrl: requestLogPath(req.originalUrl || req.path),
        rateLimitInfo: {
          limit: req.rateLimit?.limit,
          current: req.rateLimit?.current,
          remaining: req.rateLimit?.remaining,
          resetTime: req.rateLimit?.resetTime ? new Date(req.rateLimit.resetTime).toISOString() : null
        }
      });
      
      res.status(429).json({ 
        error: 'Too many requests, please try again later.',
        retryAfter: res.getHeader('Retry-After')
      });
    },
    standardHeaders: true, // Return rate limit info in headers
    legacyHeaders: false, // Disable X-RateLimit headers
  });
}

/**
 * Create auth-specific rate limiter
 *
 * This is a separate rateLimit() instance from createRateLimiter(), so it owns
 * its own MemoryStore and therefore its own per-IP bucket. That separation is
 * the point: the credential endpoints get a small budget of their own that the
 * ordinary /api traffic a login page makes cannot exhaust.
 *
 * skipSuccessfulRequests means only failed attempts are counted, which is what
 * makes a 5-per-window per-IP budget safe behind NAT — a room full of guests on
 * one venue IP who all type the correct gallery password consume nothing.
 */
async function createAuthRateLimiter(store = new MemoryStore()) {
  const config = await getRateLimitSettings();

  return rateLimit({
    store,
    windowMs: config.windowMinutes * 60 * 1000,
    // Read per request, like the general limiter, so a change to
    // rate_limit_auth_max_requests in admin Settings takes effect within the
    // settings cache TTL instead of needing a restart.
    max: async () => {
      const currentConfig = await getRateLimitSettings();
      return currentConfig.authMaxRequests;
    },
    skipSuccessfulRequests: true,
    keyGenerator: rateLimitKey,
    skip: async () => {
      const currentConfig = await getRateLimitSettings();
      return !currentConfig.enabled;
    },
    handler: (req, res) => {
      const clientIp = req.ip;
      
      // Enhanced logging for auth failures
      logger.warn('Auth rate limit exceeded', {
        ip: clientIp,
        path: requestLogPath(req.originalUrl || req.path),
        method: req.method,
        userAgent: req.headers['user-agent'],
        timestamp: new Date().toISOString(),
        headers: {
          'x-forwarded-for': req.headers['x-forwarded-for'],
          'x-real-ip': req.headers['x-real-ip']
        },
        requestUrl: requestLogPath(req.originalUrl || req.path),
        authType: req.path.includes('admin') ? 'admin' : 'gallery',
        rateLimitInfo: {
          limit: req.rateLimit?.limit,
          current: req.rateLimit?.current,
          remaining: req.rateLimit?.remaining,
          resetTime: req.rateLimit?.resetTime ? new Date(req.rateLimit.resetTime).toISOString() : null
        }
      });
      
      res.status(429).json({ 
        error: 'Too many authentication attempts, please try again later.',
        retryAfter: res.getHeader('Retry-After')
      });
    },
    standardHeaders: true,
    legacyHeaders: false,
  });
}

// The live limiter instances. express-rate-limit fixes windowMs when an
// instance is built — max and skip re-read the settings per request, the
// window does not — so a saved window only takes effect on a rebuild. The
// gates in server.js resolve the instance per request through the getters
// below, and the settings route rebuilds after a save (#1337). Rebuilding
// starts fresh counters; on a settings change that is acceptable.
//
// The stores are held explicitly because a MemoryStore runs a cleanup
// interval for as long as it exists: dropping the limiter reference alone
// would leave one more live timer and one more retained store per save.
const current = { general: null, auth: null, stores: [] };

async function initializeRateLimiters() {
  const stores = [new MemoryStore(), new MemoryStore()];
  const general = await createRateLimiter(stores[0]);
  const auth = await createAuthRateLimiter(stores[1]);
  const superseded = current.stores;
  current.general = general;
  current.auth = auth;
  current.stores = stores;
  for (const store of superseded) {
    if (typeof store.shutdown === 'function') store.shutdown();
  }
  return current;
}

/**
 * Give a counted request its slot back. For a route whose one user action is
 * many requests and that has just authorised this one itself: a segment of
 * an adaptive video stream (issue 1733) is fetched every six seconds, by
 * viewers of a public gallery too, who carry no token the limiter could have
 * skipped on. The limiter still counts first, so a request the route refuses
 * (wrong gallery, hidden photo, bad name) is never refunded, and an address
 * already over its budget is stopped before it gets here. Once per request;
 * a no-op for a request the limiter skipped or never saw.
 */
function refundRateLimit(req) {
  const refund = req.rateLimitRefund;
  if (!refund) return;
  req.rateLimitRefund = null;
  Promise.resolve().then(refund).catch((error) => logger.warn('Rate limit refund failed', { error: error.message }));
}

const getGeneralLimiter = () => current.general;
const getAuthLimiter = () => current.auth;

module.exports = {
  RATE_LIMIT_DEFAULTS,
  initializeRateLimiters,
  getGeneralLimiter,
  getAuthLimiter,
  getRateLimitSettings,
  clearSettingsCache,
  createRateLimiter,
  createAuthRateLimiter,
  isAuthenticated,
  isOwnGalleryImageRequest,
  isOwnGalleryViewerRequest,
  GALLERY_VIEWER_BUDGET_FACTOR,
  shouldSkipRateLimit,
  refundRateLimit
};
