const express = require('express');
const { db, logActivity } = require('../database/db');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const logger = require('../utils/logger');
const router = express.Router();

// Get notifications (unread activity logs)
router.get('/', adminAuth, requirePermission('settings.view'), async (req, res) => {
  try {
    const { limit = 20, includeRead = false } = req.query;

    let query = db('activity_logs')
      .select(
        'activity_logs.*',
        'events.event_name'
      )
      .leftJoin('events', 'activity_logs.event_id', 'events.id')
      .orderBy('activity_logs.created_at', 'desc')
      .limit(parseInt(limit));
    
    // By default, only show unread notifications
    if (includeRead !== 'true') {
      query = query.whereNull('activity_logs.read_at');
    }

    const notifications = await query;

    // Format notifications
    const formattedNotifications = notifications.map(notification => ({
      id: notification.id,
      type: notification.activity_type,
      actorType: notification.actor_type,
      actorName: notification.actor_name,
      eventName: notification.event_name,
      eventId: notification.event_id,
      metadata: (() => {
        try {
          if (!notification.metadata) return {};
          if (typeof notification.metadata === 'object') return notification.metadata;
          return JSON.parse(notification.metadata);
        } catch (e) {
          logger.warn('Failed to parse metadata for notification:', notification.id, e.message);
          return {};
        }
      })(),
      createdAt: notification.created_at,
      readAt: notification.read_at,
      isRead: !!notification.read_at
    }));

    // Get unread count
    const unreadCount = await db('activity_logs')
      .whereNull('read_at')
      .count('id as count')
      .first();

    res.json({
      notifications: formattedNotifications,
      unreadCount: unreadCount.count || 0
    });
  } catch (error) {
    logger.error('Notifications fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// Mark notification as read
router.put('/:id/read', adminAuth, requirePermission('settings.edit'), async (req, res) => {
  try {
    const { id } = req.params;

    await db('activity_logs')
      .where('id', id)
      .update({
        read_at: new Date()
      });

    res.json({ message: 'Notification marked as read' });
  } catch (error) {
    logger.error('Mark notification read error:', error);
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

// Mark all notifications as read
router.put('/read-all', adminAuth, requirePermission('settings.edit'), async (req, res) => {
  try {
    await db('activity_logs')
      .whereNull('read_at')
      .update({
        read_at: new Date()
      });

    res.json({ message: 'All notifications marked as read' });
  } catch (error) {
    logger.error('Mark all notifications read error:', error);
    res.status(500).json({ error: 'Failed to mark all notifications as read' });
  }
});

// Clear all notifications (#597).
//
// The frontend AdminHeader "Clear All" button hits this — its service
// at `notifications.service.ts` does DELETE /admin/notifications/clear-all.
// The previous /clear-old route was named for an "older than 30 days
// and read" semantic but had a fallback that deleted EVERYTHING when
// nothing matched the date filter, so it was effectively a confusingly
// named Clear All anyway. Drop the rename and the branching, return
// the simple deletedCount the existing test (and frontend toast) expect.
router.delete('/clear-all', adminAuth, requirePermission('settings.edit'), async (req, res) => {
  try {
    const deletedCount = await db('activity_logs').delete();
    res.json({ message: 'All notifications cleared', deletedCount });
  } catch (error) {
    logger.error('Clear notifications error:', error);
    res.status(500).json({ error: 'Failed to clear notifications' });
  }
});

module.exports = router;
