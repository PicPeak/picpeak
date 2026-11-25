const { db } = require('../database/db');
const logger = require('../utils/logger');

class SecureImageService {
  /**
   * Log image access for security monitoring
   */
  async logImageAccess(photoId, eventId, clientInfo, accessType = 'view', metadata = {}) {
    try {
      // client_fingerprint is the rate-limit fingerprint: an IPv6 /64 is one
      // client (issue 1564). The raw address stays in client_ip for the audit
      // trail.
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
    } catch (error) {
      logger.error('Error logging image access:', error);
    }
  }
}

module.exports = new SecureImageService();
