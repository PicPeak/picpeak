const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Ensure logs directory exists
const logDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// Custom format for production logs
const productionFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.printf(info => {
    // Ensure all security events are properly formatted
    if (info.level === 'warn' && (info.message.includes('rate limit') || 
                                   info.message.includes('auth') ||
                                   info.message.includes('login') ||
                                   info.message.includes('JWT'))) {
      return JSON.stringify({
        timestamp: info.timestamp,
        level: info.level,
        message: info.message,
        security: true,
        ...info
      });
    }
    return JSON.stringify(info);
  })
);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: productionFormat,
  transports: [
    new winston.transports.File({ 
      filename: path.join(logDir, 'error.log'), 
      level: 'error',
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
      tailable: true
    }),
    new winston.transports.File({ 
      filename: path.join(logDir, 'combined.log'),
      maxsize: 50 * 1024 * 1024, // 50MB
      maxFiles: 10,
      tailable: true
    }),
    // Separate security log for authentication and rate limiting
    new winston.transports.File({
      filename: path.join(logDir, 'security.log'),
      level: 'warn',
      maxsize: 20 * 1024 * 1024, // 20MB
      maxFiles: 10,
      tailable: true,
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
        winston.format.json(),
        winston.format.printf(info => {
          // Only log security-related warnings
          if (info.message.includes('rate limit') || 
              info.message.includes('auth') ||
              info.message.includes('login') ||
              info.message.includes('JWT') ||
              info.message.includes('lockout') ||
              info.message.includes('suspicious')) {
            return JSON.stringify(info);
          }
          return null;
        })
      )
    })
  ].filter(Boolean)
});

// Add console logging for non-production environments
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp({ format: 'HH:mm:ss' }),
      winston.format.printf(info => {
        return `[${info.timestamp}] ${info.level}: ${info.message} ${info.stack || ''}`;
      })
    )
  }));
} else {
  // In production, also log to console for container environments
  if (process.env.LOG_TO_CONSOLE === 'true') {
    logger.add(new winston.transports.Console({
      format: productionFormat
    }));
  }
}

module.exports = logger;
