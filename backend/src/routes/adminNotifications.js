const express = require('express');
const { db } = require('../database/db');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { seesAllEvents } = require('../middleware/ownership');
const logger = require('../utils/logger');
const { toUtcIso } = require('../utils/queueTimestamps');
const router = express.Router();

/**
 * Restrict an activity_logs query to the rows the caller may see — the same
 * scope the dashboard activity feed applies (adminDashboard.applyEventScope):
 * every role except super_admin and the roles that see all events is limited
 * to its own events plus ownerless ones. `activity_logs.event_id` is NULLABLE;
 * system-level entries (logins, settings changes) carry no event and are
 * deliberately excluded for a scoped caller rather than shown.
 */
function scopeToVisibleEvents(query, admin) {
  if (seesAllEvents(admin)) return query;
  return query.whereIn('activity_logs.event_id', db('events').select('id')
    .where((q) => q.whereNull('created_by').orWhere('created_by', admin.id)));
}

/**
 * Leave out the rows this admin has cleared from their bell
 * (notification_dismissals, migration 261). Dismissal is per admin and
 * touches neither the activity_logs row nor its read_at, so the audit trail
 * and every other admin's bell are unaffected.
 */
function withoutDismissed(query, admin) {
  return query.whereNotIn('activity_logs.id', db('notification_dismissals')
    .select('activity_log_id').where('admin_id', admin.id));
}

// The rows that make up this admin's bell: visible and not dismissed.
function bellRows(admin) {
  return withoutDismissed(scopeToVisibleEvents(db('activity_logs'), admin), admin);
}

// Get notifications (unread activity logs)
router.get('/', adminAuth, requirePermission(['settings.view', 'notifications.view']), async (req, res) => {
  try {
    const { limit = 20, includeRead = false } = req.query;

    let query = bellRows(req.admin)
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
      // created_at comes from the column default: a zone-less UTC string on
      // SQLite, which the browser would read as local time (issue 1815).
      createdAt: toUtcIso(notification.created_at),
      readAt: toUtcIso(notification.read_at),
      isRead: !!notification.read_at
    }));

    // Get unread count
    const unreadCount = await bellRows(req.admin)
      .whereNull('activity_logs.read_at')
      .count('activity_logs.id as count')
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
router.put('/:id/read', adminAuth, requirePermission('notifications.manage'), async (req, res) => {
  try {
    const { id } = req.params;

    // Only a row the caller can see in the bell; a foreign row stays unread.
    await scopeToVisibleEvents(db('activity_logs'), req.admin)
      .where('activity_logs.id', id)
      .update({
        read_at: new Date().toISOString()
      });

    res.json({ message: 'Notification marked as read' });
  } catch (error) {
    logger.error('Mark notification read error:', error);
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

// Mark all notifications as read
router.put('/read-all', adminAuth, requirePermission('notifications.manage'), async (req, res) => {
  try {
    await scopeToVisibleEvents(db('activity_logs'), req.admin)
      .whereNull('activity_logs.read_at')
      .update({
        read_at: new Date().toISOString()
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
//
// activity_logs is not a notification inbox: the same rows are the contract
// audit trail, the customer timelines and every other admin's actions, so
// clearing deletes nothing. It records a dismissal per visible row for the
// calling admin (notification_dismissals); the bell then leaves those rows
// out for this admin only, read or unread, while read_at and every other
// admin's bell stay as they are. `deletedCount` keeps its name for the
// frontend toast and carries the number of rows dismissed.
router.delete('/clear-all', adminAuth, requirePermission('notifications.manage'), async (req, res) => {
  try {
    const rows = await bellRows(req.admin).select('activity_logs.id');
    const dismissedAt = new Date().toISOString();
    let deletedCount = 0;
    // Chunked so a long-lived install's first "Clear all" does not build one
    // giant statement; a dismissal written by a concurrent click is ignored.
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500).map((r) => ({
        admin_id: req.admin.id, activity_log_id: r.id, dismissed_at: dismissedAt,
      }));
      await db('notification_dismissals').insert(batch)
        .onConflict(['admin_id', 'activity_log_id']).ignore();
      deletedCount += batch.length;
    }
    res.json({ message: 'All notifications cleared', deletedCount });
  } catch (error) {
    logger.error('Clear notifications error:', error);
    res.status(500).json({ error: 'Failed to clear notifications' });
  }
});

module.exports = router;
