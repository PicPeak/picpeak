const express = require('express');
const { db } = require('../database/db');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const secureImageMiddleware = require('../middleware/secureImageMiddleware');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * Get image security settings
 */
router.get('/settings', adminAuth, requirePermission('settings.view'), async (req, res) => {
  try {
    const settings = await db('app_settings')
      .whereIn('setting_key', [
        'default_protection_level',
        'default_image_quality',
        'enable_devtools_protection',
        'max_image_requests_per_minute',
        'max_image_requests_per_5_minutes',
        'max_image_requests_per_hour',
        'suspicious_activity_threshold',
        'enable_canvas_rendering',
        'default_fragmentation_level',
        'security_monitoring_enabled',
        'block_suspicious_ips',
        'log_security_events_to_db',
        'auto_block_threshold'
      ])
      .select('setting_key', 'setting_value');

    const config = {};
    settings.forEach(setting => {
      // PostgreSQL JSON columns are already parsed by the driver
      // Just use the value directly - no need to JSON.parse
      config[setting.setting_key] = setting.setting_value;
    });

    res.json(config);
  } catch (error) {
    logger.error('Error getting image security settings', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Failed to get security settings', details: error.message });
  }
});

/**
 * Update image security settings
 */
router.put('/settings', adminAuth, requirePermission('settings.edit'), async (req, res) => {
  try {
    const updates = req.body;
    
    // Validate settings
    const validSettings = [
      'default_protection_level',
      'default_image_quality',
      'enable_devtools_protection',
      'max_image_requests_per_minute',
      'max_image_requests_per_5_minutes',
      'max_image_requests_per_hour',
      'suspicious_activity_threshold',
      'enable_canvas_rendering',
      'default_fragmentation_level',
      'security_monitoring_enabled',
      'block_suspicious_ips',
      'log_security_events_to_db',
      'auto_block_threshold'
    ];

    // Update each setting
    for (const [key, value] of Object.entries(updates)) {
      if (validSettings.includes(key)) {
        await db('app_settings')
          .where('setting_key', key)
          .update({
            setting_value: JSON.stringify(value),
            updated_at: new Date()
          });
      }
    }

    logger.info('Image security settings updated', {
      adminId: req.admin.id,
      updates: Object.keys(updates)
    });

    res.json({ message: 'Settings updated successfully' });
  } catch (error) {
    logger.error('Error updating image security settings', { 
      error: error.message,
      adminId: req.admin.id 
    });
    res.status(500).json({ error: 'Failed to update security settings' });
  }
});

/**
 * Get security monitoring dashboard data
 */
router.get('/dashboard', adminAuth, requirePermission('settings.view'), async (req, res) => {
  try {
    const { timeframe = '24h' } = req.query;
    
    let timeFilter;
    switch (timeframe) {
      case '1h':
        timeFilter = new Date(Date.now() - 3600000);
        break;
      case '24h':
        timeFilter = new Date(Date.now() - 86400000);
        break;
      case '7d':
        timeFilter = new Date(Date.now() - 604800000);
        break;
      default:
        timeFilter = new Date(Date.now() - 86400000);
    }

    // Get image access statistics
    const accessStats = await db('image_access_logs')
      .where('accessed_at', '>', timeFilter.toISOString())
      .select('access_type')
      .count('* as count')
      .groupBy('access_type');

    // Get security events
    const securityEvents = await db('security_logs')
      .where('timestamp', '>', timeFilter.toISOString())
      .select('event_type')
      .count('* as count')
      .groupBy('event_type');

    // Get top suspicious IPs
    const suspiciousIPs = await db('security_logs')
      .where('timestamp', '>', timeFilter.toISOString())
      .where('event_type', 'like', '%suspicious%')
      .select('client_ip')
      .count('* as count')
      .groupBy('client_ip')
      .orderBy('count', 'desc')
      .limit(10);

    // Get most accessed photos
    const topPhotos = await db('image_access_logs')
      .join('photos', 'image_access_logs.photo_id', 'photos.id')
      .join('events', 'photos.event_id', 'events.id')
      .where('image_access_logs.accessed_at', '>', timeFilter.toISOString())
      .select('photos.filename', 'events.event_name', 'photos.id')
      .count('* as access_count')
      .groupBy('photos.id', 'photos.filename', 'events.event_name')
      .orderBy('access_count', 'desc')
      .limit(10);

    // Get middleware status
    const middlewareStatus = secureImageMiddleware.getSecurityStatus();

    // Calculate totals
    const totalAccess = accessStats.reduce((sum, stat) => sum + parseInt(stat.count), 0);
    const totalSecurityEvents = securityEvents.reduce((sum, stat) => sum + parseInt(stat.count), 0);

    // Get unique visitors
    const uniqueVisitors = await db('image_access_logs')
      .where('accessed_at', '>', timeFilter.toISOString())
      .countDistinct('client_fingerprint as count')
      .first();

    res.json({
      timeframe,
      summary: {
        totalAccess,
        totalSecurityEvents,
        uniqueVisitors: parseInt(uniqueVisitors.count),
        suspiciousIPsCount: suspiciousIPs.length
      },
      accessStats: accessStats.reduce((acc, stat) => {
        acc[stat.access_type] = parseInt(stat.count);
        return acc;
      }, {}),
      securityEvents: securityEvents.reduce((acc, stat) => {
        acc[stat.event_type] = parseInt(stat.count);
        return acc;
      }, {}),
      suspiciousIPs: suspiciousIPs.map(ip => ({
        ip: ip.client_ip,
        incidents: parseInt(ip.count)
      })),
      topPhotos: topPhotos.map(photo => ({
        id: photo.id,
        filename: photo.filename,
        eventName: photo.event_name,
        accessCount: parseInt(photo.access_count)
      })),
      middlewareStatus
    });

  } catch (error) {
    logger.error('Error getting security dashboard data', { error: error.message });
    res.status(500).json({ error: 'Failed to get dashboard data' });
  }
});

/**
 * Get detailed security logs
 */
router.get('/logs', adminAuth, requirePermission('settings.view'), async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 50, 
      eventType = null, 
      timeframe = '24h' 
    } = req.query;

    let timeFilter;
    switch (timeframe) {
      case '1h':
        timeFilter = new Date(Date.now() - 3600000);
        break;
      case '24h':
        timeFilter = new Date(Date.now() - 86400000);
        break;
      case '7d':
        timeFilter = new Date(Date.now() - 604800000);
        break;
      default:
        timeFilter = new Date(Date.now() - 86400000);
    }

    let query = db('security_logs')
      .where('timestamp', '>', timeFilter.toISOString())
      .orderBy('timestamp', 'desc');

    if (eventType) {
      query = query.where('event_type', eventType);
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const logs = await query.limit(parseInt(limit)).offset(offset);

    // Get total count for pagination
    let countQuery = db('security_logs')
      .where('timestamp', '>', timeFilter.toISOString())
      .count('* as total');

    if (eventType) {
      countQuery = countQuery.where('event_type', eventType);
    }

    const totalResult = await countQuery.first();
    const total = parseInt(totalResult.total);

    res.json({
      logs: logs.map(log => ({
        ...log,
        details: log.details ? JSON.parse(log.details) : null
      })),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });

  } catch (error) {
    logger.error('Error getting security logs', { error: error.message });
    res.status(500).json({ error: 'Failed to get security logs' });
  }
});

