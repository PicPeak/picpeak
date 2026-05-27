require('dotenv').config();

// Validate critical environment variables before proceeding
const { validateEnvironment } = require('./src/config/validateEnv');
validateEnvironment();

// Initialize logger early to capture startup logs
const logger = require('./src/utils/logger');
logger.info('Server starting up', {
  nodeVersion: process.version,
  environment: process.env.NODE_ENV || 'development',
  timestamp: new Date().toISOString()
});

const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const { initializeDatabase, db } = require('./src/database/db');
const { startFileWatcher } = require('./src/services/fileWatcher');
const { startExpirationChecker } = require('./src/services/expirationChecker');
const { initializeTransporter, startEmailQueueProcessor } = require('./src/services/emailProcessor');
const { startBackupService } = require('./src/services/backupService');
const { startScheduledBackups } = require('./src/services/databaseBackup');
const backgroundProcessor = require('./src/services/backgroundProcessor');
const { maintenanceMiddleware } = require('./src/middleware/maintenance');
const { sessionTimeoutMiddleware } = require('./src/middleware/sessionTimeout');
const { errorHandler, notFoundHandler } = require('./src/middleware/errorHandler');
const { createRateLimiter, createAuthRateLimiter } = require('./src/services/rateLimitService');
const { getPublicSitePayload } = require('./src/services/publicSiteService');
const cookieParser = require('cookie-parser');
const {
  getAdminTokenFromRequest,
  getGalleryTokenFromRequest,
} = require('./src/utils/tokenUtils');

// Import routes
const authRoutes = require('./src/routes/auth');
const eventRoutes = require('./src/routes/events');
const galleryRoutes = require('./src/routes/gallery');
const adminRoutes = require('./src/routes/admin');
const adminAuthRoutes = require('./src/routes/adminAuth');
const secureImagesRoutes = require('./src/routes/secureImages');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy headers (required for Traefik/nginx)
// Set to specific number of proxies or loopback to be more secure
app.set('trust proxy', 'loopback, linklocal, uniquelocal');

// Security middleware with custom CSP
// In native HTTP installs, do NOT force HTTPS for subresources.
const enableHsts = process.env.ENABLE_HSTS === 'true';
const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: [
    "'self'",
    'https://www.google.com',
    'https://www.gstatic.com'
  ],
  styleSrc: ["'self'", "'unsafe-inline'", "https:"], // Required for styled components
  imgSrc: ["'self'", "data:", "https:", "blob:"], // Allow data URLs and external images
  connectSrc: ["'self'", 'https://www.google.com', 'https://www.gstatic.com'], // API connections
  fontSrc: ["'self'", "https:", "data:"], // Web fonts
  objectSrc: ["'none'"], // Disable plugins
  mediaSrc: ["'self'"], // Audio/video
  frameSrc: ["'self'", 'https://www.google.com'],
};
// Only upgrade insecure requests when HSTS explicitly enabled (HTTPS deployment)
if (enableHsts) {
  // In helmet, an empty array enables the directive
  cspDirectives.upgradeInsecureRequests = [];
}

app.use(cookieParser());

app.use((req, res, next) => {
  if (req.headers.authorization) {
    return next();
  }

  const path = req.path || '';
  const slugMatch = path.match(/\/api\/(?:gallery|secure-images)\/([^\/]+)/);
  const slug = slugMatch ? slugMatch[1] : req.requestedSlug;
  const adminToken = getAdminTokenFromRequest(req);
  const galleryToken = getGalleryTokenFromRequest(req, slug);

  const isAdminRequest = path.startsWith('/api/admin') || path.startsWith('/admin');
  const isGalleryRequest = Boolean(slugMatch)
    || path.startsWith('/api/gallery')
    || path.startsWith('/gallery')
    || path.startsWith('/api/secure-images');

  // Prefer admin credentials on admin routes so gallery sessions cannot override them.
  if (isAdminRequest) {
    if (adminToken) {
      req.headers.authorization = `Bearer ${adminToken}`;
    }
  } else if (isGalleryRequest) {
    if (galleryToken) {
      req.headers.authorization = `Bearer ${galleryToken}`;
    } else if (adminToken) {
      req.headers.authorization = `Bearer ${adminToken}`;
    }
  } else if (adminToken) {
    req.headers.authorization = `Bearer ${adminToken}`;
  } else if (galleryToken) {
    req.headers.authorization = `Bearer ${galleryToken}`;
  }

  next();
});

