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
  const backupKey = require('../utils/backupManifestKey').keyStatus();
  // A warning, not a boot error: before manifests were authenticated any
  // BACKUP_MANIFEST_KEY string was accepted, so exiting here would put an
  // upgraded install into a restart loop. Signing and verification still fail
  // closed, and System Health shows the key as not ready.
  if (backupKey.source === 'invalid') {
    warnings.push('BACKUP SIGNING IS DISABLED: the backup manifest signing key configuration is invalid, so new backups cannot be authenticated. '
      + 'BACKUP_MANIFEST_KEY must be 64 hex digits (openssl rand -hex 32); a key file must be a private regular file outside backed-up storage. '
      + 'An earlier passphrase-style BACKUP_MANIFEST_KEY still verifies the backups it signed.');
  } else if (!backupKey.ready) warnings.push('Backup manifest key not provisioned yet. A new key is created only when signing a backup; retain that external key separately for recovery.');
  if (process.env.BACKUP_MANIFEST_RECOVERY_SHA256 || process.env.BACKUP_MANIFEST_RECOVERY_REASON) {
    warnings.push('UNAUTHENTICATED backup recovery approval is configured. Use only on an isolated recovery host and remove it immediately after that one-artifact recovery.');
  }

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

  const emailQueueKey = process.env.EMAIL_QUEUE_ENCRYPTION_KEY;
  if (emailQueueKey && emailQueueKey.trim().length < 32) {
    errors.push('EMAIL_QUEUE_ENCRYPTION_KEY must contain at least 32 characters. Generate a unique secret with openssl rand -hex 32.');
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
    return;
  }

  // Log successful validation
  logger.info('Environment validation passed');
}

module.exports = { validateEnvironment };
