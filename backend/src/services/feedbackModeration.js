const { db } = require('../database/db');
const logger = require('../utils/logger');

class FeedbackModerationService {
  constructor() {
    this.wordFiltersCache = null;
    this.cacheExpiry = null;
    this.CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Get word filters (with caching)
   */
  async getWordFilters() {
    try {
      // Check cache
      if (this.wordFiltersCache && this.cacheExpiry && Date.now() < this.cacheExpiry) {
        return this.wordFiltersCache;
      }
      
      // Fetch from database
      const filters = await db('feedback_word_filters')
        .where('is_active', true)
        .select('word', 'severity');
      
      // Update cache
      this.wordFiltersCache = filters;
      this.cacheExpiry = Date.now() + this.CACHE_DURATION;
      
      return filters;
    } catch (error) {
      logger.error('Error getting word filters:', error);
      return [];
    }
  }

  /**
   * Clear word filters cache
   */
  clearCache() {
    this.wordFiltersCache = null;
    this.cacheExpiry = null;
  }

  /**
   * Check if text contains inappropriate content
   */
  async moderateText(text) {
    try {
      if (!text || typeof text !== 'string') {
        return { approved: true };
      }
      
      const filters = await this.getWordFilters();
      const violations = [];
      const lowerText = text.toLowerCase();
      
      for (const filter of filters) {
        // Create regex for whole word matching
        const regex = new RegExp(`\\b${this.escapeRegex(filter.word.toLowerCase())}\\b`, 'gi');
        if (regex.test(lowerText)) {
          violations.push({
            word: filter.word,
            severity: filter.severity
          });
        }
      }
      
      // Check for severe violations
      if (violations.some(v => v.severity === 'severe')) {
        return {
          approved: false,
          reason: 'Content contains prohibited words',
          violations: violations.filter(v => v.severity === 'severe')
        };
      }
      
      // Check for moderate violations
      if (violations.some(v => v.severity === 'moderate')) {
        return {
          approved: false,
          reason: 'Content requires moderation',
          violations
        };
      }
      
      // Check for mild violations (may just flag for review)
      if (violations.length > 0) {
        return {
          approved: true,
          flagged: true,
          reason: 'Content contains potentially inappropriate words',
          violations
        };
      }
      
      // Additional checks
      const additionalChecks = this.performAdditionalChecks(text);
      if (!additionalChecks.passed) {
        return {
          approved: false,
          reason: additionalChecks.reason
        };
      }
      
      return { approved: true };
    } catch (error) {
      logger.error('Error moderating text:', error);
      // In case of error, err on the side of caution
      return {
        approved: false,
        reason: 'Moderation system error'
      };
    }
  }

  /**
   * Perform additional content checks
   */
  performAdditionalChecks(text) {
    // Check for excessive caps
    const capsRatio = (text.match(/[A-Z]/g) || []).length / text.length;
    if (text.length > 10 && capsRatio > 0.7) {
      return {
        passed: false,
        reason: 'Excessive use of capital letters'
      };
    }
    
    // Check for spam patterns
    if (this.detectSpamPatterns(text)) {
      return {
        passed: false,
        reason: 'Content appears to be spam'
      };
    }
    
    // Check for excessive special characters
    const specialCharRatio = (text.match(/[!@#$%^&*()]/g) || []).length / text.length;
    if (text.length > 10 && specialCharRatio > 0.3) {
      return {
        passed: false,
        reason: 'Excessive use of special characters'
      };
    }
    
    return { passed: true };
  }

  /**
   * Detect common spam patterns
   */
  detectSpamPatterns(text) {
    const spamPatterns = [
      /\b(buy|cheap|discount|offer|sale|deal)\s+(now|today|here)/gi,
      /\b(click|visit|check)\s+(here|link|this)/gi,
      /\b(viagra|cialis|pills|drugs)\b/gi,
      /\b(casino|betting|poker|slots)\b/gi,
      /\b(make|earn)\s+\$?\d+/gi,
      /https?:\/\/[^\s]+/gi, // URLs (might want to allow in some cases)
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, // Email addresses
      /\b\d{3,}\s?\d{3,}\s?\d{4,}\b/g // Phone numbers
    ];
    
    return spamPatterns.some(pattern => pattern.test(text));
  }

  /**
   * Escape special regex characters
   */
  escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Add word filter
   */
  async addWordFilter(word, severity = 'moderate') {
    try {
      await db('feedback_word_filters').insert({
        word: word.toLowerCase(),
        severity,
        is_active: true,
        created_at: new Date()
      });
      
      this.clearCache();
      logger.info(`Added word filter: ${word} (${severity})`);
      
      return true;
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT' || error.code === '23505') {
        throw new Error('Word filter already exists');
      }
      logger.error('Error adding word filter:', error);
      throw error;
    }
  }

  /**
   * Update word filter
   */
  async updateWordFilter(id, updates) {
    try {
      await db('feedback_word_filters')
        .where('id', id)
        .update(updates);
      
      this.clearCache();
      return true;
    } catch (error) {
      logger.error('Error updating word filter:', error);
      throw error;
    }
  }

  /**
   * Delete word filter
   */
  async deleteWordFilter(id) {
    try {
      await db('feedback_word_filters')
        .where('id', id)
        .delete();
      
      this.clearCache();
      return true;
    } catch (error) {
      logger.error('Error deleting word filter:', error);
      throw error;
    }
  }

  /**
   * Get all word filters (for admin)
   */
  async getAllWordFilters() {
    try {
      return await db('feedback_word_filters')
        .orderBy('severity', 'desc')
        .orderBy('word', 'asc');
    } catch (error) {
      logger.error('Error getting all word filters:', error);
      throw error;
    }
  }

  /**
   * Sanitize text for display (remove but don't reject)
   */
  sanitizeText(text) {
    // Remove excessive whitespace
    text = text.replace(/\s+/g, ' ').trim();
    
    // Remove zero-width characters
    text = text.replace(/[\u200B-\u200D\uFEFF]/g, '');
    
    // Limit consecutive special characters
    text = text.replace(/([!?.]){3,}/g, '$1$1');
    
    return text;
  }

  /**
   * Check if user should be rate limited based on previous violations
   */
  async checkUserReputation(guestIdentifier, eventId) {
    try {
      // Count recent violations
      const recentViolations = await db('photo_feedback')
        .where('guest_identifier', guestIdentifier)
        .where('event_id', eventId)
        .where('is_hidden', true)
        .where('created_at', '>', new Date(Date.now() - 24 * 60 * 60 * 1000)) // Last 24 hours
        .count('id as count')
        .first();
      
      // If user has multiple violations, they might be problematic
      if (recentViolations && recentViolations.count > 3) {
        return {
          trusted: false,
          reason: 'Multiple recent violations'
        };
      }
      
      // Check total approved comments
      const approvedComments = await db('photo_feedback')
        .where('guest_identifier', guestIdentifier)
        .where('event_id', eventId)
        .where('feedback_type', 'comment')
        .where('is_approved', true)
        .where('is_hidden', false)
        .count('id as count')
        .first();
      
      // User with many approved comments is trusted
      if (approvedComments && approvedComments.count > 10) {
        return {
          trusted: true,
          autoApprove: true
        };
      }
      
      return { trusted: true };
    } catch (error) {
      logger.error('Error checking user reputation:', error);
      return { trusted: true }; // Default to trusting in case of error
    }
  }
}

module.exports = new FeedbackModerationService();