app.use(helmet({
  contentSecurityPolicy: {
    // Avoid helmet adding defaults like upgrade-insecure-requests when not desired
    useDefaults: false,
    directives: cspDirectives,
  },
  hsts: enableHsts ? {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true
  } : false,
  permittedCrossDomainPolicies: false,
  referrerPolicy: { policy: "strict-origin-when-cross-origin" }
}));

// Additional security headers
app.use((req, res, next) => {
  // Permissions Policy (controls browser features)
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  next();
});

// CORS configuration (apply only to API routes)
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = [
      process.env.FRONTEND_URL || 'http://localhost:3005',
      process.env.ADMIN_URL || 'http://localhost:3005'
    ];

    // In development, also allow localhost origins
    if (process.env.NODE_ENV === 'development') {
      allowedOrigins.push(
        'http://localhost:5173', // Vite dev server
        'http://localhost:3002', // Backend server
        'http://localhost:3001', // For API testing
        'http://localhost:3000'  // Direct backend access
      );
    }

    // Allow requests with no origin (like curl) and allow-listed origins
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      // Do not error globally; just omit CORS headers on disallowed origins
      callback(null, false);
    }
  },
  credentials: true,
  // Expose Content-Disposition so split (cross-origin) frontend
  // deployments can read the server's chosen download filename. Used
  // by the gallery/admin download flows to honour the #493 "original
  // camera filename" toggle on individual photo downloads (#507).
  exposedHeaders: ['Content-Disposition'],
};

// Only attach CORS to API endpoints, not static assets
app.use('/api', cors(corsOptions));
// Handle preflight explicitly for API paths
app.options('/api/*', cors(corsOptions));

// Initialize rate limiters (they will be created dynamically)
let generalRateLimiter;
let authRateLimiter;

