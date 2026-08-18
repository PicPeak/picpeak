const { db } = require('../database/db');
const logger = require('../utils/logger');

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
    // SSO variants of the admin login (#798) — same reasoning: an SSO-only
    // (JIT-provisioned) admin has no password, so blocking these would make
    // maintenance mode admin-proof for them.
    '/api/auth/admin/sso/login',
    '/api/auth/admin/sso/callback',
    '/api/auth/session',
    '/api/public/settings',
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
  const BACKEND_RENDERED_PREFIXES = ['/api/', '/photos/', '/thumbnails/', '/fonts/', '/og/', '/s/'];
  const BACKEND_RENDERED_EXACT = [
    '/',
    '/robots.txt',
    '/favicon.ico',
    '/apple-touch-icon.png',
    '/apple-touch-icon-precomposed.png'
  ];
  const isBackendRendered = BACKEND_RENDERED_EXACT.includes(req.path)
    || BACKEND_RENDERED_PREFIXES.some((prefix) => req.path.startsWith(prefix));
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