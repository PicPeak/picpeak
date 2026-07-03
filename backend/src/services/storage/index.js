const LocalFsStorage = require('./LocalFsStorage');
const S3StorageBackend = require('./S3StorageBackend');
const { getStoragePath } = require('../../config/storage');
const logger = require('../../utils/logger');

let instance = null;

/**
 * Build the storage backend selected by STORAGE_BACKEND env var.
 *
 * STORAGE_BACKEND=local (default)
 *   Uses STORAGE_PATH on the local filesystem. Backwards compatible with every
 *   existing deployment.
 *
 * STORAGE_BACKEND=s3
 *   Reads STORAGE_S3_* vars. Compatible with AWS S3 and any S3-compatible
 *   service (MinIO, R2, Backblaze, Wasabi, DigitalOcean Spaces, etc.) by
 *   pointing STORAGE_S3_ENDPOINT at the alternate host.
 *
 * Required S3 vars:
 *   STORAGE_S3_BUCKET
 *   STORAGE_S3_REGION (default us-east-1)
 *   STORAGE_S3_ACCESS_KEY
 *   STORAGE_S3_SECRET_KEY
 * Optional S3 vars:
 *   STORAGE_S3_ENDPOINT      — custom endpoint URL (MinIO/R2/etc.)
 *   STORAGE_S3_PREFIX        — namespace prefix inside the bucket
 *   STORAGE_S3_FORCE_PATH_STYLE=true|false (default: auto when endpoint set)
 *   STORAGE_S3_SSL=true|false (default: true)
 */
function buildStorage() {
  const backend = (process.env.STORAGE_BACKEND || 'local').toLowerCase();

  if (backend === 's3') {
    const required = ['STORAGE_S3_BUCKET', 'STORAGE_S3_ACCESS_KEY', 'STORAGE_S3_SECRET_KEY'];
    const missing = required.filter((v) => !process.env[v]);
    if (missing.length) {
      throw new Error(
        `STORAGE_BACKEND=s3 but missing required env vars: ${missing.join(', ')}`
      );
    }
    return new S3StorageBackend({
      bucket: process.env.STORAGE_S3_BUCKET,
      region: process.env.STORAGE_S3_REGION || 'us-east-1',
      endpoint: process.env.STORAGE_S3_ENDPOINT,
      accessKeyId: process.env.STORAGE_S3_ACCESS_KEY,
      secretAccessKey: process.env.STORAGE_S3_SECRET_KEY,
      prefix: process.env.STORAGE_S3_PREFIX,
      forcePathStyle: process.env.STORAGE_S3_FORCE_PATH_STYLE === 'true' ? true : undefined,
      sslEnabled: process.env.STORAGE_S3_SSL !== 'false',
    });
  }

  if (backend !== 'local') {
    throw new Error(`Unknown STORAGE_BACKEND: ${backend}. Expected 'local' or 's3'.`);
  }

  return new LocalFsStorage({ root: getStoragePath() });
}

/**
 * Lazily build + memoize the storage backend. Tests can pass an injected
 * instance via `setStorageForTesting` to bypass env-var configuration.
 */
function getStorage() {
  if (!instance) {
    instance = buildStorage();
  }
  return instance;
}

/** @internal */
function setStorageForTesting(stub) {
  instance = stub;
}

/** @internal — clear the memoized instance so the next call re-reads env. */
function resetStorage() {
  instance = null;
}

/**
 * Initialize the configured backend. Call once at server startup so config errors
 * surface before any request comes in.
 */
async function initStorage() {
  const storage = getStorage();
  try {
    await storage.init();
  } catch (err) {
    logger.error(`[storage] init failed for backend=${storage.kind()}: ${err.message}`);
    throw err;
  }
  return storage;
}

module.exports = {
  getStorage,
  initStorage,
  setStorageForTesting,
  resetStorage,
};
