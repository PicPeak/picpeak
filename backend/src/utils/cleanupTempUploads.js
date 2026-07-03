const path = require('path');
const fs = require('fs').promises;
const logger = require('./logger');

const getStoragePath = () => process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');

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
}

/**
 * Start periodic cleanup of temp uploads
 * Runs every hour
 */
function startTempUploadCleanup() {
  // Run immediately on startup
  cleanupTempUploads();
  
  // Then run every hour
  setInterval(() => {
    cleanupTempUploads();
  }, 60 * 60 * 1000); // 1 hour
  
  logger.info('Temp upload cleanup service started');
}

module.exports = {
  cleanupTempUploads,
  startTempUploadCleanup
};