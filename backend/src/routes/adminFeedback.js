const express = require('express');
const router = express.Router();
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const feedbackService = require('../services/feedbackService');
const feedbackModeration = require('../services/feedbackModeration');
const { db, logActivity } = require('../database/db');
const logger = require('../utils/logger');
const {
  validateEventId,
  validateFeedbackSettings,
  validateWordFilter,
  checkValidation
} = require('../utils/feedbackValidation');
const { requireEventOwnership } = require('../middleware/ownership');

// Get event feedback settings
router.get('/events/:eventId/feedback-settings',
  adminAuth,
  requirePermission('events.view'),
  requireEventOwnership,
  validateEventId,
  checkValidation,
  async (req, res) => {
    try {
      const { eventId } = req.params;
      
      // Verify event exists and belongs to admin
      const event = await db('events').where('id', eventId).first();
      if (!event) {
        return res.status(404).json({ error: 'Event not found' });
      }
      
      const settings = await feedbackService.getEventFeedbackSettings(eventId);
      res.json(settings);
    } catch (error) {
      logger.error('Error getting feedback settings:', error);
      res.status(500).json({ error: 'Failed to get feedback settings' });
    }
  }
);

// Update event feedback settings
router.put('/events/:eventId/feedback-settings',
  adminAuth,
  requirePermission('events.edit'),
  requireEventOwnership,
  validateEventId,
  validateFeedbackSettings,
  checkValidation,
  async (req, res) => {
    try {
      const { eventId } = req.params;
      const settings = req.body;
      
      // Verify event exists
      const event = await db('events').where('id', eventId).first();
      if (!event) {
        return res.status(404).json({ error: 'Event not found' });
      }
      
      const updatedSettings = await feedbackService.updateEventFeedbackSettings(eventId, settings);
      
      await logActivity('feedback_settings_updated', {
        event_id: eventId,
        settings: updatedSettings
      }, eventId, {
        type: 'admin',
        id: req.admin.id,
        name: req.admin.username
      });
      
      res.json(updatedSettings);
    } catch (error) {
      logger.error('Error updating feedback settings:', error);
      res.status(500).json({ error: 'Failed to update feedback settings' });
    }
  }
);

// Get feedback for an event (with filters)
router.get('/events/:eventId/feedback',
  adminAuth,
  requirePermission('events.view'),
  requireEventOwnership,
  validateEventId,
  checkValidation,
  async (req, res) => {
    try {
      const { eventId } = req.params;
      const { type, status, photoId, page = 1, limit = 50 } = req.query;
      
      // Build query
      let query = db('photo_feedback')
        .join('photos', 'photo_feedback.photo_id', 'photos.id')
        .where('photo_feedback.event_id', eventId)
        .select(
          'photo_feedback.*',
          'photos.filename',
          'photos.path'
        );
      
      if (type) {
        query = query.where('photo_feedback.feedback_type', type);
      }
      
      if (status === 'pending') {
        query = query.where('photo_feedback.is_approved', false)
                     .where('photo_feedback.is_hidden', false);
      } else if (status === 'approved') {
        query = query.where('photo_feedback.is_approved', true);
      } else if (status === 'hidden') {
        query = query.where('photo_feedback.is_hidden', true);
      }
      
      if (photoId) {
        query = query.where('photo_feedback.photo_id', photoId);
      }
      
      // Pagination
      const offset = (page - 1) * limit;
      
      // Create a separate count query
      let countQuery = db('photo_feedback')
        .where('photo_feedback.event_id', eventId);
      
      if (type) {
        countQuery = countQuery.where('photo_feedback.feedback_type', type);
      }
      
      if (status === 'pending') {
        countQuery = countQuery.where('photo_feedback.is_approved', false)
                               .where('photo_feedback.is_hidden', false);
      } else if (status === 'approved') {
        countQuery = countQuery.where('photo_feedback.is_approved', true);
      } else if (status === 'hidden') {
        countQuery = countQuery.where('photo_feedback.is_hidden', true);
      }
      
      if (photoId) {
        countQuery = countQuery.where('photo_feedback.photo_id', photoId);
      }
      
      const totalCount = await countQuery.count('photo_feedback.id as count').first();
      
      const feedback = await query
        .orderBy('photo_feedback.created_at', 'desc')
        .limit(limit)
        .offset(offset);
      
      res.json({
        feedback,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: totalCount?.count || 0,
          pages: Math.ceil((totalCount?.count || 0) / limit)
        }
      });
    } catch (error) {
      logger.error('Error getting feedback:', error);
      res.status(500).json({ error: 'Failed to get feedback' });
    }
  }
);

