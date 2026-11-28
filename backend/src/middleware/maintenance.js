const { db } = require('../database/db');
const logger = require('../utils/logger');
const { isSocialCrawler } = require('../services/galleryOgService');

// Cache maintenance mode status to avoid DB queries on every request
let maintenanceMode = false;
let lastCheck = 0;
const CACHE_DURATION = 60000; // 1 minute

// Retry configuration for database queries
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second

async function queryWithRetry(queryFn, retries = MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      return await queryFn();
    } catch (error) {
      if (i === retries - 1) {
        throw error;
      }
      
      // Check if it's a connection error that might benefit from retry
      const isConnectionError = 
        error.message?.includes('Connection terminated') ||
        error.message?.includes('ECONNREFUSED') ||
        error.message?.includes('ETIMEDOUT') ||
        error.code === 'ECONNRESET';
      
      if (isConnectionError) {
        logger.warn(`Database connection error, retrying in ${RETRY_DELAY}ms... (attempt ${i + 1}/${retries})`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      } else {
        throw error; // Don't retry non-connection errors
      }
    }
  }
}

async function checkMaintenanceMode() {
  const now = Date.now();
  
  // Use cached value if recent
  if (now - lastCheck < CACHE_DURATION) {
    return maintenanceMode;
  }
  
  try {
    const setting = await queryWithRetry(async () => {
      return await db('app_settings')
        .where('setting_key', 'general_maintenance_mode')
        .where('setting_type', 'general')
        .first();
    });
    
    maintenanceMode = setting ? (setting.setting_value === 'true' || setting.setting_value === true) : false;
    lastCheck = now;
    
    return maintenanceMode;
  } catch (error) {
    logger.error('Error checking maintenance mode after retries:', error.message);
    // Return cached value or false if no cache
    return maintenanceMode;
  }
}

// Middleware to enforce maintenance mode
// The website page location of frontend/nginx.conf, the same shape server.js
// routes to the builder: one slug-shaped segment the app does not own itself
// (a page, a legal page, the not-found page for any other address), while
// the builder is on. ownedByApp is server.js's own decision.
async function isWebsitePagePath(requestPath) {
  const match = require('../services/website/validators').PAGE_PATH_PATTERN.exec(requestPath);
  if (!match || require('../services/website/document').ownedByApp(match[1])) return false;
  return require('./requireFeatureFlag').isFeatureEnabled('websiteBuilder').catch(() => false);
}

