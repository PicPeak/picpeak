const express = require('express');
const { db, withRetry } = require('../database/db');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { formatBoolean } = require('../utils/dbCompat');
const logger = require('../utils/logger');
const { checkForUpdates, getCurrentChannel } = require('../services/updateCheckService');
const { detectEnvironment, generateUpdateInstructions } = require('../services/environmentService');
const {
  checkAndNotifyUpdates,
  sendTestUpdateNotification,
  getUpdateNotificationSettings
} = require('../services/updateNotificationService');
const router = express.Router();

// Get system version
router.get('/version', adminAuth, requirePermission('settings.view'), async (req, res) => {
  try {
    // Read backend version from package.json
    let backendVersion = '1.0.0';
    try {
      const packagePath = path.join(__dirname, '../../package.json');
      const packageContent = await fs.readFile(packagePath, 'utf8');
      const packageJson = JSON.parse(packageContent);
      backendVersion = packageJson.version || '1.0.0';
    } catch (err) {
      console.error('Could not read package.json:', err);
    }

    const channel = getCurrentChannel(backendVersion);

    res.json({
      backend: backendVersion,
      frontend: '1.0.0', // This will be set by frontend
      node: process.version,
      environment: process.env.NODE_ENV || 'production',
      channel: channel
    });
  } catch (error) {
    console.error('Error fetching version:', error);
    res.status(500).json({ error: 'Failed to fetch version information' });
  }
});

// Check for updates
router.get('/updates', adminAuth, requirePermission('settings.view'), async (req, res) => {
  try {
    // Check if update checking is enabled
    const updateCheckEnabled = process.env.UPDATE_CHECK_ENABLED !== 'false';

    if (!updateCheckEnabled) {
      return res.json({
        enabled: false,
        message: 'Update checking is disabled'
      });
    }

    const forceRefresh = req.query.refresh === 'true';
    const updateInfo = await checkForUpdates(forceRefresh);

    res.json({
      enabled: true,
      ...updateInfo
    });
  } catch (error) {
    logger.error('Error checking for updates:', error);
    res.status(500).json({ error: 'Failed to check for updates' });
  }
});

// Get update instructions for current environment
router.get('/updates/instructions', adminAuth, requirePermission('settings.view'), async (req, res) => {
  try {
    // Check if update checking is enabled
    const updateCheckEnabled = process.env.UPDATE_CHECK_ENABLED !== 'false';

    if (!updateCheckEnabled) {
      return res.json({
        enabled: false,
        message: 'Update checking is disabled'
      });
    }

    const env = await detectEnvironment();
    const updateInfo = await checkForUpdates();

    if (!updateInfo.updateAvailable) {
      return res.json({
        updateAvailable: false,
        currentVersion: updateInfo.current,
        message: 'You are running the latest version'
      });
    }

    const instructions = generateUpdateInstructions(env, updateInfo.latest.forChannel);

    res.json({
      updateAvailable: true,
      currentVersion: updateInfo.current,
      targetVersion: updateInfo.latest.forChannel,
      channel: updateInfo.channel,
      environment: env,
      instructions,
      releaseNotesUrl: `https://github.com/the-luap/picpeak/releases/tag/v${updateInfo.latest.forChannel}`
    });
  } catch (error) {
    logger.error('Error generating update instructions:', error);
    res.status(500).json({ error: 'Failed to generate update instructions' });
  }
});

// Get comprehensive system status
router.get('/status', adminAuth, requirePermission('settings.view'), async (req, res) => {
  try {
    // Database size - check if PostgreSQL or SQLite
    let dbSize = 0;
    const dbClient = process.env.DATABASE_CLIENT || 'sqlite3';
    
    if (dbClient === 'pg') {
      // PostgreSQL - query database size
      try {
        const dbName = process.env.DB_NAME || 'picpeak';
        const result = await db.raw(`
          SELECT pg_database_size(?) as size
        `, [dbName]);
        dbSize = result.rows[0]?.size || 0;
      } catch (error) {
        console.error('Error getting PostgreSQL database size:', error);
      }
    } else {
      // SQLite - check file size
      const dbPath = path.join(__dirname, '../../data/photo_sharing.db');
      try {
        const stats = await fs.stat(dbPath);
        dbSize = stats.size;
      } catch (error) {
        console.error('Error getting SQLite database size:', error);
      }
    }

    // Count various entities
    const [eventsCount] = await db('events').count('* as count');
    const [photosCount] = await db('photos').count('* as count');
    const [adminsCount] = await db('admin_users').count('* as count');
    const [categoriesCount] = await db('photo_categories').count('* as count');
    
    // Email queue status
    const [pendingEmails] = await db('email_queue').where('status', 'pending').count('* as count');
    const [processableEmails] = await db('email_queue')
      .where('status', 'pending')
      .where('retry_count', '<', 3)
      .count('* as count');
    const [sentEmails] = await db('email_queue').where('status', 'sent').count('* as count');
    const [failedEmails] = await db('email_queue').where('status', 'failed').count('* as count');
    const [stuckEmails] = await db('email_queue')
      .where('status', 'pending')
      .where('retry_count', '>=', 3)
      .count('* as count');

    // Activity logs count
    const [activityCount] = await db('activity_logs').count('* as count');
    
    // Storage info
    const [{ totalPhotoStorage }] = await db('photos')
      .sum('size_bytes as totalPhotoStorage');

    const archives = await db('events')
      .where('is_archived', formatBoolean(true))
      .whereNotNull('archive_path')
      .select('archive_path');

    let archiveStorage = 0;
    const storagePath = process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');
    
    for (const archive of archives) {
      if (archive.archive_path) {
        try {
          const fullArchivePath = path.join(storagePath, archive.archive_path);
          const stats = await fs.stat(fullArchivePath);
          archiveStorage += stats.size;
        } catch (error) {
          console.error('Archive file not found:', archive.archive_path);
        }
      }
    }

    const totalStorage = (parseInt(totalPhotoStorage) || 0) + archiveStorage;
    
    // System info
    const systemInfo = {
      platform: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
      uptime: Math.floor(process.uptime()),
      nodeVersion: process.version,
      memory: {
        total: os.totalmem(),
        free: os.freemem(),
        used: os.totalmem() - os.freemem()
      },
      cpu: {
        model: os.cpus()[0]?.model || 'Unknown',
        cores: os.cpus().length
      }
    };

    // Build response
    const status = {
      database: {
        size: dbSize,
        tables: {
          events: eventsCount.count,
          photos: photosCount.count,
          admins: adminsCount.count,
          categories: categoriesCount.count,
          activityLogs: activityCount.count
        }
      },
      storage: {
        totalUsed: totalStorage,
        photoStorage: parseInt(totalPhotoStorage) || 0,
        archiveStorage: archiveStorage
      },
      emailQueue: {
        pending: pendingEmails.count,
        processable: processableEmails.count,
        stuck: stuckEmails.count,
        sent: sentEmails.count,
        failed: failedEmails.count
      },
      system: systemInfo,
      services: {
        fileWatcher: { status: 'active' }, // These would ideally check actual service status
        expirationChecker: { status: 'active' },
        emailProcessor: { status: 'active' }
      },
      timestamp: new Date()
    };

    res.json(status);
  } catch (error) {
    console.error('Error fetching system status:', error);
    res.status(500).json({ error: 'Failed to fetch system status' });
  }
});