// Moderate feedback (approve/hide/reject)
router.put('/feedback/:feedbackId/:action',
  adminAuth,
  requirePermission('events.edit'),
  async (req, res) => {
    try {
      const { feedbackId, action } = req.params;
      
      if (!['approve', 'hide', 'reject'].includes(action)) {
        return res.status(400).json({ error: 'Invalid action' });
      }
      
      await feedbackService.moderateFeedback(feedbackId, action, req.admin.id);
      
      res.json({ success: true });
    } catch (error) {
      logger.error('Error moderating feedback:', error);
      res.status(500).json({ error: 'Failed to moderate feedback' });
    }
  }
);

// Delete feedback
router.delete('/feedback/:feedbackId',
  adminAuth,
  requirePermission('events.delete'),
  async (req, res) => {
    try {
      const { feedbackId } = req.params;
      
      await feedbackService.deleteFeedback(feedbackId, req.admin.id);
      
      res.json({ success: true });
    } catch (error) {
      logger.error('Error deleting feedback:', error);
      res.status(500).json({ error: 'Failed to delete feedback' });
    }
  }
);

// Get feedback analytics for an event
router.get('/events/:eventId/feedback-analytics',
  adminAuth,
  requirePermission('events.view'),
  requireEventOwnership,
  validateEventId,
  checkValidation,
  async (req, res) => {
    try {
      const { eventId } = req.params;
      
      // Get summary statistics
      const summaryData = await feedbackService.getEventFeedbackSummary(eventId);
      
      // Calculate average rating and other summary stats
      const avgRatingResult = await db('photo_feedback')
        .where('event_id', eventId)
        .where('feedback_type', 'rating')
        .avg('rating as average_rating')
        .first();
      
      const pendingModeration = await db('photo_feedback')
        .where('event_id', eventId)
        .where('feedback_type', 'comment')
        .where('is_approved', false)
        .where('is_hidden', false)
        .count('* as count')
        .first();
      
      const summary = {
        average_rating: parseFloat(avgRatingResult?.average_rating || 0),
        total_ratings: summaryData.stats?.total_ratings || 0,
        total_likes: summaryData.stats?.total_likes || 0,
        total_comments: summaryData.stats?.total_comments || 0,
        total_favorites: summaryData.stats?.total_favorites || 0,
        pending_moderation: pendingModeration?.count || 0,
        total_feedback: (summaryData.stats?.total_ratings || 0) + 
                       (summaryData.stats?.total_likes || 0) + 
                       (summaryData.stats?.total_comments || 0) + 
                       (summaryData.stats?.total_favorites || 0)
      };
      
      // Get top-rated photos
      const topRated = await db('photos')
        .where('event_id', eventId)
        .where('average_rating', '>', 0)
        .orderBy('average_rating', 'desc')
        .orderBy('feedback_count', 'desc')
        .limit(10)
        .select('id', 'filename', 'average_rating', 'feedback_count', 'like_count');
      
      // Get most liked photos
      const mostLiked = await db('photos')
        .where('event_id', eventId)
        .where('like_count', '>', 0)
        .orderBy('like_count', 'desc')
        .limit(10)
        .select('id', 'filename', 'like_count', 'average_rating');
      
      // Get recent comments
      const recentComments = await db('photo_feedback')
        .join('photos', 'photo_feedback.photo_id', 'photos.id')
        .where('photo_feedback.event_id', eventId)
        .where('photo_feedback.feedback_type', 'comment')
        .where('photo_feedback.is_approved', true)
        .where('photo_feedback.is_hidden', false)
        .orderBy('photo_feedback.created_at', 'desc')
        .limit(10)
        .select(
          'photo_feedback.comment_text',
          'photo_feedback.guest_name',
          'photo_feedback.created_at',
          'photos.filename'
        );
      
      // Get feedback timeline (last 7 days)
      const timeline = await db('photo_feedback')
        .where('event_id', eventId)
        .where('created_at', '>', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
        .select(
          db.raw('DATE(created_at) as date'),
          db.raw('COUNT(*) as count'),
          'feedback_type'
        )
        .groupBy('date', 'feedback_type')
        .orderBy('date', 'asc');
      
      res.json({
        summary,
        topRated,
        mostLiked,
        recentComments,
        timeline
      });
    } catch (error) {
      logger.error('Error getting feedback analytics:', error);
      res.status(500).json({ error: 'Failed to get feedback analytics' });
    }
  }
);

// Export feedback data
router.get('/events/:eventId/feedback/export',
  adminAuth,
  requirePermission('events.view'),
  requireEventOwnership,
  validateEventId,
  checkValidation,
  async (req, res) => {
    try {
      const { eventId } = req.params;
      const { format = 'json', shape = 'long' } = req.query;

      // shape='long' (default, backward-compat) → one row per individual
      // feedback action. shape='pivot' (#640 part #6) → one row per
      // (photo, guest) with is_favorited / is_liked / star_rating / comment.
      const isPivot = String(shape).toLowerCase() === 'pivot';
      const feedback = isPivot
        ? await feedbackService.exportEventFeedbackPivoted(eventId)
        : await feedbackService.exportEventFeedback(eventId);

      if (format === 'csv') {
        const csv = convertToCSV(feedback);
        const fileSuffix = isPivot ? 'pivot' : 'long';
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="feedback-${fileSuffix}-${eventId}.csv"`);
        res.send(csv);
      } else {
        res.json(feedback);
      }
    } catch (error) {
      logger.error('Error exporting feedback:', error);
      res.status(500).json({ error: 'Failed to export feedback' });
    }
  }
);

// Get pending moderation items (across all events)
router.get('/feedback/pending-moderation',
  adminAuth,
  requirePermission('events.view'),
  async (req, res) => {
    try {
      const pending = await feedbackService.getPendingModeration();
      res.json(pending);
    } catch (error) {
      logger.error('Error getting pending moderation:', error);
      res.status(500).json({ error: 'Failed to get pending moderation' });
    }
  }
);

// Word filter management
router.get('/word-filters',
  adminAuth,
  requirePermission('settings.view'),
  async (req, res) => {
    try {
      const filters = await feedbackModeration.getAllWordFilters();
      res.json(filters);
    } catch (error) {
      logger.error('Error getting word filters:', error);
      res.status(500).json({ error: 'Failed to get word filters' });
    }
  }
);

router.post('/word-filters',
  adminAuth,
  requirePermission('settings.edit'),
  validateWordFilter,
  checkValidation,
  async (req, res) => {
    try {
      const { word, severity = 'moderate' } = req.body;
      
      await feedbackModeration.addWordFilter(word, severity);
      
      await logActivity('word_filter_added', { word, severity }, null, {
        type: 'admin',
        id: req.user?.id || req.admin?.id,
        name: req.user?.username || req.admin?.username
      });
      
      res.json({ success: true });
    } catch (error) {
      if (error.message === 'Word filter already exists') {
        return res.status(409).json({ error: 'Word filter already exists' });
      }
      logger.error('Error adding word filter:', error);
      res.status(500).json({ error: 'Failed to add word filter' });
    }
  }
);

router.put('/word-filters/:id',
  adminAuth,
  requirePermission('settings.edit'),
  async (req, res) => {
    try {
      const { id } = req.params;
      const updates = req.body;
      
      await feedbackModeration.updateWordFilter(id, updates);
      
      res.json({ success: true });
    } catch (error) {
      logger.error('Error updating word filter:', error);
      res.status(500).json({ error: 'Failed to update word filter' });
    }
  }
);

router.delete('/word-filters/:id',
  adminAuth,
  requirePermission('settings.edit'),
  async (req, res) => {
    try {
      const { id } = req.params;
      
      await feedbackModeration.deleteWordFilter(id);
      
      res.json({ success: true });
    } catch (error) {
      logger.error('Error deleting word filter:', error);
      res.status(500).json({ error: 'Failed to delete word filter' });
    }
  }
);

// Helper function to convert JSON to CSV. Improvements over the original
// (#640 part #6): handles booleans (rendered yes/no for spreadsheet
// readability), nulls/undefined (rendered as empty), and escapes strings
// containing newlines as well as commas/quotes — comments with line breaks
// were silently breaking the CSV row count before this.
function convertToCSV(data) {
  if (!data || data.length === 0) return '';

  const headers = Object.keys(data[0]);
  const csvHeaders = headers.join(',');

  const csvRows = data.map(row => {
    return headers.map(header => {
      const value = row[header];
      if (value === null || value === undefined) return '';
      if (typeof value === 'boolean') return value ? 'yes' : 'no';
      if (typeof value === 'string'
        && (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r'))) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return value;
    }).join(',');
  });

  return [csvHeaders, ...csvRows].join('\n');
}

module.exports = router;
