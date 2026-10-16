const { db } = require('../database/db');
const logger = require('../utils/logger');

class SecureImageService {
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
        // Logged only: nothing blocks on it.
      }

    } catch (error) {
      logger.error('Error flagging suspicious activity:', error);
    }
  }
}

module.exports = new SecureImageService();
