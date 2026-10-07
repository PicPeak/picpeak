const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { bootCrmDb } = require('./helpers/crmDb');

const mockObjects = new Map();
const mockUpload = jest.fn(async (file, key) => {
  mockObjects.set(key, await fs.readFile(file));
});
jest.mock('../../src/services/storage/s3Storage', () => jest.fn().mockImplementation(() => ({
  testConnection: jest.fn().mockResolvedValue(true),
  upload: mockUpload,
  getMetadata: jest.fn(async key => ({ ContentLength: mockObjects.get(key)?.length })),
  downloadStream: jest.fn(async key => require('stream').Readable.from([mockObjects.get(key)])),
})));

jest.setTimeout(120000);

describe('complete standalone backup restore points', () => {
  let db;
  let cleanup;
  let fixtureRoot;
  let storage;
  let dump;
  let destination;
  let service;
  let manifests;

  const media = ['events/active/E1/unchanged.jpg', 'business-docs/invoice/changed.pdf'];

  async function setting(key, value) {
    await db('app_settings').insert({
      setting_key: key, setting_value: JSON.stringify(value), setting_type: 'backup',
    }).onConflict('setting_key').merge();
  }

  async function write(relativePath, bytes) {
    const file = path.join(storage, relativePath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
  }

  async function run() {
    await service.runBackup(true);
    return db('backup_runs').orderBy('id', 'desc').first();
  }

  async function manifestFor(runRow) {
    if (runRow.manifest_path.startsWith('s3://')) {
      const key = runRow.manifest_path.replace(/^s3:\/\/[^/]+\//, '');
      const manifest = JSON.parse(mockObjects.get(key).toString());
      manifests.validateManifest(manifest);
      return manifest;
    }
    return manifests.loadManifest(runRow.manifest_path);
  }

  beforeAll(async () => {
    ({ db, cleanup, tmpDir: fixtureRoot } = await bootCrmDb());
    storage = process.env.STORAGE_PATH;
    destination = path.join(fixtureRoot, 'backups');
    dump = path.join(fixtureRoot, 'source-database.sql');
    service = require('../../src/services/backupService');
    manifests = require('../../src/services/backupManifest');
  });

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    mockUpload.mockClear();
    mockObjects.clear();
    await db('backup_runs').del();
    await db('backup_file_states').del();
    await db('app_settings').where('setting_type', 'backup').del();
    await fs.writeFile(dump, 'independent database dump');
    jest.spyOn(service, 'getDatabaseBackupInfo').mockResolvedValue({
      type: 'sqlite', backupFile: dump, size: 25,
      checksum: crypto.createHash('sha256').update('independent database dump').digest('hex'),
      hasChanged: true,
    });
    for (const [key, value] of Object.entries({
      backup_enabled: true, backup_destination_type: 'local',
      backup_destination_path: destination, backup_incremental: true,
      backup_include_database: true, backup_database_inline_dump: false,
      backup_email_on_success: false, backup_email_on_failure: false,
      backup_s3_bucket: 'standalone-fixture', backup_s3_access_key: 'fixture-key',
      backup_s3_secret_key: 'fixture-secret', backup_s3_prefix: 'restore-points',
    })) await setting(key, value);
    await write(media[0], 'unchanged original');
    await write(media[1], 'first version');
  });

  it.each(['local', 's3'])('includes unchanged files without an ancestor in each %s point', async type => {
    await setting('backup_destination_type', type);
    const first = await run();
    expect(first.status).toBe('completed');
    await write(media[1], 'second version');
    const second = await run();
    expect(second.status).toBe('completed');
    const latest = await manifestFor(second);
    expect(latest.files.manifest.map(file => file.path)).toEqual(expect.arrayContaining(media));
    expect(latest.backup.type).toBe('full');
    expect(latest.backup.parent_backup_id).toBeNull();
    expect(latest.metadata.restore_point).toBe('standalone-v1');
    for (const relativePath of media) {
      const bytes = type === 'local'
        ? await fs.readFile(path.join(latest.backup.path, relativePath), 'utf8')
        : mockObjects.get(latest.backup.path.replace(/^s3:\/\/[^/]+\//, '') + '/' + relativePath).toString();
      expect(bytes).toBe(relativePath === media[0] ? 'unchanged original' : 'second version');
    }
  });

  it('does not overwrite an earlier local point or depend on database dump retention', async () => {
    const first = await manifestFor(await run());
    await write(media[1], 'second version');
    const second = await manifestFor(await run());
    expect(second.backup.path).not.toBe(first.backup.path);
    expect(await fs.readFile(path.join(first.backup.path, media[1]), 'utf8')).toBe('first version');
    await fs.unlink(dump);
    const copiedDump = path.resolve(first.backup.path, first.database.backup_file);
    expect(path.relative(first.backup.path, copiedDump)).not.toMatch(/^\.\./);
    expect(await fs.readFile(copiedDump, 'utf8')).toBe('independent database dump');
  });

  it('does not reuse global file states after switching destinations or deleting history', async () => {
    expect((await run()).status).toBe('completed');
    await db('backup_runs').del();
    await setting('backup_destination_path', path.join(fixtureRoot, 'other-destination'));
    const manifest = await manifestFor(await run());
    expect(manifest.files.manifest.map(file => file.path)).toEqual(expect.arrayContaining(media));
  });

  it.each(['local', 's3'])('restores either %s point into an empty media target without ancestors', async type => {
    await setting('backup_destination_type', type);
    const firstRun = await run();
    const first = await manifestFor(firstRun);
    await write(media[1], 'second version');
    const secondRun = await run();
    const second = await manifestFor(secondRun);
    await db('backup_runs').del();
    await fs.unlink(dump);
    const { resolveBackupPointLocation } = require('../../src/utils/backupRestorePoint');
    const { restoreService } = require('../../src/services/restoreService');
    restoreService.tempDir = path.join(fixtureRoot, 'restore-staging');
    for (const [manifest, row, expected] of [
      [second, secondRun, 'second version'], [first, firstRun, 'first version'],
    ]) {
      for (const relativePath of media) await fs.unlink(path.join(storage, relativePath)).catch(() => {});
      const options = { source: type, restoreType: 'files', manifestPath: row.manifest_path };
      let selected = await resolveBackupPointLocation(manifest, options, await service.getBackupConfig());
      if (type === 's3') selected = await restoreService.downloadFromS3(selected, manifest, options);
      const result = await restoreService.performFilesRestore(selected, manifest, options);
      expect(result.filesRestored).toBe(manifest.files.manifest.length);
      expect(await fs.readFile(path.join(storage, media[0]), 'utf8')).toBe('unchanged original');
      expect(await fs.readFile(path.join(storage, media[1]), 'utf8')).toBe(expected);
      expect((await restoreService.performPostRestoreVerification(manifest, options)).isValid).toBe(true);
    }
  });

  it('uploads captured bytes rather than a source changed after checksum capture', async () => {
    await setting('backup_destination_type', 's3');
    mockUpload.mockImplementationOnce(async (captured, key) => {
      const source = key.endsWith(media[0]) ? media[0] : media[1];
      await write(source, 'source changed during upload');
      mockObjects.set(key, await fs.readFile(captured));
    });
    const manifest = await manifestFor(await run());
    const prefix = manifest.backup.path.replace(/^s3:\/\/[^/]+\//, '');
    for (const file of manifest.files.manifest) {
      const bytes = mockObjects.get(prefix + '/' + file.path);
      expect(bytes.length).toBe(file.size);
      expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(file.checksum);
    }
  });

  it('rejects ambiguous legacy completion before safety backup or rollback, even with force', async () => {
    const manifest = await manifestFor(await run());
    delete manifest.metadata.restore_point;
    manifest.backup.type = 'incremental';
    const { restoreService } = require('../../src/services/restoreService');
    jest.spyOn(restoreService, 'loadAndValidateManifest').mockResolvedValue(manifest);
    jest.spyOn(restoreService, 'sendRestoreNotification').mockResolvedValue();
    const safetyBackup = jest.spyOn(restoreService, 'createPreRestoreBackup');
    const rollback = jest.spyOn(restoreService, 'attemptRollback');
    restoreService.preRestoreBackupPath = 'a stale prior-run snapshot';
    await expect(restoreService.restore({
      source: 'local', manifestPath: 'selected-manifest.json', restoreType: 'full', force: true,
    })).rejects.toThrow(/cannot prove a complete file set/);
    expect(safetyBackup).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
  });

  it('fails the run rather than claiming completion after a required local copy fails', async () => {
    const original = fs.copyFile;
    jest.spyOn(fs, 'copyFile').mockImplementation((source, ...args) => {
      if (source.endsWith(media[1])) return Promise.reject(new Error('fixture copy failure'));
      return original(source, ...args);
    });
    expect((await run()).status).toBe('failed');
  });

  it('fails the run rather than claiming completion after a required S3 upload fails', async () => {
    await setting('backup_destination_type', 's3');
    mockUpload.mockRejectedValueOnce(new Error('fixture upload failure'));
    expect((await run()).status).toBe('failed');
  });

  it('fails the run if its manifest cannot be published', async () => {
    jest.spyOn(manifests, 'saveManifest').mockRejectedValueOnce(new Error('fixture manifest failure'));
    expect((await run()).status).toBe('failed');
  });
  it.each(['json', 'yaml'])('round-trips an authenticated standalone %s catalogue', async format => {
    const originalKey = process.env.BACKUP_MANIFEST_KEY;
    process.env.BACKUP_MANIFEST_KEY = 'standalone-fixture-key-not-a-production-secret';
    try {
      await setting('backup_manifest_format', format);
      const row = await run();
      expect(row.status).toBe('completed');
      expect(row.manifest_path).toMatch(new RegExp('\\.' + format + '$'));
      const manifest = await manifestFor(row);
      expect(manifests.verifyManifestChecksum(manifest).valid).toBe(true);
      expect(manifest.metadata.restore_point_manifest_layout).toBe('nested');
      expect(manifest.files.manifest.map(file => file.path)).toEqual(expect.arrayContaining(media));
    } finally {
      if (originalKey === undefined) delete process.env.BACKUP_MANIFEST_KEY;
      else process.env.BACKUP_MANIFEST_KEY = originalKey;
    }
  });

  it('records a valid relative local destination as an absolute restorable point', async () => {
    await setting('backup_destination_path', path.relative(process.cwd(), destination));
    const row = await run();
    expect(row.status).toBe('completed');
    const manifest = await manifestFor(row);
    expect(path.isAbsolute(manifest.backup.path)).toBe(true);
    const { resolveBackupPointLocation } = require('../../src/utils/backupRestorePoint');
    expect(await resolveBackupPointLocation(manifest, {
      source: 'local', manifestPath: row.manifest_path,
    }, await service.getBackupConfig())).toBe(await fs.realpath(manifest.backup.path));
  });

  it.each(['local', 's3'])('fails a %s point if an eligible directory cannot be enumerated', async type => {
    await setting('backup_destination_type', type);
    const original = fs.readdir;
    jest.spyOn(fs, 'readdir').mockImplementation((directory, ...args) => {
      if (directory === path.join(storage, 'business-docs')) {
        return Promise.reject(Object.assign(new Error('fixture catalogue permission failure'), { code: 'EACCES' }));
      }
      return original(directory, ...args);
    });
    const row = await run();
    expect(row.status).toBe('failed');
    expect(row.manifest_path).toBeNull();
  });
});