function composeInlineStyles(payload) {
  const { branding } = payload;
  const cssSegments = [];

  cssSegments.push(`:root {
  --brand-primary: ${branding.colors.primary};
  --brand-accent: ${branding.colors.accent};
  --brand-background: ${branding.colors.background};
  --brand-text: ${branding.colors.text};
  --brand-surface: ${branding.colors.surface || '#ffffff'};
  --brand-elevated: ${branding.colors.elevated || '#f5f5f5'};
  --brand-border: ${branding.colors.border || '#e5e5e5'};
  --brand-muted-text: ${branding.colors.mutedText || '#737373'};
}`);

  if (payload.baseCss) {
    cssSegments.push(payload.baseCss);
  }

  if (payload.css) {
    cssSegments.push(`/* Custom styles */\n${payload.css}`);
  }

  return cssSegments.join('\n\n');
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderBrandHeader(branding) {
  const displayName = escapeHtml(branding.companyName || 'PicPeak');
  const logoSrc = encodeURI(branding.logoUrl || '/picpeak-logo-transparent.png');
  const logo = `<img src="${logoSrc}" alt="${displayName}" class="brand-logo" loading="lazy" decoding="async" />`;

  const tagline = branding.companyTagline
    ? `<p class="brand-tagline">${escapeHtml(branding.companyTagline)}</p>`
    : '';

  return `<header class="site-header">
  <div class="header-inner">
    <div class="brand">
      ${logo}
      <div class="brand-copy">
        <p class="brand-label">${displayName}</p>
        ${tagline}
      </div>
    </div>
    <nav class="site-nav">
      <a href="#features">${'Features'}</a>
      <a href="#workflow">${'Workflow'}</a>
      <a href="#collections">${'Collections'}</a>
      <a href="#stories">${'Stories'}</a>
      <a href="#contact">${'Contact'}</a>
    </nav>
  </div>
</header>`;
}

function renderBrandFooter(branding) {
  const displayName = escapeHtml(branding.companyName || 'PicPeak');
  const footerNote = branding.footerText
    ? `<p>${escapeHtml(branding.footerText)}</p>`
    : '<p>Powered by PicPeak to keep every celebration beautifully organised.</p>';

  const supportEmail = escapeHtml(branding.supportEmail || '');
  const supportLink = supportEmail
    ? `<a href="mailto:${supportEmail}">Support</a>`
    : '';

  const legalLinks = `
    <a href="/datenschutz">Privacy Policy</a>
    <a href="/impressum">Impressum</a>
    ${supportLink}
  `;

  return `<footer class="site-footer" id="contact">
  <div class="footer-inner">
    <div>
      <h2>${displayName}</h2>
      ${footerNote}
    </div>
    <div class="footer-links">
      ${legalLinks}
    </div>
  </div>
</footer>`;
}

function buildSeoMetaTags(seoSettings) {
  const tags = [];
  const robotsDirectives = [];

  if (seoSettings.seo_meta_noindex) robotsDirectives.push('noindex');
  if (seoSettings.seo_meta_nofollow) robotsDirectives.push('nofollow');

  if (robotsDirectives.length > 0) {
    tags.push(`<meta name="robots" content="${robotsDirectives.join(', ')}" />`);
  }

  if (seoSettings.seo_meta_noai) {
    tags.push('<meta name="robots" content="noai, noimageai" />');
  }

  return tags.join('\n  ');
}

function buildPublicSiteDocument(payload) {
  const inlineStyles = composeInlineStyles(payload);
  const header = renderBrandHeader(payload.branding);
  const footer = renderBrandFooter(payload.branding);
  const seoMeta = payload.seoSettings ? buildSeoMetaTags(payload.seoSettings) : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(payload.title)}</title>
  <meta name="description" content="Curated photo galleries and stories from unforgettable celebrations." />
  ${seoMeta}
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>${inlineStyles}</style>
</head>
<body>
  <div class="site-shell">
    ${header}
    <main class="site-main">
      ${payload.html}
    </main>
    ${footer}
  </div>
</body>
</html>`;
}

async function handlePublicSiteRequest(req, res, next) {
  try {
    const payload = await getPublicSitePayload();

    if (!payload.enabled) {
      res.redirect(302, '/admin/login');
      return;
    }

    if (payload.etag && req.headers['if-none-match'] === payload.etag) {
      res.status(304).end();
      return;
    }

    // Inject SEO meta settings into payload
    try {
      const seoRows = await db('app_settings')
        .where('setting_type', 'seo')
        .whereIn('setting_key', ['seo_meta_noindex', 'seo_meta_nofollow', 'seo_meta_noai'])
        .select('setting_key', 'setting_value');
      const seoSettings = {};
      for (const row of seoRows) {
        let val = row.setting_value;
        if (typeof val === 'string') { try { val = JSON.parse(val); } catch {} }
        seoSettings[row.setting_key] = val;
      }
      payload.seoSettings = seoSettings;
    } catch {}

    const document = buildPublicSiteDocument(payload);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=30, must-revalidate');
    res.setHeader('ETag', payload.etag);
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https:; font-src 'self' https: data:; object-src 'none'; script-src 'self'; form-action 'self'");

    res.status(200).send(document);
  } catch (error) {
    logger.error('Failed to render public site', { error: error.message });
    next();
  }
}

// Function to initialize rate limiters
async function initializeRateLimiters() {
  generalRateLimiter = await createRateLimiter();
  authRateLimiter = await createAuthRateLimiter();
  
  // Apply rate limiting
  app.use('/api/', generalRateLimiter);
  app.use('/api/auth', authRateLimiter);
  app.use('/api/gallery/:slug/verify', authRateLimiter);
  app.use('/api/admin/auth/login', authRateLimiter);
}

// Note: Rate limiters will be initialized after database connection
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// CSRF protection: require JSON Content-Type on mutating API requests
// This blocks cross-origin form submissions which cannot set Content-Type: application/json
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const contentType = req.headers['content-type'] || '';
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);
    // Allow empty-body requests (e.g. logout), multipart for uploads, and JSON for API calls
    if (contentLength > 0 && !contentType.includes('application/json') && !contentType.includes('multipart/form-data')) {
      return res.status(415).json({ error: 'Unsupported Content-Type. Use application/json or multipart/form-data.' });
    }
  }
  next();
});

// Request logging for API routes (with timestamps)
const apiRequestLogger = (req, res, next) => {
  try {
    const started = Date.now();
    const ts = new Date().toISOString();
    logger.info(`[${ts}] ${req.method} ${req.originalUrl}`);
    res.on('finish', () => {
      const ms = Date.now() - started;
      const tsDone = new Date().toISOString();
      logger.info(`[${tsDone}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
    });
  } catch (_) {}
  next();
};
app.use('/api', apiRequestLogger);

