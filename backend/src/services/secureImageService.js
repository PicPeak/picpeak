const crypto = require('crypto');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { rateLimitKey } = require('../utils/rateLimitKey');

class SecureImageService {
  constructor() {
    this.rateLimitCache = new Map();
    this.rateLimitWindows = new Map();
    this.cleanupTimer = null;
  }

  start() {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    this.cleanupTimer.unref();
  }

  stop() {
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }

  dispose() {
    this.stop();
    this.rateLimitCache.clear();
    this.rateLimitWindows.clear();
  }

  /**
   * Create client fingerprint from request.
   *
   * Binds a secure image token to the device it was minted for, so it keys
   * on the full address. Rate limits and block lists use
   * createRateLimitFingerprint() instead (issue 1564).
   */
  createClientFingerprint(req) {
    return this.fingerprintFor(req, req.ip);
  }

  /**
   * The same fingerprint with the address collapsed by rateLimitKey: an IPv6
   * /64 is one client, so rotating through it neither resets the image rate
   * limit nor escapes a block. For a plain IPv4 client it equals
   * createClientFingerprint(), so nothing changes there. Never use it for
   * token binding: that would let every device in the /64 use one token.
   */
  createRateLimitFingerprint(req) {
    return this.fingerprintFor(req, rateLimitKey(req) || req.ip);
  }

  fingerprintFor(req, address) {
    const components = [
      address,
      req.get('User-Agent') || '',
      req.get('Accept-Language') || '',
      req.get('Accept-Encoding') || ''
    ];
    
    return crypto
      .createHash('sha256')
      .update(components.join('|'))
      .digest('hex')
      .substring(0, 16);
  }

  /**
   * Rate limiting for image requests
   */
  checkRateLimit(clientId, limit = 50, windowMs = 60000) {
    if (!this.peekRateLimit(clientId, limit, windowMs)) return false;
    this.recordRateLimit(clientId, windowMs);
    return true;
  }

  /**
   * Whether one more request fits the window, without counting it. With
   * recordRateLimit() a caller checks several windows before charging any,
   * so a request refused by one window does not spend the others.
   */
  peekRateLimit(clientId, limit, windowMs) {
    const windowStart = Date.now() - windowMs;
    const recentRequests = (this.rateLimitCache.get(clientId) || [])
      .filter(timestamp => timestamp > windowStart);
    this.rateLimitCache.set(clientId, recentRequests);
    // cleanup() prunes each key by its own window, not a fixed minute.
    this.rateLimitWindows.set(clientId, windowMs);
    return recentRequests.length < limit;
  }

  recordRateLimit(clientId, windowMs) {
    // The sweep used to start with the first minted token; the rate windows
    // are what is left to prune, so it starts with the first charge.
    this.start();
    if (!this.rateLimitCache.has(clientId)) this.rateLimitCache.set(clientId, []);
    this.rateLimitWindows.set(clientId, windowMs);
    this.rateLimitCache.get(clientId).push(Date.now());
  }

  /**
   * Log image access for security monitoring
   */
  async logImageAccess(photoId, eventId, clientInfo, accessType = 'view', metadata = {}) {
    try {
      // client_fingerprint is what the suspicious-activity checks count on,
      // so it is the rate-limit fingerprint: an IPv6 /64 is one client and
      // rotating through it does not dilute the count (issue 1564). The raw
      // address stays in client_ip for the audit trail.
      const countKey = clientInfo.rateLimitFingerprint || clientInfo.fingerprint;
      const logEntry = {
        photo_id: photoId,
        event_id: eventId,
        client_ip: clientInfo.ip,
        user_agent: clientInfo.userAgent?.substring(0, 500), // Limit length
        access_type: accessType,
        client_fingerprint: countKey?.substring(0, 32) || 'unknown',
        accessed_at: new Date().toISOString(),
        metadata: JSON.stringify({
          timestamp: clientInfo.timestamp || Date.now(),
          ...metadata
        })
      };

      await db('image_access_logs').insert(logEntry);

      // Check for rapid successive access (potential scraping)
      if (accessType === 'view' || accessType === 'download') {
        await this.checkForRapidAccess(countKey, photoId, eventId);
      }

    } catch (error) {
      logger.error('Error logging image access:', error);
    }
  }

