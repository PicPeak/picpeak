const express = require('express');
const { body } = require('express-validator');
const router = express.Router();
const { verifyGalleryAccess, denySlideshowToken } = require('../middleware/gallery');
const { guestBlockedByReveal, blockHiddenGallery } = require('../utils/revealMode');
const { feedbackRateLimit, generateGuestIdentifier } = require('../middleware/feedbackRateLimit');
const { resolveGuest, scopeGuestToFeedback, downloadIdentityRequired } = require('../middleware/guestAuth');
const feedbackService = require('../services/feedbackService');
const feedbackModeration = require('../services/feedbackModeration');
const selectionSubmissions = require('../services/selectionSubmissions');
const { scopeToViewer } = selectionSubmissions;
const { db, logActivity } = require('../database/db');
const logger = require('../utils/logger');
const {
  isPhotoHiddenFromViewer, isPhotoProcessed, applyPhotoVisibilityFilter, joinLivePhotos, livePhotos, wherePhotoProcessed, viewerOf,
} = require('../utils/photoVisibility');
const {
  validatePhotoId,
  validateFeedbackSubmission,
  checkValidation,
  validateGuestRequirements,
  checkGuestName,
  normalizeGuestName
} = require('../utils/feedbackValidation');
const { IDENTITY_PRESERVING_NORMALIZE_EMAIL } = require('../utils/emailNormalization');
const { normalizeAnnotation } = require('../utils/photoAnnotation');
const favoriteLists = require('../services/favoriteLists');

// Most photos one bulk rating request may name (issue 1733).
const BULK_RATING_MAX_PHOTOS = 200;

// The 401 a write gets without the guest identity it needs, or for a guest
// merged away or deleted while the request ran: the answer resolveGuest
// gives the next request from that token.
const GUEST_IDENTITY_REQUIRED_BODY = Object.freeze({ error: 'Guest identity required', code: 'GUEST_IDENTITY_REQUIRED' });

// Handed in (issue 1733, A1): the picks, or the approve / reject, are frozen
// until an admin reopens the submission. 409 with a code the UI explains.
function lockedBody(result) {
  return {
    error: result.kind === 'approval'
      ? 'The edited photos are approved; the decisions are locked'
      : 'The selection is finished; the picks are locked',
    code: result.kind === 'approval' ? 'APPROVAL_LOCKED' : 'SELECTION_LOCKED',
    kind: result.kind,
    submitted_at: result.submitted_at,
  };
}

/**
 * Charge `count` units of the `actionType` budget. Awaits the middleware
 * itself: a rejected request gets its 429 and next() is not called. True
 * when that answer has been sent and the route must stop.
 */
async function rateLimited(req, res, actionType, count) {
  await feedbackRateLimit(actionType, count)(req, res, (err) => { if (err) throw err; });
  return res.headersSent;
}

/**
 * This event's photo, if this viewer may give or read feedback on it. A
 * client-hidden photo does not exist for a viewer who cannot see it: no
 * reading its comments and counts, no adding to them. Nor does one the worker
 * has not finished or failed on: the gallery list leaves it out
 * (wherePhotoProcessed). Null otherwise; the routes answer 404.
 */
async function viewablePhoto(req, photoId) {
  const photo = await livePhotos(db)
    .where({ id: photoId, event_id: req.event.id })
    .first();
  if (!photo || isPhotoHiddenFromViewer(photo, viewerOf(req)) || !isPhotoProcessed(photo)) return null;
  return photo;
}

/**
 * Feedback on, and in guest identity mode a guest: the first checks of every
 * feedback write and of a hand-over. Returns the refusal to send, or null.
 */
function feedbackIdentityRefusal(req, settings) {
  if (!settings.feedback_enabled) {
    return { status: 403, body: { error: 'Feedback is not enabled for this event' } };
  }

  // In guest identity mode, a valid guest token is required. The server
  // never trusts guest_name/guest_email from the body in this mode — it
  // reads them from the verified token via req.guest (resolveGuest has
  // already dropped a guest of another gallery).
  if (settings.identity_mode === 'guest') {
    if (!req.guest) {
      return { status: 401, body: GUEST_IDENTITY_REQUIRED_BODY };
    }
  }
  return null;
}

/**
 * The event-level checks every feedback write passes before a photo is looked
 * at, shared by the single and the bulk route so they cannot drift. Returns
 * the refusal to send, or null.
 */
function feedbackWriteRefusal(req, settings, feedbackType) {
  const identityRefusal = feedbackIdentityRefusal(req, settings);
  if (identityRefusal) return identityRefusal;

  // Check if specific feedback type is allowed
  const typeAllowed = {
    rating: settings.allow_ratings,
    like: settings.allow_likes,
    comment: settings.allow_comments,
    favorite: settings.allow_favorites,
    reaction: settings.allow_reactions,
    color_label: settings.allow_color_labels,
    decision: settings.allow_decisions
  };

  if (!typeAllowed[feedbackType]) {
    return { status: 403, body: { error: `${feedbackType} feedback is not enabled` } };
  }
  return null;
}

/**
 * Who is writing, for feedbackService.submitFeedback. In guest mode the
 * verified token is the source of truth for name/email — never the body.
 */
