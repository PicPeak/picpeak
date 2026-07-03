const { db } = require('../database/db');
const secureImageService = require('../services/secureImageService');
const logger = require('../utils/logger');
const { formatBoolean } = require('../utils/dbCompat');

/**
 * Enhanced secure image middleware with comprehensive protection
 */
class SecureImageMiddleware {
  constructor() {
    this.suspiciousIPs = new Set();
    this.blockedFingerprints = new Set();
    this.rateLimitViolations = new Map();
  }

  /**
   * Main security middleware for image access
   */
  secureImageAccess = async (req, res, next) => {
    try {
      const startTime = Date.now();
      const clientIP = this.getClientIP(req);
      const userAgent = req.get('User-Agent') || '';
      const clientFingerprint = secureImageService.createClientFingerprint(req);

      // Create client info object
      req.clientInfo = {
        ip: clientIP,
        userAgent,
        fingerprint: clientFingerprint,
        timestamp: startTime
      };

      // Security checks
      const securityCheck = await this.performSecurityChecks(req, res);
      if (!securityCheck.passed) {
        return res.status(securityCheck.status).json({ 
          error: securityCheck.message 
        });
      }

      // Set security headers
      this.setSecurityHeaders(res);

      // Log successful security check
      logger.info('Secure image access granted', {
        ip: clientIP,
        fingerprint: clientFingerprint,
        photoId: req.params.photoId,
        eventId: req.params.slug,
        userAgent: userAgent.substring(0, 100)
      });

      next();
    } catch (error) {
      logger.error('Secure image middleware error', {
        error: error.message,
        stack: error.stack,
        ip: req.ip,
        path: req.path
      });
      
      res.status(500).json({ 
        error: 'Security validation failed' 
      });
    }
  };

  /**
   * Perform comprehensive security checks
   */
  async performSecurityChecks(req, res) {
    const { clientInfo } = req;
    const { photoId } = req.params;

    // 1. Check if IP is blocked
    if (this.suspiciousIPs.has(clientInfo.ip)) {
      await this.logSecurityEvent('blocked_ip_access', req, { reason: 'IP on block list' });
      return { passed: false, status: 403, message: 'Access denied' };
    }

    // 2. Check if fingerprint is blocked
    if (this.blockedFingerprints.has(clientInfo.fingerprint)) {
      await this.logSecurityEvent('blocked_fingerprint_access', req, { reason: 'Fingerprint blocked' });
      return { passed: false, status: 403, message: 'Access denied' };
    }

    // 3. Rate limiting check
    const rateLimit = await this.checkRateLimit(req);
    if (!rateLimit.passed) {
      await this.logSecurityEvent('rate_limit_exceeded', req, rateLimit);
      return { passed: false, status: 429, message: 'Too many requests' };
    }

    // 4. Check for suspicious patterns
    if (photoId) {
      const suspiciousActivity = await secureImageService.detectSuspiciousActivity(
        clientInfo.fingerprint, 
        photoId
      );
      
      if (suspiciousActivity) {
        await this.logSecurityEvent('suspicious_activity', req, { 
          photoId, 
          reason: 'Multiple rapid accesses' 
        });
        
        // Add to monitoring but don't block yet
        this.flagSuspiciousActivity(clientInfo);
      }
    }

    // 5. User-Agent validation
    const userAgentValid = this.validateUserAgent(clientInfo.userAgent);
    if (!userAgentValid.valid) {
      await this.logSecurityEvent('invalid_user_agent', req, userAgentValid);
      return { passed: false, status: 400, message: 'Invalid client' };
    }

    // 6. Check request headers for automation signs
    const automationCheck = this.detectAutomation(req);
    if (automationCheck.detected) {
      await this.logSecurityEvent('automation_detected', req, automationCheck);
      return { passed: false, status: 403, message: 'Automated access not allowed' };
    }

    return { passed: true };
  }

  /**
   * Advanced rate limiting with multiple windows
   */
  async checkRateLimit(req) {
    const { clientInfo } = req;
    const now = Date.now();

    // Get rate limit settings from database
    const settings = await this.getRateLimitSettings();
    
    // Check different time windows
    const windows = [
      { duration: 60000, limit: settings.perMinute || 30 }, // 1 minute
      { duration: 300000, limit: settings.per5Minutes || 100 }, // 5 minutes
      { duration: 3600000, limit: settings.perHour || 500 } // 1 hour
    ];

    for (const window of windows) {
      const allowed = secureImageService.checkRateLimit(
        `${clientInfo.fingerprint}_${window.duration}`,
        window.limit,
        window.duration
      );

      if (!allowed) {
        // Track violations
        const violationKey = `${clientInfo.fingerprint}_violations`;
        const violations = this.rateLimitViolations.get(violationKey) || 0;
        this.rateLimitViolations.set(violationKey, violations + 1);

        // Block after multiple violations
        if (violations >= 5) {
          this.blockedFingerprints.add(clientInfo.fingerprint);
          logger.warn('Client fingerprint blocked due to repeated violations', {
            fingerprint: clientInfo.fingerprint,
            violations: violations + 1
          });
        }

        return {
          passed: false,
          window: window.duration / 1000,
          limit: window.limit,
          violations: violations + 1
        };
      }
    }

    return { passed: true };
  }

