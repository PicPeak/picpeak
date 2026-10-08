'use strict';

process.env.DATABASE_CLIENT = 'sqlite3';
process.env.JWT_SECRET = 'primary-storage-backup-isolated-test-secret';
process.env.BACKUP_MANIFEST_KEY = '93'.repeat(32);
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
let db; let cleanup; let tmpDir; let customerId; let storageModule; let files; let backup; let exporter; let importer; let RestoreService;
let objects; let adapter; let listed; let readFault; let putFault;
const original = 'events/active/managed/individual/original.jpg';
const archived = 'events/archived/old.zip';
const document = 'business-docs/customer-documents/1/customer.pdf';
const extra = 'transfers/1/files/extra';
const upload = 'uploads/transfers/1/upload';
const metadata = { contentType: 'image/jpeg', contentDisposition: 'inline', cacheControl: 'private, max-age=31', metadata: { fixture: 'kept' } };

function store(key, bytes = Buffer.from(key), options = metadata) {
  objects.set(key, { bytes: Buffer.from(bytes), options: { ...options }, etag: `"${sha(bytes)}"` });
}
async function local(key, bytes = Buffer.from(key)) {
  const target = path.join(process.env.STORAGE_PATH, key);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes);
  return target;
}
async function event(slug, fields = {}) {
  const [row] = await db('events').insert({ slug, event_name: slug, event_type: 'wedding',
    event_date: '2026-10-07', host_email: 'host@example.com', admin_email: 'admin@example.com',
    password_hash: 'fixture', share_link: `${slug}-share`, expires_at: '2027-10-07', ...fields }).returning('id');
  return row?.id || row;
}
async function configure(destinationType = 'local') {
  const settings = { backup_enabled: true, backup_destination_type: destinationType, backup_destination_path: path.join(tmpDir, 'backups'),
    backup_manifest_path: path.join(tmpDir, 'backups', 'manifests'), backup_incremental: false, backup_include_archived: true,
    backup_database_inline_dump: true, database_backup_destination_path: path.join(tmpDir, 'dumps'),
    backup_email_on_success: false, backup_email_on_failure: false,
    database_backup_email_on_success: false, database_backup_email_on_failure: false,
    backup_s3_bucket: 'owned-backup-fixture', backup_s3_access_key: 'fixture', backup_s3_secret_key: 'fixture-secret',
    backup_rsync_host: 'backup.example.com', backup_rsync_path: '/backups' };
  for (const [key, value] of Object.entries(settings)) await db('app_settings').insert({ setting_key: key,
    setting_value: JSON.stringify(value), setting_type: key.startsWith('database_') ? 'database_backup' : 'backup' }).onConflict('setting_key').merge();
}
async function seedEstate() {
  const managed = await event('managed');
  await db('photos').insert({ event_id: managed, filename: 'original.jpg', path: 'managed/individual/original.jpg',
    type: 'individual', thumbnail_path: 'thumbnails/original.jpg' });
  const old = await event('old', { is_archived: 1, archive_path: archived });
  await db('photos').insert({ event_id: old, filename: 'removed.jpg', path: 'old/removed.jpg',
    type: 'individual', thumbnail_path: 'thumbnails/removed.jpg' });
  const external = await event('external', { source_mode: 'reference' });
  await db('photos').insert({ event_id: external, filename: 'external.jpg', path: 'external/absent.jpg',
    type: 'individual', source_origin: 'external', external_relpath: 'library/absent.jpg' });
  await db('transfers').insert({ id: 1, token: 'ab'.repeat(32), title: 'fixture', expires_at: '2027-10-07' });
  await db('transfer_extra_files').insert({ transfer_id: 1, original_filename: 'extra.html', stored_path: extra });
  await db('transfer_uploads').insert({ transfer_id: 1, original_filename: 'upload.js', stored_path: upload });
  for (const key of [original, archived, document, extra, upload, 'thumbnails/original.jpg',
    'previews/original.jpg', 'heroes/original.jpg', 'watermarks/original.jpg']) {
    store(key, Buffer.from(key), key === extra || key === upload
      ? { contentType: 'application/octet-stream', contentDisposition: 'attachment', metadata: { fixture: 'kept' } } : metadata);
  }
  await local('business-docs/invoice/2026/invoice.pdf');
  await local('uploads/logos/logo.svg');
  await local(original, Buffer.from('unused local decoy'));
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  ({ customerId } = await seedMinimal(db));
  storageModule = require('../../src/services/storage');
  files = require('../../src/services/recoveryFiles');
  backup = require('../../src/services/backupService');
  exporter = require('../../src/services/picpeakExportService');
  importer = require('../../src/services/picpeakImportService');
  ({ RestoreService } = require('../../src/services/restoreService'));
}, 120000);
beforeEach(async () => {
  await db('photos').del(); await db('events').del();
  await db('transfer_uploads').del(); await db('transfer_extra_files').del(); await db('transfers').del();
  await db('backup_file_states').del(); await db('backup_runs').del();
  await db('database_backup_runs').del();
  await fs.rm(path.join(tmpDir, 'backups'), { recursive: true, force: true });
  await fs.rm(process.env.STORAGE_PATH, { recursive: true, force: true });
  await fs.mkdir(process.env.STORAGE_PATH);
  objects = new Map(); readFault = null; putFault = null; listed = null;
  adapter = {
    kind: () => 's3',
    list: jest.fn(async prefix => listed || [...objects].filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, size: value.bytes.length }))),
    stat: jest.fn(async key => objects.has(key) ? { size: objects.get(key).bytes.length,
      etag: objects.get(key).etag, ...objects.get(key).options } : null),
    get: jest.fn(async key => { if (readFault === key) throw new Error('fixture read failure');
      if (!objects.has(key)) throw new Error('fixture object missing'); return Readable.from(objects.get(key).bytes); }),
    putFromFile: jest.fn(async (key, source, options) => { store(key, await fs.readFile(source), options);
      if (putFault === key) { putFault = null; throw new Error('fixture publication failure'); } }),
    delete: jest.fn(async key => objects.delete(key)),
  };
  storageModule.setStorageForTesting(adapter);
});
afterAll(async () => { storageModule.resetStorage(); await cleanup(); });

