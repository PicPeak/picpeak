const path = require('path');
const fs = require('fs').promises;
const logger = require('./logger');

const { getStoragePath } = require('../config/storage');

// A chunked upload expires 24 hours after it starts (chunkedUploadService).
const CHUNK_UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Remove chunk directories (storage/chunks/<uploadId>) and merge directories
 * (temp/merge_<ms>_*) of chunked uploads that ran without an upload admission.
 * The expiry sweep only knows the uploads in its in-memory map, so a restart
 * stranded every such directory, and a failed merge left its merge directory.
 * Admitted uploads stage under temp/public-uploads, which the upload quota's
 * own lease reaper clears.
 */
async function cleanupStaleChunkUploads() {
  const cutoff = Date.now() - CHUNK_UPLOAD_MAX_AGE_MS;
  const candidates = [];
  const chunksPath = path.join(getStoragePath(), 'chunks');
  for (const item of await fs.readdir(chunksPath).catch(() => [])) {
    candidates.push({ itemPath: path.join(chunksPath, item), timestamp: null });
  }
  const tempPath = path.join(getStoragePath(), 'temp');
  for (const item of await fs.readdir(tempPath).catch(() => [])) {
    if (item.startsWith('merge_')) {
      candidates.push({ itemPath: path.join(tempPath, item), timestamp: parseInt(item.split('_')[1], 10) });
    }
  }

  let cleanedCount = 0;
  for (const { itemPath, timestamp } of candidates) {
    try {
      const stats = await fs.stat(itemPath);
      // A chunk directory changes with every chunk written into it.
      const startedAt = Number.isFinite(timestamp) ? timestamp : stats.mtimeMs;
      if (stats.isDirectory() && startedAt < cutoff) {
        await fs.rm(itemPath, { recursive: true, force: true });
        cleanedCount++;
      }
    } catch (error) {
      logger.error(`Error cleaning up stale chunk upload ${itemPath}:`, error.message);
    }
  }
  if (cleanedCount > 0) {
    logger.info(`Cleaned up ${cleanedCount} stale chunked upload directories`);
  }
}

/**
 * Clean up old temporary upload directories
 * Removes temp directories older than 1 hour
 */
async function cleanupTempUploads() {
  const tempPath = path.join(getStoragePath(), 'temp');
  
  try {
    // Ensure temp directory exists
    await fs.mkdir(tempPath, { recursive: true });
    
    // Read all items in temp directory
    const items = await fs.readdir(tempPath);
    
    let cleanedCount = 0;
    const oneHourAgo = Date.now() - (60 * 60 * 1000); // 1 hour
    
    for (const item of items) {
      const itemPath = path.join(tempPath, item);
      
      try {
        const stats = await fs.stat(itemPath);
        
        // Only process directories that match our upload pattern
        if (stats.isDirectory() && item.startsWith('upload_')) {
          // Extract timestamp from directory name
          const parts = item.split('_');
          if (parts.length >= 2) {
            const timestamp = parseInt(parts[1]);
            
            // Remove if older than 1 hour
            if (!isNaN(timestamp) && timestamp < oneHourAgo) {
              logger.info(`Cleaning up old temp upload directory: ${item}`);
              await fs.rm(itemPath, { recursive: true, force: true });
              cleanedCount++;
            }
          }
        }
      } catch (error) {
        logger.error(`Error processing temp item ${item}:`, error.message);
      }
    }
    
    if (cleanedCount > 0) {
      logger.info(`Cleaned up ${cleanedCount} old temp upload directories`);
    }
    
  } catch (error) {
    logger.error('Error during temp upload cleanup:', error);
  }

  await cleanupStaleChunkUploads();
}

/**
 * Start periodic cleanup of temp uploads
 * Runs every hour
 */
const cleanupTask = require('../services/scheduledTask').scheduledTask(cleanupTempUploads, {
  interval: 60 * 60 * 1000, initialDelay: 0
});
function startTempUploadCleanup() { cleanupTask.start(); }
function stopTempUploadCleanup() { return cleanupTask.stop(); }

module.exports = { cleanupTempUploads, startTempUploadCleanup, stopTempUploadCleanup };