// Maintenance mode middleware - add after body parsing but before routes
app.use(maintenanceMiddleware);

// Session timeout middleware for admin routes
app.use('/api/admin', sessionTimeoutMiddleware);

// Middleware to set CORS headers for static files
const setCorsHeaders = (req, res, next) => {
  const origin = req.headers.origin;
  const staticAllowedOrigins = [
    process.env.FRONTEND_URL || 'http://localhost:3005',
    process.env.ADMIN_URL || 'http://localhost:3005'
  ];
  if (process.env.NODE_ENV === 'development') {
    staticAllowedOrigins.push(
      'http://localhost:5173',
      'http://localhost:3002',
      'http://localhost:3001',
      'http://localhost:3000'
    );
  }
  if (origin && staticAllowedOrigins.indexOf(origin) !== -1) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
  }
  res.header('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
};

// Import secure static middleware
const secureStatic = require('./src/middleware/secureStatic');

// Get storage path from environment or use default
const storagePath = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
process.env.EXTERNAL_MEDIA_ROOT = process.env.EXTERNAL_MEDIA_ROOT || '/external-media';

// Static file serving for photos (protected)
app.use('/photos', require('./src/middleware/photoAuth'), setCorsHeaders, secureStatic(path.join(storagePath, 'events/active')));

// Static file serving for thumbnails (protected)
app.use('/thumbnails', require('./src/middleware/photoAuth'), setCorsHeaders, secureStatic(path.join(storagePath, 'thumbnails')));

// Static file serving for uploads (public - logos, favicons)
app.use('/uploads', setCorsHeaders, secureStatic(path.join(storagePath, 'uploads')));

// Static file serving for self-hosted webfonts (public — gallery visitors
// load these via @font-face). Replaces the previous Google Fonts CDN
// dependency, which leaked visitor IPs to a third party (LG München 2022
// GDPR ruling).
//
// Two mounts in priority order:
//   1. STORAGE_PATH/fonts/ — runtime user additions (drop a folder, restart)
//   2. backend/assets/fonts/ — bundled defaults baked into the image
// Express evaluates handlers in order, so user-supplied files win on overlap.
//
// We deliberately do NOT set `immutable` on these responses. The filenames
// are stable (e.g. Inter/400.woff2), so an admin replacing the file on disk
// must be able to roll out the change to clients. With max-age + Last-Modified
// (set by express.static from file mtime), browsers send If-Modified-Since
// after expiry and pick up the new version automatically. See docs/fonts.md
// "Replacing an existing font" for the documented rollout strategy.
const fontStaticOpts = { maxAge: '7d' };
app.use(
  '/fonts',
  setCorsHeaders,
  secureStatic(path.join(storagePath, 'fonts'), fontStaticOpts)
);
app.use(
  '/fonts',
  setCorsHeaders,
  secureStatic(path.resolve(__dirname, 'assets/fonts'), fontStaticOpts)
);

