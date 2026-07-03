/**
 * Rate Limiting Security Utilities
 * Provides secure rate limiting that prevents bypass attempts
 */

const jwt = require('jsonwebtoken');
const logger = require('./logger');

/**
 * Safely check if a request has a valid admin token
 * Used to determine if rate limiting should be skipped
 * 
 * IMPORTANT: This prevents the bypass vulnerability where
 * invalid tokens could skip rate limiting
 * 
 * @param {Object} req - Express request object
 * @returns {boolean} - True only if token is valid AND admin type
 */
function hasValidAdminToken(req) {
  try {
    // Only check admin paths
    if (!req.path.startsWith('/api/admin/')) {
      return false;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return false;
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix
    
    // Critical: Verify token is valid before skipping rate limit
    // This prevents invalid tokens from bypassing rate limiting
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Additional validation
    if (!decoded || typeof decoded !== 'object') {
      return false;
    }
    
    // Must be admin type to skip rate limiting
    if (decoded.type !== 'admin') {
      logger.warn('Non-admin token attempted to bypass rate limit', {
        path: req.path,
        tokenType: decoded.type,
        ip: req.ip
      });
      return false;
    }
    
    // Optional: Check token age (prevent old tokens)
    const tokenAge = Date.now() - (decoded.iat * 1000);
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    
    if (tokenAge > maxAge) {
      logger.warn('Old admin token attempted to bypass rate limit', {
        path: req.path,
        tokenAge: Math.floor(tokenAge / 1000 / 60) + ' minutes',
        ip: req.ip
      });
      return false;
    }
    
    // Valid admin token - can skip rate limiting
    return true;
    
  } catch (error) {
    // Any error means token is invalid
    // Log attempts with invalid tokens (potential attacks)
    if (error.name === 'JsonWebTokenError') {
      logger.warn('Invalid token attempted to bypass rate limit', {
        path: req.path,
        error: error.message,
        ip: req.ip
      });
    }
    
    // Apply rate limiting for any invalid token
    return false;
  }
}

/**
 * Create a skip function for rate limiter that prevents bypass
 * @returns {Function} Skip function for express-rate-limit
 */
function createSecureSkipFunction() {
  return (req) => {
    // In development, be more lenient with public settings
    if (process.env.NODE_ENV === 'development' && req.path === '/api/public/settings') {
      return true;
    }
    
    // Only skip for valid admin tokens
    return hasValidAdminToken(req);
  };
}

/**
 * Log rate limit hits for security monitoring
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
function logRateLimitHit(req, res) {
  logger.warn('Rate limit exceeded', {
    ip: req.ip,
    path: req.path,
    userAgent: req.headers['user-agent'],
    remaining: res.getHeader('X-RateLimit-Remaining'),
    limit: res.getHeader('X-RateLimit-Limit')
  });
}

module.exports = {
  hasValidAdminToken,
  createSecureSkipFunction,
  logRateLimitHit
};