// Get database statistics
router.get('/database', adminAuth, requirePermission('settings.view'), async (req, res) => {
  try {
    // Get table info
    const tables = [
      'events', 'photos', 'admin_users', 'photo_categories', 
      'cms_pages', 'email_templates', 'email_queue', 'activity_logs',
      'app_settings', 'email_configs', 'access_logs', 'migrations'
    ];
    
    const tableInfo = [];
    
    for (const table of tables) {
      try {
        const [count] = await db(table).count('* as count');
        
        // Get last update time
        let lastUpdate = null;
        try {
          const lastRow = await db(table)
            .orderBy('updated_at', 'desc')
            .orOrderBy('created_at', 'desc')
            .orOrderBy('timestamp', 'desc')
            .orOrderBy('applied_at', 'desc')
            .first();
          
          if (lastRow) {
            lastUpdate = lastRow.updated_at || lastRow.created_at || lastRow.timestamp || lastRow.applied_at;
          }
        } catch (e) {
          // Table might not have timestamp columns
        }
        
        tableInfo.push({
          name: table,
          rows: count.count,
          lastUpdate
        });
      } catch (error) {
        // Table might not exist
        logger.warn('Failed to retrieve table info', {
          table,
          error: error.message
        });
        tableInfo.push({
          name: table,
          rows: 0,
          error: 'Unable to retrieve table details'
        });
      }
    }
    
    res.json({
      tables: tableInfo,
      timestamp: new Date()
    });
  } catch (error) {
    console.error('Error fetching database info:', error);
    res.status(500).json({ error: 'Failed to fetch database information' });
  }
});

// Get update notification settings
router.get('/updates/notifications', adminAuth, requirePermission('settings.view'), async (req, res) => {
  try {
    const settings = await getUpdateNotificationSettings();
    res.json(settings);
  } catch (error) {
    logger.error('Error fetching update notification settings:', error);
    res.status(500).json({ error: 'Failed to fetch update notification settings' });
  }
});

// Update notification settings
router.put('/updates/notifications', adminAuth, requirePermission('settings.edit'), async (req, res) => {
  try {
    const { enabled, recipients } = req.body;

    if (typeof enabled !== 'undefined') {
      await db('app_settings')
        .where('setting_key', 'update_email_notifications_enabled')
        .update({
          setting_value: JSON.stringify(enabled === true),
          updated_at: db.fn.now()
        });
    }

    if (typeof recipients !== 'undefined') {
      await db('app_settings')
        .where('setting_key', 'update_email_recipients')
        .update({
          setting_value: JSON.stringify(recipients || ''),
          updated_at: db.fn.now()
        });
    }

    const updatedSettings = await getUpdateNotificationSettings();
    res.json({ success: true, settings: updatedSettings });
  } catch (error) {
    logger.error('Error updating notification settings:', error);
    res.status(500).json({ error: 'Failed to update notification settings' });
  }
});

// Manually trigger update notification email
// Send a test update notification email. Uses the dedicated
// `version_update_test` template (migration 087) rather than reusing
// `version_update_available`, so admins on the latest version can still
// verify their SMTP + recipient config — the previous handler bailed
// with "No updates available" when nothing was pending (#418).
router.post('/updates/notifications/send', adminAuth, requirePermission('settings.edit'), async (req, res) => {
  try {
    const result = await sendTestUpdateNotification();
    res.json(result);
  } catch (error) {
    logger.error('Error sending test update notification:', error);
    res.status(500).json({ error: 'Failed to send test update notification' });
  }
});

// Check and send update notifications (called on admin login or periodically)
router.post('/updates/notifications/check', adminAuth, requirePermission('settings.view'), async (req, res) => {
  try {
    const result = await checkAndNotifyUpdates();
    res.json(result);
  } catch (error) {
    logger.error('Error checking for update notifications:', error);
    res.status(500).json({ error: 'Failed to check for update notifications' });
  }
});

module.exports = router;
