/**
 * The backup_retention_count setting and the age-based S3 cleanup route. Every
 * local and S3 run is a complete standalone snapshot, so both decide how much
 * storage a destination ends up holding.
 */
const request = require('supertest');
const express = require('express');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken,
} = require('../integration/helpers/crmDb');

const mockList = jest.fn();
const mockDeleteMany = jest.fn();
jest.mock('../../src/services/storage/s3Storage', () => class {
  list(prefix, options) { return mockList(prefix, options); }
  deleteMany(keys) { return mockDeleteMany(keys); }
});

describe('standalone snapshot retention routes', () => {
  let db; let cleanup; let app; let token;
  const stored = async key => {
    const row = await db('app_settings').where('setting_key', key).first();
    return row ? JSON.parse(row.setting_value) : undefined;
  };
  const put = body => request(app).put('/backup/config').set('Authorization', 'Bearer ' + token).send(body);
  const cleanupS3 = body => request(app).delete('/backup/s3/cleanup').set('Authorization', 'Bearer ' + token).send(body);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId);
    token = mintAdminToken(adminId);
    app = express();
    app.use(express.json());
    app.use('/backup', require('../../src/routes/adminBackup'));
  }, 120000);
  afterAll(async () => { await cleanup(); });
  beforeEach(() => {
    mockList.mockReset();
    mockDeleteMany.mockReset();
    mockDeleteMany.mockImplementation(async keys => ({ Deleted: keys.map(Key => ({ Key })), Errors: [] }));
  });

  it.each([0, 1, 7, 1000])('stores backup_retention_count %j', async value => {
    expect((await put({ backup_retention_count: value })).status).toBe(200);
    expect(await stored('backup_retention_count')).toBe(value);
  });

  it.each([-1, 1001, 2.5, '3', '3; rm -rf /', null, true, [3]])('refuses backup_retention_count %j', async value => {
    await put({ backup_retention_count: 5 });
    const res = await put({ backup_retention_count: value });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/backup_retention_count/);
    expect(await stored('backup_retention_count')).toBe(5);
  });

  describe('DELETE /s3/cleanup', () => {
    const old = new Date(Date.now() - 90 * 86400000).toISOString();
    const recent = new Date(Date.now() - 86400000).toISOString();
    const oldPoint = 'archive/2026/07/01/backup-00000000-0000-4000-8000-000000000001';
    const straddling = 'archive/2026/09/01/backup-00000000-0000-4000-8000-000000000002';
    const legacy = 'archive/2026/06/01/backup-1756692000000';

    beforeEach(async () => {
      for (const [key, value] of Object.entries({
        backup_destination_type: 's3', backup_s3_bucket: 'bucket', backup_s3_prefix: 'archive',
        backup_s3_endpoint: 'https://fixture.example', backup_s3_access_key: 'fixture', backup_s3_secret_key: 'fixture',
      })) {
        await db('app_settings').insert({
          setting_key: key, setting_value: JSON.stringify(value), setting_type: 'backup',
        }).onConflict('setting_key').merge();
      }
      mockList
        .mockResolvedValueOnce({
          Contents: [
            { Key: oldPoint + '/events/a.jpg', LastModified: old, Size: 10 },
            { Key: oldPoint + '/manifests/m.json', LastModified: old, Size: 1 },
            { Key: legacy + '/events/b.jpg', LastModified: old, Size: 20 },
          ],
          IsTruncated: true, NextContinuationToken: 'page-2',
        })
        .mockResolvedValueOnce({
          Contents: [
            // One run never goes in part: its newest object is still in date.
            { Key: straddling + '/events/a.jpg', LastModified: old, Size: 10 },
            { Key: straddling + '/manifests/m.json', LastModified: recent, Size: 1 },
            { Key: 'archive/loose.txt', LastModified: old, Size: 5 },
            { Key: 'elsewhere/x', LastModified: old, Size: 5 },
          ],
          IsTruncated: false,
        });
    });

    it('reads the adapter\'s Contents pages under the configured prefix and removes aged runs whole', async () => {
      const res = await cleanupS3({ retentionDays: 30 });
      expect(res.status).toBe(200);
      expect(mockList).toHaveBeenNthCalledWith(1, 'archive/', { maxKeys: 1000, continuationToken: undefined });
      expect(mockList).toHaveBeenNthCalledWith(2, 'archive/', { maxKeys: 1000, continuationToken: 'page-2' });
      expect(mockDeleteMany.mock.calls[0][0].sort()).toEqual([
        oldPoint + '/events/a.jpg', oldPoint + '/manifests/m.json', legacy + '/events/b.jpg', 'archive/loose.txt',
      ].sort());
      expect(res.body).toMatchObject({ deletedCount: 4, totalSize: 36 });
    });

    it('previews without deleting', async () => {
      const res = await cleanupS3({ retentionDays: 30, dryRun: true });
      expect(res.body.wouldDelete).toBe(4);
      expect(mockDeleteMany).not.toHaveBeenCalled();
    });

    it('never removes the newest run, however old', async () => {
      mockList.mockReset();
      mockList.mockResolvedValueOnce({
        Contents: [
          { Key: oldPoint + '/events/a.jpg', LastModified: new Date(Date.now() - 80 * 86400000).toISOString(), Size: 10 },
          { Key: legacy + '/events/b.jpg', LastModified: old, Size: 20 },
        ],
        IsTruncated: false,
      });
      await cleanupS3({ retentionDays: 30 });
      expect(mockDeleteMany).toHaveBeenCalledWith([legacy + '/events/b.jpg']);
    });
  });
});
