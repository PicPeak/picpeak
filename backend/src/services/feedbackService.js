const { db, logActivity } = require('../database/db');
const logger = require('../utils/logger');
const { formatBoolean } = require('../utils/dbCompat');

class FeedbackService {
  /**
   * Get feedback settings for an event
   */
  async getEventFeedbackSettings(eventId) {
    try {
      const settings = await db('event_feedback_settings')
        .where('event_id', eventId)
        .first();
      
      if (!settings) {
        // Return default settings if none exist
        return {
          event_id: eventId,
          feedback_enabled: false,
          allow_ratings: true,
          allow_likes: true,
          allow_comments: false,
          allow_favorites: true,
          require_name_email: false,
          moderate_comments: true,
          show_feedback_to_guests: true,
          identity_mode: 'simple',
          max_favorites_per_guest: null,
          max_likes_per_guest: null,
        };
      }

      // Back-compat: rows created before migration 078 have NULL identity_mode.
      if (!settings.identity_mode) {
        settings.identity_mode = 'simple';
      }
      // Per-guest caps (#655). NULL on existing rows = unlimited; the route
      // layer treats null/0/missing identically.
      settings.max_favorites_per_guest = settings.max_favorites_per_guest ?? null;
      settings.max_likes_per_guest = settings.max_likes_per_guest ?? null;
      return settings;
    } catch (error) {
      logger.error('Error getting feedback settings:', error);
      throw error;
    }
  }

  /**
   * Update feedback settings for an event
   */
  async updateEventFeedbackSettings(eventId, settings) {
    try {
      const existing = await db('event_feedback_settings')
        .where('event_id', eventId)
        .first();
      
      if (existing) {
        await db('event_feedback_settings')
          .where('event_id', eventId)
          .update({
            ...settings,
            updated_at: new Date()
          });
      } else {
        await db('event_feedback_settings').insert({
          event_id: eventId,
          ...settings,
          created_at: new Date(),
          updated_at: new Date()
        });
      }
      
      await logActivity('feedback_settings_updated', settings, eventId);
      
      return this.getEventFeedbackSettings(eventId);
    } catch (error) {
      logger.error('Error updating feedback settings:', error);
      throw error;
    }
  }

  /**
   * Submit feedback for a photo
   */
  /**
   * Count how many existing feedback rows of `feedback_type` a single guest
   * has on a given event, matching the same guest-key shape submitFeedback's
   * duplicate-check uses (guest_id when present, fall back to
   * guest_identifier). Used for the per-guest favorite/like caps (#655).
   */
  async countGuestFeedback(eventId, feedbackType, guestId, guestIdentifier) {
    const query = db('photo_feedback')
      .where({ event_id: eventId, feedback_type: feedbackType });
    if (guestId) {
      query.where('guest_id', guestId);
    } else {
      query.where('guest_identifier', guestIdentifier);
    }
    const result = await query.count('* as count').first();
    return parseInt(result?.count, 10) || 0;
  }