function feedbackAuthor(req, settings) {
  return {
    // Read by the service to route a colour label to the photo's one
    // shared slot instead of the guest's own row (#1197). Passed rather
    // than re-fetched: the settings are already in hand here.
    identity_mode: settings.identity_mode,
    guest_name: req.guest?.name ?? req.body.guest_name,
    guest_email: req.guest?.email ?? req.body.guest_email,
    guest_id: req.guest?.id ?? null,
    ip_address: req.ip || req.connection.remoteAddress,
    user_agent: (req.headers['user-agent'] || '').replace(/[<>&"']/g, '').substring(0, 255),
    moderate_comments: settings.moderate_comments
  };
}

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
        allow_reactions: Boolean(settings.allow_reactions),
        allow_color_labels: Boolean(settings.allow_color_labels),
        allow_decisions: Boolean(settings.allow_decisions),
        // Named favourite lists (issue 2303).
        allow_favorite_lists: Boolean(settings.allow_favorite_lists),
        // Drawing on a comment (issue 1733).
        allow_annotations: Boolean(settings.allow_annotations),
        // Which lightbox shortcut scheme this gallery uses (#1044).
        keybind_mode: settings.keybind_mode || 'colors',
        require_name_email: Boolean(settings.require_name_email),
        show_feedback_to_guests: Boolean(settings.show_feedback_to_guests),
        identity_mode: settings.identity_mode || 'simple',
        // Per-guest caps (#655). The UI uses these to disable the heart /
        // thumbs-up at the limit and render an "8 / 10" counter. null = no
        // cap; positive integer = enforced.
        max_favorites_per_guest: settings.max_favorites_per_guest || null,
        max_likes_per_guest: settings.max_likes_per_guest || null,
        // Guest identity before downloading, and the guest prompt's privacy
        // note (issue 2503). The downloads themselves enforce the former.
        require_guest_for_download: downloadIdentityRequired(settings),
        guest_privacy_text: settings.guest_privacy_text || null,
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
  // The Live Slideshow kiosk only lists and shows photos, which keep to a
  // pinned category; it has no use for these feedback routes, so a show
  // session reads nothing through them about photos outside its pin.
  denySlideshowToken,
  // Reveal-gated (#838): sequential photo ids would let hidden-gallery
  // guests enumerate comments/stats.
  blockHiddenGallery,
  resolveGuest,
  scopeGuestToFeedback,
  validatePhotoId,
  checkValidation,
  async (req, res) => {
    try {
      const { photoId } = req.params;
      const event = req.event;
      const guestIdentifier = await generateGuestIdentifier(req);
      
      // Get feedback settings
      const settings = await feedbackService.getEventFeedbackSettings(event.id);
      
      if (!settings.feedback_enabled) {
        return res.status(403).json({ error: 'Feedback is not enabled for this event' });
      }
      
      const photo = await viewablePhoto(req, photoId);
      if (!photo) {
        return res.status(404).json({ error: 'Photo not found' });
      }
      
      // Get feedback based on settings
      const options = {
        approved_only: true,
        include_hidden: false,
        // Only the colour-label set this event is actually using (#1197).
        identity_mode: settings.identity_mode,
      };
      
      // Include guest's own feedback even if not approved
      const feedback = await feedbackService.getPhotoFeedback(photoId, options);
      
      // Get guest's own feedback separately
      const guestFeedback = await feedbackService.getPhotoFeedback(photoId, {
        // Older merges updated guest_id without rewriting guest_identifier.
        // Use the verified identity, as /my-feedback and submissions do.
        guest_id: req.guest?.id,
        guest_identifier: guestIdentifier,
        identity_mode: settings.identity_mode,
        with_favorite_list: Boolean(settings.allow_favorite_lists),
      });

      // The photo's shared tag (#1197), when the event is in that mode.
      const sharedColorLabel = settings.identity_mode === 'shared'
        ? (await feedbackService.getSharedColorLabels(event.id, [photoId]))[photoId] || null
        : null;
      
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
      
      // Filter based on what guests should see. A decision's reason (issue
      // 744) is addressed to the photographer, not to the other guests:
      // sharing feedback shows that someone rejected the photo, not why.
      const visibleFeedback = (settings.show_feedback_to_guests ? allFeedback :
        allFeedback.filter(f => f.is_mine))
        .map(f => (f.feedback_type === 'decision' && !f.is_mine ? { ...f, comment_text: null } : f));
      
      // Every aggregate is other guests' feedback, so all of them are gated
      // on show_feedback_to_guests — the photo list already hides like_count
      // this way. The viewer's own choices stay in my_feedback below.
      const shareAggregates = Boolean(settings.show_feedback_to_guests);
      res.json({
        feedback: visibleFeedback,
        summary: {
          average_rating: shareAggregates ? (photo.average_rating || 0) : 0,
          total_ratings: shareAggregates
            ? await db('photo_feedback')
              .where({ photo_id: photoId, feedback_type: 'rating', is_hidden: false })
              .count('id as count')
              .first()
              .then(r => r.count)
            : 0,
          like_count: shareAggregates ? (photo.like_count || 0) : 0,
          favorite_count: shareAggregates ? (photo.favorite_count || 0) : 0,
          reaction_count: shareAggregates ? (photo.reaction_count || 0) : 0,
          color_label_count: shareAggregates ? (photo.color_label_count || 0) : 0,
          approved_count: shareAggregates ? (photo.approved_count || 0) : 0,
          rejected_count: shareAggregates ? (photo.rejected_count || 0) : 0,
          comment_count: shareAggregates
            ? await db('photo_feedback')
              .where({
                photo_id: photoId,
                feedback_type: 'comment',
                is_approved: true,
                is_hidden: false
              })
              .count('id as count')
              .first()
              .then(r => r.count)
            : 0
        },
        // Per-emoji tallies for the reaction bar (#839). Gated on
        // show_feedback_to_guests: with sharing off a guest sees only their
        // own selection (my_feedback.reaction below), no aggregate counts.
        reactions: settings.show_feedback_to_guests
          ? await feedbackService.getPhotoReactionCounts(photoId)
          : {},
        // Per-colour tallies (#1044), gated exactly like `reactions` above:
        // with sharing off the guest sees only their own label.
        color_labels: settings.show_feedback_to_guests
          ? await feedbackService.getPhotoColorLabelCounts(photoId)
          : {},
        my_feedback: {
          rating: guestFeedback.find(f => f.feedback_type === 'rating')?.rating,
          liked: !!guestFeedback.find(f => f.feedback_type === 'like'),
          favorited: !!guestFeedback.find(f => f.feedback_type === 'favorite'),
          reaction: guestFeedback.find(f => f.feedback_type === 'reaction')?.reaction || null,
          // In shared mode the photo's one tag IS this viewer's tag (#1197):
          // there is no per-guest row to find, and returning null here would
          // leave the lightbox swatch unselected while the photo plainly
          // carries a colour. Delivered through my_feedback rather than the
          // gated `color_labels` map above on purpose — the shared tag is the
          // photo's own state, so it stays visible even with
          // show_feedback_to_guests off, while the per-colour tallies (which
          // are other people's data) stay hidden.
          color_label: settings.identity_mode === 'shared'
            ? sharedColorLabel
            : (guestFeedback.find(f => f.feedback_type === 'color_label')?.color_label || null),
          // Approve / reject (issue 744) and the reason the guest gave.
          decision: guestFeedback.find(f => f.feedback_type === 'decision')?.decision || null,
          decision_reason: guestFeedback.find(f => f.feedback_type === 'decision')?.comment_text || null,
          // Which of the guest's lists hold the photo (issue 2303), null for
          // the default list; the bookmark shows the list the guest picked.
          ...(settings.allow_favorite_lists ? {
            favorite_list_ids: [...new Set(guestFeedback
              .filter(f => f.feedback_type === 'favorite' && !f.is_hidden)
              .map(f => (f.favorite_list_id == null ? null : Number(f.favorite_list_id))))],
          } : {}),
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
  // Reveal-gated (#838): no interacting with photos you cannot see.
  blockHiddenGallery,
  resolveGuest,
  scopeGuestToFeedback,
  validatePhotoId,
  validateFeedbackSubmission,
  checkValidation,
  async (req, res) => {
    try {
      const { photoId } = req.params;
      const event = req.event;

      // Get feedback settings first so we can enforce identity_mode.
      const settings = await feedbackService.getEventFeedbackSettings(event.id);

      const feedbackType = req.body.feedback_type;
      const refusal = feedbackWriteRefusal(req, settings, feedbackType);
      if (refusal) return res.status(refusal.status).json(refusal.body);

      const guestIdentifier = await generateGuestIdentifier(req);

      // The list a favourite goes to (issue 2303). Without lists the field is
      // refused rather than ignored, and the service reads every list as one,
      // as before lists existed. Absent or null is the default list.
      let favoriteListId;
      if (feedbackType === 'favorite' && settings.allow_favorite_lists) {
        const raw = req.body.favorite_list_id;
        if (raw === undefined || raw === null) {
          favoriteListId = null;
        } else {
          favoriteListId = Number(raw);
          if (!Number.isSafeInteger(favoriteListId) || favoriteListId <= 0) {
            return res.status(400).json({ error: 'Invalid favorite list', code: 'INVALID_FAVORITE_LIST' });
          }
        }
      } else if (req.body.favorite_list_id !== undefined && req.body.favorite_list_id !== null) {
        return res.status(403).json({ error: 'Favorite lists are not enabled', code: 'FAVORITE_LISTS_DISABLED' });
      }

      // A drawing (issue 1733) belongs to a comment and needs its own switch.
      // Validated here into a fresh structure; anything off is a 400 and the
      // client's own string is never stored.
      let annotation = null;
      if (req.body.annotation !== undefined && req.body.annotation !== null) {
        if (feedbackType !== 'comment') {
          return res.status(400).json({ error: 'An annotation needs a comment', code: 'INVALID_ANNOTATION' });
        }
        if (!settings.allow_annotations) {
          return res.status(403).json({ error: 'Annotations are not enabled', code: 'ANNOTATIONS_DISABLED' });
        }
        annotation = normalizeAnnotation(req.body.annotation);
        if (!annotation) {
          return res.status(400).json({ error: 'Invalid annotation', code: 'INVALID_ANNOTATION' });
        }
        const drawnOn = req.body.annotation_rev;
        if (drawnOn !== undefined && drawnOn !== null && !(Number.isInteger(drawnOn) && drawnOn >= 0)) {
          return res.status(400).json({ error: 'Invalid annotation revision', code: 'INVALID_ANNOTATION' });
        }
      }

      if (!(await viewablePhoto(req, photoId))) {
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
      if (await rateLimited(req, res, feedbackType)) return;

      // Prepare feedback data.
      const feedbackData = {
        feedback_type: feedbackType,
        rating: req.body.rating,
        comment_text: req.body.comment_text,
        reaction: req.body.reaction,
        color_label: req.body.color_label,
        decision: req.body.decision,
        annotation,
        // The edit revision of the picture the drawing was made on (issue
        // 2619): the e= of the guest's image URLs. Absent from an older
        // client, which draws on the revision applied now.
        annotation_rev: annotation && req.body.annotation_rev !== undefined && req.body.annotation_rev !== null
          ? Number(req.body.annotation_rev) : undefined,
        favorite_list_id: favoriteListId,
        // The cap counts the picks this viewer can see (issue 2356).
        viewer: viewerOf(req),
        ...feedbackAuthor(req, settings)
      };
      
      // For comments, check moderation
      if (feedbackType === 'comment') {
        // Moderate the comment
        const moderationResult = await feedbackModeration.moderateText(req.body.comment_text);
        
        if (moderationResult.blocked) {
          // `block` severity means rejected outright — never stored, not even
          // as a pending row for a moderator to see. Anything else that isn't
          // approved falls through to the held-for-moderation branch below.
          logger.warn('Comment rejected by word filter:', {
            eventId: event.id,
            reason: moderationResult.reason,
            violations: moderationResult.violations
          });
          return res.status(400).json({
            error: 'Your comment contains words that are not allowed here.',
            code: 'COMMENT_BLOCKED'
          });
        }

        if (!moderationResult.approved) {
          // Still save but mark as not approved
          feedbackData.is_approved = false;
          logger.warn('Comment flagged for moderation:', {
            reason: moderationResult.reason,
            violations: moderationResult.violations
          });
        }
        // Otherwise feedbackService applies the event's moderate_comments.
      }
      
      // A decision's reason (issue 744) is read only by the photographer, so
      // the word filter's hold-for-review tier does not apply — but a
      // `block` word is refused here exactly as it is in a comment.
      if (feedbackType === 'decision' && feedbackData.comment_text) {
        const moderationResult = await feedbackModeration.moderateText(feedbackData.comment_text);
        if (moderationResult.blocked) {
          return res.status(400).json({
            error: 'Your comment contains words that are not allowed here.',
            code: 'COMMENT_BLOCKED'
          });
        }
      }

      // Submit feedback
      const result = await feedbackService.submitFeedback(
        photoId,
        event.id,
        feedbackData,
        guestIdentifier
      );

      // The guest was merged away or deleted while this request was running.
      // Same answer resolveGuest gives the next request from that token.
      if (result && result.guest_missing) {
        return res.status(401).json(GUEST_IDENTITY_REQUIRED_BODY);
      }

      // Not one of this guest's lists in this gallery, or deleted meanwhile.
      if (result && result.list_missing) {
        return res.status(404).json({ error: 'Favorite list not found', code: 'FAVORITE_LIST_NOT_FOUND' });
      }

      // Drawn on a picture an edit has replaced since (issue 2619).
      if (result && result.image_changed) {
        return res.status(409).json({ error: 'The photo has changed since it was shown; reload it to draw on it', code: 'IMAGE_CHANGED' });
      }

      // Handed in: nothing was written.
      if (result && result.locked) {
        return res.status(409).json(lockedBody(result));
      }

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
        // Which way the guest decided (issue 744), for the bell and the feed.
        ...(feedbackType === 'decision' ? { decision: req.body.decision } : {}),
        result
      }, event.id, {
        type: 'guest',
        id: guestIdentifier.substring(0, 16),
        name: req.body.guest_name || 'Anonymous'
      });

      res.json({
        success: true,
        ...result,
        // Held exactly when feedbackService stores the row unapproved: an
        // explicit `false`, or the event moderating comments. `is_approved`
        // stays undefined for an auto-approved comment, which `!undefined`
        // used to read as held (issue 2077).
        message: feedbackType === 'comment'
          && (feedbackData.is_approved === false || Boolean(feedbackData.moderate_comments)) ?
          'Your comment has been submitted for moderation' : undefined
      });
    } catch (error) {
      logger.error('Error submitting feedback:', error);
      res.status(500).json({ error: 'Failed to submit feedback' });
    }
  }
);

// Rate several photos at once (issue 1733). Ratings only: the one feedback
// type a guest gives to a whole selection, and a loop over the single route
// spends a request per photo. Every photo passes the checks of the single
// route and costs one unit of the rating budget; a selection the budget does
// not cover is refused whole.
router.post('/:slug/feedback/bulk',
  verifyGalleryAccess,
  denySlideshowToken,
  blockHiddenGallery,
  resolveGuest,
  scopeGuestToFeedback,
  // The single route's validators for rating, guest_name and guest_email.
  (req, _res, next) => { req.body = { ...req.body, feedback_type: 'rating' }; next(); },
  validateFeedbackSubmission,
  body('photo_ids')
    .isArray({ min: 1, max: BULK_RATING_MAX_PHOTOS })
    .withMessage(`photo_ids must list 1 to ${BULK_RATING_MAX_PHOTOS} photos`),
  body('photo_ids.*').isInt({ min: 1, max: 2147483647 }).withMessage('Invalid photo ID').toInt(),
  checkValidation,
  async (req, res) => {
    try {
      const event = req.event;
      const settings = await feedbackService.getEventFeedbackSettings(event.id);

      const refusal = feedbackWriteRefusal(req, settings, 'rating');
      if (refusal) return res.status(refusal.status).json(refusal.body);

      if (settings.identity_mode !== 'guest') {
        const guestValidation = await validateGuestRequirements(settings, req.body);
        if (!guestValidation.valid) {
          return res.status(400).json({
            error: 'Guest information required',
            errors: guestValidation.errors
          });
        }
      }

      const photoIds = [...new Set(req.body.photo_ids)];
      // Same conditions as the single route: the photo is this event's, it is
      // not hidden from this viewer, and its processing has finished.
      const rows = await livePhotos(db).whereIn('id', photoIds).where({ event_id: event.id });
      const rateable = new Set(rows
        .filter(photo => !isPhotoHiddenFromViewer(photo, viewerOf(req)) && isPhotoProcessed(photo))
        .map(photo => Number(photo.id)));

      // One unit per photo that will be rated, reserved before any write.
      if (rateable.size > 0) {
        if (await rateLimited(req, res, 'rating', rateable.size)) return;
      }

      const guestIdentifier = await generateGuestIdentifier(req);
      const feedbackData = {
        feedback_type: 'rating',
        rating: req.body.rating,
        viewer: viewerOf(req),
        ...feedbackAuthor(req, settings)
      };

      const results = [];
      for (const photoId of photoIds) {
        if (!rateable.has(photoId)) {
          results.push({ photo_id: photoId, success: false, error: 'Photo not found' });
          continue;
        }
        let result;
        try {
          result = await feedbackService.submitFeedback(photoId, event.id, feedbackData, guestIdentifier);
        } catch {
          // Logged by the service. The photos before this one are rated, so
          // the answer still has to say which.
          results.push({ photo_id: photoId, success: false, error: 'Failed to submit feedback' });
          continue;
        }
        // The guest was merged away or deleted while this request was running.
        if (result && result.guest_missing) {
          return res.status(401).json(GUEST_IDENTITY_REQUIRED_BODY);
        }
        results.push({ photo_id: photoId, success: true, ...result });
      }

      const ratedIds = results.filter(r => r.success).map(r => r.photo_id);
      if (ratedIds.length > 0) {
        // Other guests' ratings are in the aggregates, so they go to whoever
        // the photo list gives them to (galleryQueryService): a guest while
        // feedback is shared, the PIN client always. The frontend writes
        // this answer into that list without refetching it.
        if (settings.show_feedback_to_guests || req.accessLevel === 'client') {
          const averages = await livePhotos(db).whereIn('id', ratedIds).select('id', 'average_rating');
          const totals = await db('photo_feedback')
            .whereIn('photo_id', ratedIds)
            .where({ feedback_type: 'rating', is_hidden: false })
            .groupBy('photo_id')
            .select('photo_id')
            .count('id as count');
          const averageById = new Map(averages.map(row => [Number(row.id), Number(row.average_rating) || 0]));
          const totalById = new Map(totals.map(row => [Number(row.photo_id), Number(row.count) || 0]));
          for (const entry of results) {
            if (!entry.success) continue;
            entry.average_rating = averageById.get(entry.photo_id) || 0;
            entry.total_ratings = totalById.get(entry.photo_id) || 0;
          }
        }

        await logActivity('guest_feedback_rating', {
          photo_ids: ratedIds,
          rating: req.body.rating
        }, event.id, {
          type: 'guest',
          id: guestIdentifier.substring(0, 16),
          name: req.body.guest_name || 'Anonymous'
        });
      }

      res.json({ success: true, rating: req.body.rating, results });
    } catch (error) {
      logger.error('Error submitting bulk rating:', error);
      res.status(500).json({ error: 'Failed to submit feedback' });
    }
  }
);

// Get feedback summary for entire gallery
router.get('/:slug/feedback-summary',
  verifyGalleryAccess,
  denySlideshowToken,
  async (req, res) => {
    try {
      const event = req.event;

      // Reveal mode (#838): the summary lists top photos by filename —
      // hidden along with the gallery for plain guests.
      if (guestBlockedByReveal(req)) {
        return res.json({ enabled: false, summary: null });
      }

      // Get feedback settings
      const settings = await feedbackService.getEventFeedbackSettings(event.id);
      
      if (!settings.feedback_enabled || !settings.show_feedback_to_guests) {
        return res.json({
          enabled: false,
          summary: null
        });
      }
      
      // Totals scoped like the list below: feedback on photos this viewer
      // cannot see is not counted either.
      const summary = await feedbackService.getEventFeedbackSummary(event.id, { viewerAccessLevel: viewerOf(req) });

      // Filter data based on what guests should see
      const guestSummary = {
        stats: summary.stats,
        top_rated: summary.photos
          // No filenames or ratings of photos this viewer cannot see, nor of
          // photos the gallery list leaves out while they are processed.
          .filter(p => !isPhotoHiddenFromViewer(p, viewerOf(req)) && isPhotoProcessed(p))
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
          allow_favorites: settings.allow_favorites,
          allow_reactions: settings.allow_reactions,
          allow_color_labels: settings.allow_color_labels,
          allow_decisions: settings.allow_decisions,
          keybind_mode: settings.keybind_mode || 'colors'
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
  denySlideshowToken,
  resolveGuest,
  scopeGuestToFeedback,
  async (req, res) => {
    try {
      const event = req.event;

      // Reveal mode (#838): rows join photos (filename + storage path) —
      // return the empty back-compat shape rather than a 403 so the gallery
      // shell loading in parallel doesn't surface error toasts.
      if (guestBlockedByReveal(req)) {
        return res.json([]);
      }

      const query = applyPhotoVisibilityFilter(
        // A photo back in processing (an admin retry) is not in the gallery
        // list; its rows are kept and come back once it is complete again.
        wherePhotoProcessed(db('photo_feedback'))
          .modify(joinLivePhotos, 'photo_feedback.photo_id', 'photos.id')
          .where('photo_feedback.event_id', event.id)
          // Hidden rows are absent for the guest who left them too (#1150). In
          // guest identity mode GalleryView builds its Liked/Favorited/Rated
          // chips and their filters from THIS array rather than from is_liked,
          // so without this a hidden like left an empty heart while the Liked
          // chip still counted it and still surfaced the photo. Unapproved rows
          // stay: a comment in the moderation queue is still the guest's own.
          .where('photo_feedback.is_hidden', false),
        // A photo the client has since hidden is gone for this viewer, its id
        // and filename included.
        viewerOf(req)
      );

      // Prefer guest_id lookup when a verified guest token is present
      // (per-person identity). Fall back to the device hash otherwise.
      // The identifier is only derived when there is no guest to go by.
      scopeToViewer(query, {
        guestId: req.guest?.id,
        guestIdentifier: req.guest?.id ? null : await generateGuestIdentifier(req),
      }, 'photo_feedback');

      // The list of each favourite (issue 2303), only while the gallery has
      // lists: without them the rows read as they always did.
      const { allow_favorite_lists: listsOn } = await feedbackService.getEventFeedbackSettings(event.id);

      // Name the columns rather than photo_feedback.*: the row also carries
      // guest_email, guest_name, ip_address and user_agent. After an admin
      // merges two guest identities those still describe the source guest,
      // so the survivor's token would receive another person's email and IP.
      // GalleryView reads photo_id and feedback_type from this list.
      const myFeedback = await query
        .select(
          'photo_feedback.id',
          'photo_feedback.photo_id',
          'photo_feedback.feedback_type',
          'photo_feedback.rating',
          'photo_feedback.comment_text',
          'photo_feedback.reaction',
          'photo_feedback.color_label',
          'photo_feedback.decision',
          'photo_feedback.is_approved',
          'photo_feedback.created_at',
          'photo_feedback.updated_at',
          'photos.filename',
          ...(listsOn ? ['photo_feedback.favorite_list_id'] : [])
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

// Take back all of the viewer's own likes in this gallery at once (issue
// 2561). Other guests' likes and every other feedback type stay as they are.
router.delete('/:slug/my-feedback/likes',
  verifyGalleryAccess,
  denySlideshowToken,
  blockHiddenGallery,
  resolveGuest,
  scopeGuestToFeedback,
  async (req, res) => {
    try {
      const event = req.event;
      const settings = await feedbackService.getEventFeedbackSettings(event.id);
      const refusal = feedbackWriteRefusal(req, settings, 'like');
      if (refusal) return res.status(refusal.status).json(refusal.body);

      // One unit of the like budget for the whole request.
      if (await rateLimited(req, res, 'like')) return;

      const result = await feedbackService.clearOwnLikes(event.id, await selectionViewer(req));
      if (result.guest_missing) {
        return res.status(401).json(GUEST_IDENTITY_REQUIRED_BODY);
      }
      // Likes lock with the selection, so kind is always 'selection' here.
      if (result.locked) {
        return res.status(409).json(lockedBody(result));
      }
      res.json({ success: true, removed: result.removed, photo_ids: result.photo_ids });
    } catch (error) {
      logger.error('Error clearing own likes:', error);
      res.status(500).json({ error: 'Failed to remove your likes' });
    }
  }
);

// The viewer of a selection route, by the rule that finds their feedback: the
// registered guest, else the anonymous browser identity. The access level
// keeps a pick on a photo this viewer can no longer see out of the counts.
async function selectionViewer(req) {
  return {
    guestId: req.guest?.id ?? null,
    guestIdentifier: await generateGuestIdentifier(req),
    accessLevel: req.accessLevel,
    fullView: req.galleryFullView === true,
  };
}

// Finish selection / approve edited photos (issue 1733, A1): the viewer's own
// state per kind, with the cap and how much of it is used.
router.get('/:slug/selection',
  verifyGalleryAccess,
  denySlideshowToken,
  resolveGuest,
  scopeGuestToFeedback,
  async (req, res) => {
    try {
      // Reveal mode (#838): a hidden gallery has nothing to select yet; the
      // same all-off shape rather than a 403, as /my-feedback does.
      const settings = guestBlockedByReveal(req)
        ? { feedback_enabled: false }
        : await feedbackService.getEventFeedbackSettings(req.event.id);
      res.json(await selectionSubmissions.getState(req.event.id, settings, await selectionViewer(req)));
    } catch (error) {
      logger.error('Error getting selection state:', error);
      res.status(500).json({ error: 'Failed to get the selection' });
    }
  }
);

// Hand the selection in, or approve the edited photos. Locks that guest's
// picks (or decisions) until an admin reopens it.
router.post('/:slug/selection/submit',
  verifyGalleryAccess,
  denySlideshowToken,
  blockHiddenGallery,
  resolveGuest,
  scopeGuestToFeedback,
  body('kind').isIn(selectionSubmissions.KINDS),
  body('note').optional({ nullable: true }).isString().trim()
    .isLength({ max: selectionSubmissions.NOTE_MAX_LENGTH }),
  // Simple and shared mode: the name and email the hand-over dialog asked
  // for, validated as the feedback routes validate them.
  body('guest_name').optional().customSanitizer(normalizeGuestName).custom(checkGuestName),
  body('guest_email').optional().trim().isEmail().normalizeEmail(IDENTITY_PRESERVING_NORMALIZE_EMAIL),
  checkValidation,
  feedbackRateLimit('selection_submit'),
  async (req, res) => {
    try {
      const event = req.event;
      const settings = await feedbackService.getEventFeedbackSettings(event.id);
      // As for feedback: feedback on, and guest identity mode takes a
      // verified guest only.
      const refusal = feedbackIdentityRefusal(req, settings);
      if (refusal) return res.status(refusal.status).json(refusal.body);

      const { kind } = req.body;
      const note = req.body.note || null;
      // The note is read by the photographer only, like a decision's reason:
      // a `block` word is refused, nothing is held for review.
      if (note && (await feedbackModeration.moderateText(note)).blocked) {
        return res.status(400).json({
          error: 'Your comment contains words that are not allowed here.',
          code: 'COMMENT_BLOCKED'
        });
      }

      const viewer = await selectionViewer(req);
      let guestName = req.guest?.name ?? null;
      // Outside guest mode a guest token kept from guest mode names the
      // visitor only when it carries what the gallery requires: the feedback
      // routes check the body there, token or not.
      if (settings.identity_mode !== 'guest' && settings.require_name_email
        && !(guestName?.trim() && req.guest?.email?.trim())) {
        guestName = null;
      }
      if (!guestName) {
        // Simple and shared mode name the guest from the body, as the feedback
        // routes do; else from the name given with their earlier feedback.
        const typed = settings.identity_mode !== 'guest'
          && (await validateGuestRequirements(settings, req.body)).valid
          ? req.body.guest_name || null
          : null;
        guestName = typed || await selectionSubmissions.feedbackName(event.id, viewer, {
          requireEmail: !!settings.require_name_email,
        });
      }
      // A gallery that requires name and email takes no anonymous hand-over:
      // an approval needs no feedback, so nothing else asked for the name.
      if (settings.identity_mode !== 'guest' && settings.require_name_email && !guestName) {
        return res.status(400).json({ error: 'Guest information required', code: 'GUEST_INFO_REQUIRED' });
      }
      const result = await selectionSubmissions.submit(event.id, settings, viewer, { kind, note, guestName });

      // Merged away or deleted while this request was running: the answer
      // resolveGuest gives the next request from that token.
      if (result.guest_missing) {
        return res.status(401).json(GUEST_IDENTITY_REQUIRED_BODY);
      }
      if (result.disabled) {
        return res.status(403).json({ error: `${kind} cannot be submitted in this gallery`, code: 'SUBMISSION_DISABLED' });
      }
      if (result.empty) {
        return res.status(400).json({ error: 'Nothing is selected yet', code: 'NOTHING_SELECTED' });
      }
      if (result.already) {
        return res.status(409).json({ error: 'Already submitted', code: 'ALREADY_SUBMITTED', submission: result.already });
      }

      try {
        await selectionSubmissions.notifySubmitted(event, result.submission, {
          guestName,
          guestIdentifier: viewer.guestIdentifier,
          rejected: result.rejected,
        });
      } catch (notifyError) {
        // Stored already; the guest's submission stands without the notice.
        logger.error('Selection submission notification failed:', notifyError);
      }

      res.status(201).json({ success: true, submission: result.submission });
    } catch (error) {
      logger.error('Error submitting selection:', error);
      res.status(500).json({ error: 'Failed to submit' });
    }
  }
);

// Named favourite lists (issue 2303). The default list is implicit (NULL on
// the favourite row) and has no route: it cannot be renamed or deleted. Every
// route answers 403 while the gallery has lists off.
function favoriteListRefusal(req, settings) {
  const refusal = feedbackWriteRefusal(req, settings, 'favorite');
  if (refusal) return refusal;
  if (!settings.allow_favorite_lists) {
    return { status: 403, body: { error: 'Favorite lists are not enabled', code: 'FAVORITE_LISTS_DISABLED' } };
  }
  return null;
}

// The shared answers of the list writes; null when the result is a success.
function favoriteListWriteError(res, result) {
  if (result.guest_missing) {
    return res.status(401).json(GUEST_IDENTITY_REQUIRED_BODY);
  }
  if (result.locked) {
    // The same answer a favourite gets: the lists are part of the selection.
    return res.status(409).json(lockedBody(result));
  }
  if (result.not_found) {
    return res.status(404).json({ error: 'Favorite list not found', code: 'FAVORITE_LIST_NOT_FOUND' });
  }
  if (result.invalid_name) {
    return res.status(400).json({
      error: `A list name needs 1 to ${favoriteLists.NAME_MAX_LENGTH} characters`,
      code: 'INVALID_FAVORITE_LIST_NAME',
      max_length: favoriteLists.NAME_MAX_LENGTH,
    });
  }
  if (result.name_taken) {
    return res.status(409).json({ error: 'A list with this name exists', code: 'FAVORITE_LIST_NAME_TAKEN' });
  }
  if (result.limit_reached) {
    return res.status(403).json({ error: 'List limit reached', code: 'FAVORITE_LIST_LIMIT_REACHED', limit: result.limit });
  }
  return null;
}

// Reads and writes alike: the Live Slideshow kiosk shows no favorite lists.
const favoriteListGuards = [verifyGalleryAccess, denySlideshowToken, blockHiddenGallery, resolveGuest, scopeGuestToFeedback];

// The viewer's lists with the number of photos in each.
router.get('/:slug/favorite-lists',
  ...favoriteListGuards,
  async (req, res) => {
    try {
      const settings = await feedbackService.getEventFeedbackSettings(req.event.id);
      const refusal = favoriteListRefusal(req, settings);
      if (refusal) return res.status(refusal.status).json(refusal.body);
      const lists = await favoriteLists.listForViewer(req.event.id, await selectionViewer(req));
      res.json({
        ...lists,
        max_lists: favoriteLists.MAX_LISTS_PER_GUEST,
        max_name_length: favoriteLists.NAME_MAX_LENGTH,
      });
    } catch (error) {
      logger.error('Error listing favorite lists:', error);
      res.status(500).json({ error: 'Failed to get favorite lists' });
    }
  }
);

router.post('/:slug/favorite-lists',
  ...favoriteListGuards,
  async (req, res) => {
    try {
      const settings = await feedbackService.getEventFeedbackSettings(req.event.id);
      const refusal = favoriteListRefusal(req, settings);
      if (refusal) return res.status(refusal.status).json(refusal.body);
      if (await rateLimited(req, res, 'favorite_list')) return;
      const result = await favoriteLists.create(req.event.id, await selectionViewer(req), req.body?.name);
      if (favoriteListWriteError(res, result)) return;
      res.status(201).json({ success: true, list: result.list });
    } catch (error) {
      logger.error('Error creating favorite list:', error);
      res.status(500).json({ error: 'Failed to create the list' });
    }
  }
);

router.patch('/:slug/favorite-lists/:listId',
  ...favoriteListGuards,
  async (req, res) => {
    try {
      const settings = await feedbackService.getEventFeedbackSettings(req.event.id);
      const refusal = favoriteListRefusal(req, settings);
      if (refusal) return res.status(refusal.status).json(refusal.body);
      if (await rateLimited(req, res, 'favorite_list')) return;
      const result = await favoriteLists.rename(req.event.id, await selectionViewer(req), req.params.listId, req.body?.name);
      if (favoriteListWriteError(res, result)) return;
      res.json({ success: true, list: result.list });
    } catch (error) {
      logger.error('Error renaming favorite list:', error);
      res.status(500).json({ error: 'Failed to rename the list' });
    }
  }
);

// Deletes the list and the favourites in it.
router.delete('/:slug/favorite-lists/:listId',
  ...favoriteListGuards,
  async (req, res) => {
    try {
      const settings = await feedbackService.getEventFeedbackSettings(req.event.id);
      const refusal = favoriteListRefusal(req, settings);
      if (refusal) return res.status(refusal.status).json(refusal.body);
      if (await rateLimited(req, res, 'favorite_list')) return;
      const result = await favoriteLists.remove(req.event.id, await selectionViewer(req), req.params.listId);
      if (favoriteListWriteError(res, result)) return;
      // After the commit, as for a favourite: favorite_count is per guest.
      for (const photoId of result.photo_ids) {
        await feedbackService.updatePhotoFeedbackStats(photoId);
      }
      res.json({ success: true, removed: result.removed });
    } catch (error) {
      logger.error('Error deleting favorite list:', error);
      res.status(500).json({ error: 'Failed to delete the list' });
    }
  }
);

module.exports = router;
