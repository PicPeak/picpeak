/**
 * DELETE /api/admin/backup/runs/:id (issue 1711). The History table's trash
 * action called this route while only GET /runs/:id existed. Deletion targets
 * come from the run's own recorded manifest location, never from the request,
 * and the record is removed only once the artifact step succeeded.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-backup-run-delete-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'backup-run-delete-test-secret';

const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const mockS3 = {
  constructed: [],
  objects: [],
  deleteErrors: [],
  list: jest.fn(),
  deleteMany: jest.fn(),
};

jest.mock('../../src/services/storage/s3Storage', () => (
  class FakeS3StorageAdapter {
    constructor(config) { mockS3.constructed.push(config); }
    list(prefix, options) { return mockS3.list(prefix, options); }
    deleteMany(keys) { return mockS3.deleteMany(keys); }
  }
));

const { bootCrmDb } = require('../integration/helpers/crmDb');

describe('DELETE /api/admin/backup/runs/:id (issue 1711)', () => {
  let db; let cleanup; let app; let superToken; let viewerToken; let storagePath;

  const insertId = async (table, row) => {
    const inserted = await db(table).insert(row).returning('id');
    return inserted[0]?.id ?? inserted[0];
  };

  const tokenFor = async (username, roleName) => {
    const role = await db('roles').where({ name: roleName }).first();
    const id = await insertId('admin_users', {
      username,
      email: `${username}@example.com`,
      password_hash: await bcrypt.hash('Passw0rd!', 4),
      role_id: role.id,
      is_active: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    return jwt.sign(
      { id, username, type: 'admin', role: roleName, loginTime: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' },
    );
  };

  const setBackupSettings = async (settings) => {
    await db('app_settings').where({ setting_type: 'backup' }).del();
    for (const [key, value] of Object.entries(settings)) {
      await db('app_settings').insert({
        setting_key: key, setting_value: JSON.stringify(value), setting_type: 'backup',
        updated_at: new Date().toISOString(),
      });
    }
  };

  const insertRun = (overrides = {}) => insertId('backup_runs', {
    started_at: new Date('2026-09-01T02:00:00Z').toISOString(),
    completed_at: new Date('2026-09-01T02:05:00Z').toISOString(),
    status: 'completed',
    backup_type: 'full',
    ...overrides,
  });

  const del = (id, token = superToken) => request(app)
    .delete(`/api/admin/backup/runs/${id}`)
    .set('Authorization', `Bearer ${token}`);

  const runExists = async (id) => Boolean(await db('backup_runs').where('id', id).first());
  const lastAudit = () => db('activity_logs').orderBy('id', 'desc').first();

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    storagePath = process.env.STORAGE_PATH;

    const viewerRoleId = await insertId('roles', {
      name: 'backup-viewer', display_name: 'Backup viewer', description: 'test role', is_system: false, priority: 10,
    });
    const viewPermission = await db('permissions').where({ name: 'backup.view' }).first();
    await db('role_permissions').insert({ role_id: viewerRoleId, permission_id: viewPermission.id });

    superToken = await tokenFor('root-admin', 'super_admin');
    viewerToken = await tokenFor('backup-viewer', 'backup-viewer');

    app = express();
    app.use(express.json());
    app.use('/api/admin/backup', require('../../src/routes/adminBackup'));
  }, 120000);

  beforeEach(async () => {
    mockS3.constructed = [];
    mockS3.list.mockReset();
    mockS3.deleteMany.mockReset();
    await db('activity_logs').del();
    await db('backup_manifest').del();
    await db('backup_runs').del();
    await setBackupSettings({
      backup_destination_type: 'local',
      backup_destination_path: path.join(storagePath, 'backups'),
    });
  });

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  describe('authorisation and lookup', () => {
    it('refuses a role without backup.delete with 403 and touches nothing', async () => {
      const manifest = path.join(storagePath, 'backups', 'manifests', 'backup-manifest-403.json');
      fs.mkdirSync(path.dirname(manifest), { recursive: true });
      fs.writeFileSync(manifest, '{}');
      const id = await insertRun({ manifest_path: manifest });

      const res = await del(id, viewerToken);
      expect(res.status).toBe(403);
      expect(await runExists(id)).toBe(true);
      expect(fs.existsSync(manifest)).toBe(true);
    });

    it('answers 404 with a stable code for an unknown id, without any path in the body', async () => {
      const res = await del(999999);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Backup run not found', code: 'BACKUP_NOT_FOUND' });
      expect(JSON.stringify(res.body)).not.toContain(storagePath);
    });

    it.each(['abc', '-1', '1.5', '1/../2', '%2e%2e'])('treats a crafted id %s as not found', async (crafted) => {
      const res = await request(app)
        .delete(`/api/admin/backup/runs/${crafted}`)
        .set('Authorization', `Bearer ${superToken}`);
      expect(res.status).toBe(404);
    });

    it('refuses to delete a running backup', async () => {
      const id = await insertRun({ status: 'running', completed_at: null });
      const res = await del(id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('BACKUP_RUNNING');
      expect(await runExists(id)).toBe(true);
    });
  });

  describe('local destination', () => {
    it('deletes the manifest inside the manifest directory, the record, its manifest row, and audits it', async () => {
      const manifest = path.join(storagePath, 'backups', 'manifests', 'backup-manifest-local.json');
      fs.mkdirSync(path.dirname(manifest), { recursive: true });
      fs.writeFileSync(manifest, '{}');
      const id = await insertRun({ manifest_path: manifest, manifest_id: 'backup-manifest-local' });
      await db('backup_manifest').insert({
        backup_run_id: id,
        manifest_id: '11111111-1111-4111-8111-111111111111',
        backup_start: new Date('2026-09-01T02:00:00Z').toISOString(),
        backup_end: new Date('2026-09-01T02:05:00Z').toISOString(),
      });
      const childId = await insertRun({ parent_backup_id: id });

      const res = await del(id);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true, id, destination: 'local',
        artifact: { kind: 'manifest', status: 'deleted', removed: 1 },
      });
      expect(fs.existsSync(manifest)).toBe(false);
      expect(await runExists(id)).toBe(false);
      expect(await db('backup_manifest').where('backup_run_id', id).first()).toBeUndefined();
      const child = await db('backup_runs').where('id', childId).first();
      expect(child.parent_backup_id).toBeNull();

      const audit = await lastAudit();
      expect(audit.activity_type).toBe('backup_run_deleted');
      expect(audit.actor_type).toBe('admin');
      expect(audit.actor_name).toBe('root-admin');
      const metadata = JSON.parse(audit.metadata);
      expect(metadata).toMatchObject({ backup_run_id: id, destination: 'local', artifact: 'deleted' });
      expect(JSON.stringify(metadata)).not.toContain(storagePath);
    });

    it('deletes the record and reports the artifact as missing when the manifest is already gone', async () => {
      const manifest = path.join(storagePath, 'backups', 'manifests', 'backup-manifest-gone.json');
      const id = await insertRun({ manifest_path: manifest });

      const res = await del(id);
      expect(res.status).toBe(200);
      expect(res.body.artifact).toEqual({ kind: 'manifest', status: 'missing', removed: 0 });
      expect(await runExists(id)).toBe(false);
    });

    it('deletes a record that has no manifest at all', async () => {
      const id = await insertRun({ manifest_path: null });
      const res = await del(id);
      expect(res.status).toBe(200);
      expect(res.body.artifact).toEqual({ kind: 'none', status: 'none', removed: 0 });
      expect(await runExists(id)).toBe(false);
    });

    it('refuses a recorded manifest outside the manifest directory and keeps the record and the file', async () => {
      const outside = path.join(storagePath, 'events', 'active', 'not-a-manifest.json');
      fs.mkdirSync(path.dirname(outside), { recursive: true });
      fs.writeFileSync(outside, 'keep me');
      const id = await insertRun({ manifest_path: outside });

      const res = await del(id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ARTIFACT_OUT_OF_SCOPE');
      expect(JSON.stringify(res.body)).not.toContain(storagePath);
      expect(fs.existsSync(outside)).toBe(true);
      expect(await runExists(id)).toBe(true);
      expect((await lastAudit()).activity_type).toBe('backup_run_delete_failed');
    });

    it('refuses a traversal that only textually starts inside the manifest directory', async () => {
      const manifestDir = path.join(storagePath, 'backups', 'manifests');
      const traversal = path.join(manifestDir, '..', '..', 'events', 'traversal.json');
      fs.mkdirSync(path.dirname(path.resolve(traversal)), { recursive: true });
      fs.writeFileSync(path.resolve(traversal), 'keep me');
      const id = await insertRun({ manifest_path: traversal });

      const res = await del(id);
      expect(res.status).toBe(409);
      expect(fs.existsSync(path.resolve(traversal))).toBe(true);
      expect(await runExists(id)).toBe(true);
    });

    it('refuses a manifest reached through a symlinked subdirectory that points outside', async () => {
      const manifestDir = path.join(storagePath, 'backups', 'manifests');
      const outsideDir = path.join(storagePath, 'events', 'active');
      fs.mkdirSync(manifestDir, { recursive: true });
      fs.mkdirSync(outsideDir, { recursive: true });
      const victim = path.join(outsideDir, 'victim.json');
      fs.writeFileSync(victim, 'keep me');
      const link = path.join(manifestDir, 'link');
      fs.rmSync(link, { force: true });
      fs.symlinkSync(outsideDir, link, 'dir');
      const id = await insertRun({ manifest_path: path.join(link, 'victim.json') });

      const res = await del(id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ARTIFACT_OUT_OF_SCOPE');
      expect(fs.existsSync(victim)).toBe(true);
      expect(await runExists(id)).toBe(true);
    });

    it('honours a custom backup_manifest_path', async () => {
      const manifestDir = path.join(storagePath, 'custom-manifests');
      const manifest = path.join(manifestDir, 'backup-manifest-custom.json');
      fs.mkdirSync(manifestDir, { recursive: true });
      fs.writeFileSync(manifest, '{}');
      await setBackupSettings({
        backup_destination_type: 'local',
        backup_destination_path: path.join(storagePath, 'backups'),
        backup_manifest_path: manifestDir,
      });
      const id = await insertRun({ manifest_path: manifest });

      const res = await del(id);
      expect(res.status).toBe(200);
      expect(fs.existsSync(manifest)).toBe(false);
    });
  });

  describe('S3 destination', () => {
    const runPrefix = 'backups/2026/09/01/backup-1756692000000';
    const manifestUri = `s3://picpeak-backups/${runPrefix}/manifests/backup-manifest-s3.json`;

    const s3Settings = (extra = {}) => setBackupSettings({
      backup_destination_type: 's3',
      backup_s3_endpoint: 'https://s3.example.com',
      backup_s3_bucket: 'picpeak-backups',
      backup_s3_access_key: 'key',
      backup_s3_secret_key: 'secret',
      ...extra,
    });

    it('deletes the run manifests and summary, paginated, and never a data object', async () => {
      await s3Settings();
      const id = await insertRun({ manifest_path: manifestUri });
      mockS3.list
        // manifests/ listing, two pages, one stray key the listing should not contain
        .mockResolvedValueOnce({
          Contents: [
            { Key: `${runPrefix}/manifests/backup-manifest-s3.json` },
            { Key: `${runPrefix}/events/active/a.jpg` },
          ],
          IsTruncated: true,
          NextContinuationToken: 'page-2',
        })
        .mockResolvedValueOnce({
          Contents: [{ Key: `${runPrefix}/manifests/backup-manifest-s3.yaml` }],
          IsTruncated: false,
        })
        // backup-summary.json listing
        .mockResolvedValueOnce({
          Contents: [{ Key: `${runPrefix}/backup-summary.json` }],
          IsTruncated: false,
        });
      mockS3.deleteMany.mockImplementation(async (keys) => ({ Deleted: keys.map((Key) => ({ Key })), Errors: [] }));

      const res = await del(id);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ destination: 's3', artifact: { kind: 'manifest', status: 'deleted', removed: 3 } });
      expect(mockS3.list).toHaveBeenNthCalledWith(1, `${runPrefix}/manifests/`, { maxKeys: 1000, continuationToken: undefined });
      expect(mockS3.list).toHaveBeenNthCalledWith(2, `${runPrefix}/manifests/`, { maxKeys: 1000, continuationToken: 'page-2' });
      expect(mockS3.list).toHaveBeenNthCalledWith(3, `${runPrefix}/backup-summary.json`, { maxKeys: 1000, continuationToken: undefined });
      // The data objects an incremental chain relies on are never touched.
      expect(mockS3.deleteMany).toHaveBeenCalledWith([
        `${runPrefix}/manifests/backup-manifest-s3.json`,
        `${runPrefix}/manifests/backup-manifest-s3.yaml`,
        `${runPrefix}/backup-summary.json`,
      ]);
      expect(mockS3.constructed[0]).toMatchObject({ bucket: 'picpeak-backups', endpoint: 'https://s3.example.com' });
      expect(await runExists(id)).toBe(false);
      expect((await lastAudit()).metadata).not.toContain('secret');
    });

    it.each([
      ['/backups', '/backups'],
      ['archive/picpeak/', 'archive/picpeak'],
      ['/nested//custom', '/nested/custom'],
    ])('accepts runs written under a configured prefix of %s the way performS3Backup joins it', async (configured, stored) => {
      await s3Settings({ backup_s3_prefix: configured });
      const prefix = `${stored}/2026/09/01/backup-1756692000000`;
      const id = await insertRun({ manifest_path: `s3://picpeak-backups/${prefix}/manifests/m.json` });
      mockS3.list
        .mockResolvedValueOnce({ Contents: [{ Key: `${prefix}/manifests/m.json` }], IsTruncated: false })
        .mockResolvedValueOnce({ Contents: [], IsTruncated: false });
      mockS3.deleteMany.mockImplementation(async (keys) => ({ Deleted: keys.map((Key) => ({ Key })), Errors: [] }));

      const res = await del(id);
      expect(res.status).toBe(200);
      expect(mockS3.list).toHaveBeenNthCalledWith(1, `${prefix}/manifests/`, { maxKeys: 1000, continuationToken: undefined });
      expect(mockS3.deleteMany).toHaveBeenCalledWith([`${prefix}/manifests/m.json`]);
      expect(await runExists(id)).toBe(false);
    });

    it('refuses a manifest recorded in a bucket other than the configured one', async () => {
      await s3Settings();
      const id = await insertRun({ manifest_path: `s3://someone-elses-bucket/${runPrefix}/manifests/m.json` });
      const res = await del(id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ARTIFACT_OUT_OF_SCOPE');
      expect(mockS3.deleteMany).not.toHaveBeenCalled();
      expect(await runExists(id)).toBe(true);
    });

    it('refuses a manifest key that is not under a per-run prefix of the configured base prefix', async () => {
      await s3Settings();
      for (const key of [
        'backups/manifests/m.json',
        'other/2026/09/01/backup-1756692000000/manifests/m.json',
        'backups/2026/09/01/not-a-run/manifests/m.json',
        'backups/../events/backup-1/manifests/m.json',
      ]) {
        const id = await insertRun({ manifest_path: `s3://picpeak-backups/${key}` });
        const res = await del(id);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('ARTIFACT_OUT_OF_SCOPE');
        expect(await runExists(id)).toBe(true);
      }
      expect(mockS3.list).not.toHaveBeenCalled();
      expect(mockS3.deleteMany).not.toHaveBeenCalled();
    });

    it('refuses an S3 run while the configured destination is not S3', async () => {
      const id = await insertRun({ manifest_path: manifestUri });
      const res = await del(id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ARTIFACT_OUT_OF_SCOPE');
      expect(await runExists(id)).toBe(true);
    });

    it('keeps the record and reports a partial failure when S3 rejects some objects', async () => {
      await s3Settings();
      const id = await insertRun({ manifest_path: manifestUri });
      mockS3.list
        .mockResolvedValueOnce({
          Contents: [{ Key: `${runPrefix}/manifests/a.json` }, { Key: `${runPrefix}/manifests/b.json` }], IsTruncated: false,
        })
        .mockResolvedValueOnce({ Contents: [], IsTruncated: false });
      mockS3.deleteMany.mockResolvedValueOnce({
        Deleted: [{ Key: `${runPrefix}/manifests/a.json` }],
        Errors: [{ Key: `${runPrefix}/manifests/b.json`, Code: 'AccessDenied' }],
      });

      const res = await del(id);
      expect(res.status).toBe(500);
      expect(res.body.code).toBe('ARTIFACT_DELETE_FAILED');
      expect(await runExists(id)).toBe(true);
      const audit = await lastAudit();
      expect(audit.activity_type).toBe('backup_run_delete_failed');
      expect(JSON.parse(audit.metadata)).toMatchObject({ code: 'ARTIFACT_DELETE_FAILED', removed: 1 });
    });

    it('deletes the record when the run metadata is already gone', async () => {
      await s3Settings();
      const id = await insertRun({ manifest_path: manifestUri });
      mockS3.list.mockResolvedValue({ Contents: [], IsTruncated: false });

      const res = await del(id);
      expect(res.status).toBe(200);
      expect(res.body.artifact).toEqual({ kind: 'manifest', status: 'missing', removed: 0 });
      expect(mockS3.deleteMany).not.toHaveBeenCalled();
      expect(await runExists(id)).toBe(false);
    });
  });
});
