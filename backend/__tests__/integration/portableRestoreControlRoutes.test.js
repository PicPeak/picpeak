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
const { fixtureIngress } = require('./helpers/restoreIngress');

describe('exact portable restore control admission', () => {
  let db, cleanup, app, work, restore, uploadRoot, superId, adminId, inactiveId, ingress;
  const attemptId = crypto.randomUUID();
  const capability = 'c'.repeat(64);
  const token = (id, type = 'admin') => jwt.sign({ id, type, role: 'super_admin' }, process.env.JWT_SECRET,
    { issuer: 'picpeak-auth', expiresIn: '30m' });
  beforeAll(async () => {
    let tmpDir;
    ({ db, cleanup, tmpDir } = await bootCrmDb());
    uploadRoot = path.join(tmpDir, 'control-uploads');
    const fixture = await fixtureIngress(uploadRoot);
    ingress = fixture.ingress; uploadRoot = fixture.storage.privateRoot;
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
      admitUpload: jest.fn(async () => {}),
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
    app.use(require('../../src/routes/portableRestoreControl').createRestoreControlRouter({ work, restore, ingress }));
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
    expect((await fs.readdir(uploadRoot)).filter(name => name !== 'upload.lease' && name !== 'uploads')).toEqual([]);
  });

  it('admits real live typed SuperAdmin, not JWT/body role strings, and does not drain its own upload response', async () => {
    const response = await importAt('/API/ADMIN/BACKUP/PICPEAK/IMPORT').set('Authorization', `Bearer ${token(superId)}`).expect(202);
    expect(response.body).toMatchObject({ attemptId, progressToken: capability });
    expect(restore.start).toHaveBeenCalledWith({ archivePath: expect.stringContaining(uploadRoot), operatorId: superId, options: {} });
    expect(work.pendingCount()).toBe(0);
    expect(await fs.readdir(path.join(uploadRoot, 'uploads'))).toEqual([]);
  });

  it('rejects malformed extra multipart options rather than granting a broad worker argument shape', async () => {
    await request(app).post('/api/admin/backup/picpeak/import').set('Authorization', `Bearer ${token(superId)}`)
      .field('options[force]', 'true').attach('backup', Buffer.from('fixture'), 'test.picpeak').expect(400);
    expect(restore.start).not.toHaveBeenCalled();
  });

  it('rejects an unexpired but idle-expired SuperAdmin before multipart parsing', async () => {
    const iat = Math.floor(Date.now() / 1000) - 2 * 60 * 60;
    const stale = jwt.sign({ id: superId, type: 'admin', role: 'super_admin', iat }, process.env.JWT_SECRET,
      { issuer: 'picpeak-auth', expiresIn: '24h' });
    expect(jwt.verify(stale, process.env.JWT_SECRET).exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(await require('../../src/middleware/sessionTimeout').isSessionExpired(stale, jwt.decode(stale))).toBe(true);
    const response = await importAt('/api/admin/backup/picpeak/import').set('Authorization', `Bearer ${stale}`).expect(401);
    expect(response.body.code).toBe('SESSION_TIMEOUT');
    expect(restore.start).not.toHaveBeenCalled();
    expect(restore.admitUpload).not.toHaveBeenCalled();
    expect(await fs.readdir(path.join(uploadRoot, 'uploads'))).toEqual([]);
    await request(app).get(`/api/admin/backup/picpeak/restore/${attemptId}`).set('Authorization', `Bearer ${stale}`).expect(401);
    expect(restore.progress).not.toHaveBeenCalled();
  });

  it('preserves remembered admin idle exemption without exempting typed active authentication', async () => {
    const iat = Math.floor(Date.now() / 1000) - 2 * 60 * 60;
    const remembered = jwt.sign({ id: superId, type: 'admin', role: 'super_admin', rememberMe: true, iat }, process.env.JWT_SECRET,
      { issuer: 'picpeak-auth', expiresIn: '24h' });
    await importAt('/api/admin/backup/picpeak/import').set('Authorization', `Bearer ${remembered}`).expect(202);
    expect(restore.start).toHaveBeenCalledTimes(1);
  });

  it('checks fresh ready/open admission before any multipart file parsing', async () => {
    restore.admitUpload.mockRejectedValue(Object.assign(new Error('fenced'), { code: 'RESTORE_MAINTENANCE', statusCode: 503 }));
    await importAt('/api/admin/backup/picpeak/import').set('Authorization', `Bearer ${token(superId)}`).expect(503);
    expect(restore.start).not.toHaveBeenCalled();
    expect(await fs.readdir(path.join(uploadRoot, 'uploads'))).toEqual([]);
  });

  it.each(['two files', 'long field name', 'wrong field', 'ordinary field'])('bounded multipart rejects %s without starting a worker', async kind => {
    let call = request(app).post('/api/admin/backup/picpeak/import').set('Authorization', `Bearer ${token(superId)}`);
    if (kind === 'ordinary field') call = call.field('operatorId', String(superId));
    call = call.attach(kind === 'long field name' ? 'a'.repeat(101) : kind === 'wrong field' ? 'other' : 'backup', Buffer.from('fixture'), 'test.picpeak');
    if (kind === 'two files') call = call.attach('backup', Buffer.from('second fixture'), 'second.picpeak');
    await call.expect(400);
    expect(restore.start).not.toHaveBeenCalled();
    expect(await fs.readdir(path.join(uploadRoot, 'uploads'))).toEqual([]);
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
