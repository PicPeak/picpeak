/**
 * Smoke tests for backupService's config resolution + file-collection
 * and manifest validation paths — safety net ahead of the god-file
 * decomposition.
 *
 * Uses the same real-SQLite harness as
 * backupService.configurableWalker.test.js (bootCrmDb + a temp
 * STORAGE_PATH) rather than the broken deep-mock approach in
 * backupService.enhanced.test.js.
 */

const fs = require('fs');
const path = require('path');

const { bootCrmDb } = require('./helpers/crmDb');

jest.setTimeout(30000);

describe('backupService — config + file collection + manifest (smoke)', () => {
  let db;
  let cleanup;
  let storagePath;
  let backupService;
  let backupManifest;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    storagePath = process.env.STORAGE_PATH;
    backupService = require('../../src/services/backupService');
    backupManifest = require('../../src/services/backupManifest');
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  beforeEach(async () => {
    await db('app_settings').del();
    // Reset the storage tree so each test starts from a pristine walk.
    await fs.promises.rm(storagePath, { recursive: true, force: true });
    await fs.promises.mkdir(storagePath, { recursive: true });
  });

  function seedFile(relPath, content = 'dummy bytes') {
    const abs = path.join(storagePath, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  }

  async function insertBackupSetting(key, value) {
    await db('app_settings').insert({
      setting_key: key,
      setting_value: value,
      setting_type: 'backup',
    });
  }

  describe('getBackupConfig', () => {
    it('parses booleans, numbers, JSON arrays and plain strings from app_settings', async () => {
      await insertBackupSetting('backup_enabled', 'true');
      await insertBackupSetting('backup_include_archived', 'false');
      await insertBackupSetting('backup_retention_days', '30');
      await insertBackupSetting('backup_destination_path', '/backups/picpeak');
      await insertBackupSetting('backup_email_recipients', '["a@example.com","b@example.com"]');
      // Non-backup settings must not leak into the backup config.
      await db('app_settings').insert({
        setting_key: 'general_site_name',
        setting_value: 'PicPeak',
        setting_type: 'general',
      });

      const config = await backupService.getBackupConfig();

      expect(config.backup_enabled).toBe(true);
      expect(config.backup_include_archived).toBe(false);
      expect(config.backup_retention_days).toBe(30);
      expect(config.backup_destination_path).toBe('/backups/picpeak');
      expect(config.backup_email_recipients).toEqual(['a@example.com', 'b@example.com']);
      expect(config).not.toHaveProperty('general_site_name');
      // Raw (unparsed) values are preserved on the non-enumerable __raw.
      expect(String(config.__raw.backup_retention_days)).toBe('30');
    });

    it('returns an empty config object (not null) when nothing is configured', async () => {
      const config = await backupService.getBackupConfig();
      expect(config).not.toBeNull();
      expect(Object.keys(config)).toHaveLength(0);
    });
  });

  describe('getFilesToBackup', () => {
    it('returns an empty list on a pristine storage tree', async () => {
      const files = await backupService.getFilesToBackup({ backup_include_archived: true });
      expect(files).toEqual([]);
    });

    it('captures path/relativePath/size/modified metadata for backed-up files', async () => {
      const content = 'not really a jpeg';
      const abs = seedFile('events/active/E9/pic.jpg', content);

      const files = await backupService.getFilesToBackup({ backup_include_archived: true });
      const entry = files.find((f) => f.relativePath === path.join('events/active/E9', 'pic.jpg'));

      expect(entry).toBeDefined();
      expect(entry.path).toBe(abs);
      expect(entry.size).toBe(Buffer.byteLength(content));
      // Not toBeInstanceOf(Date) — fs.stat mtime comes from a different
      // realm under Jest and fails the cross-realm instanceof check.
      expect(Object.prototype.toString.call(entry.modified)).toBe('[object Date]');
    });
  });

  describe('validateBackupManifest', () => {
    it('round-trips a generated manifest as valid', async () => {
      seedFile('events/active/E1/a.jpg', 'aaa');
      const files = await backupService.getFilesToBackup({ backup_include_archived: true });

      const manifest = await backupManifest.generateManifest({
        backupType: 'full',
        backupPath: '/backup/run-1',
        files,
      });
      const manifestPath = path.join(storagePath, 'manifest-smoke.json');
      await backupManifest.saveManifest(manifest, manifestPath, 'json');

      const result = await backupService.validateBackupManifest(manifestPath);
      expect(result.valid).toBe(true);
      expect(result.manifest.backup.type).toBe('full');
      expect(result.manifest.files.count).toBe(files.length);
      expect(result.manifest.verification.total_checksum).toBeTruthy();
    });

    it('flags a manifest missing required sections as invalid', async () => {
      const badPath = path.join(storagePath, 'manifest-broken.json');
      fs.writeFileSync(badPath, JSON.stringify({ manifest: { version: '2.0' } }));

      const result = await backupService.validateBackupManifest(badPath);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/Missing required section/);
    });
  });
});