  async submitFeedback(photoId, eventId, feedbackData, guestIdentifier) {
    try {
      const { feedback_type, rating, comment_text, guest_name, guest_email, ip_address, user_agent, guest_id } = feedbackData;

      // Validate feedback type
      if (!['rating', 'like', 'comment', 'favorite'].includes(feedback_type)) {
        throw new Error('Invalid feedback type');
      }

      // Check if similar feedback already exists (prevent duplicates).
      // When a per-person guest_id is present, scope the check to that guest
      // so two guests on the same device can independently like a photo.
      if (feedback_type !== 'comment') {
        const duplicateQuery = db('photo_feedback')
          .where({
            photo_id: photoId,
            event_id: eventId,
            feedback_type,
          });
        if (guest_id) {
          duplicateQuery.where('guest_id', guest_id);
        } else {
          duplicateQuery.where('guest_identifier', guestIdentifier);
        }
        const existing = await duplicateQuery.first();

        if (existing) {
          if (feedback_type === 'rating' && rating !== existing.rating) {
            // Update existing rating
            await db('photo_feedback')
              .where('id', existing.id)
              .update({
                rating,
                updated_at: new Date()
              });

            await this.updatePhotoFeedbackStats(photoId);
            return { id: existing.id, updated: true };
          }

          // For likes and favorites, toggle off if already exists.
          // Toggle-off always allowed — the cap below is on adds only, so a
          // guest at the limit can still free a slot by un-favoriting (#655).
          if (feedback_type === 'like' || feedback_type === 'favorite') {
            await db('photo_feedback')
              .where('id', existing.id)
              .delete();

            await this.updatePhotoFeedbackStats(photoId);
            return { removed: true };
          }

          return { id: existing.id, exists: true };
        }
      }

      // Per-guest cap enforcement (#655). Only checked on ADD; toggle-off is
      // always allowed. NULL or 0 stored in the column means "unlimited" —
      // the photographer hasn't opted in to a cap for this event.
      if (feedback_type === 'favorite' || feedback_type === 'like') {
        const settings = await this.getEventFeedbackSettings(eventId);
        const cap = feedback_type === 'favorite'
          ? settings.max_favorites_per_guest
          : settings.max_likes_per_guest;
        if (cap && cap > 0) {
          const currentCount = await this.countGuestFeedback(
            eventId, feedback_type, guest_id, guestIdentifier,
          );
          if (currentCount >= cap) {
            // Don't insert; surface a structured payload so the route layer
            // can return a 403 with `code` + `limit` + `current_count` and
            // the UI can render an explicit popup with the cap value.
            return {
              limit_reached: true,
              feedback_type,
              limit: cap,
              current_count: currentCount,
            };
          }
        }
      }

      // Insert new feedback
      const result = await db('photo_feedback').insert({
        photo_id: photoId,
        event_id: eventId,
        feedback_type,
        rating: feedback_type === 'rating' ? rating : null,
        comment_text: feedback_type === 'comment' ? comment_text : null,
        guest_name,
        guest_email,
        guest_identifier: guestIdentifier,
        guest_id: guest_id || null,
        ip_address,
        user_agent,
        is_approved: feedback_type !== 'comment' || !feedbackData.moderate_comments,
        created_at: new Date(),
        updated_at: new Date()
      }).returning('id');
      
      const id = result[0]?.id || result[0];
      
      // Update photo stats
      await this.updatePhotoFeedbackStats(photoId);
      
      // Log activity
      await logActivity(`photo_${feedback_type}`, { photo_id: photoId }, eventId);
      
      return { id, created: true };
    } catch (error) {
      logger.error('Error submitting feedback:', error);
      throw error;
    }
  }

  /**
   * Get feedback for a photo
   */
  async getPhotoFeedback(photoId, options = {}) {
    try {
      const query = db('photo_feedback')
        .where('photo_id', photoId);
      
      if (options.feedback_type) {
        query.where('feedback_type', options.feedback_type);
      }
      
      if (options.approved_only) {
        query.where('is_approved', true);
      }
      
      if (!options.include_hidden) {
        query.where('is_hidden', false);
      }
      
      if (options.guest_identifier) {
        query.where('guest_identifier', options.guest_identifier);
      }
      
      const feedback = await query
        .orderBy('created_at', 'desc')
        .select('id', 'feedback_type', 'rating', 'comment_text', 'guest_name', 'created_at', 'is_approved', 'is_hidden');
      
      return feedback;
    } catch (error) {
      logger.error('Error getting photo feedback:', error);
      throw error;
    }
  }

  /**
   * Get feedback summary for an event
   */
  async getEventFeedbackSummary(eventId) {
    try {
      const photos = await db('photos')
        .where('event_id', eventId)
        .select('id', 'filename', 'feedback_count', 'like_count', 'average_rating', 'favorite_count')
        .orderBy('average_rating', 'desc')
        .orderBy('like_count', 'desc');
      
      const totalStats = await db('photo_feedback')
        .where('event_id', eventId)
        .select(
          db.raw('COUNT(DISTINCT CASE WHEN feedback_type = ? THEN guest_identifier END) as unique_raters', ['rating']),
          db.raw('COUNT(CASE WHEN feedback_type = ? THEN 1 END) as total_ratings', ['rating']),
          db.raw('COUNT(CASE WHEN feedback_type = ? THEN 1 END) as total_likes', ['like']),
          db.raw('COUNT(CASE WHEN feedback_type = ? THEN 1 END) as total_comments', ['comment']),
          db.raw('COUNT(CASE WHEN feedback_type = ? THEN 1 END) as total_favorites', ['favorite'])
        )
        .first();
      
      return {
        photos,
        stats: totalStats
      };
    } catch (error) {
      logger.error('Error getting feedback summary:', error);
      throw error;
    }
  }

