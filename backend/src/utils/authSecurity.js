/**
 * Authentication Security Utilities
 * Provides enhanced security features for authentication
 */

const { db } = require('../database/db');
const { formatBoolean } = require('./dbCompat');
const logger = require('./logger');

const DEFAULT_SECURITY_CONFIG = Object.freeze({
  maxAttempts: 5,
  lockoutDurationMs: 30 * 60 * 1000, // 30 minutes
  attemptWindowMs: 15 * 60 * 1000 // 15 minutes
});

const SECURITY_CONFIG_CACHE_MS = 60 * 1000; // 1 minute cache
let cachedSecurityConfig = { ...DEFAULT_SECURITY_CONFIG };
let cachedConfigFetchedAt = 0;

function parseStoredValue(rawValue) {
  if (rawValue === undefined || rawValue === null) {
    return undefined;
  }

  if (typeof rawValue !== 'string') {
    return rawValue;
  }

  try {
    return JSON.parse(rawValue);
  } catch (error) {
    logger.warn(`Unable to parse stored security setting value "${rawValue}", using raw string.`);
    return rawValue;
  }
}

function normalizePositiveInteger(name, value, fallback, options = {}) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    logger.warn(`Invalid numeric value for ${name}: ${value}. Falling back to default (${fallback}).`);
    return fallback;
  }

  let adjustedValue = Math.floor(numericValue);

  if (options.min !== undefined && adjustedValue < options.min) {
    logger.warn(`Value for ${name} below minimum (${options.min}). Clamping to minimum.`);
    adjustedValue = options.min;
  }

  if (options.max !== undefined && adjustedValue > options.max) {
    logger.warn(`Value for ${name} exceeds maximum (${options.max}). Clamping to maximum.`);
    adjustedValue = options.max;
  }

  if (adjustedValue <= 0) {
    logger.warn(`Value for ${name} must be positive. Falling back to default (${fallback}).`);
    return fallback;
  }

  return adjustedValue;
}

async function loadSecurityConfigFromSettings() {
  const rows = await db('app_settings').whereIn('setting_key', [
    'security_max_login_attempts',
    'security_lockout_duration_minutes',
    'security_attempt_window_minutes'
  ]);

  const config = { ...DEFAULT_SECURITY_CONFIG };

  rows.forEach(row => {
    const value = parseStoredValue(row.setting_value);

    switch (row.setting_key) {
      case 'security_max_login_attempts': {
        config.maxAttempts = normalizePositiveInteger(
          'security_max_login_attempts',
          value,
          DEFAULT_SECURITY_CONFIG.maxAttempts,
          { min: 1, max: 50 }
        );
        break;
      }
      case 'security_lockout_duration_minutes': {
        const minutes = normalizePositiveInteger(
          'security_lockout_duration_minutes',
          value,
          DEFAULT_SECURITY_CONFIG.lockoutDurationMs / (60 * 1000),
          { min: 1, max: 24 * 60 }
        );
        config.lockoutDurationMs = minutes * 60 * 1000;
        break;
      }
      case 'security_attempt_window_minutes': {
        const minutes = normalizePositiveInteger(
          'security_attempt_window_minutes',
          value,
          DEFAULT_SECURITY_CONFIG.attemptWindowMs / (60 * 1000),
          { min: 1, max: 24 * 60 }
        );
        config.attemptWindowMs = minutes * 60 * 1000;
        break;
      }
      default:
        break;
    }
  });

  return config;
}

async function getSecurityConfig(options = {}) {
  const now = Date.now();
  const forceRefresh = options.forceRefresh === true;

  if (!forceRefresh && cachedSecurityConfig && (now - cachedConfigFetchedAt) < SECURITY_CONFIG_CACHE_MS) {
    return cachedSecurityConfig;
  }

  try {
    const config = await loadSecurityConfigFromSettings();
    cachedSecurityConfig = config;
    cachedConfigFetchedAt = now;
    return cachedSecurityConfig;
  } catch (error) {
    logger.error('Error loading security configuration:', error);
    cachedSecurityConfig = { ...DEFAULT_SECURITY_CONFIG };
    cachedConfigFetchedAt = now;
    return cachedSecurityConfig;
  }
}

function resetSecurityConfigCache() {
  cachedSecurityConfig = { ...DEFAULT_SECURITY_CONFIG };
  cachedConfigFetchedAt = 0;
}

/**
 * Track failed login attempt
 * @param {string} identifier - Username or email
 * @param {string} ipAddress - IP address of the attempt
 * @param {string} userAgent - User agent string
 */
