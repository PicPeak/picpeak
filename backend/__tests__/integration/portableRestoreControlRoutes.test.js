'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { bootCrmDb } = require('./helpers/crmDb');
const { createWorkRegistry } = require('../../src/services/activeApplicationWork');
const { createApplicationWorkMiddleware, ownRouteHandlers } = require('../../src/middleware/applicationWork');

describe('exact portable restore control admission', () => {
  let db, cleanup, app, work, restore, uploadRoot, superId, adminId, inactiveId;
  const attemptId = crypto.randomUUID();
  const capability = 'c'.repeat(64);
  const token = (id, type = 'admin') => jwt.sign({ id, type, role: 'super_admin' }, process.env.JWT_SECRET,
    { issuer: 'picpeak-auth', expiresIn: '30m' });
  beforeAll(async () => {
    let tmpDir;
    ({ db, cleanup, tmpDir } = await bootCrmDb());
    uploadRoot = path.join(tmpDir, 'control-uploads'); await fs.mkdir(uploadRoot, { mode: 0o700 });
    const superRole = await db('roles').where({ name: 'super_admin' }).first();
    const ordinaryRole = await db('roles').where({ name: 'admin' }).first();
    const users = await db('admin_users').insert([
      { username: 'restore_super', email: 'restore-super@example.test', password_hash: 'fixture', role_id: superRole.id, is_active: 1, must_change_password: 0 },
      { username: 'restore_delegated', email: 'restore-admin@example.test', password_hash: 'fixture', role_id: ordinaryRole.id, is_active: 1, must_change_password: 0 },
      { username: 'restore_inactive', email: 'restore-inactive@example.test', password_hash: 'fixture', role_id: superRole.id, is_active: 0, must_change_password: 0 },
    ]).returning('id');
    [superId, adminId, inactiveId] = users.map(value => value.id ?? value);
  });
  beforeEach(() => {
    work = createWorkRegistry(); work.closeAdmission();
    restore = {
      start: jest.fn(async () => ({ attemptId, progressToken: capability, state: 'draining' })),
      progress: jest.fn(async (id, token, superAdmin) => {
        if (id !== attemptId || (token !== capability && !superAdmin)) {
          throw Object.assign(new Error('not found'), { code: 'RESTORE_NOT_FOUND', statusCode: 404 });
        }
        return { attemptId, state: 'restart_required', restartRequired: true, complete: false,
          summary: { tables: 2, filesRestored: 1 }, outcome: 'committed' };
      }),
    };
    app = express();
    app.use(require('../../src/routes/portableRestoreControl').createRestoreControlRouter({ work, restore, uploadRoot }));
    app.use(createApplicationWorkMiddleware({ work, admitRequest: () => { throw new Error('should never admit'); } }));
    app.all('*', (_req, res) => res.json({ ordinary: true }));
    ownRouteHandlers(app, work);
  });
  afterAll(async () => { await cleanup(); });
  const importAt = url => request(app).post(url).attach('backup', Buffer.from('complete owned archive fixture'), 'test.picpeak');

  it.each([['no token', null, 401], ['delegated role with forged super claim', () => token(adminId), 403],
    ['gallery token', () => token(superId, 'gallery'), 403], ['customer token', () => token(superId, 'customer'), 403],
    ['inactive super admin', () => token(inactiveId), 401]])('rejects %s before multipart storage', async (_name, auth, status) => {
    let call = importAt('/api/admin/backup/picpeak/import');
    if (auth) call = call.set('Authorization', `Bearer ${auth()}`);
    await call.expect(status);
    expect(restore.start).not.toHaveBeenCalled();
    expect(await fs.readdir(uploadRoot)).toEqual([]);
  });

  it('admits real live typed SuperAdmin, not JWT/body role strings, and does not drain its own upload response', async () => {
    const response = await importAt('/API/ADMIN/BACKUP/PICPEAK/IMPORT').set('Authorization', `Bearer ${token(superId)}`).expect(202);
    expect(response.body).toMatchObject({ attemptId, progressToken: capability });
    expect(restore.start).toHaveBeenCalledWith({ archivePath: expect.stringContaining(uploadRoot), operatorId: superId, options: {} });
    expect(work.pendingCount()).toBe(0);
    expect(await fs.readdir(uploadRoot)).toEqual([]);
  });

  it('rejects malformed extra multipart options rather than granting a broad worker argument shape', async () => {
    await request(app).post('/api/admin/backup/picpeak/import').set('Authorization', `Bearer ${token(superId)}`)
      .field('options[force]', 'true').attach('backup', Buffer.from('fixture'), 'test.picpeak').expect(400);
    expect(restore.start).not.toHaveBeenCalled();
  });

  it('the one-attempt read-only capability survives invalid sessions and remains sanitized/no-store', async () => {
    const response = await request(app).get(`/api/admin/backup/picpeak/restore/${attemptId}`)
      .set('Authorization', 'Bearer invalidated-session').set('X-Picpeak-Restore-Progress', capability).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({ restartRequired: true });
    expect(restore.progress).toHaveBeenCalledWith(attemptId, capability, false);
    expect(JSON.stringify(response.body)).not.toContain(capability);
  });

  it('live typed SuperAdmin may inspect progress without a capability but ordinary admins may not', async () => {
    await request(app).get(`/api/admin/backup/picpeak/restore/${attemptId}`).set('Authorization', `Bearer ${token(adminId)}`).expect(403);
    await request(app).get(`/api/admin/backup/picpeak/restore/${attemptId}`).set('Authorization', `Bearer ${token(superId)}`).expect(200);
    expect(restore.progress).toHaveBeenCalledWith(attemptId, undefined, true);
  });

  it.each([['GET', '/api/admin/users'], ['POST', `/api/admin/backup/picpeak/restore/${attemptId}`],
    ['GET', '/api/admin/backup/picpeak/import'], ['GET', `/api/admin/backup/picpeak/restore/${attemptId}/other`],
    ['GET', '/health'], ['GET', '/uploads/logos/example.png']])('progress headers do not open %s %s', async (method, url) => {
    await request(app)[method.toLowerCase()](url).set('Authorization', `Bearer ${token(superId)}`)
      .set('X-Picpeak-Restore-Progress', capability).expect(503);
    expect(restore.start).not.toHaveBeenCalled();
    expect(restore.progress).not.toHaveBeenCalled();
  });

  it('unknown/changed capabilities and attempts share a bounded not-found response', async () => {
    const bad = await request(app).get(`/api/admin/backup/picpeak/restore/${attemptId}`).set('X-Picpeak-Restore-Progress', 'b'.repeat(64)).expect(404);
    const other = await request(app).get(`/api/admin/backup/picpeak/restore/${crypto.randomUUID()}`).set('X-Picpeak-Restore-Progress', capability).expect(404);
    expect(bad.body).toEqual(other.body);
  });
});
