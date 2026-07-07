const logger = require('../utils/logger');

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
      // Check for the insecure default value
      if (value === 'your-secret-key') {
        errors.push('CRITICAL: JWT_SECRET is set to the insecure default value. Please set a secure secret key.');
      }
      
      // Check minimum length (should be at least 32 characters for security)
      if (value.length < 32) {
        warnings.push(`JWT_SECRET should be at least 32 characters long for better security (current: ${value.length} characters)`);
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
  }

  // Log successful validation
  logger.info('Environment validation passed');
}

module.exports = { validateEnvironment };