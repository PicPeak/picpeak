/**
 * WatermarkGeneratorService
 *
 * Handles batch generation of pre-watermarked images for fast serving.
 * This service is responsible for:
 * - Generating watermarks for newly uploaded photos
 * - Regenerating all watermarks when settings change
 * - Tracking regeneration progress
 */

const { db } = require('../database/db');
const watermarkService = require('./watermarkService');
const { resolvePhotoStorageKey, resolvePhotoFilePath } = require('./photoResolver');
const { withLocalCopy } = require('./imageProcessor');
const logger = require('../utils/logger');

class WatermarkGeneratorService {
  constructor() {
    // Track active regeneration jobs
    this.activeJobs = new Map();
    // Batch size for processing (to manage memory)
    this.batchSize = 10;
    // Concurrent processing limit
    this.concurrentLimit = 2;
  }

  /**
   * Generate watermark for a single photo
   * @param {number} photoId - The photo ID
   * @returns {Object} Result with success status and watermark path
   */
  async generateForPhoto(photoId) {
    try {
      // Get photo with event info
      const photo = await db('photos')
        .join('events', 'photos.event_id', 'events.id')
        .where('photos.id', photoId)
        .select(
          'photos.*',
          'events.slug',
          'events.source_mode',
          'events.external_path'
        )
        .first();

      if (!photo) {
        return { success: false, error: 'Photo not found' };
      }

      // Skip video files
      if (photo.media_type === 'video' || (photo.mime_type && photo.mime_type.startsWith('video/'))) {
        return { success: false, error: 'Videos do not support watermarks' };
      }

      // Get watermark settings
      const settings = await watermarkService.getWatermarkSettings();
      if (!settings || !settings.enabled) {
        return { success: false, error: 'Watermarking is disabled' };
      }

      // Resolve the source via the storage backend (managed) or local disk
      // (external reference mode). watermarkService needs a local file path.
      const event = { slug: photo.slug, source_mode: photo.source_mode, external_path: photo.external_path };
      const storageKey = resolvePhotoStorageKey(event, photo);
      const result = storageKey
        ? await withLocalCopy(storageKey, (lp) =>
          watermarkService.generateAndSaveWatermark(photo, lp, settings)
        )
        : await watermarkService.generateAndSaveWatermark(photo, resolvePhotoFilePath(event, photo), settings);

      if (result.success) {
        // Update database with watermark path
        await db('photos')
          .where({ id: photoId })
          .update({
            watermark_path: result.watermarkPath,
            watermark_generated_at: db.fn.now()
          });
      }

      return result;
    } catch (error) {
      logger.error(`Error generating watermark for photo ${photoId}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Generate watermarks for all photos in an event
   * @param {number} eventId - The event ID
   * @param {Function} onProgress - Optional callback for progress updates
   * @returns {Object} Result with success count and errors
   */
  async generateForEvent(eventId, onProgress = null) {
    const results = { total: 0, success: 0, failed: 0, errors: [] };

    try {
      // Get all photos for the event (excluding videos)
      const photos = await db('photos')
        .join('events', 'photos.event_id', 'events.id')
        .where('photos.event_id', eventId)
        .whereNot(function() {
          this.where('photos.media_type', 'video')
            .orWhere('photos.mime_type', 'like', 'video/%');
        })
        .select(
          'photos.*',
          'events.slug',
          'events.source_mode',
          'events.external_path'
        );

      results.total = photos.length;

      if (photos.length === 0) {
        return results;
      }

      // Get watermark settings once
      const settings = await watermarkService.getWatermarkSettings();
      if (!settings || !settings.enabled) {
        return { ...results, errors: ['Watermarking is disabled'] };
      }

      // Process in batches
      for (let i = 0; i < photos.length; i += this.batchSize) {
        const batch = photos.slice(i, i + this.batchSize);

        // Process batch with limited concurrency
        const batchResults = await Promise.all(
          batch.map(photo => this.processPhotoWatermark(photo, settings))
        );

        // Collect results
        for (const result of batchResults) {
          if (result.success) {
            results.success++;
          } else {
            results.failed++;
            if (result.error) {
              results.errors.push(`Photo ${result.photoId}: ${result.error}`);
            }
          }
        }

        // Progress callback
        if (onProgress) {
          onProgress({
            total: results.total,
            processed: results.success + results.failed,
            success: results.success,
            failed: results.failed
          });
        }
      }

      return results;
    } catch (error) {
      logger.error(`Error generating watermarks for event ${eventId}:`, error);
      return { ...results, errors: [...results.errors, error.message] };
    }
  }

  /**
   * Process watermark for a single photo (internal helper)
   */
  async processPhotoWatermark(photo, settings) {
    try {
      const event = { slug: photo.slug, source_mode: photo.source_mode, external_path: photo.external_path };
      const storageKey = resolvePhotoStorageKey(event, photo);
      const result = storageKey
        ? await withLocalCopy(storageKey, (lp) =>
          watermarkService.generateAndSaveWatermark(photo, lp, settings)
        )
        : await watermarkService.generateAndSaveWatermark(photo, resolvePhotoFilePath(event, photo), settings);

      if (result.success) {
        await db('photos')
          .where({ id: photo.id })
          .update({
            watermark_path: result.watermarkPath,
            watermark_generated_at: db.fn.now()
          });
      }

      return { ...result, photoId: photo.id };
    } catch (error) {
      return { success: false, photoId: photo.id, error: error.message };
    }
  }

  /**
   * Regenerate watermarks for all photos in the system
   * @param {Function} onProgress - Optional callback for progress updates
   * @returns {Object} Result with success count and errors
   */
  async regenerateAll(onProgress = null) {
    const jobId = Date.now().toString();
    const results = { jobId, total: 0, success: 0, failed: 0, errors: [], status: 'running' };

    try {
      this.activeJobs.set(jobId, results);

      // Get watermark settings
      const settings = await watermarkService.getWatermarkSettings();
      if (!settings || !settings.enabled) {
        results.status = 'completed';
        results.errors.push('Watermarking is disabled');
        return results;
      }

      // First, clear existing watermarks from DB (the files will be overwritten)
      // This ensures stale paths don't persist if regeneration fails

      // Get all image photos (exclude videos)
      const photos = await db('photos')
        .join('events', 'photos.event_id', 'events.id')
        .whereNot(function() {
          this.where('photos.media_type', 'video')
            .orWhere('photos.mime_type', 'like', 'video/%');
        })
        .select(
          'photos.*',
          'events.slug',
          'events.source_mode',
          'events.external_path'
        );

      results.total = photos.length;

      if (photos.length === 0) {
        results.status = 'completed';
        return results;
      }

      logger.info(`Starting watermark regeneration for ${photos.length} photos`);

      // Process in batches
      for (let i = 0; i < photos.length; i += this.batchSize) {
        // Check if job was cancelled
        if (!this.activeJobs.has(jobId)) {
          results.status = 'cancelled';
          return results;
        }

        const batch = photos.slice(i, i + this.batchSize);

        // Process batch with limited concurrency
        const batchResults = await Promise.all(
          batch.map(photo => this.processPhotoWatermark(photo, settings))
        );

        // Collect results
        for (const result of batchResults) {
          if (result.success) {
            results.success++;
          } else {
            results.failed++;
            if (result.error && results.errors.length < 50) {
              results.errors.push(`Photo ${result.photoId}: ${result.error}`);
            }
          }
        }

        // Update job status
        this.activeJobs.set(jobId, { ...results });

        // Progress callback
        if (onProgress) {
          onProgress({
            jobId,
            total: results.total,
            processed: results.success + results.failed,
            success: results.success,
            failed: results.failed,
            percentComplete: Math.round(((results.success + results.failed) / results.total) * 100)
          });
        }

        // Small delay between batches to prevent CPU saturation
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      results.status = 'completed';
      logger.info(`Watermark regeneration completed: ${results.success}/${results.total} successful`);

      return results;
    } catch (error) {
      logger.error('Error during watermark regeneration:', error);
      results.status = 'failed';
      results.errors.push(error.message);
      return results;
    } finally {
      // Clean up job tracking after a delay
      setTimeout(() => {
        this.activeJobs.delete(jobId);
      }, 60000); // Keep for 1 minute for status queries
    }
  }

  /**
   * Clear all watermarks (when watermarking is disabled)
   */
  async clearAllWatermarks() {
    try {
      // Get all photos with watermarks
      const photos = await db('photos')
        .whereNotNull('watermark_path')
        .select('id', 'watermark_path');

      // Delete watermark files
      for (const photo of photos) {
        await watermarkService.deleteWatermarkFile(photo.watermark_path);
      }

      // Clear database paths
      await db('photos')
        .whereNotNull('watermark_path')
        .update({
          watermark_path: null,
          watermark_generated_at: null
        });

      logger.info(`Cleared ${photos.length} watermarks`);
      return { success: true, cleared: photos.length };
    } catch (error) {
      logger.error('Error clearing watermarks:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Delete watermark for a specific photo
   */
  async deleteForPhoto(photoId) {
    try {
      const photo = await db('photos')
        .where({ id: photoId })
        .select('watermark_path')
        .first();

      if (photo && photo.watermark_path) {
        await watermarkService.deleteWatermarkFile(photo.watermark_path);
        await db('photos')
          .where({ id: photoId })
          .update({
            watermark_path: null,
            watermark_generated_at: null
          });
      }

      return { success: true };
    } catch (error) {
      logger.error(`Error deleting watermark for photo ${photoId}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get status of an active regeneration job
   */
  getJobStatus(jobId) {
    return this.activeJobs.get(jobId) || null;
  }

  /**
   * Cancel an active regeneration job
   */
  cancelJob(jobId) {
    if (this.activeJobs.has(jobId)) {
      this.activeJobs.delete(jobId);
      return true;
    }
    return false;
  }

  /**
   * Check if there's an active regeneration job
   */
  hasActiveJob() {
    for (const [, job] of this.activeJobs) {
      if (job.status === 'running') {
        return true;
      }
    }
    return false;
  }

  /**
   * Get count of photos needing watermark generation
   */
  async getPendingCount() {
    const settings = await watermarkService.getWatermarkSettings();
    if (!settings || !settings.enabled) {
      return 0;
    }

    const result = await db('photos')
      .whereNull('watermark_path')
      .whereNot(function() {
        this.where('media_type', 'video')
          .orWhere('mime_type', 'like', 'video/%');
      })
      .count('id as count')
      .first();

    return parseInt(result.count) || 0;
  }
}

module.exports = new WatermarkGeneratorService();