// Debug endpoint to check IP detection (only in development)
if (process.env.NODE_ENV === 'development') {
  app.get('/api/debug/ip', (req, res) => {
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
                     req.headers['x-real-ip'] || 
                     req.connection.remoteAddress || 
                     req.ip;
    
    res.json({
      detectedIp: clientIp,
      reqIp: req.ip,
      headers: {
        'x-forwarded-for': req.headers['x-forwarded-for'],
        'x-real-ip': req.headers['x-real-ip'],
        'x-forwarded-proto': req.headers['x-forwarded-proto'],
        'x-forwarded-host': req.headers['x-forwarded-host']
      },
      trustProxy: app.get('trust proxy')
    });
  });
}

// OG/Twitter-card preview endpoint for gallery share URLs. Crawlers (WhatsApp,
// Slack, Facebook, etc.) don't execute JS, so the SPA's client-side meta tags
// never reach them. nginx routes UA-detected crawlers from /gallery/:slug to
// here; humans still get the SPA via try_files.
const {
  isSocialCrawler,
  handleGalleryOgRequest,
  handleGalleryOgCover,
} = require('./src/services/galleryOgService');
app.get('/og/gallery/:slug', handleGalleryOgRequest);
// Public hero-photo cover served as og:image when the admin has flipped
// events.og_image_share_enabled (#474). Unauthenticated by design;
// returns 404 unless the opt-in is on AND a hero_photo_id is set.
app.get('/og/gallery/:slug/cover', handleGalleryOgCover);

// robots.txt endpoint (dynamic, served from DB settings)
const { generateRobotsTxt } = require('./src/services/robotsTxtService');
app.get('/robots.txt', async (req, res) => {
  try {
    const robotsTxt = await generateRobotsTxt();
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.status(200).send(robotsTxt);
  } catch (error) {
    logger.error('Failed to generate robots.txt', { error: error.message });
    // Safe default for a private photo platform
    res.setHeader('Content-Type', 'text/plain');
    res.status(200).send('User-agent: *\nDisallow: /\n');
  }
});

// Health check endpoint. `pid` + `uptime` let monitors (and the local E2E
// watchdog) detect a silent process restart between two checks.
app.get('/health', async (req, res) => {
  try {
    await db.raw('SELECT 1');
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      pid: process.pid,
      uptime: process.uptime()
    });
  } catch (error) {
    logger.error('Health check failed:', error);
    res.status(503).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      pid: process.pid,
      uptime: process.uptime()
    });
  }
});

// Routes
app.use('/api/auth', authRoutes);
  app.use('/api/events', eventRoutes);
  app.use('/api/admin/external-media', require('./src/routes/adminExternalMedia'));