async function trackFailedAttempt(identifier, ipAddress, userAgent) {
  try {
    // Check if table exists first
    const tableExists = await db.schema.hasTable('login_attempts');
    if (!tableExists) {
      return;
    }
    
    await db('login_attempts').insert({
      identifier,
      ip_address: ipAddress,
      user_agent: userAgent,
      attempt_time: new Date().toISOString(),
      success: false
    });

    // Log security event
    logger.warn('Failed login attempt', {
      identifier,
      ipAddress,
      userAgent,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error tracking failed login attempt:', error);
  }
}

/**
 * Track successful login
 * @param {string} identifier - Username or email
 * @param {string} ipAddress - IP address
 * @param {string} userAgent - User agent string
 */
async function trackSuccessfulLogin(identifier, ipAddress, userAgent) {
  try {
    // Check if table exists first
    const tableExists = await db.schema.hasTable('login_attempts');
    if (!tableExists) {
      return;
    }

    const { attemptWindowMs } = await getSecurityConfig();
    
    await db('login_attempts').insert({
      identifier,
      ip_address: ipAddress,
      user_agent: userAgent,
      attempt_time: new Date().toISOString(),
      success: true
    });

    // Clear old failed attempts for this user
    const cutoffTime = new Date(Date.now() - attemptWindowMs);
    await db('login_attempts')
      .where('identifier', identifier)
      .where('success', formatBoolean(false))
      .where('attempt_time', '<', cutoffTime.toISOString())
      .delete();
  } catch (error) {
    logger.error('Error tracking successful login:', error);
  }
}

/**
 * Check if account is locked due to too many failed attempts
 * @param {string} identifier - Username or email
 * @param {string} [ipAddress] - Optional IP address scope
 * @returns {Promise<{isLocked: boolean, remainingTime?: number}>}
 */
async function checkAccountLockout(identifier, ipAddress) {
  try {
    // Check if table exists first
    const tableExists = await db.schema.hasTable('login_attempts');
    if (!tableExists) {
      return { isLocked: false };
    }

    const { attemptWindowMs, maxAttempts, lockoutDurationMs } = await getSecurityConfig();
    
    const recentWindow = new Date(Date.now() - attemptWindowMs);
    
    // Get recent failed attempts
    const failedAttemptsQuery = db('login_attempts')
      .where('identifier', identifier)
      .where('success', formatBoolean(false))
      .where('attempt_time', '>=', recentWindow.toISOString());

    if (ipAddress) {
      failedAttemptsQuery.andWhere('ip_address', ipAddress);
    }

    const failedAttempts = await failedAttemptsQuery
      .orderBy('attempt_time', 'desc')
      .limit(maxAttempts);

    if (failedAttempts.length >= maxAttempts) {
      // Check if still within lockout period
      const oldestAttempt = failedAttempts[failedAttempts.length - 1];
      const lockoutEnd = new Date(oldestAttempt.attempt_time).getTime() + lockoutDurationMs;
      const now = Date.now();

      if (now < lockoutEnd) {
        return {
          isLocked: true,
          remainingTime: Math.ceil((lockoutEnd - now) / 1000) // seconds
        };
      }
    }

    return { isLocked: false };
  } catch (error) {
    logger.error('Error checking account lockout:', error);
    return { isLocked: true, remainingTime: 300 }; // Fail closed on DB error
  }
}

/**
 * Check for suspicious login patterns
 * @param {string} identifier - Username or email
 * @param {string} ipAddress - Current IP address
 * @returns {Promise<boolean>} - True if suspicious
 */
async function checkSuspiciousActivity(identifier, ipAddress) {
  try {
    // Check if table exists first
    const tableExists = await db.schema.hasTable('login_attempts');
    if (!tableExists) {
      return false;
    }
    
    // Check for rapid attempts from different IPs
    const recentWindow = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes
    
    const recentAttempts = await db('login_attempts')
      .where('identifier', identifier)
      .where('attempt_time', '>=', recentWindow.toISOString())
      .select('ip_address')
      .distinct('ip_address');

    // If more than 3 different IPs in 5 minutes, it's suspicious
    if (recentAttempts.length > 3) {
      logger.warn('Suspicious login activity detected', {
        identifier,
        uniqueIPs: recentAttempts.length,
        currentIP: ipAddress
      });
      return true;
    }

    return false;
  } catch (error) {
    logger.error('Error checking suspicious activity:', error);
    return false;
  }
}

/**
 * Get generic error message to prevent user enumeration
 * @returns {string}
 */
function getGenericAuthError() {
  return 'Invalid credentials';
}

/**
 * Clean up old login attempts (should be run periodically)
 */
async function cleanupOldAttempts() {
  try {
    // Check if table exists first
    const tableExists = await db.schema.hasTable('login_attempts');
    if (!tableExists) {
      // Table doesn't exist, skip cleanup
      return;
    }
    
    const cutoffDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days
    
    const deleted = await db('login_attempts')
      .where('attempt_time', '<', cutoffDate.toISOString())
      .delete();

    if (deleted > 0) {
      logger.info(`Cleaned up ${deleted} old login attempts`);
    }
  } catch (error) {
    logger.error('Error cleaning up login attempts:', error);
  }
}

/**
 * Initialize cleanup job
 */
function initializeCleanupJob() {
  // Run cleanup every 24 hours
  setInterval(cleanupOldAttempts, 24 * 60 * 60 * 1000);
  
  // Run initial cleanup
  cleanupOldAttempts();
}

module.exports = {
  trackFailedAttempt,
  trackSuccessfulLogin,
  checkAccountLockout,
  checkSuspiciousActivity,
  getGenericAuthError,
  initializeCleanupJob,
  getSecurityConfig,
  resetSecurityConfigCache
};