it('inventories managed originals/archives/derivatives/documents/both transfer roots while preserving local estate', async () => {
  await seedEstate();
  const inventory = await backup.getFilesToBackup({ backup_include_archived: true });
  expect(inventory.filter(file => file.storage === 'adapter').map(file => file.relativePath).sort()).toEqual([...objects.keys()].sort());
  expect(inventory.filter(file => file.relativePath === original)).toHaveLength(1);
  expect(inventory.filter(file => file.storage !== 'adapter').map(file => file.relativePath)).toEqual(expect.arrayContaining([
    'business-docs/invoice/2026/invoice.pdf', 'uploads/logos/logo.svg',
  ]));
});

it('honors archive/photo/thumb toggles and explicit path/exclusion policy for required references too', async () => {
  await seedEstate(); objects.delete(original); objects.delete(archived); objects.delete('thumbnails/original.jpg');
  const inventory = await backup.getFilesToBackup({ backup_include_archives: false, backup_include_photos: false,
    backup_include_thumbnails: false, backup_exclude_patterns: ['customer.pdf'] });
  expect(inventory.some(file => [original, archived, document, 'thumbnails/original.jpg'].includes(file.relativePath))).toBe(false);
});

it.each([original, archived, extra, upload])('refuses a missing required object %s even with a local decoy', async key => {
  await seedEstate(); objects.delete(key); await local(key);
  await expect(backup.getFilesToBackup({ backup_include_archived: true })).rejects.toThrow(/Required primary-storage object/);
});

it('rejects incomplete listings and unsafe keys; does not include lexical-prefix siblings', async () => {
  await seedEstate(); listed = [];
  await expect(exporter.collectFiles(true)).rejects.toThrow(/missing from the backup inventory/);
  listed = [{ key: 'events/active/../escape', size: 1 }];
  await expect(exporter.collectFiles(true)).rejects.toThrow(/Invalid recovery storage key/);
  listed = null; store('transfers-other/leak');
  expect((await exporter.collectFiles(true)).some(file => file.rel === 'transfers-other/leak')).toBe(false);
});

it('captures bounded immutable bytes plus metadata; refuses read errors and concurrent object changes', async () => {
  await seedEstate();
  const captured = await files.captureAdapter(original);
  try { expect(await fs.readFile(captured.path)).toEqual(objects.get(original).bytes); expect(captured.objectMetadata).toEqual(metadata);
    expect((await fs.stat(path.dirname(captured.path))).mode & 0o777).toBe(0o700); }
  finally { await captured.cleanup(); }
  await expect(files.captureAdapter(original, 1)).rejects.toThrow(/size limit/);
  readFault = original; await expect(files.captureAdapter(original)).rejects.toThrow(/read failure/); readFault = null;
  adapter.get.mockImplementationOnce(async key => { const bytes = objects.get(key).bytes; store(key, Buffer.from('changed')); return Readable.from(bytes); });
  await expect(files.captureAdapter(original)).rejects.toThrow(/changed during capture/);
});

