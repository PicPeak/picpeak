const fs = require('fs').promises;
const path = require('path');
const request = require('supertest');
const express = require('express');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken,
} = require('../integration/helpers/crmDb');

const mockConstructed = [];
const mockList = jest.fn();
const mockSigned = jest.fn(async (_operation, key) => 'https://fixture.example/' + key);
jest.mock('../../src/services/storage/s3Storage', () => class {
  constructor(config) { mockConstructed.push(config); }
  list(prefix, options) { return mockList(prefix, options); }
  getSignedUrl(...args) { return mockSigned(...args); }
});

describe('selected backup-point download', () => {
  let db; let cleanup; let root; let app; let token; let selectedManifest;
  const config = async settings => {
    for (const [key, value] of Object.entries(settings)) {
      await db('app_settings').insert({
        setting_key: key, setting_value: JSON.stringify(value), setting_type: 'backup',
      }).onConflict('setting_key').merge();
    }
  };
  const run = async manifestPath => {
    const result = await db('backup_runs').insert({
      status: 'completed', backup_type: 'full', started_at: new Date(),
      completed_at: new Date(), manifest_path: manifestPath,
    }).returning('id');
    return result[0]?.id ?? result[0];
  };
  const download = id => request(app).get('/backup/download/' + id).set('Authorization', 'Bearer ' + token);
  beforeAll(async () => {
    ({ db, cleanup, tmpDir: root } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId);
    token = mintAdminToken(adminId);
    const service = require('../../src/services/backupService');
    jest.spyOn(service, 'getBackupManifest').mockImplementation(async () => ({ manifest: selectedManifest }));
    app = express();
    app.use('/backup', require('../../src/routes/adminBackup'));
  }, 120000);
  afterAll(async () => { jest.restoreAllMocks(); await cleanup(); });
  beforeEach(async () => {
    await db('backup_runs').del();
    mockConstructed.length = 0;
    mockList.mockReset();
    mockSigned.mockClear();
    await config({
      backup_destination_type: 'local', backup_destination_path: root,
      backup_s3_bucket: 'current-not-selected', backup_s3_endpoint: 'https://fixture.example',
      backup_s3_access_key: 'fixture', backup_s3_secret_key: 'fixture',
    });
    selectedManifest = {
      backup: { type: 'full', parent_backup_id: null },
      files: { count: 2, manifest: [{ path: 'a.jpg' }, { path: 'b.jpg' }] },
      metadata: { restore_point: 'standalone-v1', destination_type: 's3' },
    };
  });
  it('uses the selected S3 bucket/prefix and every AWS Contents page despite changed settings', async () => {
    mockList.mockResolvedValueOnce({
      Contents: [{ Key: 'points/selected/a.jpg', Size: 10 }],
      IsTruncated: true, NextContinuationToken: 'next-page',
    }).mockResolvedValueOnce({
      Contents: [{ Key: 'points/selected/b.jpg', Size: 20 }], IsTruncated: false,
    });
    const id = await run('s3://rescued/points/selected/manifests/m.json');
    const response = await download(id);
    expect(response.status).toBe(200);
    expect(mockConstructed[0].bucket).toBe('rescued');
    expect(mockList.mock.calls).toEqual([
      ['points/selected/', { maxKeys: 1000, continuationToken: undefined }],
      ['points/selected/', { maxKeys: 1000, continuationToken: 'next-page' }],
    ]);
    expect(response.body.files.map(file => [file.key, file.size])).toEqual([
      ['points/selected/a.jpg', 10], ['points/selected/b.jpg', 20],
    ]);
    expect(response.body.expiresIn).toBe(3600);
  });
  it.each([
    { Contents: [{ Key: 'another-point/a.jpg', Size: 1 }] },
    { Contents: [], IsTruncated: true },
  ])('refuses an invalid or incomplete object page rather than returning partial success', async page => {
    mockList.mockResolvedValue(page);
    const response = await download(await run('s3://bucket/points/selected/manifests/m.json'));
    expect(response.status).toBe(500);
    expect(response.body.files).toBeUndefined();
  });
  it('refuses repeated continuation tokens', async () => {
    mockList.mockResolvedValue({ Contents: [], IsTruncated: true, NextContinuationToken: 'repeat' });
    expect((await download(await run('s3://bucket/points/selected/manifests/m.json'))).status).toBe(500);
    expect(mockList).toHaveBeenCalledTimes(2);
  });
  it('streams the selected local snapshot rather than guessing backup-<database id>', async () => {
    const snapshot = path.join(root, 'backup-selected');
    await fs.mkdir(path.join(snapshot, 'manifests'), { recursive: true });
    await fs.writeFile(path.join(snapshot, 'a.jpg'), 'selected snapshot bytes');
    const manifestPath = path.join(snapshot, 'manifests', 'm.json');
    const manifests = require('../../src/services/backupManifest');
    selectedManifest = await manifests.generateManifest({
      backupPath: snapshot,
      files: [{ path: path.join(snapshot, 'a.jpg'), relativePath: 'a.jpg', size: 23,
        checksum: require('crypto').createHash('sha256').update('selected snapshot bytes').digest('hex') }],
      customMetadata: { restore_point: 'standalone-v1', destination_type: 'local',
        restore_point_manifest_layout: 'nested' },
    });
    await manifests.saveManifest(selectedManifest, manifestPath);
    await config({ backup_destination_type: 's3' });
    const response = await download(await run(manifestPath)).buffer(true).parse((res, callback) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
    });
    expect(response.status).toBe(200);
    const zipPath = path.join(root, 'download.zip');
    await fs.writeFile(zipPath, response.body);
    const zip = new (require('node-stream-zip').async)({ file: zipPath });
    try {
      expect((await zip.entryData('a.jpg')).toString()).toBe('selected snapshot bytes');
      expect(JSON.parse((await zip.entryData('manifest.json')).toString())).toEqual(selectedManifest);
      const rescued = path.join(root, 'picpeak-backup-extracted-by-download-name');
      await fs.mkdir(rescued);
      await zip.extract(null, rescued);
      await fs.rm(snapshot, { recursive: true });
      await config({ backup_destination_type: 'local', backup_destination_path: rescued });
      const { resolveBackupPointLocation } = require('../../src/utils/backupRestorePoint');
      const { restoreService } = require('../../src/services/restoreService');
      const options = { source: 'local', manifestPath: path.join(rescued, 'manifest.json'), restoreType: 'files' };
      const restoredManifest = await manifests.loadManifest(options.manifestPath);
      const selected = await resolveBackupPointLocation(restoredManifest, options, { backup_destination_path: rescued });
      expect(selected).toBe(await fs.realpath(rescued));
      expect((await restoreService.performFilesRestore(selected, restoredManifest, options)).filesRestored).toBe(1);
      expect(await fs.readFile(path.join(process.env.STORAGE_PATH, 'a.jpg'), 'utf8')).toBe('selected snapshot bytes');
    } finally { await zip.close(); }
  });
  it('leaves standalone snapshots out of a legacy run\'s archive of the destination root', async () => {
    const legacyRoot = path.join(root, 'legacy-destination');
    const snapshot = path.join(legacyRoot, 'backup-00000000-0000-4000-8000-000000000001');
    await fs.mkdir(path.join(legacyRoot, 'events', 'active'), { recursive: true });
    await fs.mkdir(path.join(legacyRoot, 'manifests'), { recursive: true });
    await fs.mkdir(snapshot, { recursive: true });
    await fs.writeFile(path.join(legacyRoot, 'events', 'active', 'a.jpg'), 'legacy mirror bytes');
    await fs.writeFile(path.join(legacyRoot, 'top-level.txt'), 'legacy file');
    await fs.writeFile(path.join(snapshot, 'a.jpg'), 'another run entirely');
    const manifestPath = path.join(legacyRoot, 'manifests', 'backup-manifest-legacy.json');
    await fs.writeFile(manifestPath, '{}');
    await config({ backup_destination_path: legacyRoot });
    selectedManifest = { backup: { type: 'full' }, metadata: { destination_type: 'local' } };
    const response = await download(await run(manifestPath)).buffer(true).parse((res, callback) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
    });
    expect(response.status).toBe(200);
    const zipPath = path.join(root, 'legacy-download.zip');
    await fs.writeFile(zipPath, response.body);
    const zip = new (require('node-stream-zip').async)({ file: zipPath });
    try {
      const names = Object.keys(await zip.entries()).filter(name => !name.endsWith('/')).sort();
      expect(names).toEqual([
        'events/active/a.jpg', 'manifest.json', 'manifests/backup-manifest-legacy.json', 'top-level.txt',
      ]);
    } finally { await zip.close(); }
  });
  it('refuses an out-of-root snapshot path in the selected manifest', async () => {
    selectedManifest.backup.path = '/not-an-operator-configured-root';
    selectedManifest.metadata.destination_type = 'local';
    expect((await download(await run(path.join(root, 'm.json')))).status).toBe(500);
  });
});