  /**
   * Update photo feedback statistics
   */
  async updatePhotoFeedbackStats(photoId) {
    try {
      // Get aggregated stats
      const stats = await db('photo_feedback')
        .where('photo_id', photoId)
        .where('is_hidden', false)
        .select(
          db.raw('COUNT(CASE WHEN feedback_type = ? AND is_approved = ? THEN 1 END) as comment_count', ['comment', formatBoolean(true)]),
          db.raw('COUNT(CASE WHEN feedback_type = ? THEN 1 END) as like_count', ['like']),
          db.raw('COUNT(CASE WHEN feedback_type = ? THEN 1 END) as favorite_count', ['favorite']),
          db.raw('AVG(CASE WHEN feedback_type = ? THEN rating END) as average_rating', ['rating']),
          db.raw('COUNT(DISTINCT COALESCE(CAST(guest_id AS VARCHAR), guest_identifier)) as feedback_count')
        )
        .first();
      
      // Update photo table
      await db('photos')
        .where('id', photoId)
        .update({
          feedback_count: stats.feedback_count || 0,
          like_count: stats.like_count || 0,
          average_rating: stats.average_rating || 0,
          favorite_count: stats.favorite_count || 0
        });
    } catch (error) {
      logger.error('Error updating photo feedback stats:', error);
      throw error;
    }
  }

  /**
   * Moderate feedback (approve/hide)
   */
  async moderateFeedback(feedbackId, action, adminId) {
    try {
      const updates = {
        updated_at: new Date()
      };
      
      if (action === 'approve') {
        updates.is_approved = true;
        updates.is_hidden = false;
      } else if (action === 'hide') {
        updates.is_hidden = true;
      } else if (action === 'reject') {
        updates.is_approved = false;
        updates.is_hidden = true;
      }
      
      const feedback = await db('photo_feedback')
        .where('id', feedbackId)
        .first();
      
      if (!feedback) {
        throw new Error('Feedback not found');
      }
      
      await db('photo_feedback')
        .where('id', feedbackId)
        .update(updates);
      
      // Update photo stats if visibility changed
      await this.updatePhotoFeedbackStats(feedback.photo_id);
      
      // Log moderation action
      await logActivity('feedback_moderated', {
        feedback_id: feedbackId,
        action,
        admin_id: adminId
      }, feedback.event_id);
      
      return true;
    } catch (error) {
      logger.error('Error moderating feedback:', error);
      throw error;
    }
  }

  /**
   * Delete feedback
   */
  async deleteFeedback(feedbackId, adminId) {
    try {
      const feedback = await db('photo_feedback')
        .where('id', feedbackId)
        .first();
      
      if (!feedback) {
        throw new Error('Feedback not found');
      }
      
      await db('photo_feedback')
        .where('id', feedbackId)
        .delete();
      
      // Update photo stats
      await this.updatePhotoFeedbackStats(feedback.photo_id);
      
      // Log deletion
      await logActivity('feedback_deleted', {
        feedback_id: feedbackId,
        feedback_type: feedback.feedback_type,
        admin_id: adminId
      }, feedback.event_id);
      
      return true;
    } catch (error) {
      logger.error('Error deleting feedback:', error);
      throw error;
    }
  }

  /**
   * Get feedback requiring moderation
   */
  async getPendingModeration(eventId = null) {
    try {
      let query = db('photo_feedback')
        .join('photos', 'photo_feedback.photo_id', 'photos.id')
        .join('events', 'photo_feedback.event_id', 'events.id')
        .where('photo_feedback.is_approved', false)
        .where('photo_feedback.is_hidden', false)
        .where('photo_feedback.feedback_type', 'comment');
      
      if (eventId) {
        query = query.where('photo_feedback.event_id', eventId);
      }
      
      const pending = await query
        .select(
          'photo_feedback.*',
          'photos.filename as photo_filename',
          'events.event_name'
        )
        .orderBy('photo_feedback.created_at', 'desc');
      
      return pending;
    } catch (error) {
      logger.error('Error getting pending moderation:', error);
      throw error;
    }
  }