/**
 * Get image access logs for a specific event
 */
router.get('/events/:eventId/access-logs', adminAuth, requirePermission('settings.view'), async (req, res) => {
  try {
    const { eventId } = req.params;
    const { page = 1, limit = 50 } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    const logs = await db('image_access_logs')
      .join('photos', 'image_access_logs.photo_id', 'photos.id')
      .where('image_access_logs.event_id', eventId)
      .select(
        'image_access_logs.*',
        'photos.filename'
      )
      .orderBy('image_access_logs.accessed_at', 'desc')
      .limit(parseInt(limit))
      .offset(offset);

    const totalResult = await db('image_access_logs')
      .where('event_id', eventId)
      .count('* as total')
      .first();

    const total = parseInt(totalResult.total);

    res.json({
      logs: logs.map(log => ({
        ...log,
        metadata: log.metadata ? JSON.parse(log.metadata) : null
      })),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });

  } catch (error) {
    logger.error('Error getting event access logs', { 
      error: error.message, 
      eventId: req.params.eventId 
    });
    res.status(500).json({ error: 'Failed to get access logs' });
  }
});

/**
 * Block/unblock suspicious IPs
 */
router.post('/block-ip', adminAuth, requirePermission('settings.edit'), async (req, res) => {
  try {
    const { ip, action = 'block' } = req.body;
    
    if (!ip) {
      return res.status(400).json({ error: 'IP address required' });
    }

    if (action === 'block') {
      // Add to blocked IPs in middleware
      secureImageMiddleware.suspiciousIPs.add(ip);
      
      logger.warn('IP manually blocked by admin', {
        ip,
        adminId: req.admin.id,
        adminUsername: req.admin.username
      });
    } else if (action === 'unblock') {
      // Remove from blocked IPs
      secureImageMiddleware.suspiciousIPs.delete(ip);
      
      logger.info('IP manually unblocked by admin', {
        ip,
        adminId: req.admin.id,
        adminUsername: req.admin.username
      });
    }

    res.json({ 
      message: `IP ${ip} ${action}ed successfully`,
      action,
      ip
    });

  } catch (error) {
    logger.error('Error blocking/unblocking IP', { 
      error: error.message,
      adminId: req.admin.id 
    });
    res.status(500).json({ error: 'Failed to update IP status' });
  }
});

