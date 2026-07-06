/**
 * Event Rename Service
 * Handles renaming events including slug updates, file system changes, and database updates
 */

const { db, logActivity } = require('../database/db');
const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');
const { buildShareLinkVariants } = require('./shareLinkService');
const { queueEmail } = require('./emailProcessor');

class EventRenameService {
  constructor() {
    this.storagePath = process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');
  }

  /**
   * Format a date to YYYY-MM-DD string
   * @param {Date|string} date - Date object or string
   * @returns {string} Formatted date string
   */
  formatDate(date) {
    if (!date) return '';
    const d = new Date(date);
    if (isNaN(d.getTime())) return String(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /**
   * Generate a slug from event details
   * @param {string} eventType - Type of event (wedding, birthday, etc.)
   * @param {string} eventName - Name of the event
   * @param {string|Date} eventDate - Date of the event
   * @returns {string} Generated slug
   */
  generateSlug(eventType, eventName, eventDate) {
    const processedEventName = eventName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    const formattedDate = this.formatDate(eventDate);
    return `${eventType}-${processedEventName}-${formattedDate}`;
  }

  /**
   * Validate if a rename operation is possible
   * @param {number} eventId - Event ID
   * @param {string} newEventName - New event name
   * @returns {Promise<{valid: boolean, error?: string, newSlug?: string}>}
   */
  async validateRename(eventId, newEventName) {
    try {
      // Get current event
      const event = await db('events').where({ id: eventId }).first();
      if (!event) {
        return { valid: false, error: 'Event not found' };
      }

      if (event.is_archived) {
        return { valid: false, error: 'Cannot rename archived events' };
      }

      // Validate new name
      if (!newEventName || newEventName.trim().length < 3) {
        return { valid: false, error: 'Event name must be at least 3 characters' };
      }

      if (newEventName.trim().length > 100) {
        return { valid: false, error: 'Event name must be less than 100 characters' };
      }

      // Generate new slug
      const newSlug = this.generateSlug(event.event_type, newEventName.trim(), event.event_date);

      // Check if slug already exists (for different event)
      const existingEvent = await db('events')
        .where({ slug: newSlug })
        .whereNot({ id: eventId })
        .first();

      if (existingEvent) {
        return { valid: false, error: 'An event with this name already exists for the same date', conflicts: [existingEvent.event_name] };
      }

      // Check if the slug is the same as current
      if (newSlug === event.slug) {
        return { valid: false, error: 'New name generates the same URL as the current name' };
      }

      return { valid: true, newSlug, currentSlug: event.slug };
    } catch (error) {
      logger.error('Validation error:', { error: error.message });
      return { valid: false, error: 'Validation failed' };
    }
  }

  /**
   * Rename the event folder on the filesystem
   * @param {string} oldSlug - Current slug
   * @param {string} newSlug - New slug
   * @returns {Promise<boolean>}
   */
  async renameEventFolder(oldSlug, newSlug) {
    const oldPath = path.join(this.storagePath, 'events/active', oldSlug);
    const newPath = path.join(this.storagePath, 'events/active', newSlug);

    try {
      // Check if old folder exists
      await fs.access(oldPath);

      // Check if new folder already exists
      try {
        await fs.access(newPath);
        throw new Error('Target folder already exists');
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }

      // Rename folder
      await fs.rename(oldPath, newPath);
      logger.info('Event folder renamed', { oldSlug, newSlug });
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') {
        logger.warn('Event folder not found, skipping rename', { oldSlug });
        return true; // Not a fatal error if folder doesn't exist
      }
      throw error;
    }
  }

  /**
   * Rename individual photo files to match new event name
   * @param {number} eventId - Event ID
   * @param {string} oldEventName - Old event name
   * @param {string} newEventName - New event name
   * @param {string} newSlug - New slug for path updates
   * @returns {Promise<number>} Number of files renamed
   */
  async renamePhotoFiles(eventId, oldEventName, newEventName, oldSlug, newSlug) {
    const photos = await db('photos').where({ event_id: eventId });
    let renamedCount = 0;

    // Process event name for filenames
    const oldNamePrefix = oldEventName.replace(/[^a-zA-Z0-9]/g, '_');
    const newNamePrefix = newEventName.replace(/[^a-zA-Z0-9]/g, '_');

    for (const photo of photos) {
      try {
        const oldFilename = photo.filename;
        let newFilename = oldFilename;

        // Replace event name prefix if present
        if (oldFilename.startsWith(oldNamePrefix)) {
          newFilename = oldFilename.replace(oldNamePrefix, newNamePrefix);
        }

        // Update path with new slug
        const newPath = photo.path.replace(oldSlug, newSlug);
        const newThumbnailPath = photo.thumbnail_path ?
          photo.thumbnail_path.replace(oldSlug, newSlug) : null;

        // Rename physical file if filename changed
        if (newFilename !== oldFilename) {
          const oldFilePath = path.join(this.storagePath, 'events/active', newSlug,
            photo.type === 'collage' ? 'collages' : 'individual', oldFilename);
          const newFilePath = path.join(this.storagePath, 'events/active', newSlug,
            photo.type === 'collage' ? 'collages' : 'individual', newFilename);

          try {
            await fs.rename(oldFilePath, newFilePath);
          } catch (error) {
            if (error.code !== 'ENOENT') {
              logger.warn('Could not rename photo file', { oldFilename, error: error.message });
            }
          }
        }

        // Update database record
        await db('photos')
          .where({ id: photo.id })
          .update({
            filename: newFilename,
            path: newPath,
            thumbnail_path: newThumbnailPath
          });

        renamedCount++;
      } catch (error) {
        logger.error('Error renaming photo', { photoId: photo.id, error: error.message });
      }
    }

    return renamedCount;
  }

  /**
   * Update database records for the rename
   * @param {object} trx - Knex transaction
   * @param {number} eventId - Event ID
   * @param {string} oldSlug - Current slug
   * @param {string} newSlug - New slug
   * @param {string} newEventName - New event name
   * @returns {Promise<{newShareLink: string}>}
   */
  async updateDatabaseRecords(trx, eventId, oldSlug, newSlug, newEventName) {
    const event = await trx('events').where({ id: eventId }).first();

    // Generate new share link
    const { sharePath, shareUrl, shareLinkToStore } = await buildShareLinkVariants({
      slug: newSlug,
      shareToken: event.share_token
    });

    // Update event
    await trx('events')
      .where({ id: eventId })
      .update({
        event_name: newEventName,
        slug: newSlug,
        share_link: shareLinkToStore
      });

    return { newShareLink: shareUrl };
  }

  /**
   * Create a redirect entry for the old slug
   * @param {object} trx - Knex transaction
   * @param {number} eventId - Event ID
   * @param {string} oldSlug - Old slug
   * @param {string} newSlug - New slug
   */
  async createSlugRedirect(trx, eventId, oldSlug, newSlug) {
    // Check if table exists
    const hasTable = await trx.schema.hasTable('slug_redirects');
    if (!hasTable) {
      logger.warn('slug_redirects table does not exist, skipping redirect creation');
      return;
    }

    // Check if redirect already exists
    const existingRedirect = await trx('slug_redirects')
      .where({ old_slug: oldSlug })
      .first();

    if (existingRedirect) {
      // Update existing redirect
      await trx('slug_redirects')
        .where({ old_slug: oldSlug })
        .update({ new_slug: newSlug });
    } else {
      // Create new redirect
      await trx('slug_redirects').insert({
        old_slug: oldSlug,
        new_slug: newSlug,
        event_id: eventId
      });
    }

    // Also update any existing redirects pointing to the old slug
    await trx('slug_redirects')
      .where({ new_slug: oldSlug })
      .update({ new_slug: newSlug });
  }

  /**
   * Send notification email about the rename
   * @param {number} eventId - Event ID
   * @param {string} newShareLink - New share link
   */
  async sendRenamedEventEmail(eventId, newShareLink) {
    const event = await db('events').where({ id: eventId }).first();
    if (!event) return;

    const recipientEmail = event.customer_email || event.host_email;
    if (!recipientEmail) return;

    const recipientName = event.customer_name || event.host_name ||
      (recipientEmail ? recipientEmail.split('@')[0] : 'Guest');

    await queueEmail(eventId, recipientEmail, 'gallery_link_updated', {
      customer_name: recipientName,
      event_name: event.event_name,
      new_gallery_link: newShareLink,
      event_date: event.event_date
    });
  }

  /**
   * Rollback a failed rename operation
   * @param {object} backupData - Backup data from the rename attempt
   */
  async rollbackRename(backupData) {
    try {
      if (backupData.folderRenamed && backupData.event) {
        const oldPath = path.join(this.storagePath, 'events/active', backupData.newSlug);
        const newPath = path.join(this.storagePath, 'events/active', backupData.event.slug);

        try {
          await fs.rename(oldPath, newPath);
          logger.info('Rolled back folder rename');
        } catch (error) {
          logger.error('Failed to rollback folder rename', { error: error.message });
        }
      }
    } catch (error) {
      logger.error('Rollback failed', { error: error.message });
    }
  }

  /**
   * Main method to rename an event
   * @param {number} eventId - Event ID
   * @param {string} newEventName - New event name
   * @param {boolean} resendEmail - Whether to resend invitation email
   * @param {object} adminUser - Admin user performing the action
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  async renameEvent(eventId, newEventName, resendEmail = false, adminUser = null) {
    const backupData = {};

    try {
      // 1. Validate
      const validation = await this.validateRename(eventId, newEventName);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }

      // 2. Get current event data
      const event = await db('events').where({ id: eventId }).first();
      backupData.event = event;
      backupData.newSlug = validation.newSlug;

      const oldSlug = event.slug;
      const oldName = event.event_name;
      const newSlug = validation.newSlug;

      // 3. Start transaction
      const trx = await db.transaction();

      try {
        // 4. Rename folder (filesystem)
        await this.renameEventFolder(oldSlug, newSlug);
        backupData.folderRenamed = true;

        // 5. Rename photo files and update paths
        const filesRenamed = await this.renamePhotoFiles(eventId, oldName, newEventName.trim(), oldSlug, newSlug);

        // 6. Update database records
        const { newShareLink } = await this.updateDatabaseRecords(trx, eventId, oldSlug, newSlug, newEventName.trim());

        // 7. Create redirect entry
        await this.createSlugRedirect(trx, eventId, oldSlug, newSlug);

        // 8. Log activity
        await trx('activity_logs').insert({
          activity_type: 'event_renamed',
          actor_type: adminUser ? 'admin' : 'system',
          actor_id: adminUser?.id || null,
          actor_name: adminUser?.username || 'system',
          metadata: JSON.stringify({
            old_name: oldName,
            new_name: newEventName.trim(),
            old_slug: oldSlug,
            new_slug: newSlug,
            files_renamed: filesRenamed,
            email_sent: resendEmail
          }),
          event_id: eventId
        });

        // 9. Commit transaction
        await trx.commit();

        // 10. Send email (after commit, non-critical)
        let emailSent = false;
        if (resendEmail) {
          try {
            await this.sendRenamedEventEmail(eventId, newShareLink);
            emailSent = true;
          } catch (error) {
            logger.error('Failed to send rename notification email', { error: error.message });
          }
        }

        return {
          success: true,
          data: {
            eventId,
            oldName,
            newName: newEventName.trim(),
            oldSlug,
            newSlug,
            newShareLink,
            emailSent,
            filesRenamed
          }
        };

      } catch (error) {
        await trx.rollback();
        throw error;
      }

    } catch (error) {
      logger.error('Event rename failed', { eventId, error: error.message });
      await this.rollbackRename(backupData);
      return { success: false, error: error.message || 'Failed to rename event' };
    }
  }
}

module.exports = new EventRenameService();
