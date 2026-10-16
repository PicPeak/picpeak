/**
 * Event Rename Service
 * Handles renaming events including slug updates, file system changes, and database updates
 */

const { db } = require('../database/db');
const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');
const { buildShareLinkVariants } = require('./shareLinkService');
const { galleryLinkFor } = require('./galleryNotificationService');
const { queueEmail } = require('./emailProcessor');
const { getStorage } = require('./storage');
const { findSlugHolder } = require('./slugRedirects');
const { slugify } = require('../utils/slug');

/**
 * Run `fn` over `items` with at most `limit` in flight. On the first failure
 * no further item is started, the in-flight ones are allowed to settle, and
 * that error is rethrown — so a caller recording progress in `fn` sees every
 * item that actually completed.
 */
async function forEachBounded(items, limit, fn) {
  let cursor = 0;
  let failure = null;
  const worker = async () => {
    while (cursor < items.length && !failure) {
      const item = items[cursor++];
      try {
        await fn(item);
      } catch (error) {
        failure = failure || error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure;
}

/** A missing source, on either backend: ENOENT locally, NoSuchKey/404 on S3. */
function isNotFound(err) {
  return err.code === 'ENOENT'
    || err.name === 'NoSuchKey'
    || err.name === 'NotFound'
    || err.$metadata?.httpStatusCode === 404;
}

// Galleries this process is renaming right now. The archive claim is the lock
// for both jobs, so a refused claim alone cannot say which one holds it.
const renamingIds = new Set();
const busyMessage = (eventId) => (renamingIds.has(eventId)
  ? 'This gallery is already being renamed'
  : 'Cannot rename a gallery while it is being archived or renamed');

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
    // The shared slugify, as event creation uses: accents are stripped, so
    // NFC and NFD (macOS) input give the same slug ("Jörg" → "jorg"). ASCII
    // names slug exactly as before; existing slugs are not touched.
    const processedEventName = slugify(eventName);
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
    // NFC, like every other stored name: macOS input arrives decomposed.
    if (typeof newEventName === 'string') newEventName = newEventName.normalize('NFC');
    try {
      // Get current event
      const event = await db('events').where({ id: eventId }).first();
      if (!event) {
        return { valid: false, error: 'Event not found' };
      }

      if (event.is_archived) {
        return { valid: false, error: 'Cannot rename archived events' };
      }
      // The archive job reads the photos under the current slug (issue 2012).
      if (await require('./archiveService').isArchiveRunning(eventId)) {
        return { valid: false, conflict: true, error: busyMessage(eventId) };
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

      // Check if slug already exists (for different event). Another
      // gallery's old slug counts: its links still lead to that gallery.
      const existingEvent = await findSlugHolder(newSlug, { exceptEventId: eventId });

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
   * Copy every object under the old event prefix to the new one (#1694).
   *
   * S3 has no directory rename. `renameEventFolder` above is a local
   * `fs.rename`, which on STORAGE_BACKEND=s3 found no folder, logged "not
   * found, skipping" and returned true — so the rows were rewritten to the
   * new slug while every object stayed under the old one, and the renamed
   * gallery 404ed on every image.
   *
   * Copy only, here: the sources are deleted after the transaction commits
   * (`deleteObjects`), so a failure anywhere before that point leaves the
   * event readable at its old keys and the rollback has only the copies to
   * remove. Server-side copies, bounded like the cascade delete's sweep so a
   * large event neither serialises into minutes nor exhausts the S3 client's
   * connection pool.
   *
   * @param {{sourceKeys: string[], copiedKeys: string[]}} progress - Filled in
   *   as the copies land, so a throw midway still leaves the rollback an
   *   exact list of what to remove.
   */
  async moveEventObjects(oldSlug, newSlug, progress) {
    const storage = getStorage();
    const oldPrefix = path.posix.join('events/active', oldSlug);
    const newPrefix = path.posix.join('events/active', newSlug);

    // `list` is prefix-based on S3, so `wedding-x` would also match a
    // sibling `wedding-x-2`; the slash keeps both checks to this event.
    const occupied = (await storage.list(newPrefix))
      .filter((entry) => entry.key.startsWith(`${newPrefix}/`));
    if (occupied.length > 0) {
      throw new Error('Target folder already exists');
    }

    progress.sourceKeys = (await storage.list(oldPrefix))
      .map((entry) => entry.key)
      .filter((key) => key.startsWith(`${oldPrefix}/`));
    if (progress.sourceKeys.length === 0) {
      logger.warn('Event prefix holds no objects, skipping move', { oldSlug });
      return;
    }

    await forEachBounded(progress.sourceKeys, 16, async (key) => {
      const target = newPrefix + key.slice(oldPrefix.length);
      await storage.copy(key, target);
      progress.copiedKeys.push(target);
    });
    logger.info('Event objects copied', { oldSlug, newSlug, count: progress.copiedKeys.length });
  }

  /** Best-effort removal of `keys`; a leftover is recoverable noise, not an error. */
  async deleteObjects(keys, context) {
    const storage = getStorage();
    let removed = 0;
    await forEachBounded(keys, 16, async (key) => {
      try {
        await storage.delete(key);
        removed++;
      } catch (error) {
        logger.warn('Could not delete stored object after rename', { key, error: error.message, ...context });
      }
    });
    return removed;
  }

  /**
   * Rename individual photo files to match new event name
   * @param {number} eventId - Event ID
   * @param {string} oldEventName - Old event name
   * @param {string} newEventName - New event name
   * @param {string} newSlug - New slug for path updates
   * @param {object} [trx] - Knex transaction; the rows are read and written
   *   through it so a failed rename rolls them back with the event. On SQLite
   *   this is not optional: the pool holds one connection and the open
   *   transaction owns it, so a query through `db` here waited out the
   *   60s acquire timeout and every rename failed.
   * @returns {Promise<number>} Number of files renamed
   */
  async renamePhotoFiles(eventId, oldEventName, newEventName, oldSlug, newSlug, trx = db) {
    const storage = getStorage();
    const photos = await trx('photos').where({ event_id: eventId });
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

        // Rename physical file if filename changed. Through the storage
        // backend, not `fs`: on S3 there is no local file to rename (#1694).
        if (newFilename !== oldFilename) {
          const subfolder = photo.type === 'collage' ? 'collages' : 'individual';
          const oldKey = path.posix.join('events/active', newSlug, subfolder, oldFilename);
          const newKey = path.posix.join('events/active', newSlug, subfolder, newFilename);

          try {
            await storage.rename(oldKey, newKey);
          } catch (error) {
            if (!isNotFound(error)) {
              logger.warn('Could not rename photo file', { oldFilename, error: error.message });
            }
          }

          // Responsive tiers (#1095 / #492) are keyed off the basename, so the
          // update below is the point past which the old keys can no longer be
          // derived — a later delete or archive would compute the new ones and
          // leave these in storage forever. Dropped rather than renamed: they
          // are a pure cache and the next request regenerates.
          //
          // Inside this branch, not the loop body: only a filename change moves
          // the key. Sweeping unconditionally would fire four storage deletes
          // per photo on every rename, which is 20k calls against S3 for a
          // 5,000-photo event that merely had its slug adjusted.
          const imageProcessor = require('./imageProcessor');
          await imageProcessor.deleteThumbnailTiers(photo);
          await imageProcessor.deletePreviewTiers(photo);
        }

        // Update database record
        await trx('photos')
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
   * @param {string} shareLinkToStore - Built before the transaction opened:
   *   buildShareLinkVariants reads app_settings through `db`, which on
   *   SQLite waits for the connection the transaction holds.
   */
  async updateDatabaseRecords(trx, eventId, oldSlug, newSlug, newEventName, shareLinkToStore) {
    await trx('events')
      .where({ id: eventId })
      .update({
        event_name: newEventName,
        slug: newSlug,
        share_link: shareLinkToStore
      });
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
      // Update existing redirect. The row may have been written for a gallery
      // that held this slug before; it belongs to this one now, so a delete of
      // that other gallery must not cascade it away.
      await trx('slug_redirects')
        .where({ old_slug: oldSlug })
        .update({ new_slug: newSlug, event_id: eventId });
    } else {
      // Create new redirect
      await trx('slug_redirects').insert({
        old_slug: oldSlug,
        new_slug: newSlug,
        event_id: eventId
      });
    }

    // Also update any existing redirects pointing to the old slug. Their
    // event_id stays: these rows are this gallery's own, or (SQLite, no
    // foreign keys) a deleted gallery's that must not become this one's.
    await trx('slug_redirects')
      .where({ new_slug: oldSlug })
      .update({ new_slug: newSlug });

    // Renamed back to an earlier name: the chain update above turned that
    // name's redirect into one pointing at itself. Only that row goes; a
    // redirect from this slug to another gallery is that gallery's to keep.
    await trx('slug_redirects')
      .where({ old_slug: newSlug, new_slug: newSlug })
      .del();
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
      new_gallery_link: await galleryLinkFor(event, recipientEmail, newShareLink),
      event_date: event.event_date
    });
  }

  /**
   * Rollback a failed rename operation
   * @param {object} backupData - Backup data from the rename attempt
   */
  async rollbackRename(backupData) {
    try {
      if (backupData.moved && backupData.moved.copiedKeys.length > 0) {
        // The sources were never deleted, so the event is still readable at
        // its old keys; only the copies have to go, or the next attempt is
        // refused for finding the target occupied.
        const removed = await this.deleteObjects(backupData.moved.copiedKeys, { newSlug: backupData.newSlug });
        logger.info('Rolled back object copies', { removed, total: backupData.moved.copiedKeys.length });
      }

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
    if (typeof newEventName === 'string') newEventName = newEventName.normalize('NFC');
    const backupData = {};
    let lease = null;
    let tracked = false;

    try {
      // 1. Validate
      const validation = await this.validateRename(eventId, newEventName);
      if (!validation.valid) {
        return { success: false, error: validation.error, ...(validation.conflict && { conflict: true }) };
      }

      // The archive job reads the photos under the current slug (issue 2012).
      // Holding the gallery's archive claim through the move keeps one from
      // starting halfway and zipping an emptied prefix.
      lease = await require('./archiveService').claimArchive(eventId);
      if (!lease) {
        return { success: false, conflict: true, error: busyMessage(eventId) };
      }
      renamingIds.add(eventId);
      tracked = true;

      // 2. Get current event data, under the claim: an archive that finished
      // after the validation above has moved the photos on.
      const event = await db('events').where({ id: eventId }).first();
      if (!event || event.is_archived) {
        return { success: false, error: 'Cannot rename archived events' };
      }
      backupData.event = event;
      backupData.newSlug = validation.newSlug;

      const oldSlug = event.slug;
      const oldName = event.event_name;
      const newSlug = validation.newSlug;

      // Reads settings through `db`, so it has to happen before the
      // transaction takes SQLite's only connection.
      const { shareUrl: newShareLink, shareLinkToStore } = await buildShareLinkVariants({
        slug: newSlug,
        shareToken: event.share_token
      });

      // A restore before per-run archive keys left its zip at the shared key
      // of the old slug (issue 2012); after the rename nothing would find it
      // there. Read before the transaction, which takes SQLite's only
      // connection, and recorded inside it.
      const archiveService = require('./archiveService');
      const legacyZips = [];
      for (const key of await archiveService.legacyArchiveKeys(event).catch(() => [])) {
        if (await getStorage().exists(key).catch(() => false)) legacyZips.push(key);
      }

      // 3. Start transaction
      const trx = await db.transaction();

      try {
        // 4. Move the event's objects. Local disk keeps the one-call folder
        // rename; a remote backend has no such thing, so its objects are
        // copied here and the sources removed only after commit (#1694).
        const remote = getStorage().kind() !== 'local';
        if (remote) {
          backupData.moved = { sourceKeys: [], copiedKeys: [] };
          await this.moveEventObjects(oldSlug, newSlug, backupData.moved);
        } else {
          await this.renameEventFolder(oldSlug, newSlug);
          backupData.folderRenamed = true;
        }

        // 5. The event row before the photos on PostgreSQL (issue 2108). The
        // slug update below needs it FOR UPDATE, and a face scan, a tag
        // commit or a trash restore takes it before the photo; held only
        // from the photo rewrite on, each could hold its photo's event and
        // wait for the photo while this waited for the event. After the
        // object move, so a slow S3 copy does not hold up the gallery.
        if (trx.client.config.client === 'pg') {
          await trx('events').where({ id: eventId }).forUpdate().first('id');
        }

        // Rename photo files and update paths
        const filesRenamed = await this.renamePhotoFiles(eventId, oldName, newEventName.trim(), oldSlug, newSlug, trx);

        // 6. Update database records
        await this.updateDatabaseRecords(trx, eventId, oldSlug, newSlug, newEventName.trim(), shareLinkToStore);

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

        for (const key of legacyZips) await archiveService.recordSupersededArchive(lease, key, trx);

        // 9. Commit transaction
        await trx.commit();

        // Post-commit and best-effort, like the cascade delete's sweep: an
        // orphaned source object is recoverable noise, a rolled-back rename
        // with its objects already gone is not.
        if (backupData.moved && backupData.moved.sourceKeys.length > 0) {
          const removed = await this.deleteObjects(backupData.moved.sourceKeys, { oldSlug });
          logger.info('Event objects moved', { oldSlug, newSlug, removed, total: backupData.moved.sourceKeys.length });
        }

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
      // A claim taken over mid-rename (recordSupersededArchive) is a 409 too.
      return {
        success: false,
        error: error.message || 'Failed to rename event',
        ...(error.statusCode === 409 ? { conflict: true } : {}),
      };
    } finally {
      if (tracked) renamingIds.delete(eventId);
      if (lease) await lease.release();
    }
  }
}

module.exports = new EventRenameService();