it('exports and imports primary-only objects and metadata, while CRM documents and logos stay local', async () => {
  await seedEstate();
  const expected = new Map(objects);
  const exported = await exporter.createPicpeak({ includePhotos: true, outDir: path.join(tmpDir, 'portable') });
  expect(exported.manifest.file_count).toBe(expected.size + 2);
  expect(exported.manifest.files.find(file => file.path === original).object_metadata).toEqual(metadata);
  objects.clear();
  await fs.rm(process.env.STORAGE_PATH, { recursive: true, force: true }); await fs.mkdir(process.env.STORAGE_PATH);
  const result = await importer.importFromPicpeak({ picpeakPath: exported.filePath });
  expect(result.filesRestored).toBe(expected.size + 2);
  for (const [key, value] of expected) expect(objects.get(key)).toMatchObject(value);
  await expect(fs.access(path.join(process.env.STORAGE_PATH, original))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(path.join(process.env.STORAGE_PATH, 'business-docs/invoice/2026/invoice.pdf'))).toEqual(Buffer.from('business-docs/invoice/2026/invoice.pdf'));
});

it('keeps document-only and row-only exports intentional; row-only never lists or reads primary storage', async () => {
  await seedEstate();
  const docs = await exporter.createPicpeak({ includePhotos: false, outDir: path.join(tmpDir, 'portable') });
  expect(docs.manifest.files.map(file => file.path).sort()).toEqual([document, extra, upload,
    'business-docs/invoice/2026/invoice.pdf', 'uploads/logos/logo.svg'].sort());
  adapter.list.mockClear(); adapter.get.mockClear(); adapter.stat.mockClear();
  const rows = await exporter.createPicpeak({ includeFiles: false, includePhotos: true, outDir: path.join(tmpDir, 'portable') });
  expect(rows.manifest.files).toEqual([]); expect(adapter.list).not.toHaveBeenCalled();
  expect(adapter.get).not.toHaveBeenCalled(); expect(adapter.stat).not.toHaveBeenCalled();
});

it('standard local backup actually copies captured S3 bytes and records object metadata', async () => {
  await seedEstate();
  await configure();
  await backup.runBackup(true);
  const run = await db('backup_runs').orderBy('id', 'desc').first();
  expect(run.status).toBe('completed');
  const manifest = (await backup.getBackupManifest(run.id)).manifest;
  expect(manifest.files.manifest.find(file => file.path === original)).toMatchObject({ checksum: sha(objects.get(original).bytes), object_metadata: metadata });
  expect(await fs.readFile(path.join(tmpDir, 'backups', original))).toEqual(objects.get(original).bytes);
});

it('S3 backup destination receives actual primary bytes/metadata and does not skip metadata-only updates', async () => {
  await seedEstate(); await configure('s3');
  await db('app_settings').where('setting_key', 'backup_incremental').update({ setting_value: 'true' });
  const RawAdapter = require('../../src/services/storage/s3Storage');
  const destination = new Map();
  const spies = [jest.spyOn(RawAdapter.prototype, 'testConnection').mockResolvedValue(true),
    jest.spyOn(RawAdapter.prototype, 'upload').mockImplementation(async (source, key) => { destination.set(key, await fs.readFile(source)); }),
    jest.spyOn(RawAdapter.prototype, 'getMetadata').mockImplementation(async key => ({ ContentLength: destination.get(key).length })),
    jest.spyOn(RawAdapter.prototype, 'downloadStream').mockImplementation(async key => Readable.from(destination.get(key))),
    jest.spyOn(RawAdapter.prototype, 'download').mockImplementation(async (key, target) => fs.writeFile(target, destination.get(key)))];
  try {
    for (const cacheControl of ['private, max-age=31', 'private, max-age=32']) {
      objects.get(original).options.cacheControl = cacheControl;
      await backup.runBackup(true);
      const run = await db('backup_runs').orderBy('id', 'desc').first();
      expect(run.status).toBe('completed');
      const manifest = (await backup.getBackupManifest(run.id)).manifest;
      expect(manifest.files.manifest.find(file => file.path === original).object_metadata.cacheControl).toBe(cacheControl);
      const root = manifest.backup.path.replace('s3://owned-backup-fixture/', '');
      expect(destination.get(`${root}/${original}`)).toEqual(objects.get(original).bytes);
      const invoice = 'business-docs/invoice/2026/invoice.pdf';
      expect(manifest.files.manifest.some(file => file.path === invoice)).toBe(true);
      expect(destination.get(`${root}/${invoice}`)).toEqual(Buffer.from(invoice));
    }
  } finally { spies.forEach(spy => spy.mockRestore()); }
});

