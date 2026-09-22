const request = require('supertest');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp } = require('./helpers/crmDb');

let db; let cleanup; let app; let superId; let editorId; let targetId; let service;
beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId: superId } = await seedMinimal(db));
  await assignAdminRole(db, superId);
  service = require('../../src/services/userManagementService');
  const role = await service.createRole({ name: 'status_editor', permissions: ['users.edit'] }, superId);
  for (const username of ['editor', 'target']) {
    const [row] = await db('admin_users').insert({
      username, email: `${username}@example.test`, password_hash: 'unused',
      role_id: role.id, is_active: true, must_change_password: false
    }).returning('id');
    if (username === 'editor') editorId = row.id ?? row;
    else targetId = row.id ?? row;
  }
  require('../../src/middleware/permissions').clearPermissionCache();
  app = buildRouteApp('/users', require('../../src/routes/adminUsers'));
});
afterAll(async () => { if (cleanup) await cleanup(); });

test.each([false, true, 'false', 0, null])('profile updates reject status fields (%p) without partial writes', async (status) => {
  await request(app).put(`/users/${superId}`)
    .set('Authorization', `Bearer ${mintAdminToken(editorId)}`)
    .send({ is_active: status, username: 'changed-name' }).expect(400);
  const user = await db('admin_users').where({ id: superId }).first();
  expect(Boolean(user.is_active)).toBe(true);
  expect(user.username).toBe('tester');
});

test('profile edits without status still work for users.edit', async () => {
  await request(app).put(`/users/${targetId}`)
    .set('Authorization', `Bearer ${mintAdminToken(editorId)}`)
    .send({ username: 'renamed-target' }).expect(200);
});

test('users.edit alone cannot call either status action', async () => {
  for (const action of ['activate', 'deactivate']) {
    await request(app).post(`/users/${superId}/${action}`)
      .set('Authorization', `Bearer ${mintAdminToken(editorId)}`).expect(403);
  }
});

test('authorized status actions retain self and last-super-admin safeguards', async () => {
  await expect(service.deactivateAdminUser(superId, superId)).rejects.toThrow(/own account/);
  await expect(service.deactivateAdminUser(superId, editorId)).rejects.toThrow(/last Super Admin/);
  await request(app).post(`/users/${targetId}/deactivate`)
    .set('Authorization', `Bearer ${mintAdminToken(superId)}`).expect(200);
  expect(Boolean((await db('admin_users').where({ id: targetId }).first()).is_active)).toBe(false);
  await request(app).post(`/users/${targetId}/activate`)
    .set('Authorization', `Bearer ${mintAdminToken(superId)}`).expect(200);
  expect(Boolean((await db('admin_users').where({ id: targetId }).first()).is_active)).toBe(true);
});
