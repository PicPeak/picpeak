const crypto = require('crypto');
const sharp = require('sharp');
const { db } = require('../database/db');
const watermarkService = require('./watermarkService');
const path = require('path');
const fs = require('fs').promises;

class SecureImageService {
  constructor() {
    this.tokenCache = new Map();
    this.sessionTokens = new Map();
    this.rateLimitCache = new Map();
  }

  /**
   * Generate a secure, time-limited, single-use token for image access
   */
  generateSecureToken(photoId, sessionId, options = {}) {
    const {
      expiresIn = 300, // 5 minutes default
      maxUses = 1,
      clientFingerprint = '',
      protectionLevel = 'standard'
    } = options;

    const tokenData = {
      photoId: parseInt(photoId),
      sessionId,
      clientFingerprint,
      expiresAt: Date.now() + (expiresIn * 1000),
      maxUses,
      usedCount: 0,
      protectionLevel,
      createdAt: Date.now()
    };

    // Create tamper-proof token
    const tokenPayload = Buffer.from(JSON.stringify(tokenData)).toString('base64');
    const imageSecret = process.env.IMAGE_SECRET || process.env.JWT_SECRET + '_IMAGE_PROTECTION';
    const signature = crypto
      .createHmac('sha256', process.env.JWT_SECRET + imageSecret)
      .update(tokenPayload)
      .digest('hex');
    
    const token = `${tokenPayload}.${signature}`;
    
    // Cache token with metadata
    this.tokenCache.set(token, tokenData);
    
    // Set cleanup timer
    setTimeout(() => {
      this.tokenCache.delete(token);
    }, expiresIn * 1000 + 60000); // Add 1 minute buffer

    return token;
  }

  /**
   * Verify and consume secure token
   */
  verifySecureToken(token, clientFingerprint = '') {
    try {
      const cached = this.tokenCache.get(token);
      if (!cached) {
        return { valid: false, reason: 'Token not found or expired' };
      }

      // Verify token integrity
      const [payload, signature] = token.split('.');
      const imageSecret = process.env.IMAGE_SECRET || process.env.JWT_SECRET + '_IMAGE_PROTECTION';
      const expectedSignature = crypto
        .createHmac('sha256', process.env.JWT_SECRET + imageSecret)
        .update(payload)
        .digest('hex');

      if (signature !== expectedSignature) {
        return { valid: false, reason: 'Token tampered' };
      }

      // Check expiration
      if (Date.now() > cached.expiresAt) {
        this.tokenCache.delete(token);
        return { valid: false, reason: 'Token expired' };
      }

      // Check usage count
      if (cached.usedCount >= cached.maxUses) {
        return { valid: false, reason: 'Token max uses exceeded' };
      }

      // Verify client fingerprint for enhanced security
      if (cached.protectionLevel === 'enhanced' && cached.clientFingerprint !== clientFingerprint) {
        return { valid: false, reason: 'Client fingerprint mismatch' };
      }

      // Consume usage
      cached.usedCount++;
      
      // Remove token if max uses reached
      if (cached.usedCount >= cached.maxUses) {
        this.tokenCache.delete(token);
      }

      return { 
        valid: true, 
        data: cached,
        remaining: cached.maxUses - cached.usedCount
      };
    } catch (error) {
      return { valid: false, reason: 'Token verification failed' };
    }
  }