  /**
   * Enhanced suspicious activity detection
   */
  async checkForRapidAccess(clientFingerprint, photoId, eventId = null) {
    try {
      const fiveMinutesAgo = new Date(Date.now() - 300000).toISOString();
      
      // Check accesses to same photo
      const samePhotoAccess = await db('image_access_logs')
        .where('client_fingerprint', clientFingerprint)
        .where('photo_id', photoId)
        .where('accessed_at', '>', fiveMinutesAgo)
        .count('* as count')
        .first();

      // Check total accesses across all photos
      const totalAccess = await db('image_access_logs')
        .where('client_fingerprint', clientFingerprint)
        .where('accessed_at', '>', fiveMinutesAgo)
        .count('* as count')
        .first();

      const samePhotoCount = parseInt(samePhotoAccess.count);
      const totalCount = parseInt(totalAccess.count);

      // Flag if suspicious patterns detected
      if (samePhotoCount > 5 || totalCount > 30) {
        await this.flagSuspiciousActivity(
          clientFingerprint, 
          photoId, 
          'rapid_access',
          { samePhotoCount, totalCount, eventId }
        );
      }

    } catch (error) {
      logger.error('Error checking for rapid access:', error);
    }
  }

  /**
   * Flag suspicious activity and take action
   */
  async flagSuspiciousActivity(clientFingerprint, photoId, reason, details = {}) {
    try {
      // Try to get event_id from photo
      let eventId = details.eventId;
      if (!eventId && photoId) {
        const photo = await db('photos').where({ id: photoId }).first();
        eventId = photo?.event_id;
      }
      
      // Log the suspicious activity
      await db('image_access_logs').insert({
        photo_id: photoId,
        event_id: eventId || 0, // Use 0 as a fallback for suspicious activity without event context
        client_ip: details.clientIp || 'unknown',
        client_fingerprint: clientFingerprint,
        access_type: 'suspicious',
        accessed_at: new Date().toISOString(),
        metadata: JSON.stringify({
          reason,
          ...details,
          flaggedAt: Date.now()
        })
      });

      logger.warn(`Suspicious activity flagged: ${reason}`, {
        clientFingerprint,
        photoId,
        details
      });

      // If multiple suspicious activities, consider blocking
      const recentSuspicious = await db('image_access_logs')
        .where('client_fingerprint', clientFingerprint)
        .where('access_type', 'suspicious')
        .where('accessed_at', '>', new Date(Date.now() - 3600000).toISOString()) // Last hour
        .count('* as count')
        .first();

      if (parseInt(recentSuspicious.count) >= 3) {
        logger.warn(`Client fingerprint flagged for blocking: ${clientFingerprint}`);
        // This would be handled by the middleware's blocking system
      }

    } catch (error) {
      logger.error('Error flagging suspicious activity:', error);
    }
  }

  /**
   * Detect suspicious access patterns
   */
  async detectSuspiciousActivity(clientFingerprint, photoId) {
    try {
      const recentAccess = await db('image_access_logs')
        .where('client_fingerprint', clientFingerprint)
        .where('photo_id', photoId)
        .where('accessed_at', '>', new Date(Date.now() - 300000).toISOString()) // Last 5 minutes
        .count('* as count')
        .first();

      const accessCount = parseInt(recentAccess.count);
      
      // Flag if more than 10 accesses to same photo in 5 minutes
      if (accessCount > 10) {
        logger.warn(`Suspicious activity detected: ${accessCount} accesses to photo ${photoId} from ${clientFingerprint}`);
        return true;
      }

      return false;
    } catch (error) {
      logger.error('Error detecting suspicious activity:', error);
      return false;
    }
  }

  /**
   * Clean up expired tokens and logs
   */
  cleanup() {
    // Clear expired rate limit entries
    const now = Date.now();
    for (const [clientId, requests] of this.rateLimitCache.entries()) {
      // A fixed minute here emptied the five-minute and hourly windows every
      // minute, so only the per-minute limits ever held.
      const windowMs = this.rateLimitWindows.get(clientId) || 60000;
      const recent = requests.filter(timestamp => timestamp > now - windowMs);
      if (recent.length === 0) {
        this.rateLimitCache.delete(clientId);
        this.rateLimitWindows.delete(clientId);
      } else {
        this.rateLimitCache.set(clientId, recent);
      }
    }
  }
}

module.exports = new SecureImageService();