async function maintenanceMiddleware(req, res, next) {
  // Skip maintenance check for certain paths. Admin auth MUST work during
  // maintenance — otherwise enabling it locks every admin out, including
  // already-logged-in ones (their /auth/session check would 503 and read as
  // logged-out). These are the REAL endpoints: the admin login + session
  // routes live under /api/auth, NOT /api/admin (the old /api/admin/login
  // entries here matched nothing, which is exactly why the lockout happened).
  const skipPaths = [
    '/api/auth/admin/login',
    // The second factor is part of the same login — without this, any
    // MFA-enrolled admin gets a 503 on the verify step and cannot sign in
    // at all while maintenance mode is on.
    '/api/auth/admin/login/mfa',
    // Passkey login is a third way through the same door (issue 1733).
    '/api/auth/admin/passkey/options',
    '/api/auth/admin/passkey/verify',
    // SSO variants of the admin login (#798) — same reasoning: an SSO-only
    // (JIT-provisioned) admin has no password, so blocking these would make
    // maintenance mode admin-proof for them.
    '/api/auth/admin/sso/login',
    '/api/auth/admin/sso/callback',
    '/api/auth/session',
    '/api/public/settings',
    '/api/public/settings/photo-sales-policy',
    '/health'
  ];
  
  // Allow static assets (uploads, favicons, logos)
  const isStaticAsset = req.path.startsWith('/uploads/') || 
                       req.path.startsWith('/favicons/') || 
                       req.path.startsWith('/logos/');

  // The SPA shell — the HTML document and its bundle, as opposed to an API or a
  // backend-owned static mount. When the backend serves the frontend itself
  // (SERVE_FRONTEND / the all-in-one image, #1042) these requests reach this
  // middleware long before the static block; in the compose stack nginx answers
  // them and they never arrive here at all, which is why neither problem below
  // ever surfaced there.
  //
  // Gating them broke two things. An admin who switched maintenance mode on
  // could not switch it back off: the login endpoints above are exempt, but
  // /admin/login and /assets/* returned 503 JSON, so the page that calls them
  // never loaded. And a guest hitting /gallery/... got that same raw JSON
  // instead of the branded maintenance screen the frontend already ships.
  //
  // Letting the shell through costs nothing: it is inert HTML that boots, calls
  // /api/public/settings (exempt just above) and renders MaintenanceMode on its
  // own. Anything that carries real data stays gated.
  //
  // The split below is not a guess — it mirrors frontend/nginx.conf exactly.
  // Whatever nginx answers from the frontend container never reaches this
  // middleware in a compose deployment, and whatever it proxy_passes does; so
  // exempting precisely the former gives the all-in-one image the same
  // behaviour compose already has, in both directions. The proxied set is
  // small and explicit: /api, /photos, /thumbnails, /fonts, the OG renderer,
  // the /s/ short-link renderer, and the exact paths nginx maps one-to-one —
  // `location = /` hands the site root to the public-CMS handler, and the
  // robots/favicon/apple-touch entries are single `location =` proxies too.
  // Note /og/ and /s/ in particular: those render event names and cover
  // images, so leaving them open would publish gallery metadata from a site
  // that is supposed to be down.
  //
  // The website builder (issue 2618) adds three proxied shapes: /site-media/
  // (its images), `location = /sitemap.xml`, and the page location, every
  // slug-shaped single segment that is not one of the app's own paths (the
  // legal pages included: the website renders them, and the not-found page
  // for any other address). A page is the site root's sibling and is gated
  // like it; while the builder is off
  // the backend owns no such path, so it stays the shell (CMS and not-found
  // pages), exactly as before.
  const BACKEND_RENDERED_PREFIXES = ['/api/', '/photos/', '/thumbnails/', '/fonts/', '/og/', '/s/', '/site-media/'];
  const CRAWLER_RENDERED_PREFIXES = ['/gallery/', '/transfer/', '/transfer-upload/'];
  const BACKEND_RENDERED_EXACT = [
    '/',
    '/robots.txt',
    '/favicon.ico',
    '/apple-touch-icon.png',
    '/apple-touch-icon-precomposed.png',
    '/sitemap.xml'
  ];
  // Express routes case-insensitively, so `/API/gallery/...` still reaches the
  // API router; classify on the lowercased path or that spelling is treated
  // as the SPA shell and walks straight past the gate.
  const requestPath = String(req.path || '').toLowerCase();
  // Crawler hits on share links are rewritten to /og/... by nginx, so compose
  // gates them. Without nginx, server.js renders the same OG card in place on
  // the share path itself — classify it the same way or the all-in-one image
  // publishes gallery/transfer titles from a site that is supposed to be down.
  const isCrawlerShareRender = CRAWLER_RENDERED_PREFIXES.some((prefix) => requestPath.startsWith(prefix))
    && isSocialCrawler(req.headers?.['user-agent']);
  const isBackendRendered = BACKEND_RENDERED_EXACT.includes(requestPath)
    || BACKEND_RENDERED_PREFIXES.some((prefix) => requestPath.startsWith(prefix))
    || isCrawlerShareRender
    || (req.method === 'GET' && await isWebsitePagePath(requestPath));
  const isSpaShell = req.method === 'GET' && !isBackendRendered;
  
  // Allow admin routes if admin is authenticated
  const isAdminRoute = req.path.startsWith('/api/admin');
  const hasAdminAuth = req.headers.authorization?.startsWith('Bearer ');
  
  if (skipPaths.includes(req.path) || isStaticAsset || isSpaShell || (isAdminRoute && hasAdminAuth)) {
    return next();
  }
  
  try {
    const inMaintenance = await checkMaintenanceMode();
    
    if (inMaintenance && !isAdminRoute) {
      return res.status(503).json({
        error: 'Service Unavailable',
        message: 'The system is currently undergoing maintenance. Please try again later.',
        maintenance: true
      });
    }
  } catch (error) {
    // If we can't check maintenance mode, allow the request to proceed
    logger.error('Failed to check maintenance mode, allowing request:', error.message);
  }
  
  next();
}

// Function to clear cache when settings change
function clearMaintenanceCache() {
  lastCheck = 0;
}

module.exports = { maintenanceMiddleware, clearMaintenanceCache };