it('the actual rsync invocation transfers the selected staged hybrid estate, not the raw local decoy tree', async () => {
  await seedEstate(); await configure('rsync');
  await db('app_settings').where('setting_key', 'database_backup_destination_path').update({
    setting_value: JSON.stringify(path.join(process.env.STORAGE_PATH, 'backups', 'database')),
  });
  const network = jest.spyOn(require('../../src/utils/networkValidation'), 'isHostAllowed').mockResolvedValue(true);
  const spawn = jest.spyOn(require('../../src/utils/safeExec'), 'spawnAsync').mockImplementation(async (command, args) => {
    expect(command).toBe('rsync');
    const source = args[args.length - 2];
    expect(source).not.toBe(`${process.env.STORAGE_PATH}/`);
    expect(await fs.readFile(path.join(source, original))).toEqual(objects.get(original).bytes);
    expect(await fs.readFile(path.join(source, 'business-docs/invoice/2026/invoice.pdf'))).toEqual(Buffer.from('business-docs/invoice/2026/invoice.pdf'));
    const dump = await backup.getDatabaseBackupInfo();
    expect(await fs.readFile(path.join(source, 'database', path.basename(dump.backupFile)))).toEqual(await fs.readFile(dump.backupFile));
    return { stdout: 'Number of files transferred: 12\nTotal file size: 300 bytes' };
  });
  try {
    await backup.runBackup(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect((await db('backup_runs').orderBy('id', 'desc').first()).status).toBe('completed');
  } finally { spawn.mockRestore(); network.mockRestore(); }
});

it('fails a captured hybrid backup when a local CRM document cannot be published', async () => {
  await seedEstate(); await configure();
  await fs.mkdir(path.join(tmpDir, 'backups', 'business-docs'), { recursive: true });
  await fs.writeFile(path.join(tmpDir, 'backups', 'business-docs', 'invoice'), 'blocked');
  await backup.runBackup(true);
  expect((await db('backup_runs').orderBy('id', 'desc').first()).status).toBe('failed');
});

it('fails a captured hybrid backup when the S3 destination rejects a local CRM document', async () => {
  await seedEstate(); await configure('s3');
  const RawAdapter = require('../../src/services/storage/s3Storage');
  const spies = [jest.spyOn(RawAdapter.prototype, 'testConnection').mockResolvedValue(true),
    jest.spyOn(RawAdapter.prototype, 'upload').mockImplementation(async (_source, key) => {
      if (key.endsWith('/business-docs/invoice/2026/invoice.pdf')) throw new Error('invoice publication failed');
    })];
  try {
    await backup.runBackup(true);
    expect((await db('backup_runs').orderBy('id', 'desc').first()).status).toBe('failed');
  } finally { spies.forEach(spy => spy.mockRestore()); }
});

async function archiveManaged() {
  await db('events').where('slug', 'managed').update({ is_archived: 1, archive_path: 'events/archived/managed.zip' });
  objects.delete(original); store('events/archived/managed.zip');
}

it('refuses a portable catalogue that loses an original referenced by its captured rows during archiving', async () => {
  await seedEstate();
  const write = fs.writeFile.bind(fs);
  const spy = jest.spyOn(fs, 'writeFile').mockImplementation(async (target, ...args) => {
    await write(target, ...args);
    if (String(target).endsWith('/data/photos.ndjson')) await archiveManaged();
  });
  try {
    await expect(exporter.createPicpeak({ includePhotos: true, outDir: path.join(tmpDir, 'portable') })).rejects.toThrow(/Required primary-storage|reference.*changed/);
  } finally { spy.mockRestore(); }
});

it('refuses a standard catalogue that loses an original referenced by its database dump during archiving', async () => {
  await seedEstate(); await configure();
  const collect = backup.getFilesToBackup.bind(backup);
  const spy = jest.spyOn(backup, 'getFilesToBackup').mockImplementationOnce(async config => {
    await archiveManaged(); return collect(config);
  });
  try {
    await backup.runBackup(true);
    expect((await db('backup_runs').orderBy('id', 'desc').first()).status).toBe('failed');
  } finally { spy.mockRestore(); }
});

it('records dump-bound references for scheduled reuse and rejects an old unbound S3-primary dump', async () => {
  await seedEstate(); await configure();
  const { databaseBackupService } = require('../../src/services/databaseBackup');
  await databaseBackupService.backup({});
  const dump = await backup.getDatabaseBackupInfo();
  expect(dump.storageReferences).toContain(original);
  // The run row (GET /history returns it raw) pins the list, it does not hold it.
  const recorded = JSON.parse((await db('database_backup_runs').where('file_path', dump.backupFile).first()).statistics);
  const sidecar = `${dump.backupFile}${files.REFERENCES_SUFFIX}`;
  expect(recorded.storageReferences).toEqual({ count: dump.storageReferences.length, checksum: sha(await fs.readFile(sidecar)) });
  expect(JSON.stringify(recorded)).not.toContain(original);
  await db('app_settings').where('setting_key', 'backup_database_inline_dump').update({ setting_value: 'false' });
  await backup.runBackup(true);
  expect((await db('backup_runs').orderBy('id', 'desc').first()).status).toBe('completed');
  const list = await fs.readFile(sidecar);
  await fs.writeFile(sidecar, JSON.stringify([]));
  await backup.runBackup(true);
  expect((await db('backup_runs').orderBy('id', 'desc').first())).toMatchObject({
    status: 'failed', error_message: expect.stringMatching(/recorded storage references/),
  });
  await fs.writeFile(sidecar, list);
  await db('database_backup_runs').where('file_path', dump.backupFile).update({ statistics: '{}' });
  await backup.runBackup(true);
  expect((await db('backup_runs').orderBy('id', 'desc').first())).toMatchObject({
    status: 'failed', error_message: expect.stringMatching(/recorded storage references/),
  });
});

it('records the settled references when a lifecycle change lands while the database dump is being captured', async () => {
  await seedEstate(); await configure();
  const { databaseBackupService } = require('../../src/services/databaseBackup');
  const capture = databaseBackupService.createSQLiteBackup.bind(databaseBackupService);
  const spy = jest.spyOn(databaseBackupService, 'createSQLiteBackup').mockImplementationOnce(async (...args) => {
    await capture(...args); await archiveManaged();
  });
  try {
    await expect(databaseBackupService.backup({})).resolves.toMatchObject({ success: true });
    const dump = await backup.getDatabaseBackupInfo();
    expect(dump.storageReferences).toContain('events/archived/managed.zip');
    expect(dump.storageReferences).not.toContain(original);
  } finally { spy.mockRestore(); }
});

it('records the union of references, and still completes, when they never settle during the dump', async () => {
  await seedEstate(); await configure();
  const { databaseBackupService } = require('../../src/services/databaseBackup');
  let call = 0;
  const spy = jest.spyOn(files, 'requiredKeys').mockImplementation(async () => new Set([`events/active/moving/${call++}.jpg`]));
  try {
    await expect(databaseBackupService.backup({})).resolves.toMatchObject({ success: true });
    expect(spy).toHaveBeenCalledTimes(4);
  } finally { spy.mockRestore(); }
  expect((await backup.getDatabaseBackupInfo()).storageReferences).toEqual([0, 1, 2, 3].map(n => `events/active/moving/${n}.jpg`));
});

it.each([['transfer_uploads', 'stored_path'], ['transfer_extra_files', 'stored_path']])(
  'rejects a selected %s reference without a storage key', async (table, column) => {
    await seedEstate(); const row = await db(table).first(); await db(table).where('id', row.id).update({ [column]: '' });
    await expect(exporter.collectFiles(true)).rejects.toThrow(/has no primary-storage key/);
  });

it('ignores valid zero-byte S3 directory markers while still rejecting malformed or nonempty markers', async () => {
  await seedEstate(); store('events/active/', Buffer.alloc(0)); store('events/active/empty/', Buffer.alloc(0));
  expect((await exporter.collectFiles(true)).some(file => file.rel.endsWith('/'))).toBe(false);
  store('events/active/nonempty/', Buffer.from('not a directory'));
  await expect(exporter.collectFiles(true)).rejects.toThrow(/Invalid recovery storage key/);
});

it('downloads selective S3 files from catalogue entries, then publishes into primary storage', async () => {
  const bytes = Buffer.from('selected backup object');
  const manifest = { database: {}, files: { manifest: [{ path: original, size: bytes.length, checksum: sha(bytes), object_metadata: metadata }] } };
  const RawAdapter = require('../../src/services/storage/s3Storage');
  const spies = [jest.spyOn(RawAdapter.prototype, 'testConnection').mockResolvedValue(true),
    jest.spyOn(RawAdapter.prototype, 'getMetadata').mockResolvedValue({ ContentLength: bytes.length }),
    jest.spyOn(RawAdapter.prototype, 'downloadStream').mockResolvedValue(Readable.from(bytes))];
  const service = new RestoreService();
  service.tempDir = await fs.mkdtemp(path.join(tmpDir, 'selective-'));
  const pin = jest.spyOn(service, 'pinnedS3Agents').mockResolvedValue({});
  const options = { restoreType: 'selective', s3Config: { accessKeyId: 'fixture', secretAccessKey: 'fixture' },
    selectedItems: [{ type: 'file', path: original, checksum: '00'.repeat(32), size: 0 }] };
  try {
    const source = await service.downloadFromS3('s3://owned-backup-fixture/point', manifest, options);
    expect(spies[2]).toHaveBeenCalledWith(`point/${original}`);
    await service.performSelectiveRestore(source, manifest, options);
    expect(objects.get(original).bytes).toEqual(bytes);
  } finally { pin.mockRestore(); spies.forEach(spy => spy.mockRestore()); }
});

it('destroys an opened source when private capture staging cannot be allocated', async () => {
  const source = Readable.from(Buffer.from('owned stream'));
  const spy = jest.spyOn(fs, 'mkdtemp').mockRejectedValueOnce(new Error('staging unavailable'));
  try {
    await expect(files.captureStream(source)).rejects.toThrow(/staging unavailable/);
    expect(source.destroyed).toBe(true);
  } finally { spy.mockRestore(); }
});

it('records primary capture/destination failures as failed rather than completed backup runs', async () => {
  await seedEstate(); await configure(); readFault = original;
  await backup.runBackup(true);
  expect((await db('backup_runs').orderBy('id', 'desc').first())).toMatchObject({ status: 'failed', error_message: expect.stringMatching(/read failure/) });
  readFault = null;
  await fs.mkdir(path.join(tmpDir, 'backups'), { recursive: true });
  // Block the destination's events directory with a regular file.
  await fs.writeFile(path.join(tmpDir, 'backups', 'events'), 'blocked');
  await backup.runBackup(true);
  expect((await db('backup_runs').orderBy('id', 'desc').first()).status).toBe('failed');
});

async function sourceCatalogue(entries) {
  const root = await fs.mkdtemp(path.join(tmpDir, 'source-'));
  const manifest = { files: { manifest: [] }, database: {} };
  for (const [key, bytes] of entries) {
    const file = path.join(root, key); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes);
    manifest.files.manifest.push({ path: key, size: bytes.length, checksum: sha(bytes), object_metadata: metadata });
  }
  return { root, manifest };
}

