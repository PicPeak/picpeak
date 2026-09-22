const logger = require('../utils/logger');

// Published examples are public signing keys, regardless of their length.
const INSECURE_JWT_SECRETS = new Set([
  'your-secret-key',
  'your_very_long_random_jwt_secret_here',
  'your-very-secure-jwt-secret-at-least-32-characters-long-example123456'
]);

/**
 * Validates required environment variables are set
 * Exits the process if critical variables are missing
 */
function validateEnvironment() {
  const requiredVars = [
    {
      name: 'JWT_SECRET',
      description: 'Secret key for JWT token signing',
      critical: true
    }
  ];

  const warnings = [];
  const errors = [];

  // Check each required variable
  requiredVars.forEach(({ name, description, critical }) => {
    const value = process.env[name];
    
    if (!value || value.trim() === '') {
      const message = `Missing required environment variable: ${name} - ${description}`;
      
      if (critical) {
        errors.push(message);
      } else {
        warnings.push(message);
      }
    }
    
    // Additional validation for JWT_SECRET
    if (name === 'JWT_SECRET' && value) {
      if (INSECURE_JWT_SECRETS.has(value.trim())) {
        errors.push('JWT_SECRET is a public example value. Configure a unique, randomly generated secret.');
      }
      
      // Check minimum length (should be at least 32 characters for security)
      if (value.trim().length < 32) {
        errors.push('JWT_SECRET must contain at least 32 characters. Generate a unique secret with openssl rand -hex 32.');
      }
    }
  });

  // Log warnings
  warnings.forEach(warning => logger.warn(warning));

  // If there are critical errors, log them and exit
  if (errors.length > 0) {
    logger.error('=== CRITICAL CONFIGURATION ERRORS ===');
    errors.forEach(error => logger.error(error));
    logger.error('=====================================');
    logger.error('Server cannot start due to missing or invalid configuration.');
    logger.error('Please set the required environment variables and try again.');
    
    // Exit with error code
    process.exit(1);
    return;
  }

  // Log successful validation
  logger.info('Environment validation passed');
}

module.exports = { validateEnvironment };
