/**
 * Worker Manager - Background service for PicPeak
 *
 * This service runs as a separate process to handle:
 * - File watching for new photos
 * - Expiration checking for events
 * - Other background tasks
 */

const path = require('path');
const logger = require('../utils/logger');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

// Import services
const { startFileWatcher } = require('./fileWatcher');
const { startExpirationChecker } = require('./expirationChecker');

let isShuttingDown = false;

async function startWorkers() {
  logger.info('Starting PicPeak background workers...');

  try {
    // Start file watcher for automatic photo processing
    startFileWatcher();
    logger.info('File watcher started successfully');

    // Start expiration checker for event lifecycle management
    startExpirationChecker();
    logger.info('Expiration checker started successfully');

    logger.info('All background workers started successfully');
  } catch (error) {
    logger.error('Failed to start background workers:', error);
    process.exit(1);
  }
}

function handleShutdown(signal) {
  if (isShuttingDown) {
    logger.info('Shutdown already in progress...');
    return;
  }

  isShuttingDown = true;
  logger.info(`Received ${signal}. Shutting down gracefully...`);

  // Give time for cleanup
  setTimeout(() => {
    logger.info('Worker manager shutdown complete');
    process.exit(0);
  }, 1000);
}

// Handle shutdown signals
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception in worker manager:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection in worker manager:', reason);
});

// Start workers
startWorkers();