it('standard restore publishes into primary storage and verifies it, never the local decoy', async () => {
  const bytes = Buffer.from('actual restored original');
  const { root, manifest } = await sourceCatalogue([[original, bytes]]);
  const service = new RestoreService();
  expect(await service.performFilesRestore(root, manifest, { restoreType: 'files' })).toMatchObject({ filesRestored: 1 });
  expect(objects.get(original).bytes).toEqual(bytes); expect(objects.get(original).options).toEqual(metadata);
  await local(original, bytes); objects.delete(original);
  expect((await service.performPostRestoreVerification(manifest, { restoreType: 'files' })).isValid).toBe(false);
});

it('refuses bad checksums/symlinks before S3 publication and binds selective metadata/checksum to the catalogue', async () => {
  const bytes = Buffer.from('good bytes'); const { root, manifest } = await sourceCatalogue([[original, bytes]]);
  manifest.files.manifest[0].checksum = '00'.repeat(32);
  await expect(new RestoreService().performFilesRestore(root, manifest, { restoreType: 'files' })).rejects.toThrow(/checksum/);
  expect(adapter.putFromFile).not.toHaveBeenCalled();
  manifest.files.manifest[0].checksum = sha(bytes);
  await new RestoreService().performFilesRestore(root, manifest, { restoreType: 'selective', selectedItems: [
    { type: 'file', path: original, checksum: '00'.repeat(32), object_metadata: { contentType: 'text/html' } },
  ] });
  expect(objects.get(original).options).toEqual(metadata);
  await fs.unlink(path.join(root, original)); await fs.symlink(path.join(tmpDir, 'crm.db'), path.join(root, original));
  await expect(new RestoreService().performFilesRestore(root, manifest, { restoreType: 'files' })).rejects.toThrow(/symbolic link/);
});

