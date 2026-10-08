const { requestLogPath } = require('../utils/requestLogPath');
/**
 * Customer Authentication Middleware
 *
 * Verifies a 'customer' JWT issued by /api/customer/auth/login. Mirrors
 * adminAuth (same revocation, IP-log, password-change invalidation flow)
 * but operates on customer_accounts rather than admin_users — so an
 * admin token cannot pass as a customer and vice versa.
 *
 * Sets `req.customer = { id, email, displayName, isActive }` on success.
 */

const jwt = require('jsonwebtoken');
const sessionAccess = require('../services/sessionAccessService');
const logger = require('../utils/logger');
const { getCustomerTokenFromRequest } = require('../utils/tokenUtils');

async function customerAuth(req, res, next) {
  try {
    const token = getCustomerTokenFromRequest(req);
    if (!token) {
      // Quiet by default — unauthenticated /api/customer/* requests are
      // normal (page polling, pre-login session probes). Bump to debug
      // for noisy investigations only.
      logger.debug('[customerAuth] no token on request', {
        url: requestLogPath(req.originalUrl),
        hasCookieHeader: !!req.headers?.cookie,
        cookieKeys: Object.keys(req.cookies || {}),
      });
      return res.status(401).json({ error: 'No token provided', code: 'NO_TOKEN' });
    }

    let decoded;
    try {
      const verified = jwt.verify(token, process.env.JWT_SECRET, {
        algorithms: ['HS256'],
        issuer: 'picpeak-auth',
        complete: true,
      });
      decoded = verified.payload;
    } catch (err) {
      logger.warn('[customerAuth] jwt verification failed', {
        url: requestLogPath(req.originalUrl),
        errorName: err.name,
        errorMessage: err.message,
      });
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
      }
      return res.status(401).json({ error: 'Invalid token', code: 'JWT_INVALID' });
    }

    const customer = await sessionAccess.customer(decoded);
    const requestIp = req.ip || req.connection?.remoteAddress;
    if (decoded.ip && requestIp && decoded.ip !== requestIp) {
      logger.info('customer session IP changed', { accountId: customer.id, tokenIp: decoded.ip, requestIp });
    }

    req.customer = {
      id: customer.id,
      email: customer.email,
      displayName: customer.display_name,
      firstName: customer.first_name,
      lastName: customer.last_name,
      preferredLanguage: customer.preferred_language || 'en',
    };
    req.token = token;
    // CRM authorization here is the typed customer session plus the existing
    // per-document customer/action-token checks, not a photographer principal.
    const { withTrustedCrmAccess } = require('../database/crmAccess');
    withTrustedCrmAccess('authenticated customer capability', next);
  } catch (error) {
    logger.error('Customer auth middleware error:', error);
    res.status(error.statusCode || 401).json({
      error: error.isOperational ? error.message : 'Authentication failed',
      ...(error.isOperational && { code: error.code }),
    });
  }
}

module.exports = { customerAuth };