/**
 * Clear security logs older than specified time
 */
router.delete('/logs/cleanup', adminAuth, requirePermission('settings.edit'), async (req, res) => {
  try {
    const { olderThan = '30d' } = req.body;
    
    let cutoffDate;
    switch (olderThan) {
      case '7d':
        cutoffDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
        cutoffDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        break;
      case '90d':
        cutoffDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
        break;
      default:
        cutoffDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    }

    // Delete old security logs
    const securityDeleted = await db('security_logs')
      .where('timestamp', '<', cutoffDate.toISOString())
      .del();

    // Delete old image access logs
    const accessDeleted = await db('image_access_logs')
      .where('accessed_at', '<', cutoffDate.toISOString())
      .del();

    logger.info('Security logs cleanup completed', {
      adminId: req.admin.id,
      securityLogsDeleted: securityDeleted,
      accessLogsDeleted: accessDeleted,
      cutoffDate: cutoffDate.toISOString()
    });

    res.json({
      message: 'Cleanup completed successfully',
      deleted: {
        securityLogs: securityDeleted,
        accessLogs: accessDeleted
      },
      cutoffDate: cutoffDate.toISOString()
    });

  } catch (error) {
    logger.error('Error cleaning up security logs', { 
      error: error.message,
      adminId: req.admin.id 
    });
    res.status(500).json({ error: 'Failed to cleanup logs' });
  }
});

/**
 * Export security data for analysis
 */
router.get('/export', adminAuth, requirePermission('settings.view'), async (req, res) => {
  try {
    const { format = 'json', timeframe = '7d' } = req.query;
    
    let timeFilter;
    switch (timeframe) {
      case '24h':
        timeFilter = new Date(Date.now() - 86400000);
        break;
      case '7d':
        timeFilter = new Date(Date.now() - 604800000);
        break;
      case '30d':
        timeFilter = new Date(Date.now() - 2592000000);
        break;
      default:
        timeFilter = new Date(Date.now() - 604800000);
    }

    // Get security logs
    const securityLogs = await db('security_logs')
      .where('timestamp', '>', timeFilter.toISOString())
      .orderBy('timestamp', 'desc');

    // Get image access logs
    const accessLogs = await db('image_access_logs')
      .where('accessed_at', '>', timeFilter.toISOString())
      .orderBy('accessed_at', 'desc');

    const exportData = {
      exportDate: new Date().toISOString(),
      timeframe,
      securityLogs: securityLogs.map(log => ({
        ...log,
        details: log.details ? JSON.parse(log.details) : null
      })),
      accessLogs: accessLogs.map(log => ({
        ...log,
        metadata: log.metadata ? JSON.parse(log.metadata) : null
      }))
    };

    if (format === 'csv') {
      // Convert to CSV format (simplified)
      const csv = convertToCSV(exportData);
      res.set({
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="security-export-${timeframe}.csv"`
      });
      res.send(csv);
    } else {
      res.set({
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="security-export-${timeframe}.json"`
      });
      res.json(exportData);
    }

    logger.info('Security data exported', {
      adminId: req.admin.id,
      format,
      timeframe,
      recordCount: exportData.securityLogs.length + exportData.accessLogs.length
    });

  } catch (error) {
    logger.error('Error exporting security data', { 
      error: error.message,
      adminId: req.admin.id 
    });
    res.status(500).json({ error: 'Failed to export security data' });
  }
});

/**
 * Helper function to convert data to CSV
 */
function convertToCSV(data) {
  // Simplified CSV conversion for security logs
  const headers = ['timestamp', 'event_type', 'client_ip', 'details'];
  const rows = data.securityLogs.map(log => [
    log.timestamp,
    log.event_type,
    log.client_ip,
    JSON.stringify(log.details || {})
  ]);
  
  return [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
}

module.exports = router;