it('default safety backup rolls back prior S3 bytes/metadata and removes keys created by a failed restore', async () => {
  const fresh = 'events/active/managed/new.jpg'; const failed = 'events/active/managed/fail.jpg';
  const before = { contentType: 'image/png', contentDisposition: 'attachment', metadata: { old: 'retained' } };
  store(original, Buffer.from('old original'), before);
  const { root, manifest } = await sourceCatalogue([[original, Buffer.from('replacement')], [fresh, Buffer.from('new')], [failed, Buffer.from('fail')]]);
  const service = new RestoreService(); service.tempDir = path.join(tmpDir, 'safety');
  const safety = await service.createPreRestoreBackup({ restoreType: 'files' }, manifest);
  putFault = failed;
  await expect(service.performFilesRestore(root, manifest, { restoreType: 'files' })).rejects.toThrow(/publication failure/);
  await service.attemptRollback(safety);
  expect(objects.get(original)).toMatchObject({ bytes: Buffer.from('old original'), options: before });
  expect(objects.has(fresh)).toBe(false); expect(objects.has(failed)).toBe(false);
});

it('rsync source can be an owned materialized hybrid catalogue, with no raw-root/decoy escape', async () => {
  await seedEstate(); const stage = path.join(tmpDir, 'rsync');
  const inventory = await backup.getFilesToBackup({ backup_include_archived: true });
  const materialized = await files.materialize(inventory, stage);
  expect(await fs.readFile(path.join(stage, original))).toEqual(objects.get(original).bytes);
  expect(materialized.find(file => file.relativePath === original).objectMetadata).toEqual(metadata);
  const args = backup.buildRsyncArgs({ backup_rsync_host: 'backup.example.com', backup_rsync_path: '/backups' }, [], stage);
  expect(args[args.length - 2]).toBe(`${stage}/`);
});