// Gallery routes - main routes first, then feedback routes
app.use('/api/gallery', galleryRoutes);
app.use('/api/gallery', require('./src/routes/galleryFeedback'));
app.use('/api/gallery', require('./src/routes/galleryGuests'));
app.use('/api/admin', adminRoutes);
app.use('/api/admin/auth', adminAuthRoutes);
app.use('/api/admin/system', require('./src/routes/adminSystem'));
app.use('/api/admin/feature-flags', require('./src/routes/adminFeatureFlags'));
app.use('/api/admin/backup', require('./src/routes/adminBackup'));
app.use('/api/admin/database-backup', require('./src/routes/adminDatabaseBackup'));
app.use('/api/admin/feedback', require('./src/routes/adminFeedback'));
app.use('/api/admin', require('./src/routes/adminGuests'));
app.use('/api/admin/image-security', require('./src/routes/adminImageSecurity'));
app.use('/api/admin/thumbnails', require('./src/routes/adminThumbnails'));
app.use('/api/admin/photos', require('./src/routes/adminPhotoDimensions'));
app.use('/api/admin/photos', require('./src/routes/adminPhotos'));
app.use('/api/admin/photo-export', require('./src/routes/adminPhotoExport'));
app.use('/api/admin/css-templates', require('./src/routes/adminCssTemplates'));
app.use('/api/admin/events', require('./src/routes/adminEventRename'));
app.use('/api/admin/users', require('./src/routes/adminUsers'));
// Customer portal (#354). The customerPortal feature flag is a
// VISIBILITY toggle for the admin surface, not a kill switch for
// customer access. Enforcement:
//
//   1. Frontend: RequireFeature guards + AdminSidebar visibility
//      hide the Clients section when the flag is off. Customer-side
//      /customer/* surfaces stay reachable.
//   2. Backend: NO route-level gate. The admin surface is gated by
//      adminAuth + permission checks (admin still has rights to
//      manage customer records even if the section is hidden in
//      their UI). The customer surface is gated by customerAuth +
//      is_active checks on customer_accounts.
//
// For close-to-realtime access changes use the dedicated tools:
//   - Revoke a customer's access to ONE gallery → "Manage galleries"
//     dialog removes the event_customer_assignments row, which
//     verifyGalleryAccess re-checks on every customer-minted JWT.
//   - Lock out a customer entirely → "Deactivate" sets is_active=false
//     and bumps password_changed_at, killing every outstanding JWT.
//   - Toggle per-customer feature surfaces (calendar/quotes/bills)
//     → toggles on the customer detail page.
//
// Putting the global flag in the kill-switch role was a mistake — a
// stray click in Settings → Features would lock every paying
// customer out at once. PR-revert moved the gate back to per-record.
//
// `noStoreCache` belt-and-braces the cache-control story for both
// surfaces: any response — 200, 4xx, 5xx — carries `Cache-Control:
// no-store` so a transient error (the now-reverted #458 410, a
// permission flip mid-session, a backend restart) can't get pinned
// in browser or intermediate caches and outlive its cause. See the
// PR #458 → #470 history in the middleware file for context.
const { noStoreCache } = require('./src/middleware/noStoreCache');
app.use('/api/admin/customers', noStoreCache, require('./src/routes/adminCustomers'));
// Customer-side surface (#354). Strictly separate from /api/admin/* —
// distinct token type, distinct cookie, distinct middleware.
app.use('/api/customer/auth', noStoreCache, require('./src/routes/customerAuth'));
app.use('/api/customer', noStoreCache, require('./src/routes/customer'));
app.use('/api/admin/event-types', require('./src/routes/adminEventTypes'));
app.use('/api/admin/api-tokens', require('./src/routes/adminApiTokens'));
app.use('/api/admin/webhooks', require('./src/routes/adminWebhooks'));
// Public v1 API for n8n / external integrations (#322). Mounted under
// /api/v1; auth handled per-route via apiTokenAuth (Bearer tokens).
app.use('/api/v1', require('./src/routes/v1/events'));

// Swagger UI for the v1 API. Admin-gated since it lists endpoint shapes
// that should not be enumerable to anonymous users (a common reduce-info-leak hardening).
{
  const swaggerUi = require('swagger-ui-express');
  const { adminAuth } = require('./src/middleware/auth');
  const { getOpenApiSpec } = require('./src/openapi/spec');
  app.get('/api/openapi.json', adminAuth, (_req, res) => res.json(getOpenApiSpec()));
  app.use(
    '/api/docs',
    adminAuth,
    swaggerUi.serve,
    swaggerUi.setup(getOpenApiSpec(), { customSiteTitle: 'PicPeak API · v1' })
  );
}

app.use('/api/invite', require('./src/routes/acceptInvite'));
app.use('/api/public/settings', require('./src/routes/publicSettings'));
app.use('/api/public/fonts', require('./src/routes/publicFonts'));
app.use('/api/public', require('./src/routes/publicCMS'));
app.use('/api/images', require('./src/routes/protectedImages'));
app.use('/api/secure-images', secureImagesRoutes);

