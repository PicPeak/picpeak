const { DatabaseBackupService } = require('../databaseBackup');
const { db } = require('../../database/db');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// Mock dependencies
jest.mock('../../database/db');
jest.mock('../../utils/logger');
jest.mock('../emailProcessor');
jest.mock('child_process');

describe('DatabaseBackupService', () => {
  let service;
  let mockExecAsync;

  beforeEach(() => {
    service = new DatabaseBackupService();
    mockExecAsync = jest.fn();
    
    // Reset mocks
    jest.clearAllMocks();
    
    // Mock execAsync
    const childProcess = require('child_process');
    childProcess.exec = jest.fn((cmd, opts, callback) => {
      if (callback) {
        callback(null, { stdout: 'ok', stderr: '' });
      }
    });
  });

  afterEach(async () => {
    // Cleanup test files
    try {
      await fs.rmdir('/tmp/test-backup', { recursive: true });
    } catch (e) {
      // Ignore
    }
  });

  describe('calculateChecksum', () => {
    it('should calculate SHA256 checksum of a file', async () => {
      const testFile = '/tmp/test-checksum.txt';
      const testContent = 'Hello, World!';
      await fs.writeFile(testFile, testContent);

      const checksum = await service.calculateChecksum(testFile);
      
      // Expected checksum for "Hello, World!"
      const expectedChecksum = crypto
        .createHash('sha256')
        .update(testContent)
        .digest('hex');
      
      expect(checksum).toBe(expectedChecksum);
      
      await fs.unlink(testFile);
    });
  });

  describe('getTableChecksums', () => {
    it('should get checksums for all tables', async () => {
      // Mock getTables
      service.getTables = jest.fn().mockResolvedValue(['events', 'photos']);
      
      // Mock SQLite response
      db.raw = jest.fn()
        .mockResolvedValueOnce([{ row_count: 10, data_sum: 1000 }])
        .mockResolvedValueOnce([{ row_count: 20, data_sum: 2000 }]);
      
      const checksums = await service.getTableChecksums();
      
      expect(checksums).toHaveProperty('events');
      expect(checksums).toHaveProperty('photos');
      expect(checksums.events.rowCount).toBe(10);
      expect(checksums.photos.rowCount).toBe(20);
      expect(checksums.events.checksum).toBeDefined();
      expect(checksums.photos.checksum).toBeDefined();
    });
  });

  describe('getTables', () => {
    it('should get list of tables for SQLite', async () => {
      service.dbType = 'sqlite';
      
      db.raw = jest.fn().mockResolvedValue([
        { name: 'events' },
        { name: 'photos' },
        { name: 'admin_users' }
      ]);
      
      const tables = await service.getTables();
      
      expect(tables).toEqual(['events', 'photos', 'admin_users']);
      expect(db.raw).toHaveBeenCalledWith(expect.stringContaining('sqlite_master'));
    });

    it('should get list of tables for PostgreSQL', async () => {
      service.dbType = 'postgresql';
      
      db.raw = jest.fn().mockResolvedValue({
        rows: [
          { table_name: 'events' },
          { table_name: 'photos' },
          { table_name: 'admin_users' }
        ]
      });
      
      const tables = await service.getTables();
      
      expect(tables).toEqual(['events', 'photos', 'admin_users']);
      expect(db.raw).toHaveBeenCalledWith(expect.stringContaining('information_schema.tables'));
    });
  });

  describe('getDatabaseSize', () => {
    it('should get database size for SQLite', async () => {
      service.dbType = 'sqlite';
      const mockSize = 1024 * 1024 * 10; // 10MB
      
      // Mock fs.stat
      const originalStat = fs.stat;
      fs.stat = jest.fn().mockResolvedValue({ size: mockSize });
      
      const size = await service.getDatabaseSize();
      
      expect(size).toBe(mockSize);
      
      fs.stat = originalStat;
    });

    it('should get database size for PostgreSQL', async () => {
      service.dbType = 'postgresql';
      const mockSize = 1024 * 1024 * 100; // 100MB
      
      db.raw = jest.fn().mockResolvedValue({
        rows: [{ size: mockSize.toString() }]
      });
      
      const size = await service.getDatabaseSize();
      
      expect(size).toBe(mockSize);
      expect(db.raw).toHaveBeenCalledWith(expect.stringContaining('pg_database_size'));
    });
  });

  describe('compressFile', () => {
    it('should compress file and return stats', async () => {
      const testFile = '/tmp/test-compress.txt';
      const compressedFile = '/tmp/test-compress.txt.gz';
      
      // Create test file with repetitive content (compresses well)
      const testContent = 'Hello, World! '.repeat(1000);
      await fs.writeFile(testFile, testContent);
      
      const stats = await service.compressFile(testFile, compressedFile);
      
      expect(stats.originalSize).toBeGreaterThan(0);
      expect(stats.compressedSize).toBeGreaterThan(0);
      expect(stats.compressedSize).toBeLessThan(stats.originalSize);
      expect(parseFloat(stats.compressionRatio)).toBeGreaterThan(0);
      
      // Cleanup
      await fs.unlink(testFile);
      await fs.unlink(compressedFile);
    });
  });

  describe('backup configuration', () => {
    it('should get backup configuration from database', async () => {
      const mockConfig = [
        { setting_key: 'database_backup_enabled', setting_value: 'true' },
        { setting_key: 'database_backup_compress', setting_value: 'true' },
        { setting_key: 'database_backup_retention_days', setting_value: '30' }
      ];
      
      db.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue(mockConfig)
      });
      
      const config = await service.getBackupConfig();
      
      expect(config.database_backup_enabled).toBe(true);
      expect(config.database_backup_compress).toBe(true);
      expect(config.database_backup_retention_days).toBe(30);
    });
  });

  describe('cleanupOldBackups', () => {
    it('should delete old backup files and records', async () => {
      const oldBackups = [
        { id: 1, file_path: '/backup/old1.sql.gz' },
        { id: 2, file_path: '/backup/old2.sql.gz' }
      ];
      
      db.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue(oldBackups),
        delete: jest.fn().mockResolvedValue(1)
      });
      
      // Stub fs.promises.unlink via jest.spyOn so the original is
      // restored when the test finishes. The previous form
      // (`fs.unlink = jest.fn()`) leaked into every test that ran
      // after this one in the same jest worker — most visibly
      // integration/storageBackend.test.js, whose LocalFsStorage
      // delete() became a silent no-op and the subsequent
      // exists() assertion flipped from false to true. spyOn +
      // mockRestore in afterEach keeps the stub scoped to this test.
      const unlinkSpy = jest.spyOn(fs, 'unlink').mockResolvedValue(undefined);

      await service.cleanupOldBackups(30);

      expect(unlinkSpy).toHaveBeenCalledTimes(2);
      expect(unlinkSpy).toHaveBeenCalledWith('/backup/old1.sql.gz');
      expect(unlinkSpy).toHaveBeenCalledWith('/backup/old2.sql.gz');
      unlinkSpy.mockRestore();
    });
  });

  describe('progress tracking', () => {
    it('should update and retrieve progress', () => {
      expect(service.getProgress()).toBeNull();
      
      service.updateProgress('Testing...', { step: 1 });
      
      const progress = service.getProgress();
      expect(progress.message).toBe('Testing...');
      expect(progress.details.step).toBe(1);
      expect(progress.timestamp).toBeDefined();
    });
  });

  describe('backup history', () => {
    it('should retrieve backup history', async () => {
      const mockHistory = [
        {
          id: 1,
          started_at: new Date(),
          completed_at: new Date(),
          status: 'completed',
          file_size_bytes: 1024000
        }
      ];
      
      db.mockReturnValue({
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue(mockHistory)
      });
      
      const history = await service.getBackupHistory(10);
      
      expect(history).toEqual(mockHistory);
      expect(history.length).toBe(1);
    });
  });
});