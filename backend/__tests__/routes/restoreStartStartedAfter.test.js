/**
 * /admin/restore/start answers with `startedAfter`, a server timestamp taken
 * before the background run inserts its restore_runs row. The restore wizard
 * keeps it across the forced re-login a database restore causes and treats
 * only a row with started_at >= startedAfter as this run's result, so the
 * previous run is never shown as the outcome of the one just started.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-restore-start-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'restore-start-test-secret';

const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { bootCrmDb } = require('../integration/helpers/crmDb');

describe('POST /admin/restore/start', () => {
  let db;
  let cleanup;
  let app;
  let token;
  let restoreService;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const role = await db('roles').where({ name: 'super_admin' }).first();
    const inserted = await db('admin_users').insert({
      username: 'root-admin',
      email: 'root-admin@example.com',
      password_hash: await bcrypt.hash('Passw0rd!', 4),
      role_id: role.id,
      is_active: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).returning('id');
    const id = inserted[0]?.id ?? inserted[0];
    token = jwt.sign({ id, username: 'root-admin', type: 'admin', role: 'super_admin' },
      process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' });
    await db('app_settings').where({ setting_key: 'backup_destination_path' }).del();
    await db('app_settings').insert({
      setting_key: 'backup_destination_path', setting_value: JSON.stringify('/backup'), setting_type: 'backup',
    });

    ({ restoreService } = require('../../src/services/restoreService'));
    app = express();
    app.use(express.json());
    app.use('/api/admin/restore', require('../../src/routes/adminRestore'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('returns a startedAfter no later than the run it starts', async () => {
    let runStartedAt;
    const restore = jest.spyOn(restoreService, 'restore').mockImplementation(async () => {
      runStartedAt = new Date().toISOString();
    });
    const before = Date.now();
    try {
      const res = await request(app)
        .post('/api/admin/restore/start')
        .set('Authorization', `Bearer ${token}`)
        .send({ source: 'local', manifestPath: '/backup/manifests/backup-manifest-1.json', restoreType: 'database' });

      expect(res.status).toBe(200);
      expect(restore).toHaveBeenCalledTimes(1);
      const startedAfter = Date.parse(res.body.startedAfter);
      expect(startedAfter).toBeGreaterThanOrEqual(before);
      expect(startedAfter).toBeLessThanOrEqual(Date.parse(runStartedAt));
    } finally {
      restore.mockRestore();
    }
  });
});
