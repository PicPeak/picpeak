const cleanupTimers = new Set();
const crypto = require('crypto');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { rateLimitKey } = require('../utils/rateLimitKey');

const { anonymousFeedbackIdentifier } = require('../utils/anonymousFeedbackIdentity');

async function generateGuestIdentifier(req) {
  return req.guest?.identifier || await anonymousFeedbackIdentifier(req);
}

/**
 * Per-action-type rate limits, in one place — the happy path and the
 * error path used to keep separate copies, and the error copy silently
 * missed every action type added after it was written.
 */
const DEFAULT_RATE_LIMITS = {
  rating: { max: 100, window: 3600 }, // 100 ratings per hour
  comment: { max: 20, window: 3600 }, // 20 comments per hour
  like: { max: 200, window: 3600 }, // 200 likes per hour
  favorite: { max: 100, window: 3600 }, // 100 favorites per hour
  reaction: { max: 200, window: 3600 }, // reactions churn like likes (#839)
  // Colour labels (#1044) are the keyboard-driven proofing path: a client
  // works through a 500-photo shoot pressing 1/2/3, and changing their mind
  // costs a second request. A likes-sized 200/h cap would lock them out
  // mid-session, so this one is deliberately generous.
  color_label: { max: 2000, window: 3600 }
};

/**
 * Get rate limit settings from app_settings
 */
async function getRateLimitSettings() {
  try {
    const settings = await db('app_settings')
      .where('setting_key', 'feedback_rate_limits')
      .first();
    
    // Defaults FIRST, stored values override: persisted rows predate newer
    // action types (`reaction`, #839) — returning the stored object alone
    // would silently drop their intended defaults to the generic 100/h.
    const defaults = { ...DEFAULT_RATE_LIMITS };

    if (settings && settings.setting_value) {
      // setting_value is already a JSON object in PostgreSQL
      const stored = typeof settings.setting_value === 'string'
        ? JSON.parse(settings.setting_value)
        : settings.setting_value;
      return { ...defaults, ...stored };
    }

    return defaults;
  } catch (error) {
    logger.error('Error getting rate limit settings:', error);
    // Return defaults on error
    return { ...DEFAULT_RATE_LIMITS };
  }
}

/** Reserve budget before processing feedback. The event row serializes
 * reservations on PostgreSQL, including requests handled by other servers.
 * SQLite serializes writers; a busy/error response fails closed.
 */
async function consumeFeedbackLimit(req, actionType) {
  const eventId = req.event?.id;
  if (!eventId) throw new Error('Authenticated event context required');
  const settings = await getRateLimitSettings();
  const configured = settings[actionType] || DEFAULT_RATE_LIMITS[actionType];
  const fallback = DEFAULT_RATE_LIMITS[actionType] || { max: 100, window: 3600 };
  const limit = {
    max: Number.isSafeInteger(configured?.max) && configured.max > 0 ? configured.max : fallback.max,
    window: Number.isSafeInteger(configured?.window) && configured.window > 0 ? configured.window : fallback.window
  };
  const identifier = await generateGuestIdentifier(req);
  const ip = rateLimitKey(req) || 'unknown';
  const ipIdentifier = crypto.createHash('sha256').update(`feedback-ip:${ip}`).digest('hex');
  const budgets = [
    { identifier, max: limit.max },
    // Accommodate shared event Wi-Fi while bounding cookie/identity churn.
    { identifier: ipIdentifier, max: Math.max(200, limit.max * 10) }
  ];
  return db.transaction(async (trx) => {
    let eventQuery = trx('events').where({ id: eventId }).select('id');
    if (trx.client.config.client === 'pg') eventQuery = eventQuery.forUpdate();
    if (!(await eventQuery.first())) throw new Error('Event no longer available');
    const cutoff = new Date(Date.now() - limit.window * 1000);
    await trx('feedback_rate_limits').where({ event_id: eventId, action_type: actionType })
      .where('window_start', '<', cutoff).delete();
    let remaining = limit.max;
    for (const budget of budgets) {
      const row = await trx('feedback_rate_limits')
        .where({ identifier: budget.identifier, event_id: eventId, action_type: actionType })
        .where('window_start', '>=', cutoff).sum('action_count as total').first();
      const used = Number(row?.total || 0);
      if (used >= budget.max) return { limited: true, limit: limit.max, remaining: 0, window: limit.window };
      if (budget.identifier === identifier) remaining = limit.max - used - 1;
    }
    await trx('feedback_rate_limits').insert(budgets.map(budget => ({
      identifier: budget.identifier, event_id: eventId, action_type: actionType,
      action_count: 1, window_start: new Date()
    })));
    return { limited: false, limit: limit.max, remaining, window: limit.window };
  });
}