  /**
   * Create client fingerprint from request
   */
  createClientFingerprint(req) {
    const components = [
      req.ip,
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
    const now = Date.now();
    const windowStart = now - windowMs;
    
    if (!this.rateLimitCache.has(clientId)) {
      this.rateLimitCache.set(clientId, []);
    }
    
    const requests = this.rateLimitCache.get(clientId);
    
    // Remove old requests outside the window
    const recentRequests = requests.filter(timestamp => timestamp > windowStart);
    this.rateLimitCache.set(clientId, recentRequests);
    
    if (recentRequests.length >= limit) {
      return false;
    }
    
    // Add current request
    recentRequests.push(now);
    return true;
  }

  /**
   * Process image with protection measures
   * For basic/standard protection without fingerprinting, returns original file
   * For enhanced/maximum protection, applies quality reduction and fingerprinting
   */
  async processProtectedImage(imagePath, options = {}) {
    const {
      protectionLevel = 'standard',
      quality = 85,
      maxWidth = 1920,
      maxHeight = 1080,
      addFingerprint = true,
      fragmentImage = false
    } = options;

    try {
      // For basic protection level, always return original file without processing
      if (protectionLevel === 'basic') {
        return await fs.readFile(imagePath);
      }

      // For standard protection without fingerprinting, return original file
      // This avoids unnecessary recompression when no protection features are needed
      if (protectionLevel === 'standard' && !addFingerprint && !fragmentImage) {
        return await fs.readFile(imagePath);
      }

      // Get metadata to check if processing is actually needed
      const metadata = await sharp(imagePath).metadata();

      // For standard protection with fingerprint only (no resize needed, no quality change),
      // we can add fingerprint without full recompression by preserving format
      const needsResize = metadata.width > maxWidth || metadata.height > maxHeight;
      const needsQualityReduction = protectionLevel === 'enhanced' || protectionLevel === 'maximum';

      // If standard protection and only fingerprinting is needed, and image doesn't need resize,
      // just add metadata without recompressing
      if (protectionLevel === 'standard' && addFingerprint && !needsResize) {
        let image = sharp(imagePath);

        // Add fingerprint to metadata without changing image quality
        const fingerprint = crypto.randomBytes(16).toString('hex');

        // Preserve original format with high quality
        const format = metadata.format || 'jpeg';
        if (format === 'png') {
          image = image.png({ compressionLevel: 6 });
        } else if (format === 'webp') {
          image = image.webp({ quality: 95 });
        } else {
          image = image.jpeg({ quality: 100, mozjpeg: true });
        }

        image = image.withMetadata({
          exif: {
            [sharp.EXIF.IFD0.ImageDescription]: `Protected:${fingerprint}`
          }
        });

        return await image.toBuffer();
      }

      // For enhanced/maximum protection or when resize is needed, do full processing
      let image = sharp(imagePath);
      let effectiveQuality = quality;

      // Resize if too large
      if (needsResize) {
        image = image.resize(maxWidth, maxHeight, {
          fit: 'inside',
          withoutEnlargement: true
        });
      }

      // Apply quality reduction for protection
      if (protectionLevel === 'enhanced') {
        effectiveQuality = Math.min(quality, 70);
      } else if (protectionLevel === 'maximum') {
        effectiveQuality = Math.min(quality, 60);
      }

      // Preserve original format when possible, apply quality settings
      const format = metadata.format || 'jpeg';
      if (format === 'png' && !needsQualityReduction) {
        image = image.png({ compressionLevel: 6 });
      } else if (format === 'webp') {
        image = image.webp({ quality: effectiveQuality });
      } else {
        // JPEG or when quality reduction is needed (convert to JPEG)
        image = image.jpeg({ quality: effectiveQuality, progressive: true });
      }

      // Add invisible watermark/fingerprint
      if (addFingerprint) {
        const fingerprint = crypto.randomBytes(16).toString('hex');

        // Embed fingerprint in metadata
        image = image.withMetadata({
          exif: {
            [sharp.EXIF.IFD0.ImageDescription]: `Protected:${fingerprint}`
          }
        });
      }

      const buffer = await image.toBuffer();

      // Fragment image if requested (for canvas reconstruction)
      if (fragmentImage && protectionLevel === 'maximum') {
        return await this.fragmentImageBuffer(buffer, metadata);
      }

      return buffer;
    } catch (error) {
      console.error('Error processing protected image:', error);
      // Return original on error
      return await fs.readFile(imagePath);
    }
  }

  /**
   * Fragment image into multiple pieces for canvas reconstruction
   */
  async fragmentImageBuffer(buffer, metadata) {
    const { width, height } = metadata;
    const fragments = [];
    
    // Create 3x3 grid of fragments
    const cols = 3;
    const rows = 3;
    const fragmentWidth = Math.floor(width / cols);
    const fragmentHeight = Math.floor(height / rows);

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const left = col * fragmentWidth;
        const top = row * fragmentHeight;
        
        const fragment = await sharp(buffer)
          .extract({ 
            left, 
            top, 
            width: fragmentWidth, 
            height: fragmentHeight 
          })
          .toBuffer();
          
        fragments.push({
          index: row * cols + col,
          row,
          col,
          buffer: fragment,
          position: { left, top, width: fragmentWidth, height: fragmentHeight }
        });
      }
    }

    return {
      type: 'fragmented',
      fragments,
      originalDimensions: { width, height },
      fragmentDimensions: { width: fragmentWidth, height: fragmentHeight, cols, rows }
    };
  }

  /**
   * Log image access for security monitoring
   */
  async logImageAccess(photoId, eventId, clientInfo, accessType = 'view', metadata = {}) {
    try {
      const logEntry = {
        photo_id: photoId,
        event_id: eventId,
        client_ip: clientInfo.ip,
        user_agent: clientInfo.userAgent?.substring(0, 500), // Limit length
        access_type: accessType,
        client_fingerprint: clientInfo.fingerprint?.substring(0, 32) || 'unknown',
        accessed_at: new Date().toISOString(),
        metadata: JSON.stringify({
          timestamp: clientInfo.timestamp || Date.now(),
          ...metadata
        })
      };

      await db('image_access_logs').insert(logEntry);

      // Check for rapid successive access (potential scraping)
      if (accessType === 'view' || accessType === 'download') {
        await this.checkForRapidAccess(clientInfo.fingerprint, photoId, eventId);
      }

    } catch (error) {
      console.error('Error logging image access:', error);
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
      console.error('Error checking for rapid access:', error);
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

      console.warn(`Suspicious activity flagged: ${reason}`, {
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
        console.warn(`Client fingerprint flagged for blocking: ${clientFingerprint}`);
        // This would be handled by the middleware's blocking system
      }

    } catch (error) {
      console.error('Error flagging suspicious activity:', error);
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
        console.warn(`Suspicious activity detected: ${accessCount} accesses to photo ${photoId} from ${clientFingerprint}`);
        return true;
      }

      return false;
    } catch (error) {
      console.error('Error detecting suspicious activity:', error);
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
      const recent = requests.filter(timestamp => timestamp > now - 60000);
      if (recent.length === 0) {
        this.rateLimitCache.delete(clientId);
      } else {
        this.rateLimitCache.set(clientId, recent);
      }
    }
  }
}

module.exports = new SecureImageService();