'use strict';
/**
 * Website builder uploads (issue 2618) are kept only as the files under
 * `website/`: the originals are discarded, so nothing can regenerate them.
 * The directory is in every backup and restore inventory: backup_paths, the
 * standalone file backup and its restore, the portable export, and the
 * recovery reference list.
 */
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { bootCrmDb } = require('./helpers/crmDb');

jest.setTimeout(120000);

let db; let cleanup; let storage; let service; let destination; let dump;
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const publicId = 'ab'.repeat(12);
const imageKey = `website/${publicId}/w640.jpg`;
const videoKey = `website/${publicId}/video.mp4`;
const setting = (key, value) => db('app_settings').insert({ setting_key: key, setting_value: JSON.stringify(value), setting_type: 'backup' }).onConflict('setting_key').merge();

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  storage = new (require('../../src/services/storage/LocalFsStorage'))({ root: process.env.STORAGE_PATH });
  await storage.init();
  require('../../src/services/storage').setStorageForTesting(storage);
  service = require('../../src/services/backupService');
  destination = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-website-recovery-'));
  dump = path.join(destination, 'fixture.sql');
  await fs.writeFile(dump, 'independent dump');
  await storage.put(imageKey, Buffer.from('website image rendition'));
  await storage.put(videoKey, Buffer.from('website hero video'));
  await db('website_assets').insert({
    public_id: publicId, kind: 'image', rendition_keys: JSON.stringify({ 640: imageKey, video: videoKey }), created_at: new Date().toISOString(),
  });
  jest.spyOn(service, 'getDatabaseBackupInfo').mockResolvedValue({ type: 'sqlite', backupFile: dump, size: 16, checksum: hash('independent dump') });
  for (const [k, value] of Object.entries({
    backup_enabled: true, backup_destination_type: 'local', backup_destination_path: destination,
    backup_include_database: true, backup_database_inline_dump: false, backup_email_on_success: false, backup_email_on_failure: false,
  })) await setting(k, value);
});
afterAll(async () => {
  jest.restoreAllMocks();
  if (cleanup) await cleanup();
  await fs.rm(destination, { recursive: true, force: true });
});

test('website/ is a default backup path', async () => {
  const row = await db('backup_paths').where({ path: 'website' }).first();
  expect(row).toBeTruthy();
  expect(Boolean(row.include_in_default)).toBe(true);
  const { DEFAULT_PATHS } = require('../../migrations/core/109_add_backup_paths');
  expect(DEFAULT_PATHS.some((p) => p.path === 'website')).toBe(true);
});

test('the recovery inventory manages and requires the asset files', async () => {
  const recovery = require('../../src/services/recoveryFiles');
  expect(recovery.MANAGED_ROOTS).toContain('website');
  const keys = await recovery.requiredKeys(db, () => true);
  expect([...keys]).toEqual(expect.arrayContaining([imageKey, videoKey]));
});

test('a file backup carries the files and a file restore brings them back', async () => {
  await service.runBackup(true);
  const row = await db('backup_runs').orderBy('id', 'desc').first();
  expect(row.status).toBe('completed');
  const point = require('../../src/services/backupManifest').loadManifest(row.manifest_path);
  const manifest = await point;
  expect(manifest.files.manifest.map((f) => f.path)).toEqual(expect.arrayContaining([imageKey, videoKey]));
  await storage.delete(imageKey);
  await storage.delete(videoKey);
  const { restoreService } = require('../../src/services/restoreService');
  await restoreService.performFilesRestore(manifest.backup.path, manifest, { source: 'local', restoreType: 'files' });
  expect(await fs.readFile(path.join(process.env.STORAGE_PATH, imageKey), 'utf8')).toBe('website image rendition');
  expect(await fs.readFile(path.join(process.env.STORAGE_PATH, videoKey), 'utf8')).toBe('website hero video');
});

test('the portable export carries the files, and its import accepts their folder', async () => {
  const exported = await require('../../src/services/picpeakExportService').createPicpeak({ includePhotos: false });
  try {
    expect(exported.manifest.files.map((f) => f.path)).toEqual(expect.arrayContaining([imageKey, videoKey]));
  } finally {
    await fs.rm(path.dirname(exported.filePath), { recursive: true, force: true });
  }
  expect(require('../../src/services/picpeakImportService').importFilePathProblem(videoKey)).toBeNull();
});

describe('portable export on S3', () => {
  const { Readable } = require('stream');
  let objects;

  beforeEach(() => {
    objects = new Map([[imageKey, Buffer.from('website image rendition')], [videoKey, Buffer.from('website hero video')]]);
    require('../../src/services/storage').setStorageForTesting({
      kind: () => 's3',
      list: jest.fn(async (prefix) => [...objects].filter(([k]) => k.startsWith(prefix)).map(([key, bytes]) => ({ key, size: bytes.length }))),
      stat: jest.fn(async (key) => (objects.has(key) ? { size: objects.get(key).length, etag: 'e' } : null)),
      get: jest.fn(async (key) => { if (!objects.has(key)) throw new Error('fixture object missing'); return Readable.from(objects.get(key)); }),
      putFromFile: jest.fn(), delete: jest.fn(async (key) => objects.delete(key)),
    });
  });
  afterAll(() => require('../../src/services/storage').setStorageForTesting(storage));

  test('an upload deleted between the table dump and the file inventory fails the export', async () => {
    // The dump already holds the row; then the upload is deleted (row and
    // files) before the files are listed. An export with the row and no files
    // would restore a broken image, so the export is refused.
    const recovery = require('../../src/services/recoveryFiles');
    const original = recovery.requiredKeys;
    const spy = jest.spyOn(recovery, 'requiredKeys').mockImplementation(async (...args) => {
      await db('website_assets').where({ public_id: publicId }).del();
      objects.delete(imageKey);
      objects.delete(videoKey);
      return original(...args);
    });
    try {
      await expect(require('../../src/services/picpeakExportService').createPicpeak({ includePhotos: false, outDir: path.join(destination, 'portable') }))
        .rejects.toThrow(/Required primary-storage object.*website\//);
    } finally {
      spy.mockRestore();
      await db('website_assets').insert({
        public_id: publicId, kind: 'image', rendition_keys: JSON.stringify({ 640: imageKey, video: videoKey }), created_at: new Date().toISOString(),
      }).onConflict('public_id').ignore();
    }
  });
});
