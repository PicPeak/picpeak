'use strict';
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { PassThrough } = require('stream');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');
const mockObjects = new Map();
jest.mock('../../src/services/storage/s3Storage', () => jest.fn().mockImplementation(() => ({
  testConnection: async () => true,
  upload: async (file, key) => { mockObjects.set(key, await require('fs').promises.readFile(file)); },
  getMetadata: async key => ({ ContentLength: mockObjects.get(key)?.length }),
  downloadStream: async key => require('stream').Readable.from([mockObjects.get(key)]),
  list: async prefix => ({ Contents: [...mockObjects.keys()].filter(k => k.startsWith(prefix)).map(Key => ({ Key })), IsTruncated: false }),
  deleteMany: async keys => { keys.forEach(key => mockObjects.delete(key)); return { Errors: [] }; },
})));
let db, cleanup, seeded, storage, service, destination, dump, orderId;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const key = () => `.print-sales/${orderId}/pack.zip`;
const setting = (key, value) => db('app_settings').insert({ setting_key: key, setting_value: JSON.stringify(value), setting_type: 'backup' }).onConflict('setting_key').merge();
async function asset(kind = 'pack', storageKey = key(), bytes = Buffer.from('completed production bytes')) {
  await db('print_sales_assets').insert({ id: crypto.randomUUID(), order_id: orderId, storage_key: storageKey,
    sha256: hash(bytes), size: bytes.length, kind, created_at: new Date().toISOString() });
  if (kind !== 'staging') await storage.put(storageKey, bytes);
}
beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb()); seeded = await seedMinimal(db);
  storage = new (require('../../src/services/storage/LocalFsStorage'))({ root: process.env.STORAGE_PATH }); await storage.init();
  require('../../src/services/storage').setStorageForTesting(storage);
  service = require('../../src/services/backupService');
  destination = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-print-recovery-test-'));
  dump = path.join(destination, 'fixture.sql'); await fs.writeFile(dump, 'independent dump');
});
afterAll(async () => { jest.restoreAllMocks(); if (cleanup) await cleanup(); await fs.rm(destination, { recursive: true, force: true }); });
beforeEach(async () => {
  jest.restoreAllMocks(); mockObjects.clear();
  await db('print_sales_assets').del(); await db('print_sales_orders').del();
  await fs.rm(path.join(process.env.STORAGE_PATH, '.print-sales'), { recursive: true, force: true });
  orderId = crypto.randomUUID();
  await db('print_sales_orders').insert({ id: orderId, request_hash: hash(orderId), customer_account_id: seeded.customerId,
    created_by_admin_id: seeded.adminId, status: 'accepted', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600e3).toISOString() });
  jest.spyOn(service, 'getDatabaseBackupInfo').mockResolvedValue({ type: 'sqlite', backupFile: dump, size: 16, checksum: hash('independent dump'), hasChanged: true });
  for (const [k, value] of Object.entries({ backup_enabled: true, backup_destination_type: 'local', backup_destination_path: destination,
    backup_include_database: true, backup_database_inline_dump: false, backup_email_on_success: false, backup_email_on_failure: false,
    backup_s3_bucket: 'fixture', backup_s3_access_key: 'fixture-key', backup_s3_secret_key: 'fixture-secret' })) await setting(k, value);
});
async function backup() {
  await service.runBackup(true);
  return db('backup_runs').orderBy('id', 'desc').first();
}
async function manifest(row) {
  return row.manifest_path.startsWith('s3://') ? JSON.parse(mockObjects.get(row.manifest_path.replace(/^s3:\/\/[^/]+\//, '')).toString())
    : require('../../src/services/backupManifest').loadManifest(row.manifest_path);
}
test('local backup and portable export ignore an actual in-flight atomic temporary file', async () => {
  await asset('staging');
  const input = new PassThrough(), task = storage.put(key(), input);
  input.write(Buffer.alloc(65536, 7));
  const dir = path.join(process.env.STORAGE_PATH, '.print-sales', orderId);
  try {
    // Wait for the adapter to create its real sibling file, rather than a timer.
    while (!(await fs.readdir(dir).catch(() => [])).some(name => name.includes('.tmp.'))) await new Promise(r => setImmediate(r));
    const point = await backup(); expect(point.status).toBe('completed');
    expect((await manifest(point)).files.manifest.some(f => f.path.includes('.print-sales/'))).toBe(false);
    const exported = await require('../../src/services/picpeakExportService').createPicpeak({ includePhotos: false });
    try { expect(exported.manifest.files.some(f => f.path.includes('.print-sales/'))).toBe(false); }
    finally { await fs.rm(path.dirname(exported.filePath), { recursive: true, force: true }); }
  } finally { input.end(); await task; }
});
test.each(['local', 's3'])('a local asset discarded after listing does not fail a %s restore point', async type => {
  await asset(); await setting('backup_destination_type', type);
  const original = service.getFilesToBackup.bind(service);
  jest.spyOn(service, 'getFilesToBackup').mockImplementationOnce(async (...args) => {
    const files = await original(...args);
    expect(files.some(f => f.relativePath === key())).toBe(true);
    await db('print_sales_assets').where({ storage_key: key() }).del(); await storage.delete(key());
    return files;
  });
  const point = await backup(); expect(point.status).toBe('completed');
  expect((await manifest(point)).files.manifest.some(f => f.path === key())).toBe(false);
});
test.each(['before listing', 'after listing'])('a missing retained local file fails backup %s', async phase => {
  await asset();
  if (phase === 'before listing') await storage.delete(key());
  else {
    const original = service.getFilesToBackup.bind(service);
    jest.spyOn(service, 'getFilesToBackup').mockImplementationOnce(async (...args) => { const files = await original(...args); await storage.delete(key()); return files; });
  }
  const point = await backup(); expect(point.status).toBe('failed'); expect(point.manifest_path).toBeNull();
});
test.each(['local', 's3'])('a retained local asset over the configured size limit cannot silently disappear from a %s point', async type => {
  await asset('pack', key(), Buffer.alloc(2 * 1024 * 1024));
  await setting('backup_destination_type', type); await setting('backup_max_file_size_mb', 1);
  const point = await backup(); expect(point.status).toBe('failed');
  expect(point.error_message).toMatch(/Required recovery file exceeds/); expect(point.manifest_path).toBeNull();
});
test.each(['local', 's3'])('a discarded oversized file still leaves a valid %s point', async type => {
  await asset('pack', key(), Buffer.alloc(2 * 1024 * 1024));
  await setting('backup_destination_type', type); await setting('backup_max_file_size_mb', 1);
  const original = service.getFilesToBackup.bind(service);
  jest.spyOn(service, 'getFilesToBackup').mockImplementationOnce(async (...args) => {
    const files = await original(...args); await db('print_sales_assets').where({ storage_key: key() }).del(); await storage.delete(key()); return files;
  });
  const point = await backup(); expect(point.status).toBe('completed');
  expect((await manifest(point)).files.manifest.some(f => f.path === key())).toBe(false);
});
test.each(['discarded', 'retained'])('portable capture handles a %s file lost after listing', async state => {
  await asset();
  const recovery = require('../../src/services/recoveryFiles'), original = recovery.materialize;
  jest.spyOn(recovery, 'materialize').mockImplementationOnce(async (...args) => {
    if (state === 'discarded') await db('print_sales_assets').where({ storage_key: key() }).del();
    await storage.delete(key()); return original(...args);
  });
  const exported = require('../../src/services/picpeakExportService').createPicpeak({ includePhotos: false });
  if (state === 'retained') await expect(exported).rejects.toMatchObject({ code: 'ENOENT' });
  else {
    const result = await exported;
    try { expect(result.manifest.files.some(f => f.path === key())).toBe(false); }
    finally { await fs.rm(path.dirname(result.filePath), { recursive: true, force: true }); }
  }
});
test('a portable export retains captured bytes when the original is discarded before ZIP reads', async () => {
  await asset(); const recovery = require('../../src/services/recoveryFiles'), original = recovery.materialize;
  jest.spyOn(recovery, 'materialize').mockImplementationOnce(async (...args) => {
    const captured = await original(...args);
    await db('print_sales_assets').where({ storage_key: key() }).del(); await storage.delete(key()); return captured;
  });
  const result = await require('../../src/services/picpeakExportService').createPicpeak({ includePhotos: false });
  const zip = new (require('node-stream-zip').async)({ file: result.filePath });
  try {
    const entry = result.manifest.files.find(f => f.path === key()); expect(entry).toBeTruthy();
    const bytes = await zip.entryData(`files/${key()}`); expect(hash(bytes)).toBe(entry.checksum); expect(bytes.length).toBe(entry.size);
  } finally { await zip.close(); await fs.rm(path.dirname(result.filePath), { recursive: true, force: true }); }
});
test('a completed local print asset survives file restore from its standalone point', async () => {
  await asset(); const row = await backup(); expect(row.status).toBe('completed');
  const point = await manifest(row); await storage.delete(key());
  const { restoreService } = require('../../src/services/restoreService');
  const result = await restoreService.performFilesRestore(point.backup.path, point, { source: 'local', restoreType: 'files' });
  expect(result.filesRestored).toBe(point.files.manifest.length);
  expect(hash(await fs.readFile(path.join(process.env.STORAGE_PATH, key())))).toBe(point.files.manifest.find(f => f.path === key()).checksum);
});
