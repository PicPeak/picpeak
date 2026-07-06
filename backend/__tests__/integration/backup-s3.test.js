const { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } = require('@jest/globals');
const { S3Client, CreateBucketCommand, DeleteBucketCommand, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');

// Load services
const backupService = require('../../src/services/backupService');
const S3StorageAdapter = require('../../src/services/storage/s3Storage');
const { db, initializeDatabase: initDb } = require('../../src/database/db');
const logger = require('../../src/utils/logger');

// Test configuration
// Defaults match the dev MinIO container in docker-compose.dev.yml (port 7104).
// Override via TEST_S3_ENDPOINT / TEST_S3_ACCESS_KEY / TEST_S3_SECRET_KEY when running
// against a different S3 endpoint (CI, hosted MinIO, real AWS, etc.).
const TEST_CONFIG = {
  endpoint: process.env.TEST_S3_ENDPOINT || 'http://localhost:7104',
  accessKeyId: process.env.TEST_S3_ACCESS_KEY || 'minioadmin',
  secretAccessKey: process.env.TEST_S3_SECRET_KEY || 'minioadmin',
  bucket: 'test-backup-bucket-' + Date.now(),
  region: 'us-east-1'
};

describe('S3 Backup Integration Tests', () => {
  let s3Client;
  let testStoragePath;
  let originalEnv;

  beforeAll(async () => {
    // Skip if no S3 endpoint configured
    if (process.env.SKIP_S3_TESTS === 'true') {
      console.log('Skipping S3 integration tests (SKIP_S3_TESTS=true)');
      return;
    }

    // Save original environment
    originalEnv = { ...process.env };

    // Initialize S3 client for test setup
    s3Client = new S3Client({
      endpoint: TEST_CONFIG.endpoint,
      region: TEST_CONFIG.region,
      credentials: {
        accessKeyId: TEST_CONFIG.accessKeyId,
        secretAccessKey: TEST_CONFIG.secretAccessKey
      },
      forcePathStyle: true
    });

    // Create test bucket
    try {
      await s3Client.send(new CreateBucketCommand({ Bucket: TEST_CONFIG.bucket }));
      console.log(`Created test bucket: ${TEST_CONFIG.bucket}`);
    } catch (error) {
      if (error.name !== 'BucketAlreadyOwnedByYou') {
        console.error('Failed to create test bucket:', error);
        throw error;
      }
    }

    // Schema is expected to already be applied by `npm run migrate` against
    // the dev database. db.migrate.latest() can't be used here because
    // PicPeak's custom run-migrations.js tracks state in the `migrations`
    // table (not knex's `knex_migrations`), so knex would try to re-apply
    // every migration and crash on duplicate-table errors.
    const ok = await db.schema.hasTable('events')
      && await db.schema.hasTable('app_settings')
      && await db.schema.hasTable('backup_runs');
    if (!ok) {
      throw new Error('Required tables missing — run `npm run migrate` against the dev DB first.');
    }

    // Create test storage directory
    testStoragePath = path.join(__dirname, '../fixtures/test-storage');
    await fs.mkdir(testStoragePath, { recursive: true });
    process.env.STORAGE_PATH = testStoragePath;

    // Set up test data
    await setupTestData();

    // Mock logger to reduce noise
    if (process.env.UNMOCK_LOGGER !== 'true') {
      logger.info = jest.fn();
      logger.debug = jest.fn();
      logger.warn = jest.fn();
      logger.error = jest.fn();
    }
  });

  afterAll(async () => {
    if (process.env.SKIP_S3_TESTS === 'true') return;

    try {
      // Clean up S3 bucket
      await cleanupS3Bucket();
      await s3Client.send(new DeleteBucketCommand({ Bucket: TEST_CONFIG.bucket }));
      console.log(`Deleted test bucket: ${TEST_CONFIG.bucket}`);
    } catch (error) {
      console.error('Failed to cleanup S3 bucket:', error);
    }

    // Clean up test storage
    await fs.rm(testStoragePath, { recursive: true, force: true });

    // Restore environment
    process.env = originalEnv;

    // Close database
    await db.destroy();
  });

  beforeEach(async () => {
    if (process.env.SKIP_S3_TESTS === 'true') {
      return;
    }

    // Clean backup tables
    await db('backup_runs').del();
    await db('backup_file_states').del();
    await db('database_backup_runs').del();

    // Configure S3 backup settings
    await configureS3Backup();
  });

  afterEach(async () => {
    if (process.env.SKIP_S3_TESTS === 'true') return;

    // Clean up S3 objects created during test
    await cleanupS3Bucket();
  });

  describe('S3 Connection and Configuration', () => {
    it('should successfully connect to S3-compatible storage', async () => {
      if (process.env.SKIP_S3_TESTS === 'true') return;

      const s3Adapter = new S3StorageAdapter({
        ...TEST_CONFIG,
        bucket: TEST_CONFIG.bucket,
        forcePathStyle: true,
        sslEnabled: false
      });

      const connected = await s3Adapter.testConnection();
      expect(connected).toBe(true);
    });

    it('should validate S3 configuration before backup', async () => {
      if (process.env.SKIP_S3_TESTS === 'true') return;

      // Remove required configuration
      await db('app_settings')
        .where('setting_key', 'backup_s3_secret_key')
        .del();

      await backupService.runBackup();

      const lastRun = await db('backup_runs')
        .orderBy('started_at', 'desc')
        .first();

      expect(lastRun.status).toBe('failed');
      expect(lastRun.error_message).toContain('S3 backup configuration incomplete');
    });
  });

  describe('Full S3 Backup Process', () => {
    it('should perform complete S3 backup with all file types', async () => {
      if (process.env.SKIP_S3_TESTS === 'true') return;

      // Run backup
      await backupService.runBackup();

      // Verify backup run completed
      const backupRun = await db('backup_runs')
        .orderBy('started_at', 'desc')
        .first();

      expect(backupRun.status).toBe('completed');
      // pg driver returns bigint columns as strings; coerce for the size assertion.
      expect(Number(backupRun.files_backed_up)).toBeGreaterThan(0);
      expect(Number(backupRun.total_size_bytes)).toBeGreaterThan(0);

      // Verify files in S3
      const s3Objects = await listS3Objects();
      expect(s3Objects.length).toBeGreaterThan(0);

      // Check for expected file types
      const hasPhotos = s3Objects.some(obj => obj.Key.includes('events/active'));
      const hasThumbnails = s3Objects.some(obj => obj.Key.includes('thumbnails'));
      const hasManifest = s3Objects.some(obj => obj.Key.includes('backup-manifest'));
      const hasSummary = s3Objects.some(obj => obj.Key.includes('backup-summary.json'));

      expect(hasPhotos).toBe(true);
      expect(hasThumbnails).toBe(true);
      expect(hasManifest).toBe(true);
      expect(hasSummary).toBe(true);
    });

    it('should handle large file uploads with multipart', async () => {
      if (process.env.SKIP_S3_TESTS === 'true') return;

      // Create a large test file (15MB)
      const largeFilePath = path.join(testStoragePath, 'events/active/large-photo.jpg');
      const largeFileSize = 15 * 1024 * 1024; // 15MB
      const largeFileContent = Buffer.alloc(largeFileSize, 'x');
      await fs.writeFile(largeFilePath, largeFileContent);

      // Run backup
      await backupService.runBackup();

      // Verify large file was uploaded
      const s3Objects = await listS3Objects();
      const largeFileUploaded = s3Objects.some(obj => 
        obj.Key.includes('large-photo.jpg') && obj.Size === largeFileSize
      );

      expect(largeFileUploaded).toBe(true);
    });

    it('should include database backup when available', async () => {
      if (process.env.SKIP_S3_TESTS === 'true') return;

      // Create a mock database backup
      const dbBackupPath = path.join(testStoragePath, 'backups/db-backup.sql');
      await fs.mkdir(path.dirname(dbBackupPath), { recursive: true });
      await fs.writeFile(dbBackupPath, 'CREATE TABLE test (id INT);');

      // Record database backup
      await db('database_backup_runs').insert({
        started_at: new Date(),
        completed_at: new Date(),
        status: 'completed',
        backup_type: 'sqlite',
        file_path: dbBackupPath,
        file_size_bytes: 100,
        checksum: 'test123',
        statistics: JSON.stringify({ tables: {} }),
        table_checksums: JSON.stringify({})
      });

      // Configure to include database
      await db('app_settings')
        .where('setting_key', 'backup_include_database')
        .update({ setting_value: 'true' });

      // Run backup
      await backupService.runBackup();

      // Verify database backup in S3
      const s3Objects = await listS3Objects();
      const hasDbBackup = s3Objects.some(obj => obj.Key.includes('database/db-backup.sql'));
      expect(hasDbBackup).toBe(true);
    });
  });

  describe('Incremental Backup', () => {
    it('should only upload changed files in incremental backup', async () => {
      if (process.env.SKIP_S3_TESTS === 'true') return;

      // First backup - full
      await backupService.runBackup();

      const firstRun = await db('backup_runs')
        .orderBy('started_at', 'desc')
        .first();

      const firstObjectCount = (await listS3Objects()).length;

      // Wait a moment to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 100));

      // Modify one file
      const modifiedFile = path.join(testStoragePath, 'events/active/event1/photo1.jpg');
      await fs.writeFile(modifiedFile, 'modified content');

      // Second backup - incremental
      await backupService.runBackup();

      const secondRun = await db('backup_runs')
        .orderBy('started_at', 'desc')
        .first();

      expect(secondRun.id).not.toBe(firstRun.id);
      expect(Number(secondRun.files_backed_up)).toBe(1); // Only modified file

      // Check manifest indicates incremental. The current manifest schema
      // groups counts under `incremental.changes.*` (added/modified/deleted/
      // unchanged + size_difference) — see backupManifest.generateIncrementalManifest.
      if (secondRun.manifest_path) {
        const manifest = await backupService.getBackupManifest(secondRun.id);
        expect(manifest.manifest.incremental).toBeDefined();
        expect(manifest.manifest.incremental.changes).toBeDefined();
        expect(manifest.manifest.incremental.changes.modified_files_count).toBe(1);
      }
    });

    it('should track file states across backups', async () => {
      if (process.env.SKIP_S3_TESTS === 'true') return;

      await backupService.runBackup();

      // Check file states are recorded
      const fileStates = await db('backup_file_states').select('*');
      expect(fileStates.length).toBeGreaterThan(0);

      // Verify checksums are stored
      const hasChecksums = fileStates.every(state => state.checksum !== null);
      expect(hasChecksums).toBe(true);
    });
  });

  describe('S3 Manifest Storage', () => {
    it('should upload manifest to S3 and retrieve it', async () => {
      if (process.env.SKIP_S3_TESTS === 'true') return;

      // Configure YAML manifest format
      await db('app_settings')
        .where('setting_key', 'backup_manifest_format')
        .update({ setting_value: '"yaml"' });

      await backupService.runBackup();

      const backupRun = await db('backup_runs')
        .orderBy('started_at', 'desc')
        .first();

      expect(backupRun.manifest_path).toMatch(/^s3:\/\//);

      // Retrieve manifest
      const { manifest, summary } = await backupService.getBackupManifest(backupRun.id);

      expect(manifest).toBeDefined();
      expect(manifest.backup.id).toBeDefined();
      expect(summary).toContain('BACKUP MANIFEST SUMMARY');
    });

    it('should validate manifest integrity', async () => {
      if (process.env.SKIP_S3_TESTS === 'true') return;

      await backupService.runBackup();

      const backupRun = await db('backup_runs')
        .orderBy('started_at', 'desc')
        .first();

      const validationResult = await backupService.validateBackupManifest(backupRun.manifest_path);

      expect(validationResult.valid).toBe(true);
      expect(validationResult.manifest).toBeDefined();
    });
  });

  describe('Error Recovery', () => {
    it('should handle S3 connection failures gracefully', async () => {
      if (process.env.SKIP_S3_TESTS === 'true') return;

      // Configure with invalid endpoint
      await db('app_settings')
        .where('setting_key', 'backup_s3_endpoint')
        .update({ setting_value: '"http://invalid-endpoint:9999"' });

      await backupService.runBackup();

      const backupRun = await db('backup_runs')
        .orderBy('started_at', 'desc')
        .first();

      expect(backupRun.status).toBe('failed');
      expect(backupRun.error_message).toBeDefined();
    });

    it('should continue backup despite individual file failures', async () => {
      if (process.env.SKIP_S3_TESTS === 'true') return;

      // Create a file that will be deleted during backup
      const tempFile = path.join(testStoragePath, 'events/active/temp.jpg');
      await fs.writeFile(tempFile, 'temporary');

      // Mock file deletion during backup
      const originalUpload = S3StorageAdapter.prototype.upload;
      let callCount = 0;
      S3StorageAdapter.prototype.upload = jest.fn(async function(localPath, s3Key, options) {
        callCount++;
        if (callCount === 2) {
          // Delete the temp file to cause an error
          await fs.unlink(tempFile).catch(() => {});
        }
        return originalUpload.call(this, localPath, s3Key, options);
      });

      await backupService.runBackup();

      const backupRun = await db('backup_runs')
        .orderBy('started_at', 'desc')
        .first();

      // Should complete despite one file error
      expect(backupRun.status).toBe('completed');
      expect(backupRun.files_backed_up).toBeGreaterThan(0);

      // Restore original method
      S3StorageAdapter.prototype.upload = originalUpload;
    });

    it('should retry failed uploads with exponential backoff', async () => {
      if (process.env.SKIP_S3_TESTS === 'true') return;

      // Mock S3 upload to fail twice then succeed
      const originalUpload = S3StorageAdapter.prototype.upload;
      let attemptCount = 0;
      S3StorageAdapter.prototype.upload = jest.fn(async function(localPath, s3Key, options) {
        attemptCount++;
        if (attemptCount <= 2) {
          const error = new Error('Network timeout');
          error.code = 'ETIMEDOUT';
          throw error;
        }
        return originalUpload.call(this, localPath, s3Key, options);
      });

      await backupService.runBackup();

      const backupRun = await db('backup_runs')
        .orderBy('started_at', 'desc')
        .first();

      // Should succeed after retries
      expect(backupRun.status).toBe('completed');
      expect(attemptCount).toBeGreaterThan(2);

      // Restore original method
      S3StorageAdapter.prototype.upload = originalUpload;
    });
  });

  // Helper functions

  async function setupTestData() {
    // Create test directory structure
    const dirs = [
      'events/active/event1',
      'events/active/event2',
      'events/archived',
      'thumbnails',
      'uploads'
    ];

    for (const dir of dirs) {
      await fs.mkdir(path.join(testStoragePath, dir), { recursive: true });
    }

    // Create test files
    const files = [
      { path: 'events/active/event1/photo1.jpg', content: 'photo1 content' },
      { path: 'events/active/event1/photo2.jpg', content: 'photo2 content' },
      { path: 'events/active/event2/photo3.jpg', content: 'photo3 content' },
      { path: 'events/archived/old-event.zip', content: 'archived content' },
      { path: 'thumbnails/thumb1.jpg', content: 'thumbnail content' },
      { path: 'uploads/logo.png', content: 'logo content' }
    ];

    for (const file of files) {
      await fs.writeFile(
        path.join(testStoragePath, file.path),
        file.content
      );
    }
  }

  async function configureS3Backup() {
    const settings = [
      { setting_key: 'backup_enabled', setting_value: 'true' },
      { setting_key: 'backup_destination_type', setting_value: '"s3"' },
      { setting_key: 'backup_s3_bucket', setting_value: `"${TEST_CONFIG.bucket}"` },
      { setting_key: 'backup_s3_region', setting_value: `"${TEST_CONFIG.region}"` },
      { setting_key: 'backup_s3_endpoint', setting_value: `"${TEST_CONFIG.endpoint}"` },
      { setting_key: 'backup_s3_access_key', setting_value: `"${TEST_CONFIG.accessKeyId}"` },
      { setting_key: 'backup_s3_secret_key', setting_value: `"${TEST_CONFIG.secretAccessKey}"` },
      { setting_key: 'backup_s3_force_path_style', setting_value: 'true' },
      { setting_key: 'backup_s3_ssl_enabled', setting_value: 'false' },
      { setting_key: 'backup_include_archived', setting_value: 'true' },
      { setting_key: 'backup_incremental', setting_value: 'true' },
      { setting_key: 'backup_max_file_size_mb', setting_value: '100' }
    ];

    // Schema drift: app_settings has no created_at column anymore and the
    // unique constraint is on setting_key alone, not (setting_type, key).
    for (const setting of settings) {
      await db('app_settings')
        .insert({
          setting_type: 'backup',
          ...setting,
          updated_at: new Date(),
        })
        .onConflict('setting_key')
        .merge();
    }
  }

  async function listS3Objects() {
    const response = await s3Client.send(new ListObjectsV2Command({
      Bucket: TEST_CONFIG.bucket
    }));
    return response.Contents || [];
  }

  async function cleanupS3Bucket() {
    try {
      const objects = await listS3Objects();
      if (objects.length > 0) {
        await s3Client.send(new DeleteObjectsCommand({
          Bucket: TEST_CONFIG.bucket,
          Delete: {
            Objects: objects.map(obj => ({ Key: obj.Key }))
          }
        }));
      }
    } catch (error) {
      console.error('Failed to cleanup S3 objects:', error);
    }
  }
});
