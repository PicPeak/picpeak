const express = require('express');
const router = express.Router();
const { photoAuth } = require('../middleware/photoAuth');
const { verifyGalleryAccess, denySlideshowToken } = require('../middleware/gallery');
const { feedbackRateLimit, generateGuestIdentifier } = require('../middleware/feedbackRateLimit');
const { resolveGuest } = require('../middleware/guestAuth');
const feedbackService = require('../services/feedbackService');
const feedbackModeration = require('../services/feedbackModeration');
const { db, logActivity } = require('../database/db');
const logger = require('../utils/logger');
const {
  validatePhotoId,
  validateFeedbackSubmission,
  checkValidation,
  validateGuestRequirements
} = require('../utils/feedbackValidation');
const { escapeLikePattern } = require('../utils/sqlSecurity');

// Get feedback settings for a gallery
router.get('/:slug/feedback-settings',
  verifyGalleryAccess,
  async (req, res) => {
    try {
      const event = req.event;
      const settings = await feedbackService.getEventFeedbackSettings(event.id);

      // Only send relevant settings to guests
      // Convert SQLite boolean values (0/1) to proper booleans
      const guestSettings = {
        feedback_enabled: Boolean(settings.feedback_enabled),
        allow_ratings: Boolean(settings.allow_ratings),
        allow_likes: Boolean(settings.allow_likes),
        allow_comments: Boolean(settings.allow_comments),
        allow_favorites: Boolean(settings.allow_favorites),
        require_name_email: Boolean(settings.require_name_email),
        show_feedback_to_guests: Boolean(settings.show_feedback_to_guests),
        identity_mode: settings.identity_mode || 'simple',
        // Per-guest caps (#655). The UI uses these to disable the heart /
        // thumbs-up at the limit and render an "8 / 10" counter. null = no
        // cap; positive integer = enforced.
        max_favorites_per_guest: settings.max_favorites_per_guest || null,
        max_likes_per_guest: settings.max_likes_per_guest || null,
      };

      res.json(guestSettings);
    } catch (error) {
      logger.error('Error getting feedback settings:', error);
      res.status(500).json({ error: 'Failed to get feedback settings' });
    }
  }
);

// Get feedback for a specific photo
router.get('/:slug/photos/:photoId/feedback',
  verifyGalleryAccess,
  resolveGuest,
  validatePhotoId,
  checkValidation,
  async (req, res) => {
    try {
      const { photoId } = req.params;
      const event = req.event;
      const guestIdentifier = generateGuestIdentifier(req);
      
      // Get feedback settings
      const settings = await feedbackService.getEventFeedbackSettings(event.id);
      
      if (!settings.feedback_enabled) {
        return res.status(403).json({ error: 'Feedback is not enabled for this event' });
      }
      
      // Verify photo belongs to event
      const photo = await db('photos')
        .where({ id: photoId, event_id: event.id })
        .first();
      
      if (!photo) {
        return res.status(404).json({ error: 'Photo not found' });
      }
      
      // Get feedback based on settings
      const options = {
        approved_only: true,
        include_hidden: false
      };
      
      // Include guest's own feedback even if not approved
      const feedback = await feedbackService.getPhotoFeedback(photoId, options);
      
      // Get guest's own feedback separately
      const guestFeedback = await feedbackService.getPhotoFeedback(photoId, {
        guest_identifier: guestIdentifier
      });
      
      // Combine and deduplicate
      const allFeedback = [...feedback];
      guestFeedback.forEach(gf => {
        if (!feedback.find(f => f.id === gf.id)) {
          allFeedback.push({ ...gf, is_mine: true });
        } else {
          const index = allFeedback.findIndex(f => f.id === gf.id);
          allFeedback[index].is_mine = true;
        }
      });
      
      // Filter based on what guests should see
      const visibleFeedback = settings.show_feedback_to_guests ? allFeedback : 
        allFeedback.filter(f => f.is_mine);
      
      res.json({
        feedback: visibleFeedback,
        summary: {
          average_rating: photo.average_rating || 0,
          total_ratings: await db('photo_feedback')
            .where({ photo_id: photoId, feedback_type: 'rating', is_hidden: false })
            .count('id as count')
            .first()
            .then(r => r.count),
          like_count: photo.like_count || 0,
          favorite_count: photo.favorite_count || 0,
          comment_count: await db('photo_feedback')
            .where({ 
              photo_id: photoId, 
              feedback_type: 'comment', 
              is_approved: true,
              is_hidden: false 
            })
            .count('id as count')
            .first()
            .then(r => r.count)
        },
        my_feedback: {
          rating: guestFeedback.find(f => f.feedback_type === 'rating')?.rating,
          liked: !!guestFeedback.find(f => f.feedback_type === 'like'),
          favorited: !!guestFeedback.find(f => f.feedback_type === 'favorite')
        }
      });
    } catch (error) {
      logger.error('Error getting photo feedback:', error);
      res.status(500).json({ error: 'Failed to get feedback' });
    }
  }
);

