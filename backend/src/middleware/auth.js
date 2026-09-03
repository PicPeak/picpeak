const jwt = require('jsonwebtoken');
const { db } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const { isMissingRolesSchema } = require('../utils/dbErrors');
const { isTokenRevoked } = require('../utils/tokenRevocation');
const { isTokenBeforeCutoff } = require('../utils/sessionCutoff');
const logger = require('../utils/logger');
const { getAdminTokenFromRequest } = require('../utils/tokenUtils');

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
    
    // Check if token is revoked
    if (await isTokenRevoked(decoded)) {
      logger.warn('Revoked token used', {
        userId: decoded.id,
        tokenType: decoded.type
      });
      return res.status(401).json({ error: 'Token has been revoked', code: 'TOKEN_REVOKED' });
    }

    // Reject any session issued before the global cutoff (set by a .picpeak
    // restore, which can reassign admin ids). Forces every pre-restore admin
    // session to re-authenticate against the restored data.
    if (await isTokenBeforeCutoff(decoded)) {
      return res.status(401).json({ error: 'Session invalidated', code: 'SESSION_INVALIDATED' });
    }
    
    // Verify token type
    if (decoded.type !== 'admin') {
      logger.warn('Non-admin token used for admin endpoint', { 
        userId: decoded.id,
        tokenType: decoded.type 
      });
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    
    // IP validation (optional - can be strict or just log)
    const currentIp = req.ip || req.connection.remoteAddress;
    if (decoded.ip && decoded.ip !== currentIp) {
      logger.warn('Token used from different IP', {
        userId: decoded.id,
        tokenIp: decoded.ip,
        currentIp: currentIp
      });
    }
    
    // Check if admin still exists and is active, including role info
    // Use try/catch to handle case where roles table doesn't exist yet (upgrade scenario)
    let admin;
    try {
      admin = await db('admin_users')
        .leftJoin('roles', 'roles.id', 'admin_users.role_id')
        .where({ 'admin_users.id': decoded.id, 'admin_users.is_active': formatBoolean(true) })
        .select(
          'admin_users.id',
          'admin_users.username',
          'admin_users.email',
          'admin_users.password_changed_at',
          'roles.id as role_id',
          'roles.name as role_name'
        )
        .first();
    } catch (joinError) {
      // Fail CLOSED on anything that isn't a genuinely missing roles schema:
      // the fallback below fabricates super_admin, so a transient query failure
      // (connection reset, deadlock, statement timeout, pool exhaustion) must
      // not become a free privilege upgrade for every scoped admin. Rethrow →
      // outer catch → 401, which is already how every other transient DB fault
      // in this try block behaves (isTokenRevoked / isTokenBeforeCutoff both
      // hit the DB here). apiTokenAuth takes the same posture on the v1
      // surface, differing only in its 500.
      if (!isMissingRolesSchema(joinError)) throw joinError;
      // Fallback: roles table may not exist yet during upgrade
      // Query without role join - user will have no role info but can still authenticate
      logger.debug('Roles table not available, falling back to basic auth', { error: joinError.message });
      admin = await db('admin_users')
        .where({ id: decoded.id, is_active: formatBoolean(true) })
        .select('id', 'username', 'email', 'password_changed_at')
        .first();
      if (admin) {
        admin.role_id = null;
        admin.role_name = 'super_admin'; // Assume super_admin for existing users during upgrade
      }
    }

    if (!admin) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Check if password was changed after token was issued. JWT `iat` has
    // 1-second resolution; `password_changed_at` is sub-second. Floor the
    // comparison so a token issued in the *same* second as the password
    // change isn't incorrectly rejected — that race used to bite anyone
    // logging in immediately after a password reset/change.
    if (admin.password_changed_at) {
      const passwordChangedSeconds = Math.floor(
        new Date(admin.password_changed_at).getTime() / 1000
      );
      if (decoded.iat < passwordChangedSeconds) {
        logger.warn('Token used after password change', { userId: decoded.id });
        return res.status(401).json({
          error: 'Token invalid due to password change',
          code: 'PASSWORD_CHANGED'
        });
      }
    }

    // Add user info to request (enhanced with role)
    req.admin = {
      id: admin.id,
      username: admin.username,
      email: admin.email,
      roleId: admin.role_id,
      roleName: admin.role_name,
      // From the token, not the database: it is a property of this session
      // rather than of the account (#1186). Carried so a route that reissues
      // the token — change-password — can preserve the choice instead of
      // silently dropping the session back to 24h.
      rememberMe: decoded.rememberMe === true
    };
    req.token = token; // Store token for potential revocation
    
    next();
  } catch (error) {
    logger.error('Auth middleware error:', error);
    res.status(401).json({ error: 'Authentication failed' });
  }
}

module.exports = {
  adminAuth
};
