const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { getAdminTokenFromRequest, getGalleryTokenFromRequest } = require('../utils/tokenUtils');

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

    // Parse settings into object
    const config = {
      enabled: true,
      windowMinutes: 15,
      maxRequests: 100,
      authMaxRequests: 5,
      skipAuthenticated: true,
      publicEndpointsOnly: false
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
      maxRequests: 100,
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
function isAuthenticated(req) {
  try {
    const slugMatch = req.path.match(/\/api\/(?:gallery|secure-images)\/([^\/]+)/);
    const slug = slugMatch ? slugMatch[1] : req.requestedSlug;
    const token = getAdminTokenFromRequest(req) || getGalleryTokenFromRequest(req, slug);
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Check if token is valid
    if (!decoded || typeof decoded !== 'object') {
      return false;
    }

    // Valid token found - check type
    req.tokenType = decoded.type; // 'admin' or 'gallery'
    req.tokenPayload = decoded;
    
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Determine if rate limiting should be applied to this request
 */
function shouldSkipRateLimit(req, config) {
  // If rate limiting is disabled globally
  if (!config.enabled) {
    return true;
  }

  // Never skip rate limiting for auth endpoints
  const isAuthEndpoint = req.path.match(/\/(auth|login|gallery\/[^/]+\/verify)$/);
  if (isAuthEndpoint) {
    return false;
  }

  // Check if we should skip authenticated requests
  if (config.skipAuthenticated && isAuthenticated(req)) {
    return true;
  }

  // Check if we only rate limit public endpoints
  if (config.publicEndpointsOnly) {
    const isPublicEndpoint = req.path.startsWith('/api/public/') || 
                           req.path.startsWith('/api/gallery/') ||
                           isAuthEndpoint;
    return !isPublicEndpoint;
  }

  return false;
}

/**
 * Create dynamic rate limiter
 */
async function createRateLimiter() {
  const config = await getRateLimitSettings();
  
  return rateLimit({
    windowMs: config.windowMinutes * 60 * 1000,
    max: async (req) => {
      // Refresh config for each request
      const currentConfig = await getRateLimitSettings();
      
      // Different limits for auth endpoints
      const isAuthEndpoint = req.path.match(/\/(auth|login|gallery\/[^/]+\/verify)$/);
      return isAuthEndpoint ? currentConfig.authMaxRequests : currentConfig.maxRequests;
    },
    keyGenerator: (req) => req.ip,
    skip: async (req) => {
      const currentConfig = await getRateLimitSettings();
      return shouldSkipRateLimit(req, currentConfig);
    },
    handler: (req, res) => {
      const clientIp = req.ip;
      
      // Enhanced logging for production analysis
      logger.warn('Rate limit exceeded', {
        ip: clientIp,
        path: req.path,
        method: req.method,
        authenticated: isAuthenticated(req),
        tokenType: req.tokenType,
        userAgent: req.headers['user-agent'],
        referer: req.headers['referer'],
        origin: req.headers['origin'],
        timestamp: new Date().toISOString(),
        headers: {
          'x-forwarded-for': req.headers['x-forwarded-for'],
          'x-real-ip': req.headers['x-real-ip']
        },
        requestUrl: req.originalUrl,
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
 */
async function createAuthRateLimiter() {
  const config = await getRateLimitSettings();
  
  return rateLimit({
    windowMs: config.windowMinutes * 60 * 1000,
    max: config.authMaxRequests,
    keyGenerator: (req) => req.ip,
    skip: async () => {
      const currentConfig = await getRateLimitSettings();
      return !currentConfig.enabled;
    },
    handler: (req, res) => {
      const clientIp = req.ip;
      
      // Enhanced logging for auth failures
      logger.warn('Auth rate limit exceeded', {
        ip: clientIp,
        path: req.path,
        method: req.method,
        userAgent: req.headers['user-agent'],
        timestamp: new Date().toISOString(),
        headers: {
          'x-forwarded-for': req.headers['x-forwarded-for'],
          'x-real-ip': req.headers['x-real-ip']
        },
        requestUrl: req.originalUrl,
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

module.exports = {
  getRateLimitSettings,
  clearSettingsCache,
  createRateLimiter,
  createAuthRateLimiter,
  isAuthenticated,
  shouldSkipRateLimit
};