// Submit feedback for a photo
router.post('/:slug/photos/:photoId/feedback',
  verifyGalleryAccess,
  denySlideshowToken,
  resolveGuest,
  validatePhotoId,
  validateFeedbackSubmission,
  checkValidation,
  async (req, res) => {
    try {
      const { photoId } = req.params;
      const event = req.event;

      // Get feedback settings first so we can enforce identity_mode.
      const settings = await feedbackService.getEventFeedbackSettings(event.id);

      if (!settings.feedback_enabled) {
        return res.status(403).json({ error: 'Feedback is not enabled for this event' });
      }

      // In guest identity mode, a valid guest token is required. The server
      // never trusts guest_name/guest_email from the body in this mode — it
      // reads them from the verified token via req.guest.
      if (settings.identity_mode === 'guest') {
        if (!req.guest || req.guest.eventId !== event.id) {
          return res.status(401).json({
            error: 'Guest identity required',
            code: 'GUEST_IDENTITY_REQUIRED'
          });
        }
      }

      const guestIdentifier = generateGuestIdentifier(req);

      // Check if specific feedback type is allowed
      const feedbackType = req.body.feedback_type;
      const typeAllowed = {
        rating: settings.allow_ratings,
        like: settings.allow_likes,
        comment: settings.allow_comments,
        favorite: settings.allow_favorites
      };

      if (!typeAllowed[feedbackType]) {
        return res.status(403).json({ error: `${feedbackType} feedback is not enabled` });
      }

      // Verify photo belongs to event
      const photo = await db('photos')
        .where({ id: photoId, event_id: event.id })
        .first();

      if (!photo) {
        return res.status(404).json({ error: 'Photo not found' });
      }

      // Validate guest requirements only in simple mode. In guest mode, the
      // identity is already provided via the token and verified above.
      if (settings.identity_mode !== 'guest') {
        const guestValidation = await validateGuestRequirements(settings, req.body);
        if (!guestValidation.valid) {
          return res.status(400).json({
            error: 'Guest information required',
            errors: guestValidation.errors
          });
        }
      }

      // Apply rate limiting based on feedback type
      const rateLimitMiddleware = feedbackRateLimit(feedbackType);
      await new Promise((resolve, reject) => {
        rateLimitMiddleware(req, res, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // If we got here and response was sent (rate limited), return
      if (res.headersSent) return;

      // Prepare feedback data. In guest mode, use the verified token as the
      // source of truth for name/email — never the body.
      const feedbackData = {
        feedback_type: feedbackType,
        rating: req.body.rating,
        comment_text: req.body.comment_text,
        guest_name: req.guest?.name ?? req.body.guest_name,
        guest_email: req.guest?.email ?? req.body.guest_email,
        guest_id: req.guest?.id ?? null,
        ip_address: req.ip || req.connection.remoteAddress,
        user_agent: (req.headers['user-agent'] || '').replace(/[<>&"']/g, '').substring(0, 255),
        moderate_comments: settings.moderate_comments
      };
      
      // For comments, check moderation
      if (feedbackType === 'comment') {
        // Check user reputation
        const reputation = await feedbackModeration.checkUserReputation(guestIdentifier, event.id);
        
        // Moderate the comment
        const moderationResult = await feedbackModeration.moderateText(req.body.comment_text);
        
        if (!moderationResult.approved) {
          // Still save but mark as not approved
          feedbackData.is_approved = false;
          logger.warn('Comment flagged for moderation:', {
            reason: moderationResult.reason,
            violations: moderationResult.violations
          });
        } else if (reputation.autoApprove) {
          // Trusted user, auto-approve
          feedbackData.is_approved = true;
        } else if (settings.moderate_comments) {
          // Default moderation setting
          feedbackData.is_approved = false;
        }
      }
      
      // Submit feedback
      const result = await feedbackService.submitFeedback(
        photoId,
        event.id,
        feedbackData,
        guestIdentifier
      );

      // Per-guest cap reached (#655). Surface as a structured 403 so the
      // frontend can show an explicit popup with the actual cap value and
      // remaining-slots count, rather than a generic toast. Code is the
      // stable contract the UI listens for.
      if (result && result.limit_reached) {
        const code = result.feedback_type === 'favorite'
          ? 'FAVORITE_LIMIT_REACHED'
          : 'LIKE_LIMIT_REACHED';
        return res.status(403).json({
          error: `${result.feedback_type === 'favorite' ? 'Favorite' : 'Like'} limit reached`,
          code,
          limit: result.limit,
          current_count: result.current_count,
          feedback_type: result.feedback_type,
        });
      }

      // Log activity
      await logActivity(`guest_feedback_${feedbackType}`, {
        photo_id: photoId,
        result
      }, event.id, {
        type: 'guest',
        id: guestIdentifier.substring(0, 16),
        name: req.body.guest_name || 'Anonymous'
      });

      res.json({
        success: true,
        ...result,
        message: feedbackType === 'comment' && !feedbackData.is_approved ?
          'Your comment has been submitted for moderation' : undefined
      });
    } catch (error) {
      logger.error('Error submitting feedback:', error);
      res.status(500).json({ error: 'Failed to submit feedback' });
    }
  }
);

// Get feedback summary for entire gallery
router.get('/:slug/feedback-summary',
  verifyGalleryAccess,
  async (req, res) => {
    try {
      const event = req.event;
      
      // Get feedback settings
      const settings = await feedbackService.getEventFeedbackSettings(event.id);
      
      if (!settings.feedback_enabled || !settings.show_feedback_to_guests) {
        return res.json({
          enabled: false,
          summary: null
        });
      }
      
      const summary = await feedbackService.getEventFeedbackSummary(event.id);
      
      // Filter data based on what guests should see
      const guestSummary = {
        stats: summary.stats,
        top_rated: summary.photos
          .filter(p => p.average_rating > 0)
          .slice(0, 5)
          .map(p => ({
            id: p.id,
            filename: p.filename,
            average_rating: p.average_rating,
            like_count: p.like_count
          }))
      };
      
      res.json({
        enabled: true,
        settings: {
          allow_ratings: settings.allow_ratings,
          allow_likes: settings.allow_likes,
          allow_comments: settings.allow_comments,
          allow_favorites: settings.allow_favorites
        },
        summary: guestSummary
      });
    } catch (error) {
      logger.error('Error getting feedback summary:', error);
      res.status(500).json({ error: 'Failed to get feedback summary' });
    }
  }
);

// Get user's own feedback for all photos
router.get('/:slug/my-feedback',
  verifyGalleryAccess,
  resolveGuest,
  async (req, res) => {
    try {
      const event = req.event;

      const query = db('photo_feedback')
        .join('photos', 'photo_feedback.photo_id', 'photos.id')
        .where('photo_feedback.event_id', event.id);

      // Prefer guest_id lookup when a verified guest token is present
      // (per-person identity). Fall back to the device hash otherwise.
      if (req.guest?.id) {
        query.where('photo_feedback.guest_id', req.guest.id);
      } else {
        const guestIdentifier = generateGuestIdentifier(req);
        query.where('photo_feedback.guest_identifier', guestIdentifier);
      }

      const myFeedback = await query
        .select(
          'photo_feedback.*',
          'photos.filename',
          'photos.path'
        )
        .orderBy('photo_feedback.created_at', 'desc');

      // Array-shaped response preserved for back-compat with existing
      // consumers (`GalleryView` iterates the array directly). The per-event
      // caps for #655 are exposed via the `/feedback-settings` endpoint;
      // the running counts can be derived client-side from this array.
      res.json(myFeedback);
    } catch (error) {
      logger.error('Error getting user feedback:', error);
      res.status(500).json({ error: 'Failed to get your feedback' });
    }
  }
);

module.exports = router;