it('treats renditions as optional: a stale or malformed derived key does not fail the inventory or the dump', async () => {
  await seedEstate(); objects.delete('thumbnails/original.jpg');
  const managed = await db('events').where('slug', 'managed').first();
  await db('photos').insert({ event_id: managed.id, filename: 'legacy.jpg', path: 'managed/individual/legacy.jpg',
    type: 'individual', thumbnail_path: '/app/storage/thumbnails/legacy.jpg' });
  store('events/active/managed/individual/legacy.jpg');
  const inventory = await backup.getFilesToBackup({ backup_include_archived: true });
  expect(inventory.some(file => file.relativePath === 'thumbnails/original.jpg')).toBe(false);
  expect(inventory.some(file => file.relativePath === original)).toBe(true);
  const required = await files.requiredKeys(db, () => true);
  expect([...required]).toEqual(expect.arrayContaining([original, 'events/active/managed/individual/legacy.jpg']));
  expect([...required].some(key => key.includes('thumbnails'))).toBe(false);
  await configure(); await backup.runBackup(true);
  expect((await db('backup_runs').orderBy('id', 'desc').first()).status).toBe('completed');
});

it('skips a photo row without a path, but still refuses a malformed key for a required original', async () => {
  await seedEstate();
  const managed = await db('events').where('slug', 'managed').first();
  const [inserted] = await db('photos').insert({ event_id: managed.id, filename: 'empty.jpg', path: '', type: 'individual' }).returning('id');
  expect([...await files.requiredKeys(db, () => true)]).toContain(original);
  await db('photos').where('id', inserted?.id || inserted).update({ path: 'managed/bad\u0001.jpg' });
  await expect(files.requiredKeys(db, () => true)).rejects.toThrow(/Invalid recovery storage key/);
});