// Optional: Serve built frontend (native installs)
try {
  const serveFrontendEnv = process.env.SERVE_FRONTEND; // 'true' | 'false' | undefined
  const frontendDir = process.env.FRONTEND_DIR || path.join(__dirname, '../frontend/dist');
  const indexPath = path.join(frontendDir, 'index.html');
  // Auto-serve when dist exists unless explicitly disabled
  const shouldServe = (serveFrontendEnv === 'true') || ((serveFrontendEnv === undefined || serveFrontendEnv === 'auto') && fs.existsSync(indexPath));
  if (shouldServe) {
    logger.info(`Serving frontend from ${frontendDir}`);
    // Serve pre-built assets
    app.use(express.static(frontendDir));

    // Landing page handler or SPA fallback
    app.get('/', handlePublicSiteRequest, (req, res) => {
      res.sendFile(indexPath);
    });

    // SPA fallback for admin + gallery routes. For gallery URLs we intercept
    // social-crawler User-Agents and serve OG/Twitter-card metadata so link
    // previews show the event name + branding instead of the SPA stub.
    app.get('/gallery/:slug/:token?', (req, res, next) => {
      if (isSocialCrawler(req.get('user-agent'))) {
        return handleGalleryOgRequest(req, res);
      }
      return next();
    }, (req, res) => res.sendFile(indexPath));

    app.get(['/admin', '/admin/*', '/gallery/*'], (req, res) => {
      res.sendFile(indexPath);
    });
  } else {
    logger.info('Frontend static serving disabled or dist not found', { serveFrontendEnv, frontendDir });
    app.get('/', handlePublicSiteRequest, (req, res) => {
      res.status(503).send('Frontend bundle not available. Build frontend or enable public site.');
    });
  }
} catch (e) {
  logger.warn('Failed to enable frontend static serving', { error: e.message });
}

// 404 handler for undefined API routes
app.use('/api', notFoundHandler);

// Global error handler (must be last)
app.use(errorHandler);

// Initialize services
async function startServer() {
  try {
    // Initialize database
    await initializeDatabase();

    // Initialize storage backend (local fs or S3) — fail fast on misconfig
    const { initStorage } = require('./src/services/storage');
    await initStorage();

    // Initialize rate limiters after database is ready
    await initializeRateLimiters();
    logger.info('Rate limiters initialized with database configuration');

    // Initialize auth security cleanup job
    const { initializeCleanupJob } = require('./src/utils/authSecurity');
    initializeCleanupJob();
    
    // Initialize temp upload cleanup job
    const { cleanupTempUploads } = require('./src/utils/cleanupTempUploads');
    // Run cleanup on startup
    cleanupTempUploads();
    // Schedule periodic cleanup every hour
    setInterval(cleanupTempUploads, 60 * 60 * 1000);
    logger.info('Temp upload cleanup scheduled');
    
    // Start file watcher
    startFileWatcher();
    
    // Start expiration checker
    startExpirationChecker();
    
    // Initialize email transporter and start queue processor
    await initializeTransporter();
    startEmailQueueProcessor();
    
    // Start webhook delivery worker (#327)
    const { startWebhookDeliveryWorker } = require('./src/services/webhookDeliveryWorker');
    startWebhookDeliveryWorker();

    // Start S3 auto-importer (#328 follow-up). No-op when STORAGE_AUTO_IMPORT
    // is unset OR STORAGE_BACKEND=local — replaces the chokidar watcher
    // for S3-mode deployments that drop files into the bucket directly.
    const { startS3AutoImporter } = require('./src/services/s3AutoImporter');
    startS3AutoImporter();

    // Start backup service
    await startBackupService();

    // Start database backup service
    await startScheduledBackups();

    // Start the async photo-processing worker pool. Picks up
    // photos in 'pending' state (from POST /upload) and runs the
    // sharp/ffmpeg/EXIF pipeline off the request thread.
    backgroundProcessor.start();

    app.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
      logger.info(`Admin interface: ${process.env.ADMIN_URL || 'http://localhost:3000'}`);
      logger.info(`Frontend: ${process.env.FRONTEND_URL || 'http://localhost:3001'}`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

module.exports = app; // For testing