  /**
   * Export feedback data for an event — long-form (one row per individual
   * feedback action: favourite, like, rating, or comment). Backward-compatible
   * with archives and any external integrations that consume the existing CSV.
   */
  async exportEventFeedback(eventId) {
    try {
      const feedback = await db('photo_feedback')
        .join('photos', 'photo_feedback.photo_id', 'photos.id')
        .where('photo_feedback.event_id', eventId)
        .select(
          'photos.filename',
          'photo_feedback.feedback_type',
          'photo_feedback.rating',
          'photo_feedback.comment_text',
          'photo_feedback.guest_name',
          'photo_feedback.guest_email',
          'photo_feedback.created_at'
        )
        .orderBy('photos.filename')
        .orderBy('photo_feedback.created_at');

      return feedback;
    } catch (error) {
      logger.error('Error exporting feedback:', error);
      throw error;
    }
  }

  /**
   * Export feedback data for an event — pivoted (one row per
   * (filename, guest_identifier) pair, columns: is_favorited, is_liked,
   * star_rating, comment, latest_at). Useful for spreadsheet pivot tables
   * and per-guest engagement scans. Hidden-by-moderator rows are excluded
   * because the pivot represents "what the guest currently sees / what we
   * want to surface" rather than the raw event log.
   *
   * Returns the same shape regardless of database driver — pivot is built
   * in JS so Postgres / SQLite behave identically. Ported from
   * 8digit/picpeak@ed7943b (#640 part #6).
   */
  async exportEventFeedbackPivoted(eventId) {
    try {
      const rows = await db('photo_feedback')
        .join('photos', 'photo_feedback.photo_id', 'photos.id')
        .where('photo_feedback.event_id', eventId)
        .where('photo_feedback.is_hidden', false)
        .select(
          'photos.filename',
          'photo_feedback.feedback_type',
          'photo_feedback.rating',
          'photo_feedback.comment_text',
          'photo_feedback.guest_name',
          'photo_feedback.guest_email',
          'photo_feedback.guest_identifier',
          'photo_feedback.created_at'
        )
        .orderBy('photos.filename')
        .orderBy('photo_feedback.guest_identifier');

      const byKey = new Map();
      for (const row of rows) {
        // Key needs both the photo and the guest. Anonymous feedback (no
        // identifier) gets a synthetic key per row so two anonymous guests'
        // actions on the same photo don't collapse together.
        const guestKey = row.guest_identifier || `anon-${row.created_at}`;
        const key = `${row.filename}::${guestKey}`;
        let entry = byKey.get(key);
        if (!entry) {
          entry = {
            filename: row.filename,
            guest_name: row.guest_name || '',
            guest_email: row.guest_email || '',
            is_favorited: false,
            is_liked: false,
            star_rating: '',
            comment: '',
            latest_at: row.created_at,
          };
          byKey.set(key, entry);
        }
        // Prefer non-empty contact fields if any row supplied them.
        if (!entry.guest_name && row.guest_name) entry.guest_name = row.guest_name;
        if (!entry.guest_email && row.guest_email) entry.guest_email = row.guest_email;

        switch (row.feedback_type) {
          case 'favorite':
            entry.is_favorited = true;
            break;
          case 'like':
            entry.is_liked = true;
            break;
          case 'rating':
            if (row.rating != null) entry.star_rating = row.rating;
            break;
          case 'comment':
            if (row.comment_text) {
              // Most recent comment wins. Older comments from the same guest
              // on the same photo are dropped — the export is "current state",
              // not the comment history.
              entry.comment = row.comment_text;
            }
            break;
          default:
            // Unknown feedback type — ignore so a future type doesn't break the export.
            break;
        }
        // Track the latest action timestamp across all feedback types.
        if (row.created_at && entry.latest_at && row.created_at > entry.latest_at) {
          entry.latest_at = row.created_at;
        }
      }

      return Array.from(byKey.values());
    } catch (error) {
      logger.error('Error exporting feedback (pivoted):', error);
      throw error;
    }
  }