it('reads reference rows in id batches with only the path columns', async () => {
  await seedEstate();
  const managed = await db('events').where('slug', 'managed').first();
  const many = Array.from({ length: 1005 }, (_, n) => ({ event_id: managed.id, filename: `bulk-${n}.jpg`,
    path: `managed/individual/bulk-${n}.jpg`, type: 'individual' }));
  for (let start = 0; start < many.length; start += 100) await db('photos').insert(many.slice(start, start + 100));
  const queries = [];
  const listener = query => { if (/from [`"]photos[`"]/.test(query.sql)) queries.push(query.sql); };
  db.on('query', listener);
  try {
    const keys = await files.requiredKeys(db, () => true);
    expect(keys.has('events/active/managed/individual/bulk-1004.jpg')).toBe(true);
  } finally { db.removeListener('query', listener); }
  const selects = queries.filter(sql => /^select/i.test(sql));
  expect(selects.length).toBe(2);
  expect(selects.every(sql => !sql.includes('*') && /limit/i.test(sql))).toBe(true);
});

it('local storage with an rsync destination reads the storage root in place and only stages the dump', async () => {
  storageModule.setStorageForTesting({ kind: () => 'local' });
  await event('managed');
  const source = await local(original, Buffer.from('local original'));
  const old = new Date('2020-01-02T03:04:05.000Z'); await fs.utimes(source, old, old);
  await configure('rsync');
  const materialize = jest.spyOn(files, 'materialize');
  const network = jest.spyOn(require('../../src/utils/networkValidation'), 'isHostAllowed').mockResolvedValue(true);
  const spawn = jest.spyOn(require('../../src/utils/safeExec'), 'spawnAsync').mockImplementation(async (command, args) => {
    const [root, stage] = args.slice(-3);
    expect(root).toBe(`${process.env.STORAGE_PATH}/`);
    const dump = await backup.getDatabaseBackupInfo();
    expect(await fs.readdir(stage)).toEqual(['database']);
    expect(await fs.readdir(path.join(stage, 'database'))).toEqual([path.basename(dump.backupFile)]);
    return { stdout: 'Number of files transferred: 2\nTotal file size: 30 bytes' };
  });
  try {
    await backup.runBackup(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(materialize).not.toHaveBeenCalled();
    expect((await db('backup_runs').orderBy('id', 'desc').first()).status).toBe('completed');
    expect((await fs.stat(source)).mtime).toEqual(old);
  } finally { spawn.mockRestore(); network.mockRestore(); materialize.mockRestore(); }
});

it('a selective restore on local storage only copies the files it will overwrite into the safety backup', async () => {
  storageModule.setStorageForTesting({ kind: () => 'local' });
  await local(original, Buffer.from('current original')); await local('events/active/managed/other.jpg');
  const service = new RestoreService(); service.tempDir = path.join(tmpDir, 'safety-selective');
  const options = { restoreType: 'selective', selectedItems: [
    { type: 'file', path: original }, { type: 'file', path: 'events/active/managed/absent.jpg' }] };
  const safety = await service.createPreRestoreBackup(options, { files: { manifest: [] } });
  const listing = require('child_process').execFileSync('tar', ['-tzf', path.join(safety, 'files.tar.gz')]).toString().trim().split('\n');
  expect(listing).toEqual([path.join(path.basename(process.env.STORAGE_PATH), original)]);
  await fs.writeFile(path.join(process.env.STORAGE_PATH, original), 'overwritten');
  await service.attemptRollback(safety);
  expect(await fs.readFile(path.join(process.env.STORAGE_PATH, original), 'utf8')).toBe('current original');
});

it('exports local storage in place with a checksummed catalogue, and S3 storage without a per-file ceiling', async () => {
  const materialize = jest.spyOn(files, 'materialize');
  try {
    await seedEstate();
    await exporter.createPicpeak({ includePhotos: true, outDir: path.join(tmpDir, 'portable') });
    expect(materialize.mock.calls[0][2]).toBe(Number.MAX_SAFE_INTEGER);
    materialize.mockClear();
    storageModule.setStorageForTesting({ kind: () => 'local' });
    const exported = await exporter.createPicpeak({ includePhotos: true, outDir: path.join(tmpDir, 'portable') });
    expect(materialize).not.toHaveBeenCalled();
    expect(exported.manifest.files.find(file => file.path === original)).toMatchObject({
      size: 'unused local decoy'.length, checksum: sha(Buffer.from('unused local decoy')) });
    await fs.rm(process.env.STORAGE_PATH, { recursive: true, force: true }); await fs.mkdir(process.env.STORAGE_PATH);
    const result = await importer.importFromPicpeak({ picpeakPath: exported.filePath });
    expect(result.filesRestored).toBe(exported.manifest.file_count);
    expect(await fs.readFile(path.join(process.env.STORAGE_PATH, original), 'utf8')).toBe('unused local decoy');
  } finally { materialize.mockRestore(); }
});

it('rolls back an object the safety capture accepted even when the restore size limit is lower afterwards', async () => {
  store(original, Buffer.from('old original'));
  const { root, manifest } = await sourceCatalogue([[original, Buffer.from('replacement')]]);
  const service = new RestoreService(); service.tempDir = path.join(tmpDir, 'safety-limit');
  const safety = await service.createPreRestoreBackup({ restoreType: 'files' }, manifest);
  await service.performFilesRestore(root, manifest, { restoreType: 'files' });
  await db('app_settings').insert({ setting_key: 'restore_max_file_size_mb', setting_type: 'restore',
    setting_value: JSON.stringify(0.000005) }).onConflict('setting_key').merge();
  try {
    await service.attemptRollback(safety);
    expect(objects.get(original).bytes).toEqual(Buffer.from('old original'));
  } finally { await db('app_settings').where('setting_key', 'restore_max_file_size_mb').del(); }
});

it('does not open the backup source for a catalogue entry whose key fails validation', async () => {
  const bad = 'events/active/managed/bad\u0001.jpg';
  const { root, manifest } = await sourceCatalogue([[bad, Buffer.from('bytes')]]);
  const open = jest.spyOn(fs, 'open');
  try {
    await expect(new RestoreService().performFilesRestore(root, manifest, { restoreType: 'files' })).rejects.toThrow();
    expect(open.mock.calls.some(([target]) => String(target).endsWith('.jpg'))).toBe(false);
  } finally { open.mockRestore(); }
  expect(adapter.putFromFile).not.toHaveBeenCalled();
});

it.each(['../escape', '/absolute', 'events//active/x', 'events/active/./x', 'events\\active\\x', 'C:/escape', 'events/active/x\0y'])('rejects ambiguous recovery key %j', key => {
  expect(() => files.validKey(key)).toThrow(/Invalid recovery storage key/);
});
