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

  // The evidence key (#1446) is read here rather than at the first contract
  // send: a value that is a character short of a key would otherwise fail in
  // the middle of signing, hours after anyone touched the configuration.
  const fieldEncryption = require('../utils/fieldEncryption');
  const keyProblem = fieldEncryption.keyProblemAtBoot();
  if (keyProblem) errors.push(keyProblem);
  // No PICPEAK_EVIDENCE_KEY: the key is a file the install generated for
  // itself. That works, but it means the only copy of it lives in the
  // storage volume, and losing it makes every signer's name, email address
  // and IP unreadable. Say so once at boot rather than leaving operators to
  // discover the file exists.
  if (!keyProblem && fieldEncryption.keyStatus().source === 'file') {
    warnings.push(
      'PICPEAK_EVIDENCE_KEY is not set, so signing evidence is encrypted with the key file at '
      + 'storage/business-docs/keys/evidence.key. Back that file up with the database — without it, '
      + 'signer names, email addresses and IP addresses cannot be read back. See docs/ENVIRONMENT_VARIABLES.md.',
    );
  }

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