  /**
   * Get filtered photos based on feedback criteria
   * @param {number} eventId - Event ID
   * @param {string} guestIdentifier - Guest identifier
   * @param {object} filters - Filter criteria
   * @param {boolean} filters.liked - Include liked photos
   * @param {boolean} filters.favorited - Include favorited photos
   * @param {string} filters.operator - 'AND' or 'OR' for multiple filters
   * @returns {Promise<number[]>} Array of photo IDs that match criteria
   */
  async getFilteredPhotos(eventId, guestIdentifier, filters = {}) {
    try {
      const { liked, favorited, operator = 'OR' } = filters;
      
      // If no filters specified, return all photos
      if (!liked && !favorited) {
        const allPhotos = await db('photos')
          .where('event_id', eventId)
          .select('id');
        return allPhotos.map(p => p.id);
      }
      
      // Build query based on filters
      let query = db('photo_feedback')
        .where('event_id', eventId)
        .where('guest_identifier', guestIdentifier)
        .where('is_hidden', false);
      
      // Apply filter logic
      if (operator === 'AND' && liked && favorited) {
        // For AND operation, we need photos that have both types of feedback
        const likedPhotos = await db('photo_feedback')
          .where('event_id', eventId)
          .where('guest_identifier', guestIdentifier)
          .where('feedback_type', 'like')
          .where('is_hidden', false)
          .select('photo_id');
        
        const favoritedPhotos = await db('photo_feedback')
          .where('event_id', eventId)
          .where('guest_identifier', guestIdentifier)
          .where('feedback_type', 'favorite')
          .where('is_hidden', false)
          .select('photo_id');
        
        const likedIds = new Set(likedPhotos.map(p => p.photo_id));
        const favoritedIds = new Set(favoritedPhotos.map(p => p.photo_id));
        
        // Return intersection of both sets
        return Array.from(likedIds).filter(id => favoritedIds.has(id));
      } else {
        // OR operation or single filter
        const feedbackTypes = [];
        if (liked) feedbackTypes.push('like');
        if (favorited) feedbackTypes.push('favorite');
        
        query.whereIn('feedback_type', feedbackTypes);
      }
      
      const filteredPhotos = await query
        .distinct('photo_id')
        .select('photo_id');
      
      return filteredPhotos.map(p => p.photo_id);
    } catch (error) {
      logger.error('Error getting filtered photos:', error);
      throw error;
    }
  }

  /**
   * Anonymize feedback belonging to a guest — sets guest_id to NULL on all
   * their feedback rows and clears guest_name/guest_email for privacy, then
   * recomputes denormalized photo counts on affected photos.
   *
   * Used by self-service "forget me" and admin guest deletion.
   */
  async anonymizeGuestFeedback(guestId) {
    try {
      const affected = await db('photo_feedback')
        .where('guest_id', guestId)
        .select('photo_id');
      const photoIds = [...new Set(affected.map((r) => r.photo_id))];

      await db('photo_feedback')
        .where('guest_id', guestId)
        .update({
          guest_id: null,
          guest_name: null,
          guest_email: null,
          updated_at: new Date(),
        });

      for (const pid of photoIds) {
        await this.updatePhotoFeedbackStats(pid);
      }

      return { anonymized: affected.length, photos: photoIds.length };
    } catch (error) {
      logger.error('Error anonymizing guest feedback:', error);
      throw error;
    }
  }

  /**
   * Merge feedback rows from sourceGuestIds into keepGuestId. Used by admin
   * guest merge and email-based identity recovery when a user re-registers.
   * Recomputes denormalized counts on affected photos.
   */
  async mergeGuestFeedback(keepGuestId, sourceGuestIds) {
    try {
      const sources = (sourceGuestIds || []).filter((id) => id && id !== keepGuestId);
      if (sources.length === 0) {
        return { merged: 0, photos: 0 };
      }

      const affected = await db('photo_feedback')
        .whereIn('guest_id', sources)
        .select('photo_id');
      const photoIds = [...new Set(affected.map((r) => r.photo_id))];

      await db('photo_feedback')
        .whereIn('guest_id', sources)
        .update({
          guest_id: keepGuestId,
          updated_at: new Date(),
        });

      for (const pid of photoIds) {
        await this.updatePhotoFeedbackStats(pid);
      }

      return { merged: affected.length, photos: photoIds.length };
    } catch (error) {
      logger.error('Error merging guest feedback:', error);
      throw error;
    }
  }
}

module.exports = new FeedbackService();