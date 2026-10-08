const jwt = require('jsonwebtoken');
const sessionAccess = require('../services/sessionAccessService');
const logger = require('../utils/logger');
const { getAdminTokenFromRequest } = require('../utils/tokenUtils');
const { loadCrmActor, withCrmActor } = require('../database/crmAccess');

// GHSA-h4w8-57xq-53fx: must_change_password was written on reset (and on
// invitation/OIDC-bypass paths) but nothing server-side ever checked it — a
// forced-reset admin could keep using the old/weak password indefinitely
// because the flag only ever reached the frontend as a response field. The
// frontend already renders a blocking modal for it (MandatoryPasswordChangeModal),
// this is the backstop for callers that skip the UI entirely. Every route
// gated by adminAuth() is blocked except the ones a flagged admin needs to
// clear the flag or leave: change their password, and log out.
const MUST_CHANGE_PASSWORD_EXEMPT_PATHS = new Set([
  '/api/admin/auth/change-password',
  '/api/admin/auth/logout',
]);

/**
 * Enhanced admin authentication middleware with revocation checking
 */
async function adminAuth(req, res, next) {
  try {
    const token = getAdminTokenFromRequest(req);
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET, {
        algorithms: ['HS256'],
        issuer: 'picpeak-auth',
        complete: true
      });
      decoded = decoded.payload;
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
      }
      return res.status(401).json({ error: 'Invalid token' });
    }

    // includeProfile: true — need must_change_password for the enforcement
    // check below on every request, not just the profile/session-check routes.
    const admin = await sessionAccess.admin(decoded, { includeProfile: true });
    const requestIp = req.ip || req.connection?.remoteAddress;
    if (decoded.ip && requestIp && decoded.ip !== requestIp) {
      logger.info('admin session IP changed', { accountId: admin.id, tokenIp: decoded.ip, requestIp });
    }

    if (admin.must_change_password
      && !MUST_CHANGE_PASSWORD_EXEMPT_PATHS.has(req.originalUrl.split('?')[0])) {
      return res.status(403).json({
        error: 'Password change required before continuing',
        code: 'MUST_CHANGE_PASSWORD'
      });
    }

    // Add user info to request (enhanced with role)
    req.admin = {
      id: admin.id,
      username: admin.username,
      email: admin.email,
      roleId: admin.role_id,
      roleName: admin.role_name,
      mustChangePassword: !!admin.must_change_password,
      // From the token, not the database: it is a property of this session
      // rather than of the account (#1186). Carried so a route that reissues
      // the token — change-password — can preserve the choice instead of
      // silently dropping the session back to 24h.
      rememberMe: decoded.rememberMe === true
    };
    req.token = token; // Store token for potential revocation

    withCrmActor({ ...(await loadCrmActor(req.admin)), originAdminId: Number(req.admin.id) }, next);
  } catch (error) {
    logger.error('Auth middleware error:', error);
    res.status(error.statusCode || 401).json({
      error: error.isOperational ? error.message : 'Authentication failed',
      ...(error.isOperational && { code: error.code }),
    });
  }
}

module.exports = {
  adminAuth
};