/**
 * Backstop sweep for orphaned feedback_rate_limits rows (#1585).
 *
 * consumeFeedbackLimit() only ever deletes rows for the (event_id,
 * action_type) pair it is currently processing, so a gallery that stops
 * receiving feedback — or an action type nobody uses again — leaves its
 * rows behind forever; each accepted action inserts two (guest + IP budget).
 * This runs periodically (see feedbackRateLimitCleanupService) and deletes
 * anything older than 2x the widest configured window across all action
 * types — double, rather than the window itself, so a row is never swept
 * out from under a request that is still mid-window against it.
 */
async function sweepStaleFeedbackRateLimits() {
  const settings = await getRateLimitSettings();
  const maxWindowSeconds = Object.keys(DEFAULT_RATE_LIMITS).reduce((max, actionType) => {
    const configured = settings[actionType];
    const window = Number.isSafeInteger(configured?.window) && configured.window > 0
      ? configured.window
      : DEFAULT_RATE_LIMITS[actionType].window;
    return Math.max(max, window);
  }, 0);
  // A plain Date object, not .toISOString() — consumeFeedbackLimit() above
  // inserts window_start as a Date too (line ~101), and window_start is a
  // `table.timestamp(...)` column. On SQLite that gives it NUMERIC column
  // affinity; comparing it against a TEXT cutoff falls back to SQLite's
  // storage-class sort order, where every INTEGER sorts below every TEXT
  // value — so a TEXT cutoff would match (and delete) every row
  // unconditionally, regardless of actual age.
  const cutoff = new Date(Date.now() - maxWindowSeconds * 2 * 1000);
  const deleted = await db('feedback_rate_limits').where('window_start', '<', cutoff).delete();
  if (deleted > 0) logger.info(`Feedback rate-limit sweep removed ${deleted} stale row(s)`);
  return deleted;
}

function feedbackRateLimit(actionType) {
  return async (req, res, next) => {
    try {
      const status = await consumeFeedbackLimit(req, actionType);
      res.set({
        'X-RateLimit-Limit': status.limit,
        'X-RateLimit-Remaining': status.remaining,
        'X-RateLimit-Reset': new Date(Date.now() + status.window * 1000).toISOString()
      });
      if (status.limited) {
        res.setHeader('Retry-After', status.window);
        return res.status(429).json({ error: 'Too many requests', retryAfter: status.window });
      }
      return next();
    } catch (error) {
      logger.error('Feedback rate-limit reservation failed', { error: error.message });
      return res.status(503).json({ error: 'Feedback is temporarily unavailable', code: 'FEEDBACK_LIMIT_UNAVAILABLE' });
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
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, data] of store.entries()) {
      if (data.resetTime < now) {
        store.delete(key);
      }
    }
  }, windowMs);
  cleanupTimer.unref();
  cleanupTimers.add(cleanupTimer);
  
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
  dispose() { cleanupTimers.forEach(clearInterval); cleanupTimers.clear(); },
  feedbackRateLimit,
  strictRateLimit,
  generateGuestIdentifier,
  consumeFeedbackLimit,
  sweepStaleFeedbackRateLimits
};