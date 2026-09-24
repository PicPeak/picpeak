const { db } = require('../../database/db');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// Mock dependencies
jest.mock('../../database/db');
jest.mock('../../utils/logger');
jest.mock('../emailProcessor');
jest.mock('child_process');
jest.mock('node-cron', () => ({ schedule: jest.fn(() => ({ stop: jest.fn() })) }));

const { DatabaseBackupService, startScheduledBackups, databaseBackupService, isUnderPubliclyServableRoot } = require('../databaseBackup');
const logger = require('../../utils/logger');
const cron = require('node-cron');

describe('DatabaseBackupService', () => {
  let service;

  beforeEach(() => {
    service = new DatabaseBackupService();
    
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
      
      // SQLite has no row-to-text cast, so the query builds its length sum from
      // the column list — the service asks the query builder for it per table.
      db.mockReturnValue({
        columnInfo: jest.fn().mockResolvedValue({ id: {}, name: {} })
      });

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

  describe('backup() destination path resolution (#1365)', () => {
    // getBackupConfig() returns database_backup_*-prefixed keys.
    // Regression: backup() used to destructure the unprefixed names
    // (`destinationPath`, ...) straight off that object, which never
    // matched, so the configured path was silently ignored and every
    // run tried to create the hardcoded /backup/database default.
    it('creates the directory from database_backup_destination_path when configured', async () => {
      db.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue([
          { setting_key: 'database_backup_destination_path', setting_value: JSON.stringify('/data/db-backups') }
        ])
      });

      const stop = new Error('stop after mkdir — nothing past it matters for this test');
      const mkdirSpy = jest.spyOn(fs, 'mkdir').mockRejectedValue(stop);
      const accessSpy = jest.spyOn(fs, 'access');

      await expect(service.backup({})).rejects.toThrow(stop.message);

      expect(mkdirSpy).toHaveBeenCalledWith('/data/db-backups', { recursive: true });
      // A customised path is used as is; /backup is never probed.
      expect(accessSpy).not.toHaveBeenCalled();
      mkdirSpy.mockRestore();
      accessSpy.mockRestore();
    });
  });

  // Issue 1365: every install without a /backup mount (docker-compose.production.yml
  // mounts none) failed with "EACCES: permission denied, mkdir '/backup'",
  // whatever backup destination was configured, because the seeded
  // database_backup_destination_path is /backup/database and the inline dump
  // before each file backup used it.
  describe('backup destination when the database path is not customised (issue 1365)', () => {
    const originalStoragePath = process.env.STORAGE_PATH;
    const enoent = () => Object.assign(new Error('no such directory'), { code: 'ENOENT' });

    const mockSettings = ({ databasePath, fileBackupDestination, fileBackupType }) => {
      const rows = [];
      if (databasePath !== undefined) {
        rows.push({ setting_key: 'database_backup_destination_path', setting_value: JSON.stringify(databasePath) });
      }
      if (fileBackupDestination !== undefined) {
        rows.push({ setting_key: 'backup_destination_path', setting_value: JSON.stringify(fileBackupDestination) });
      }
      if (fileBackupType !== undefined) {
        rows.push({ setting_key: 'backup_destination_type', setting_value: JSON.stringify(fileBackupType) });
      }
      db.mockImplementation(() => {
        let keys = null;
        const query = {
          where: jest.fn().mockReturnThis(),
          whereIn: jest.fn((column, values) => { keys = values; return query; }),
          // getBackupConfig reads the database_backup settings; the file-backup
          // lookup asks for its keys with whereIn.
          select: jest.fn(() => Promise.resolve(keys
            ? rows.filter((row) => keys.includes(row.setting_key))
            : rows.filter((row) => row.setting_key.startsWith('database_')))),
        };
        return query;
      });
    };

    // Everything under /srv is writable; /backup, / and the rest are not.
    const srvWritable = () => jest.spyOn(fs, 'access').mockImplementation(async (dir) => {
      if (dir === '/srv' || String(dir).startsWith('/srv/')) return undefined;
      throw dir === '/' ? Object.assign(new Error('read-only'), { code: 'EACCES' }) : enoent();
    });

    const mkdirTarget = async () => {
      const stop = new Error('stop after mkdir');
      const mkdirSpy = jest.spyOn(fs, 'mkdir').mockRejectedValue(stop);
      await expect(service.backup({})).rejects.toThrow(stop.message);
      const [target] = mkdirSpy.mock.calls[0];
      mkdirSpy.mockRestore();
      return target;
    };

    afterEach(() => {
      jest.restoreAllMocks();
      if (originalStoragePath === undefined) delete process.env.STORAGE_PATH;
      else process.env.STORAGE_PATH = originalStoragePath;
    });

    it('keeps the seeded /backup/database where that location is writable', async () => {
      mockSettings({ databasePath: '/backup/database', fileBackupDestination: '/srv/picpeak-backups' });
      jest.spyOn(fs, 'access').mockResolvedValue(undefined);

      expect(await mkdirTarget()).toBe('/backup/database');
    });

    it('writes under the file-backup destination when /backup is not mounted', async () => {
      mockSettings({ databasePath: '/backup/database', fileBackupDestination: '/srv/picpeak-backups' });
      srvWritable();

      expect(await mkdirTarget()).toBe(path.join('/srv/picpeak-backups', 'database'));
    });

    it('treats an unset database path like the seeded default', async () => {
      mockSettings({ fileBackupDestination: '/srv/picpeak-backups' });
      srvWritable();

      expect(await mkdirTarget()).toBe(path.join('/srv/picpeak-backups', 'database'));
    });

    it('falls back to <storage>/backups/database when no backup destination is set either', async () => {
      process.env.STORAGE_PATH = '/tmp/picpeak-1365-storage';
      mockSettings({ databasePath: '/backup/database' });
      jest.spyOn(fs, 'access').mockRejectedValue(enoent());

      expect(await mkdirTarget()).toBe(path.join('/tmp/picpeak-1365-storage', 'backups', 'database'));
    });

    // Issue 1641: with S3 selected, backup_destination_path is a leftover
    // nothing mounts — often the historical /backup/picpeak — and the dump
    // failed with "Cannot create the database backup directory
    // /backup/picpeak/database: EACCES" before S3 was ever contacted.
    it('stages under <storage>/backups/database for an S3 backup whose local path is stale', async () => {
      process.env.STORAGE_PATH = '/srv/picpeak-storage';
      mockSettings({ databasePath: '/backup/database', fileBackupDestination: '/backup/picpeak', fileBackupType: 's3' });
      srvWritable();

      expect(await mkdirTarget()).toBe(path.join('/srv/picpeak-storage', 'backups', 'database'));
    });

    it('does not use a writable local path either while S3 is selected', async () => {
      process.env.STORAGE_PATH = '/srv/picpeak-storage';
      mockSettings({ databasePath: '/backup/database', fileBackupDestination: '/srv/old-local-backups', fileBackupType: 's3' });
      srvWritable();

      expect(await mkdirTarget()).toBe(path.join('/srv/picpeak-storage', 'backups', 'database'));
    });

    it('falls back to storage when the local file-backup destination is not writable', async () => {
      process.env.STORAGE_PATH = '/srv/picpeak-storage';
      mockSettings({ databasePath: '/backup/database', fileBackupDestination: '/backup/picpeak', fileBackupType: 'local' });
      srvWritable();

      expect(await mkdirTarget()).toBe(path.join('/srv/picpeak-storage', 'backups', 'database'));
    });

    it('names the directory and the setting when it cannot be created, and logs it', async () => {
      mockSettings({ databasePath: '/backup/database', fileBackupDestination: '/srv/picpeak-backups' });
      srvWritable();
      jest.spyOn(fs, 'mkdir').mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
      const target = path.join('/srv/picpeak-backups', 'database');

      await expect(service.backup({})).rejects.toThrow(
        `Cannot create the database backup directory ${target}: EACCES`
      );
      await expect(service.backup({})).rejects.toThrow(/database_backup_destination_path/);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining(`Cannot create the database backup directory ${target}`),
        expect.anything()
      );
    });
  });

  describe('isUnderPubliclyServableRoot (GHSA-jw8m class, #1365)', () => {
    const originalStoragePath = process.env.STORAGE_PATH;
    const storage = '/tmp/picpeak-test-storage';

    beforeEach(() => {
      process.env.STORAGE_PATH = storage;
    });

    afterAll(() => {
      if (originalStoragePath === undefined) {
        delete process.env.STORAGE_PATH;
      } else {
        process.env.STORAGE_PATH = originalStoragePath;
      }
    });

    it.each([
      path.join(storage, 'uploads', 'logos'),
      path.join(storage, 'uploads', 'logos', 'sub'),
      path.join(storage, 'uploads', 'favicons'),
      path.join(storage, 'fonts'),
      path.join(storage, 'fonts', 'inter'),
      // Bundled fallback fonts — nodejs-owned per the Dockerfile's
      // COPY --chown, and served at the same public /fonts route.
      path.resolve(__dirname, '../../../assets/fonts'),
      // Case-insensitive-but-preserving filesystems (APFS, NTFS, Docker
      // Desktop bind mounts of either) resolve this to the same directory
      // as uploads/logos even though path.resolve() never folds case.
      path.join(storage, 'UPLOADS', 'Logos')
    ])('flags %s as publicly servable', (candidate) => {
      expect(isUnderPubliclyServableRoot(candidate)).toBe(true);
    });

    it.each([
      path.join(storage, 'backups'),
      path.join(storage, 'uploads', 'contracts', 'signed'),
      path.join(storage, 'uploads', 'transfers', '123'),
      '/data/db-backups'
    ])('does not flag %s', (candidate) => {
      expect(isUnderPubliclyServableRoot(candidate)).toBe(false);
    });

    it('backup() refuses a destination inside a publicly servable root without ever calling mkdir', async () => {
      const publicPath = path.join(storage, 'uploads', 'logos');
      db.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue([
          { setting_key: 'database_backup_destination_path', setting_value: JSON.stringify(publicPath) }
        ])
      });

      const mkdirSpy = jest.spyOn(fs, 'mkdir');

      await expect(service.backup({})).rejects.toThrow('publicly served directory');

      expect(mkdirSpy).not.toHaveBeenCalled();
      mkdirSpy.mockRestore();
    });

    it('flags FRONTEND_DIR — the all-in-one image serves its built SPA unauthenticated', () => {
      const originalFrontendDir = process.env.FRONTEND_DIR;
      process.env.FRONTEND_DIR = '/app/frontend/dist';
      try {
        expect(isUnderPubliclyServableRoot('/app/frontend/dist')).toBe(true);
        expect(isUnderPubliclyServableRoot(path.join('/app/frontend/dist', 'assets'))).toBe(true);
      } finally {
        if (originalFrontendDir === undefined) delete process.env.FRONTEND_DIR;
        else process.env.FRONTEND_DIR = originalFrontendDir;
      }
    });

    it('resolves a symlinked alias of a public root to the same real directory (all-in-one /app/storage -> /data/storage)', async () => {
      const os = require('os');
      const realRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-real-'));
      const linkRoot = path.join(os.tmpdir(), `picpeak-link-${process.pid}-${Date.now()}`);
      await fs.mkdir(path.join(realRoot, 'uploads', 'logos'), { recursive: true });
      await fs.symlink(realRoot, linkRoot, 'dir');

      try {
        // STORAGE_PATH (what the guard's roots are built from) is the real
        // path; the attacker-supplied destination goes through the symlink
        // — exactly the all-in-one image's /app/storage -> /data/storage.
        process.env.STORAGE_PATH = realRoot;
        const aliased = path.join(linkRoot, 'uploads', 'logos');

        expect(isUnderPubliclyServableRoot(aliased)).toBe(true);
      } finally {
        await fs.unlink(linkRoot);
        await fs.rm(realRoot, { recursive: true, force: true });
      }
    });
  });

  describe('startScheduledBackups (#1365)', () => {
    // Same key-mismatch bug as backup(): getBackupConfig() returns
    // database_backup_*-prefixed keys, but this read `config.enabled` /
    // `config.schedule` / `config.retentionDays` — always undefined, so
    // the scheduler silently treated every install as disabled.
    it('does not start the schedule while database_backup_enabled is false', async () => {
      db.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue([
          { setting_key: 'database_backup_enabled', setting_value: 'false' }
        ])
      });

      await startScheduledBackups();

      expect(cron.schedule).not.toHaveBeenCalled();
    });

    it('starts the schedule with the configured cron when database_backup_enabled is true', async () => {
      db.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue([
          { setting_key: 'database_backup_enabled', setting_value: 'true' },
          { setting_key: 'database_backup_schedule', setting_value: JSON.stringify('0 4 * * *') }
        ])
      });

      await startScheduledBackups();

      expect(cron.schedule).toHaveBeenCalledWith('0 4 * * *', expect.any(Function));
    });

    it('re-reads retention on every tick instead of the value captured at schedule start (#1365)', async () => {
      db.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue([
          { setting_key: 'database_backup_enabled', setting_value: 'true' },
          { setting_key: 'database_backup_retention_days', setting_value: JSON.stringify(30) }
        ])
      });

      await startScheduledBackups();
      const tick = cron.schedule.mock.calls[0][1];

      // A /config update between schedule-start and this tick raised
      // retention to 365 — the closed-over 30 must not be what runs.
      db.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue([
          { setting_key: 'database_backup_enabled', setting_value: 'true' },
          { setting_key: 'database_backup_retention_days', setting_value: JSON.stringify(365) }
        ])
      });
      jest.spyOn(databaseBackupService, 'backup').mockResolvedValue({ success: true });
      const cleanupSpy = jest.spyOn(databaseBackupService, 'cleanupOldBackups').mockResolvedValue(undefined);

      await tick();

      expect(cleanupSpy).toHaveBeenCalledWith(365);

      jest.restoreAllMocks();
    });
  });

  describe('cleanupOldBackups destructive-retention guard (#1365)', () => {
    it.each([-1, 0, NaN, Infinity])('refuses retentionDays=%s without touching the database', async (bad) => {
      const dbSpy = jest.fn();
      db.mockImplementation(dbSpy);

      await service.cleanupOldBackups(bad);

      expect(dbSpy).not.toHaveBeenCalled();
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