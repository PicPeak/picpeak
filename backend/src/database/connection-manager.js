const knex = require('knex');
const knexConfig = require('../../knexfile');
const logger = require('../utils/logger');

class ConnectionManager {
  constructor() {
    this.db = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000; // 5 seconds
    this.isReconnecting = false;
  }

  async initialize() {
    try {
      this.db = knex(knexConfig);
      
      // Test the connection
      await this.db.raw('SELECT 1');
      logger.info('Database connection established successfully');
      
      // Set up connection error handling
      this.setupErrorHandling();
      
      this.reconnectAttempts = 0;
      return this.db;
    } catch (error) {
      logger.error('Failed to initialize database connection:', error);
      throw error;
    }
  }

  setupErrorHandling() {
    if (!this.db) return;

    // Handle connection errors
    this.db.on('error', async (error) => {
      logger.error('Database connection error:', error);
      
      if (this.shouldReconnect(error)) {
        await this.reconnect();
      }
    });
  }

  shouldReconnect(error) {
    const reconnectableErrors = [
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ECONNRESET',
      'Connection terminated unexpectedly',
      'Connection terminated'
    ];
    
    return reconnectableErrors.some(msg => 
      error.code === msg || error.message?.includes(msg)
    );
  }

  async reconnect() {
    if (this.isReconnecting) {
      logger.info('Already attempting to reconnect...');
      return;
    }

    this.isReconnecting = true;
    
    while (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      
      logger.info(`Attempting to reconnect to database (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
      
      try {
        // Destroy the old connection pool
        if (this.db) {
          await this.db.destroy();
        }
        
        // Create new connection
        await this.initialize();
        
        logger.info('Successfully reconnected to database');
        this.isReconnecting = false;
        return;
      } catch (error) {
        logger.error(`Reconnection attempt ${this.reconnectAttempts} failed:`, error.message);
        
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          await new Promise(resolve => setTimeout(resolve, this.reconnectDelay));
        }
      }
    }
    
    this.isReconnecting = false;
    logger.error('Failed to reconnect to database after maximum attempts');
    
    // In production, you might want to alert monitoring systems or restart the process
    if (process.env.NODE_ENV === 'production') {
      logger.error('Exiting process due to database connection failure');
      process.exit(1);
    }
  }

  getConnection() {
    if (!this.db) {
      throw new Error('Database connection not initialized');
    }
    return this.db;
  }

  async healthCheck() {
    try {
      await this.db.raw('SELECT 1');
      return { healthy: true };
    } catch (error) {
      logger.error('Database health check failed:', error);
      return { healthy: false, error: error.message };
    }
  }

  async destroy() {
    if (this.db) {
      await this.db.destroy();
      this.db = null;
    }
  }
}

// Create singleton instance
const connectionManager = new ConnectionManager();

module.exports = connectionManager;