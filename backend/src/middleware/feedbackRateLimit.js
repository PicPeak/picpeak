const crypto = require('crypto');
const { db } = require('../database/db');
const logger = require('../utils/logger');

/**
 * Generate a unique identifier for the guest.
 *
 * In guest identity mode, `req.guest.identifier` is a server-issued UUID
 * unique per person per event (set by the resolveGuest middleware). When
 * present it takes precedence, so rate limits and deduplication become
 * per-person instead of per-device.
 *
 * In simple (legacy) mode, the identifier falls back to a hash of IP + UA,
 * matching prior behavior.
 */
function generateGuestIdentifier(req) {
  if (req.guest && req.guest.identifier) {
    return req.guest.identifier;
  }
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const userAgent = req.headers['user-agent'] || 'unknown';
  return crypto
    .createHash('sha256')
    .update(`${ip}:${userAgent}`)
    .digest('hex');
}

/**
 * Get rate limit settings from app_settings
 */
async function getRateLimitSettings() {
  try {
    const settings = await db('app_settings')
      .where('setting_key', 'feedback_rate_limits')
      .first();
    
    if (settings && settings.setting_value) {
      // setting_value is already a JSON object in PostgreSQL
      return typeof settings.setting_value === 'string' 
        ? JSON.parse(settings.setting_value)
        : settings.setting_value;
    }
    
    // Default settings
    return {
      rating: { max: 100, window: 3600 }, // 100 ratings per hour
      comment: { max: 20, window: 3600 }, // 20 comments per hour
      like: { max: 200, window: 3600 }, // 200 likes per hour
      favorite: { max: 100, window: 3600 } // 100 favorites per hour
    };
  } catch (error) {
    logger.error('Error getting rate limit settings:', error);
    // Return defaults on error
    return {
      rating: { max: 100, window: 3600 },
      comment: { max: 20, window: 3600 },
      like: { max: 200, window: 3600 },
      favorite: { max: 100, window: 3600 }
    };
  }
}

/**
 * Check if action is rate limited
 */
async function checkRateLimit(identifier, eventId, actionType) {
  try {
    const settings = await getRateLimitSettings();
    const limit = settings[actionType] || { max: 100, window: 3600 };
    
    // Clean old entries (older than window)
    const cutoff = new Date(Date.now() - limit.window * 1000);
    await db('feedback_rate_limits')
      .where('window_start', '<', cutoff)
      .delete();
    
    // Count recent actions
    const recentActions = await db('feedback_rate_limits')
      .where({
        identifier,
        event_id: eventId,
        action_type: actionType
      })
      .where('window_start', '>', cutoff)
      .sum('action_count as total')
      .first();
    
    const currentCount = recentActions?.total || 0;
    
    if (currentCount >= limit.max) {
      return {
        limited: true,
        limit: limit.max,
        window: limit.window,
        current: currentCount,
        resetAt: new Date(Date.now() + limit.window * 1000)
      };
    }
    
    return {
      limited: false,
      limit: limit.max,
      window: limit.window,
      current: currentCount,
      remaining: limit.max - currentCount
    };
  } catch (error) {
    logger.error('Error checking rate limit:', error);
    // Allow action on error to avoid blocking legitimate users
    return { limited: false };
  }
}

/**
 * Record an action for rate limiting
 */
async function recordAction(identifier, eventId, actionType) {
  try {
    await db('feedback_rate_limits').insert({
      identifier,
      event_id: eventId,
      action_type: actionType,
      action_count: 1,
      window_start: new Date()
    });
  } catch (error) {
    logger.error('Error recording rate limit action:', error);
  }
}

/**
 * Middleware factory for feedback rate limiting
 */
function feedbackRateLimit(actionType) {
  return async (req, res, next) => {
    try {
      // Extract event ID from params, body or event object (set by verifyGalleryAccess)
      const eventId = req.params.eventId || req.body?.event_id || req.event?.id;
      if (!eventId) {
        return res.status(400).json({ error: 'Event ID required' });
      }
      
      // Generate guest identifier
      const identifier = generateGuestIdentifier(req);
      req.guestIdentifier = identifier;
      
      // Check rate limit
      const rateLimitStatus = await checkRateLimit(identifier, eventId, actionType);
      
      // Set rate limit headers
      res.set({
        'X-RateLimit-Limit': rateLimitStatus.limit,
        'X-RateLimit-Remaining': rateLimitStatus.remaining || 0,
        'X-RateLimit-Reset': rateLimitStatus.resetAt ? rateLimitStatus.resetAt.toISOString() : new Date().toISOString()
      });
      
      if (rateLimitStatus.limited) {
        logger.warn(`Rate limit exceeded for ${actionType}`, {
          identifier: identifier.substring(0, 16) + '...',
          eventId,
          actionType
        });
        
        return res.status(429).json({
          error: 'Too many requests',
          message: `Rate limit exceeded. Please try again later.`,
          retryAfter: rateLimitStatus.window
        });
      }
      
      // Record the action after successful processing
      res.on('finish', async () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          await recordAction(identifier, eventId, actionType);
        }
      });
      
      next();
    } catch (error) {
      logger.error('Error in rate limit middleware:', error);
      // Allow request to proceed on error
      next();
    }
  };
}

/**
 * IP-based rate limiting for more strict control
 */
function strictRateLimit(options = {}) {
  const {
    windowMs = 15 * 60 * 1000, // 15 minutes
    max = 100, // limit each IP to 100 requests per windowMs
    message = 'Too many requests from this IP, please try again later.',
    skipSuccessfulRequests = false
  } = options;
  
  const store = new Map();
  
  // Clean up old entries periodically
  setInterval(() => {
    const now = Date.now();
    for (const [key, data] of store.entries()) {
      if (data.resetTime < now) {
        store.delete(key);
      }
    }
  }, windowMs);
  
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const resetTime = now + windowMs;
    
    let data = store.get(ip);
    if (!data || data.resetTime < now) {
      data = {
        count: 0,
        resetTime
      };
      store.set(ip, data);
    }
    
    if (data.count >= max) {
      return res.status(429).json({
        error: 'Too many requests',
        message,
        retryAfter: Math.ceil((data.resetTime - now) / 1000)
      });
    }
    
    if (!skipSuccessfulRequests || res.statusCode >= 400) {
      data.count++;
    }
    
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - data.count));
    res.setHeader('X-RateLimit-Reset', new Date(data.resetTime).toISOString());
    
    next();
  };
}

module.exports = {
  feedbackRateLimit,
  strictRateLimit,
  generateGuestIdentifier,
  checkRateLimit,
  recordAction
};