  /**
   * Validate User-Agent for legitimacy
   */
  validateUserAgent(userAgent) {
    if (!userAgent || userAgent.length < 10) {
      return { valid: false, reason: 'Missing or too short User-Agent' };
    }

    // Check for common bot patterns
    const botPatterns = [
      /curl/i, /wget/i, /scrapy/i, /python/i, /requests/i,
      /bot/i, /crawler/i, /spider/i, /scraper/i
    ];

    for (const pattern of botPatterns) {
      if (pattern.test(userAgent)) {
        return { valid: false, reason: 'Bot User-Agent detected' };
      }
    }

    // Check for valid browser patterns
    const browserPatterns = [
      /mozilla/i, /chrome/i, /safari/i, /firefox/i, /edge/i, /opera/i
    ];

    const hasValidBrowser = browserPatterns.some(pattern => pattern.test(userAgent));
    if (!hasValidBrowser) {
      return { valid: false, reason: 'Invalid browser User-Agent' };
    }

    return { valid: true };
  }

  /**
   * Detect automation and scripting attempts
   */
  detectAutomation(req) {
    const headers = req.headers;
    const suspiciousHeaders = [];

    // Check for automation indicators
    if (!headers.accept) {
      suspiciousHeaders.push('missing_accept_header');
    }

    if (!headers['accept-language']) {
      suspiciousHeaders.push('missing_accept_language');
    }

    if (!headers['accept-encoding']) {
      suspiciousHeaders.push('missing_accept_encoding');
    }

    // Check for scripting headers
    if (headers['x-requested-with'] === 'XMLHttpRequest' && !headers.referer) {
      suspiciousHeaders.push('ajax_without_referer');
    }

    // Check for headless browser indicators
    if (headers['user-agent'] && headers['user-agent'].includes('HeadlessChrome')) {
      suspiciousHeaders.push('headless_browser');
    }

    const detected = suspiciousHeaders.length >= 2;

    return {
      detected,
      suspiciousHeaders,
      score: suspiciousHeaders.length
    };
  }

  /**
   * Set comprehensive security headers
   */
  setSecurityHeaders(res) {
    res.set({
      // Prevent caching
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      'Pragma': 'no-cache',
      'Expires': '0',
      
      // Security headers
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-XSS-Protection': '1; mode=block',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'",
      
      // Custom security headers
      'X-Protected-Content': 'true',
      'X-Download-Policy': 'restricted',
      
      // CORS restrictions
      'Access-Control-Allow-Origin': process.env.FRONTEND_URL || '*',
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '3600'
    });
  }

  /**
   * Get client IP address with proxy support
   */
  getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.headers['x-real-ip'] ||
           req.connection.remoteAddress ||
           req.socket.remoteAddress ||
           req.ip;
  }

  /**
   * Flag suspicious activity for monitoring
   */
  flagSuspiciousActivity(clientInfo) {
    const key = `suspicious_${clientInfo.fingerprint}`;
    const existing = this.rateLimitViolations.get(key) || 0;
    
    this.rateLimitViolations.set(key, existing + 1);
    
    // Add to suspicious IPs after multiple flags
    if (existing >= 3) {
      this.suspiciousIPs.add(clientInfo.ip);
      logger.warn('IP added to suspicious list', {
        ip: clientInfo.ip,
        fingerprint: clientInfo.fingerprint,
        flags: existing + 1
      });
    }
  }

  /**
   * Log security events
   */
  async logSecurityEvent(eventType, req, details = {}) {
    try {
      const logData = {
        event_type: eventType,
        client_ip: req.clientInfo?.ip || req.ip,
        client_fingerprint: req.clientInfo?.fingerprint,
        user_agent: req.get('User-Agent')?.substring(0, 255),
        request_path: req.path,
        request_method: req.method,
        details: JSON.stringify(details),
        timestamp: new Date().toISOString()
      };

      logger.warn(`Security event: ${eventType}`, logData);

      // Store in database if needed
      if (process.env.LOG_SECURITY_EVENTS === 'true') {
        await db('security_logs').insert(logData).catch(console.error);
      }
    } catch (error) {
      console.error('Error logging security event:', error);
    }
  }

  /**
   * Get rate limit settings from database
   */
  async getRateLimitSettings() {
    try {
      const settings = await db('app_settings')
        .whereIn('setting_key', [
          'max_image_requests_per_minute',
          'max_image_requests_per_5_minutes',
          'max_image_requests_per_hour'
        ])
        .select('setting_key', 'setting_value');

      const config = {};
      settings.forEach(setting => {
        const key = setting.setting_key.replace('max_image_requests_per_', '');
        config[key === 'minute' ? 'perMinute' : key === '5_minutes' ? 'per5Minutes' : 'perHour'] = 
          JSON.parse(setting.setting_value);
      });

      return {
        perMinute: config.perMinute || 30,
        per5Minutes: config.per5Minutes || 100,
        perHour: config.perHour || 500
      };
    } catch (error) {
      console.error('Error getting rate limit settings:', error);
      return { perMinute: 30, per5Minutes: 100, perHour: 500 };
    }
  }

  /**
   * Clean up old security data
   */
  cleanup() {
    const now = Date.now();
    
    // Clear old rate limit violations (older than 1 hour)
    for (const [key, timestamp] of this.rateLimitViolations.entries()) {
      if (typeof timestamp === 'number' && now - timestamp > 3600000) {
        this.rateLimitViolations.delete(key);
      }
    }

    // Clean up the secure image service
    secureImageService.cleanup();
  }

  /**
   * Get security status
   */
  getSecurityStatus() {
    return {
      suspiciousIPsCount: this.suspiciousIPs.size,
      blockedFingerprintsCount: this.blockedFingerprints.size,
      activeViolations: this.rateLimitViolations.size,
      timestamp: new Date().toISOString()
    };
  }
}

// Create singleton instance
const secureImageMiddleware = new SecureImageMiddleware();

// Setup cleanup interval
setInterval(() => {
  secureImageMiddleware.cleanup();
}, 300000); // Every 5 minutes

module.exports = secureImageMiddleware;