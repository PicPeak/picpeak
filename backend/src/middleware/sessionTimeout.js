const jwt = require('jsonwebtoken');
const { db } = require('../database/db');
const { getAdminTokenFromRequest } = require('../utils/tokenUtils');
const logger = require('../utils/logger');

// In-memory session tracking (in production, use Redis)
const sessions = new Map();

// Default session timeout (60 minutes)
const DEFAULT_SESSION_TIMEOUT = 60 * 60 * 1000;

// Cache for session timeout setting
let cachedTimeout = null;
let cacheExpiry = 0;
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes - reduced DB queries

// Clean up expired sessions every 5 minutes.
//
// `.unref()` so this timer doesn't keep the event loop alive on its
// own — without it, every jest worker that requires this module
// (directly or transitively via server.js / a middleware-importing
// route file) gets stuck and either prints the "worker failed to
// exit gracefully" warning or, under high CI load, force-kills mid-
// test and takes an unrelated suite down with it (we hit this with
// integration/storageBackend.test.js on PR #555). Production
// behaviour is unchanged: the timer fires every 5 min as long as
// the server has anything else keeping the loop alive (HTTP server,
// other intervals), which is always.
setInterval(() => {
  const now = Date.now();
  for (const [token, lastActivity] of sessions.entries()) {
    if (now - lastActivity > DEFAULT_SESSION_TIMEOUT) {
      sessions.delete(token);
    }
  }
}, 5 * 60 * 1000).unref();

async function getSessionTimeout() {
  const now = Date.now();
  
  // Return cached value if still valid
  if (cachedTimeout && now < cacheExpiry) {
    return cachedTimeout;
  }
  
  try {
    const setting = await db('app_settings')
      .where('setting_key', 'security_session_timeout_minutes')
      .first()
      .timeout(5000); // 5 second timeout
    
    if (setting && setting.setting_value) {
      let value = setting.setting_value;
      // Handle both string and object values
      if (typeof value === 'string') {
        try {
          value = JSON.parse(value);
        } catch (e) {
          // If it's not JSON, try to parse as number directly
          value = parseInt(value);
        }
      }
      const minutes = parseInt(value);
      if (!isNaN(minutes) && minutes > 0) {
        cachedTimeout = minutes * 60 * 1000; // Convert to milliseconds
        cacheExpiry = now + CACHE_DURATION;
        return cachedTimeout;
      }
    }
  } catch (error) {
    // Only log if it's not a connection error (to avoid spam)
    if (error.code !== 'ECONNRESET' && !error.message?.includes('Connection terminated')) {
      logger.error('Error getting session timeout:', error.message);
    }
  }
  
  // Use cached value if available, otherwise default
  return cachedTimeout || DEFAULT_SESSION_TIMEOUT;
}

async function sessionTimeoutMiddleware(req, res, next) {
  // Skip for non-authenticated routes
  const token = getAdminTokenFromRequest(req);
  if (!token) {
    return next();
  }
  
  try {
    // Verify token is valid
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    
    // Check if this is an admin token
    if (!decoded.id) {
      return next();
    }
    
    const now = Date.now();
    const lastActivity = sessions.get(token);
    const timeout = await getSessionTimeout();

    if (lastActivity) {
      // Existing session — check if idle too long
      if (now - lastActivity > timeout) {
        sessions.delete(token);
        return res.status(401).json({
          error: 'Session expired',
          code: 'SESSION_TIMEOUT'
        });
      }
    } else {
      // First request with this token — check if token was issued longer ago than the timeout
      // This prevents old/stolen tokens from bypassing session timeout after server restart
      const tokenIssuedAt = (decoded.iat || 0) * 1000; // iat is in seconds
      if (now - tokenIssuedAt > timeout) {
        return res.status(401).json({
          error: 'Session expired',
          code: 'SESSION_TIMEOUT'
        });
      }
    }

    // Update last activity
    sessions.set(token, now);
    
    // Clean up old token if user has a new one
    // This prevents memory leaks from token renewals
    const userId = decoded.id;
    for (const [oldToken, _] of sessions.entries()) {
      if (oldToken !== token) {
        try {
          const oldDecoded = jwt.verify(oldToken, process.env.JWT_SECRET, { algorithms: ['HS256'] });
          if (oldDecoded.id === userId) {
            sessions.delete(oldToken);
          }
        } catch (e) {
          // Token is invalid, remove it
          sessions.delete(oldToken);
        }
      }
    }
    
    next();
  } catch (error) {
    // Token is invalid
    next();
  }
}

// Non-mutating timeout check used by /auth/session (auth.js) so the session
// endpoint enforces the same timeout the protected /api/admin endpoints
// already enforce via sessionTimeoutMiddleware. Without this, /auth/session
// returns valid:true for a token that protected endpoints reject with
// 401 SESSION_TIMEOUT, producing the /admin/login → /admin/dashboard →
// /admin/login redirect loop reported on v3.39.1-beta.0 (issue #350).
//
// Mirrors the middleware's logic exactly:
//   - If we have an in-memory lastActivity for this token, return whether
//     the gap exceeds the timeout.
//   - Otherwise (post-restart, or first request with this token), return
//     whether the token's iat is older than the timeout — same post-restart
//     guard the middleware uses.
//
// Does NOT update the in-memory map. The middleware is the only place that
// tracks activity; /auth/session is read-only by design.
async function isSessionExpired(token, decoded) {
  if (!token || !decoded || !decoded.id) return false;
  const now = Date.now();
  const timeout = await getSessionTimeout();
  const lastActivity = sessions.get(token);
  if (lastActivity) {
    return (now - lastActivity) > timeout;
  }
  const tokenIssuedAt = (decoded.iat || 0) * 1000;
  return (now - tokenIssuedAt) > timeout;
}

// Function to end a session
function endSession(token) {
  sessions.delete(token);
}

// Function to get active sessions count
function getActiveSessions() {
  const now = Date.now();
  let active = 0;
  
  for (const [_, lastActivity] of sessions.entries()) {
    if (now - lastActivity <= DEFAULT_SESSION_TIMEOUT) {
      active++;
    }
  }
  
  return active;
}

module.exports = {
  sessionTimeoutMiddleware,
  isSessionExpired,
  endSession,
  getActiveSessions
};
