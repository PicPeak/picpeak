const { describe, it, expect, beforeEach, afterEach } = require('@jest/globals');
const mockFs = require('mock-fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

// Mock dependencies before requiring the module
jest.mock('../../src/database/db');
jest.mock('../../src/utils/logger');
jest.mock('../../src/services/emailProcessor');
jest.mock('node-cron');
jest.mock('../../src/services/backupManifest');
jest.mock('../../src/services/storage/s3Storage');

const backupService = require('../../src/services/backupService');
const { db } = require('../../src/database/db');
const logger = require('../../src/utils/logger');
const { queueEmail } = require('../../src/services/emailProcessor');
const cron = require('node-cron');
const backupManifest = require('../../src/services/backupManifest');
const S3StorageAdapter = require('../../src/services/storage/s3Storage');

describe('Enhanced Backup Service Tests', () => {
  let mockDb;
  let mockS3Client;
  let mockCronJob;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();
    
    // Mock database
    mockDb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      first: jest.fn(),
      insert: jest.fn(),
      update: jest.fn(),
      delete: jest.fn()
    };
    db.mockReturnValue(mockDb);
    
    // Mock cron job
    mockCronJob = {
      stop: jest.fn()
    };
    cron.schedule.mockReturnValue(mockCronJob);
    
    // Mock S3 client
    mockS3Client = {
      testConnection: jest.fn().mockResolvedValue(true),
      upload: jest.fn().mockResolvedValue({ Location: 's3://bucket/key' }),
      uploadStream: jest.fn().mockResolvedValue({ Location: 's3://bucket/key' }),
      download: jest.fn().mockResolvedValue(),
      exists: jest.fn().mockResolvedValue(false),
      delete: jest.fn().mockResolvedValue(),
      list: jest.fn().mockResolvedValue({ Contents: [] })
    };
    S3StorageAdapter.mockImplementation(() => mockS3Client);
    
    // Mock backup manifest
    backupManifest.generateManifest = jest.fn().mockResolvedValue({
      backup: { id: 'test-backup-123' },
      version: '2.0'
    });
    backupManifest.saveManifest = jest.fn().mockResolvedValue('/path/to/manifest.json');
    backupManifest.loadManifest = jest.fn().mockResolvedValue({});
    backupManifest.validateManifest = jest.fn();
    backupManifest.generateSummaryReport = jest.fn().mockReturnValue('Summary report');
    
    // Mock logger
    logger.info = jest.fn();
    logger.error = jest.fn();
    logger.warn = jest.fn();
    logger.debug = jest.fn();
  });

  afterEach(() => {
    mockFs.restore();
  });

  describe('getBackupConfig', () => {
    it('should retrieve and parse backup configuration from database', async () => {
      const mockSettings = [
        { setting_key: 'backup_enabled', setting_value: 'true' },
        { setting_key: 'backup_destination_type', setting_value: '"s3"' },
        { setting_key: 'backup_s3_bucket', setting_value: '"test-bucket"' },
        { setting_key: 'backup_retention_days', setting_value: '30' }
      ];
      
      mockDb.select.mockResolvedValue(mockSettings);
      
      const config = await backupService.getBackupConfig();
      
      expect(config).toEqual({
        backup_enabled: true,
        backup_destination_type: 's3',
        backup_s3_bucket: 'test-bucket',
        backup_retention_days: 30
      });
      
      expect(db).toHaveBeenCalledWith('app_settings');
      expect(mockDb.where).toHaveBeenCalledWith('setting_type', 'backup');
    });

    it('should handle JSON parse errors gracefully', async () => {
      const mockSettings = [
        { setting_key: 'backup_enabled', setting_value: 'invalid-json' }
      ];
      
      mockDb.select.mockResolvedValue(mockSettings);
      
      const config = await backupService.getBackupConfig();
      
      expect(config).toEqual({
        backup_enabled: 'invalid-json'
      });
    });

    it('should return null on database error', async () => {
      mockDb.select.mockRejectedValue(new Error('Database error'));
      
      const config = await backupService.getBackupConfig();
      
      expect(config).toBeNull();
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('S3 Backup Functionality', () => {
    beforeEach(() => {
      // Mock file system
      mockFs({
        '/storage/events/active/event1': {
          'photo1.jpg': Buffer.from('photo1 content'),
          'photo2.jpg': Buffer.from('photo2 content')
        },
        '/storage/events/archived/event2.zip': Buffer.from('archived content'),
        '/storage/thumbnails': {
          'thumb1.jpg': Buffer.from('thumb1 content')
        },
        '/storage/uploads': {
          'logo.png': Buffer.from('logo content')
        }
      });
      
      process.env.STORAGE_PATH = '/storage';
    });

    it('should perform S3 backup with correct configuration', async () => {
      const config = {
        backup_enabled: true,
        backup_destination_type: 's3',
        backup_s3_bucket: 'test-bucket',
        backup_s3_region: 'us-east-1',
        backup_s3_endpoint: 'https://s3.amazonaws.com',
        backup_s3_access_key: 'test-key',
        backup_s3_secret_key: 'test-secret',
        backup_include_archived: true,
        backup_max_file_size_mb: 100
      };
      
      mockDb.select.mockResolvedValue([]);
      mockDb.where.mockReturnThis();
      mockDb.first.mockResolvedValue(null);
      mockDb.insert.mockResolvedValue([1]);
      
      jest.spyOn(backupService, 'getBackupConfig').mockResolvedValue(config);
      jest.spyOn(backupService, 'getDatabaseBackupInfo').mockResolvedValue({
        type: 'sqlite',
        backupFile: null,
        hasChanged: true
      });
      
      await backupService.runBackup();
      
      expect(S3StorageAdapter).toHaveBeenCalledWith({
        bucket: 'test-bucket',
        region: 'us-east-1',
        endpoint: 'https://s3.amazonaws.com',
        accessKeyId: 'test-key',
        secretAccessKey: 'test-secret',
        forcePathStyle: false,
        sslEnabled: true,
        maxRetries: 3,
        retryDelay: 1000
      });
      
      expect(mockS3Client.testConnection).toHaveBeenCalled();
      expect(mockS3Client.upload).toHaveBeenCalled();
    });

    it('should handle S3 upload failures gracefully', async () => {
      const config = {
        backup_enabled: true,
        backup_destination_type: 's3',
        backup_s3_bucket: 'test-bucket',
        backup_s3_access_key: 'test-key',
        backup_s3_secret_key: 'test-secret'
      };
      
      mockDb.select.mockResolvedValue([]);
      mockDb.insert.mockResolvedValue([1]);
      mockDb.first.mockResolvedValue(null);
      
      jest.spyOn(backupService, 'getBackupConfig').mockResolvedValue(config);
      
      mockS3Client.testConnection.mockRejectedValue(new Error('Connection failed'));
      
      await backupService.runBackup();
      
      expect(logger.error).toHaveBeenCalledWith('S3 backup failed:', expect.any(Error));
      expect(mockDb.update).toHaveBeenCalledWith(expect.objectContaining({
        status: 'failed',
        error_message: expect.stringContaining('Connection failed')
      }));
    });

    it('should skip unchanged files in incremental backup', async () => {
      const config = {
        backup_enabled: true,
        backup_destination_type: 's3',
        backup_s3_bucket: 'test-bucket',
        backup_s3_access_key: 'test-key',
        backup_s3_secret_key: 'test-secret',
        backup_incremental: true
      };
      
      // Mock existing file state
      mockDb.first.mockImplementation((query) => {
        if (query === undefined) {
          return Promise.resolve({
            file_path: 'events/active/event1/photo1.jpg',
            checksum: crypto.createHash('sha256').update('photo1 content').digest('hex')
          });
        }
        return Promise.resolve(null);
      });
      
      mockDb.select.mockResolvedValue([]);
      mockDb.insert.mockResolvedValue([1]);
      
      jest.spyOn(backupService, 'getBackupConfig').mockResolvedValue(config);
      
      await backupService.runBackup();
      
      // Should skip unchanged file
      const uploadCalls = mockS3Client.upload.mock.calls;
      const photo1Uploaded = uploadCalls.some(call => 
        call[1].includes('photo1.jpg')
      );
      expect(photo1Uploaded).toBe(false);
    });

    it('should include database backup when configured', async () => {
      const config = {
        backup_enabled: true,
        backup_destination_type: 's3',
        backup_s3_bucket: 'test-bucket',
        backup_s3_access_key: 'test-key',
        backup_s3_secret_key: 'test-secret',
        backup_include_database: true
      };
      
      mockDb.select.mockResolvedValue([]);
      mockDb.insert.mockResolvedValue([1]);
      
      jest.spyOn(backupService, 'getBackupConfig').mockResolvedValue(config);
      jest.spyOn(backupService, 'getDatabaseBackupInfo').mockResolvedValue({
        type: 'sqlite',
        backupFile: '/backup/db-backup.sql',
        size: 1024000,
        checksum: 'abc123',
        hasChanged: false
      });
      
      // Mock database backup file
      mockFs({
        '/storage/events/active': {},
        '/backup/db-backup.sql': Buffer.from('database backup content')
      });
      
      await backupService.runBackup();
      
      // Verify database backup was uploaded
      const uploadCalls = mockS3Client.upload.mock.calls;
      const dbBackupUploaded = uploadCalls.some(call => 
        call[1].includes('database/db-backup.sql')
      );
      expect(dbBackupUploaded).toBe(true);
    });

    it('should validate required S3 configuration', async () => {
      const config = {
        backup_enabled: true,
        backup_destination_type: 's3',
        backup_s3_bucket: 'test-bucket'
        // Missing access key and secret key
      };
      
      mockDb.select.mockResolvedValue([]);
      mockDb.insert.mockResolvedValue([1]);
      
      jest.spyOn(backupService, 'getBackupConfig').mockResolvedValue(config);
      
      await backupService.runBackup();
      
      expect(logger.error).toHaveBeenCalledWith(
        'S3 backup failed:',
        expect.objectContaining({
          message: expect.stringContaining('S3 backup configuration incomplete')
        })
      );
    });
  });

  describe('Manifest Generation', () => {
    it('should generate and save manifest for successful backup', async () => {
      const config = {
        backup_enabled: true,
        backup_destination_type: 'local',
        backup_destination_path: '/backup',
        backup_manifest_format: 'json'
      };
      
      mockDb.select.mockResolvedValue([]);
      mockDb.insert.mockResolvedValue([1]);
      mockDb.first.mockResolvedValue(null);
      
      jest.spyOn(backupService, 'getBackupConfig').mockResolvedValue(config);
      
      mockFs({
        '/storage/events/active/event1': {
          'photo1.jpg': Buffer.from('photo1 content')
        },
        '/backup': {}
      });
      
      await backupService.runBackup();
      
      expect(backupManifest.generateManifest).toHaveBeenCalledWith(
        expect.objectContaining({
          backupType: 'full',
          backupPath: '/backup',
          format: 'json'
        })
      );
      
      expect(backupManifest.saveManifest).toHaveBeenCalled();
    });

    it('should generate incremental manifest when parent exists', async () => {
      const config = {
        backup_enabled: true,
        backup_destination_type: 'local',
        backup_destination_path: '/backup'
      };
      
      const lastBackup = {
        id: 1,
        manifest_path: '/backup/manifests/previous.json',
        manifest_id: 'previous-backup-123'
      };
      
      mockDb.select.mockResolvedValue([]);
      mockDb.insert.mockResolvedValue([2]);
      mockDb.first.mockImplementation(() => Promise.resolve(lastBackup));
      mockDb.orderBy.mockReturnThis();
      mockDb.where.mockReturnThis();
      mockDb.whereNot = jest.fn().mockReturnThis();
      
      jest.spyOn(backupService, 'getBackupConfig').mockResolvedValue(config);
      
      mockFs({
        '/storage/events/active': {},
        '/backup': {}
      });
      
      await backupService.runBackup();
      
      expect(backupManifest.loadManifest).toHaveBeenCalledWith('/backup/manifests/previous.json');
      expect(backupManifest.generateIncrementalManifest).toHaveBeenCalled();
    });

    it('should upload manifest to S3 for S3 backups', async () => {
      const config = {
        backup_enabled: true,
        backup_destination_type: 's3',
        backup_s3_bucket: 'test-bucket',
        backup_s3_access_key: 'test-key',
        backup_s3_secret_key: 'test-secret',
        backup_manifest_format: 'yaml'
      };
      
      mockDb.select.mockResolvedValue([]);
      mockDb.insert.mockResolvedValue([1]);
      mockDb.first.mockResolvedValue(null);
      
      jest.spyOn(backupService, 'getBackupConfig').mockResolvedValue(config);
      
      const manifest = {
        backup: { id: 'backup-123' },
        version: '2.0'
      };
      backupManifest.generateManifest.mockResolvedValue(manifest);
      
      mockFs({
        '/storage/events/active': {},
        '/storage/temp': {}
      });
      
      await backupService.runBackup();
      
      // Verify manifest was uploaded to S3
      const uploadCalls = mockS3Client.upload.mock.calls;
      const manifestUploaded = uploadCalls.some(call => 
        call[1].includes('manifests/backup-manifest-backup-123.yaml')
      );
      expect(manifestUploaded).toBe(true);
    });
  });

  describe('Backward Compatibility', () => {
    it('should support local backup destination', async () => {
      const config = {
        backup_enabled: true,
        backup_destination_type: 'local',
        backup_destination_path: '/backup/local'
      };
      
      mockDb.select.mockResolvedValue([]);
      mockDb.insert.mockResolvedValue([1]);
      mockDb.first.mockResolvedValue(null);
      
      jest.spyOn(backupService, 'getBackupConfig').mockResolvedValue(config);
      
      mockFs({
        '/storage/events/active/event1': {
          'photo1.jpg': Buffer.from('photo1 content')
        },
        '/backup/local': {}
      });
      
      await backupService.runBackup();
      
      // Verify files were copied to local destination
      const fs = require('fs');
      const destPath = '/backup/local/events/active/event1/photo1.jpg';
      expect(fs.existsSync(destPath)).toBe(true);
    });

    it('should support rsync backup destination', async () => {
      const config = {
        backup_enabled: true,
        backup_destination_type: 'rsync',
        backup_rsync_host: 'backup.example.com',
        backup_rsync_user: 'backup',
        backup_rsync_path: '/remote/backup'
      };
      
      mockDb.select.mockResolvedValue([]);
      mockDb.insert.mockResolvedValue([1]);
      mockDb.first.mockResolvedValue(null);
      
      jest.spyOn(backupService, 'getBackupConfig').mockResolvedValue(config);
      
      // Mock exec for rsync
      const { exec } = require('child_process');
      const mockExec = jest.fn((cmd, callback) => {
        callback(null, { stdout: 'Number of files transferred: 1\nTotal file size: 1024 bytes' });
      });
      exec.mockImplementation(mockExec);
      
      mockFs({
        '/storage/events/active': {}
      });
      
      await backupService.runBackup();
      
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('rsync'),
        expect.any(Function)
      );
    });
  });

  describe('Error Handling and Recovery', () => {
    it('should handle file read errors gracefully', async () => {
      const config = {
        backup_enabled: true,
        backup_destination_type: 's3',
        backup_s3_bucket: 'test-bucket',
        backup_s3_access_key: 'test-key',
        backup_s3_secret_key: 'test-secret'
      };
      
      mockDb.select.mockResolvedValue([]);
      mockDb.insert.mockResolvedValue([1]);
      mockDb.first.mockResolvedValue(null);
      
      jest.spyOn(backupService, 'getBackupConfig').mockResolvedValue(config);
      
      // Mock file that throws error on read
      const fs = require('fs');
      const originalCreateReadStream = fs.createReadStream;
      fs.createReadStream = jest.fn((path) => {
        if (path.includes('error.jpg')) {
          const stream = new EventEmitter();
          process.nextTick(() => stream.emit('error', new Error('File read error')));
          return stream;
        }
        return originalCreateReadStream(path);
      });
      
      mockFs({
        '/storage/events/active': {
          'error.jpg': Buffer.from('content'),
          'good.jpg': Buffer.from('content')
        }
      });
      
      await backupService.runBackup();
      
      // Should continue with other files despite error
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to backup file'),
        expect.any(Error)
      );
      
      fs.createReadStream = originalCreateReadStream;
    });

    it('should send failure email on backup error', async () => {
      const config = {
        backup_enabled: true,
        backup_destination_type: 's3',
        backup_s3_bucket: 'test-bucket',
        backup_email_on_failure: true
      };
      
      const admins = [
        { email: 'admin1@example.com', is_active: true },
        { email: 'admin2@example.com', is_active: true }
      ];
      
      mockDb.select.mockResolvedValue([]);
      mockDb.insert.mockResolvedValue([1]);
      mockDb.where.mockReturnThis();
      
      jest.spyOn(backupService, 'getBackupConfig')
        .mockResolvedValueOnce(config)
        .mockResolvedValueOnce(config);
      
      // Force an error
      jest.spyOn(backupService, 'getFilesToBackup').mockRejectedValue(new Error('Storage error'));
      
      // Mock admin users query
      db.mockImplementation((table) => {
        if (table === 'admin_users') {
          return {
            where: jest.fn().mockResolvedValue(admins)
          };
        }
        return mockDb;
      });
      
      await backupService.runBackup();
      
      expect(queueEmail).toHaveBeenCalledTimes(2);
      expect(queueEmail).toHaveBeenCalledWith(
        null,
        'admin1@example.com',
        'backup_failed',
        expect.objectContaining({
          error_message: 'Storage error'
        })
      );
    });

    it('should handle concurrent backup attempts', async () => {
      const config = {
        backup_enabled: true,
        backup_destination_type: 'local',
        backup_destination_path: '/backup'
      };
      
      jest.spyOn(backupService, 'getBackupConfig').mockResolvedValue(config);
      
      mockFs({
        '/storage/events/active': {},
        '/backup': {}
      });
      
      // Start two backups concurrently
      const backup1 = backupService.runBackup();
      const backup2 = backupService.runBackup();
      
      await Promise.all([backup1, backup2]);
      
      // Second backup should be skipped
      expect(logger.warn).toHaveBeenCalledWith('Backup already running, skipping');
    });
  });

  describe('Service Lifecycle', () => {
    it('should start backup service with cron schedule', async () => {
      const config = {
        backup_enabled: true,
        backup_schedule: '0 3 * * *' // 3 AM daily
      };
      
      mockDb.select.mockResolvedValue(
        Object.entries(config).map(([key, value]) => ({
          setting_key: key,
          setting_value: value.toString()
        }))
      );
      
      await backupService.startBackupService();
      
      expect(cron.schedule).toHaveBeenCalledWith('0 3 * * *', expect.any(Function));
      expect(logger.info).toHaveBeenCalledWith('Backup service started with schedule: 0 3 * * *');
    });

    it('should stop existing job when restarting service', async () => {
      const config = {
        backup_enabled: true,
        backup_schedule: '0 2 * * *'
      };
      
      mockDb.select.mockResolvedValue(
        Object.entries(config).map(([key, value]) => ({
          setting_key: key,
          setting_value: value.toString()
        }))
      );
      
      // Start service twice
      await backupService.startBackupService();
      await backupService.startBackupService();
      
      expect(mockCronJob.stop).toHaveBeenCalled();
    });

    it('should not start service when backup is disabled', async () => {
      const config = {
        backup_enabled: false
      };
      
      mockDb.select.mockResolvedValue([
        { setting_key: 'backup_enabled', setting_value: 'false' }
      ]);
      
      await backupService.startBackupService();
      
      expect(cron.schedule).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith('Backup service is disabled');
    });
  });

  describe('Backup Status and History', () => {
    it('should return backup status with recent runs', async () => {
      const recentRuns = [
        {
          id: 1,
          started_at: new Date(),
          completed_at: new Date(),
          status: 'completed',
          files_backed_up: 100,
          total_size_bytes: 1024000,
          manifest_path: '/backup/manifest.json'
        }
      ];
      
      mockDb.limit.mockResolvedValue(recentRuns);
      
      backupManifest.validateManifest.mockImplementation(() => true);
      
      const status = await backupService.getBackupStatus();
      
      expect(status).toEqual({
        isRunning: false,
        isHealthy: true,
        lastRun: expect.objectContaining({
          ...recentRuns[0],
          manifestValid: true
        }),
        recentRuns: recentRuns,
        nextScheduledRun: expect.any(String)
      });
    });

    it('should clean up old backup runs', async () => {
      mockDb.delete.mockResolvedValue(5);
      
      await backupService.cleanupOldBackupRuns(30);
      
      expect(mockDb.where).toHaveBeenCalledWith('started_at', '<', expect.any(Date));
      expect(mockDb.delete).toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith('Cleaned up 5 old backup runs');
    });
  });

  describe('getBackupManifest', () => {
    it('should retrieve manifest from local filesystem', async () => {
      const backupRun = {
        id: 1,
        manifest_path: '/backup/manifests/backup-123.json'
      };
      
      mockDb.first.mockResolvedValue(backupRun);
      
      const manifest = { backup: { id: 'backup-123' } };
      backupManifest.loadManifest.mockResolvedValue(manifest);
      backupManifest.generateSummaryReport.mockReturnValue('Summary');
      
      const result = await backupService.getBackupManifest(1);
      
      expect(result).toEqual({
        manifest: manifest,
        summary: 'Summary'
      });
    });

    it('should retrieve manifest from S3', async () => {
      const backupRun = {
        id: 1,
        manifest_path: 's3://test-bucket/backups/manifests/backup-123.json'
      };
      
      mockDb.first.mockResolvedValue(backupRun);
      mockDb.select.mockResolvedValue([
        { setting_key: 'backup_s3_access_key', setting_value: '"test-key"' },
        { setting_key: 'backup_s3_secret_key', setting_value: '"test-secret"' }
      ]);
      
      const manifest = { backup: { id: 'backup-123' } };
      backupManifest.loadManifest.mockResolvedValue(manifest);
      
      await backupService.getBackupManifest(1);
      
      expect(S3StorageAdapter).toHaveBeenCalled();
      expect(mockS3Client.download).toHaveBeenCalledWith(
        'backups/manifests/backup-123.json',
        expect.any(String)
      );
    });
  });
});
