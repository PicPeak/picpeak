/**
 * Update Notification Service
 * Checks for updates and sends email notifications to administrators.
 */

const { db } = require('../database/db');
const { checkForUpdates } = require('./updateCheckService');
const { sendTemplateEmail, initializeTransporter } = require('./emailProcessor');
const logger = require('../utils/logger');

/**
 * Get update notification settings from database
 */
async function getUpdateNotificationSettings() {
  try {
    const settings = await db('app_settings')
      .whereIn('setting_key', [
        'update_email_notifications_enabled',
        'update_email_recipients',
        'last_notified_version'
      ])
      .select('setting_key', 'setting_value');

    const result = {};
    for (const setting of settings) {
      try {
        result[setting.setting_key] = JSON.parse(setting.setting_value);
      } catch (e) {
        result[setting.setting_key] = setting.setting_value;
      }
    }

    return {
      enabled: result.update_email_notifications_enabled === true,
      recipients: result.update_email_recipients || '',
      lastNotifiedVersion: result.last_notified_version || ''
    };
  } catch (error) {
    logger.error('Error fetching update notification settings:', error);
    return {
      enabled: false,
      recipients: '',
      lastNotifiedVersion: ''
    };
  }
}

/**
 * Update the last notified version in database
 */
async function updateLastNotifiedVersion(version) {
  try {
    await db('app_settings')
      .where('setting_key', 'last_notified_version')
      .update({
        setting_value: JSON.stringify(version),
        updated_at: db.fn.now()
      });
  } catch (error) {
    logger.error('Error updating last notified version:', error);
  }
}

/**
 * Get admin email addresses to notify
 * If recipients setting is empty, get all active admin emails
 */
async function getNotificationRecipients(recipientsSetting) {
  try {
    if (recipientsSetting && recipientsSetting.trim()) {
      // Use configured recipients (comma-separated)
      return recipientsSetting.split(',').map(email => email.trim()).filter(Boolean);
    }

    // Fallback: get all active admin user emails
    const admins = await db('admin_users')
      .where('is_active', true)
      .whereNotNull('email')
      .select('email');

    return admins.map(admin => admin.email).filter(Boolean);
  } catch (error) {
    logger.error('Error fetching notification recipients:', error);
    return [];
  }
}

/**
 * Check for updates and send notification emails if new version is available
 */
async function checkAndNotifyUpdates() {
  logger.info('Update notification service: Checking for updates...');

  try {
    // Check if update notifications are enabled
    const settings = await getUpdateNotificationSettings();

    if (!settings.enabled) {
      logger.info('Update email notifications are disabled');
      return { notified: false, reason: 'notifications_disabled' };
    }

    // Check for available updates
    const updateInfo = await checkForUpdates();

    if (!updateInfo.updateAvailable) {
      logger.info('No updates available');
      return { notified: false, reason: 'no_updates' };
    }

    const newVersion = updateInfo.latest.forChannel;

    // Check if we've already notified about this version
    if (settings.lastNotifiedVersion === newVersion) {
      logger.info(`Already notified about version ${newVersion}`);
      return { notified: false, reason: 'already_notified' };
    }

    // Get recipients
    const recipients = await getNotificationRecipients(settings.recipients);

    if (recipients.length === 0) {
      logger.warn('No recipients configured for update notifications');
      return { notified: false, reason: 'no_recipients' };
    }

    // Ensure email transporter is initialized
    await initializeTransporter();

    // Send email to each recipient
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const releaseNotesUrl = `https://github.com/PicPeak/picpeak/releases/tag/v${newVersion}`;
    const channelLabel = updateInfo.channel === 'beta' ? 'Beta' : 'Stable';

    let successCount = 0;
    let errorCount = 0;

    for (const email of recipients) {
      try {
        await sendTemplateEmail(email, 'version_update_available', {
          current_version: updateInfo.current,
          new_version: newVersion,
          channel: channelLabel,
          release_notes_url: releaseNotesUrl,
          admin_url: `${frontendUrl}/admin`
        });
        successCount++;
        logger.info(`Update notification sent to ${email}`);
      } catch (error) {
        errorCount++;
        logger.error(`Failed to send update notification to ${email}:`, error);
      }
    }

    // Update last notified version
    if (successCount > 0) {
      await updateLastNotifiedVersion(newVersion);
      logger.info(`Update notifications sent: ${successCount} success, ${errorCount} failed`);
    }

    return {
      notified: successCount > 0,
      newVersion,
      successCount,
      errorCount,
      totalRecipients: recipients.length
    };
  } catch (error) {
    logger.error('Error in update notification service:', error);
    return { notified: false, reason: 'error', error: error.message };
  }
}

/**
 * Send a TEST notification email to the configured recipients (manual
 * trigger from the admin "Send Test Email" button on the Update
 * Notifications page).
 *
 * Uses the version_update_test template (migration 087) which is
 * explicitly labelled as a configuration check rather than a real update
 * notice. Crucially this path does NOT require updateAvailable to be
 * true — it sends regardless of whether the instance is on the latest
 * version, so admins can verify their SMTP + recipient list work before
 * an actual update lands (#418).
 *
 * Does NOT update last_notified_version — that field is owned by the
 * real-update path so a test send doesn't shadow a future genuine
 * notification for the same version.
 */
async function sendTestUpdateNotification() {
  logger.info('Sending test update notification email...');

  try {
    const settings = await getUpdateNotificationSettings();

    const recipients = await getNotificationRecipients(settings.recipients);
    if (recipients.length === 0) {
      return { success: false, message: 'No recipients configured' };
    }

    // checkForUpdates is best-effort here — we want the version + channel
    // for the email body, but a transient failure shouldn't block the test
    // send. Fall back to env-derived defaults so the email still goes out.
    let updateInfo;
    try {
      updateInfo = await checkForUpdates(true);
    } catch (error) {
      logger.warn('checkForUpdates failed during test send, using fallbacks:', error.message);
      updateInfo = {
        current: process.env.npm_package_version || 'unknown',
        channel: process.env.UPDATE_CHANNEL || 'stable'
      };
    }

    const channelLabel = updateInfo.channel === 'beta' ? 'Beta' : 'Stable';

    await initializeTransporter();

    let successCount = 0;
    let errorCount = 0;

    for (const email of recipients) {
      try {
        await sendTemplateEmail(email, 'version_update_test', {
          current_version: updateInfo.current,
          channel: channelLabel,
          recipient_email: email
        });
        successCount++;
      } catch (error) {
        errorCount++;
        logger.error(`Failed to send test update notification to ${email}:`, error);
      }
    }

    return {
      success: successCount > 0,
      successCount,
      errorCount,
      totalRecipients: recipients.length
    };
  } catch (error) {
    logger.error('Error sending test update notification:', error);
    return { success: false, message: error.message };
  }
}

module.exports = {
  checkAndNotifyUpdates,
  sendTestUpdateNotification,
  getUpdateNotificationSettings,
  getNotificationRecipients
};
