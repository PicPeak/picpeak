/**
 * PUT /api/admin/users/:id must not be a weaker path to changes the dedicated
 * routes guard.
 *
 * users.edit is delegable. A holder that is not super_admin must not rewrite a
 * super_admin's email or deactivate them, and no caller may leave the instance
 * without an active super_admin or deactivate themselves here. Email changes
 * also decide whether a later SSO login may link to the account by email
 * (admin_users.email_link_eligible, migration 227).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-users-target-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'users-target-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-users-target-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken,
} = require('../integration/helpers/crmDb');
const svc = require('../../src/services/userManagementService');
const { clearPermissionCache } = require('../../src/middleware/permissions');

describe('PUT /api/admin/users/:id — super_admin targets and deactivation', () => {
  let db; let cleanup; let app;
  let superId; let superTok;
  let clerkId; let clerkTok;
  let removerTok;
  let otherId;

  const auth = (req, tok) => req.set('Authorization', `Bearer ${tok}`);
  const row = (id) => db('admin_users').where({ id }).first();
  const insertAdmin = async (fields) => {
    const ins = await db('admin_users').insert({
      password_hash: 'x', must_change_password: false, is_active: true, created_at: new Date(), ...fields,
    }).returning('id');
    return ins[0]?.id ?? ins[0];
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId: superId } = await seedMinimal(db));
    await assignAdminRole(db, superId, 'super_admin');
    superTok = mintAdminToken(superId);

    // A delegated user manager: users.view + users.edit, nothing else.
    const clerkRole = await svc.createRole(
      { name: 'user_clerk', permissions: ['users.view', 'users.edit'] },
      superId,
    );
    clerkId = await insertAdmin({ username: 'clerk', email: 'clerk@example.com', role_id: clerkRole.id });
    clerkTok = mintAdminToken(clerkId);

    // A delegated account manager for the lifecycle routes: users.delete only.
    const removerRole = await svc.createRole(
      { name: 'user_remover', permissions: ['users.view', 'users.delete'] },
      superId,
    );
    const removerId = await insertAdmin({ username: 'remover', email: 'remover@example.com', role_id: removerRole.id });
    removerTok = mintAdminToken(removerId);

    const viewer = await db('roles').where({ name: 'viewer' }).first();
    otherId = await insertAdmin({ username: 'other', email: 'other@example.com', role_id: viewer && viewer.id });
    clearPermissionCache();

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/users', require('../../src/routes/adminUsers'));
    app.use('/api/admin/auth', require('../../src/routes/adminAuth'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('refuses a users.edit holder rewriting a super_admin\'s email', async () => {
    const before = await row(superId);
    const res = await auth(request(app).put(`/api/admin/users/${superId}`), clerkTok)
      .send({ email: 'attacker@example.com' });
    expect(res.status).toBe(403);
    expect((await row(superId)).email).toBe(before.email);
  });

  it('refuses a users.edit holder deactivating a super_admin', async () => {
    const res = await auth(request(app).put(`/api/admin/users/${superId}`), clerkTok)
      .send({ is_active: false });
    expect(res.status).toBe(403);
    expect(Boolean((await row(superId)).is_active)).toBe(true);
  });

  it('reads is_active \'false\' as false, not as a truthy string', async () => {
    // isBoolean() lets the string through; it used to be stored as active.
    const other = await insertAdmin({ username: 'second-super', email: 'second@example.com' });
    await assignAdminRole(db, other, 'super_admin');
    const res = await auth(request(app).put(`/api/admin/users/${other}`), superTok).send({ is_active: 'false' });
    expect(res.status).toBe(200);
    expect(Boolean((await row(other)).is_active)).toBe(false);
  });

  it('refuses self-deactivation through PUT', async () => {
    const res = await auth(request(app).put(`/api/admin/users/${superId}`), superTok).send({ is_active: false });
    expect(res.status).toBe(400);
    expect(Boolean((await row(superId)).is_active)).toBe(true);
  });

  it('marks an email set by a non-super admin as not eligible for SSO email linking', async () => {
    const res = await auth(request(app).put(`/api/admin/users/${otherId}`), clerkTok)
      .send({ email: 'changed-by-clerk@example.com' });
    expect(res.status).toBe(200);
    const r = await row(otherId);
    expect(r.email).toBe('changed-by-clerk@example.com');
    expect(Boolean(r.email_link_eligible)).toBe(false);
  });

  it('marks a self-edited profile email as not eligible for SSO email linking', async () => {
    const res = await auth(request(app).put('/api/admin/auth/profile'), clerkTok)
      .send({ username: 'clerk', email: 'someone-else@example.com' });
    expect(res.status).toBe(200);
    const r = await row(clerkId);
    expect(r.email).toBe('someone-else@example.com');
    expect(Boolean(r.email_link_eligible)).toBe(false);
  });

  it('marks an email set by a super_admin as eligible again', async () => {
    const res = await auth(request(app).put(`/api/admin/users/${otherId}`), superTok)
      .send({ email: 'set-by-owner@example.com' });
    expect(res.status).toBe(200);
    expect(Boolean((await row(otherId)).email_link_eligible)).toBe(true);
  });

  it('lets a super_admin confirm an email by saving it unchanged', async () => {
    await db('admin_users').where({ id: otherId }).update({ email_link_eligible: false });
    const { email } = await row(otherId);
    const res = await auth(request(app).put(`/api/admin/users/${otherId}`), superTok).send({ email });
    expect(res.status).toBe(200);
    expect(Boolean((await row(otherId)).email_link_eligible)).toBe(true);
  });

  describe('deactivate, activate and delete of a super_admin', () => {
    let targetId;
    beforeAll(async () => {
      targetId = await insertAdmin({ username: 'third-super', email: 'third@example.com' });
      await assignAdminRole(db, targetId, 'super_admin');
    });

    it('refuses a users.delete holder deactivating, activating or deleting a super_admin', async () => {
      let res = await auth(request(app).post(`/api/admin/users/${targetId}/deactivate`), removerTok);
      expect(res.status).toBe(403);
      expect(Boolean((await row(targetId)).is_active)).toBe(true);

      await db('admin_users').where({ id: targetId }).update({ is_active: false });
      res = await auth(request(app).post(`/api/admin/users/${targetId}/activate`), removerTok);
      expect(res.status).toBe(403);
      expect(Boolean((await row(targetId)).is_active)).toBe(false);
      await db('admin_users').where({ id: targetId }).update({ is_active: true });

      res = await auth(request(app).delete(`/api/admin/users/${targetId}`), removerTok);
      expect(res.status).toBe(403);
      expect(await row(targetId)).toBeTruthy();
    });

    it('still lets a users.delete holder deactivate an account that is not a super_admin', async () => {
      const res = await auth(request(app).post(`/api/admin/users/${otherId}/deactivate`), removerTok);
      expect(res.status).toBe(200);
      expect(Boolean((await row(otherId)).is_active)).toBe(false);
      await db('admin_users').where({ id: otherId }).update({ is_active: true });
    });

    it('lets a super_admin deactivate another super_admin', async () => {
      const res = await auth(request(app).post(`/api/admin/users/${targetId}/deactivate`), superTok);
      expect(res.status).toBe(200);
      expect(Boolean((await row(targetId)).is_active)).toBe(false);
    });
  });

});
