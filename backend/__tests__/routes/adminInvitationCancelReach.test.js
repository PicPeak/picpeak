/**
 * DELETE /api/admin/users/invitations/:id — a users.create holder's reach.
 *
 * Creating an invitation refuses a non-super actor the super_admin role and
 * any role carrying permissions the actor lacks. Cancelling must hold the
 * same line, and an accepted invitation is an account's provenance and is
 * never deleted.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-invite-cancel-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'invite-cancel-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-invite-cancel-storage-'));

const request = require('supertest');
const crypto = require('crypto');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('../integration/helpers/crmDb');
const svc = require('../../src/services/userManagementService');
const { clearPermissionCache } = require('../../src/middleware/permissions');

describe('DELETE /api/admin/users/invitations/:id — target reach', () => {
  let db; let cleanup; let app;
  let superId; let superTok; let inviterTok;
  let juniorRoleId; let adminRoleId; let superRoleId;

  const auth = (req, tok) => req.set('Authorization', `Bearer ${tok}`);
  const insertId = async (table, row) => {
    const ins = await db(table).insert(row).returning('id');
    return ins[0]?.id ?? ins[0];
  };
  const mkInvitation = (email, role_id, extra = {}) => insertId('admin_invitations', {
    email, token: crypto.randomBytes(32).toString('hex'), role_id, invited_by: superId,
    expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
    created_at: new Date().toISOString(), ...extra,
  });
  const exists = async (id) => Boolean(await db('admin_invitations').where({ id }).first());

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId: superId } = await seedMinimal(db));
    await assignAdminRole(db, superId, 'super_admin');
    superTok = mintAdminToken(superId);

    juniorRoleId = (await svc.createRole({ name: 'junior', permissions: ['events.view'] }, superId)).id;
    adminRoleId = (await db('roles').where({ name: 'admin' }).first()).id;
    superRoleId = (await db('roles').where({ name: 'super_admin' }).first()).id;

    const inviter = await svc.createRole(
      { name: 'inviter', permissions: ['events.view', 'users.view', 'users.create'] },
      superId,
    );
    inviterTok = mintAdminToken(await insertId('admin_users', {
      username: 'inviter', email: 'inviter@example.com', password_hash: 'x', role_id: inviter.id,
      must_change_password: false, is_active: true, created_at: new Date().toISOString(),
    }));
    clearPermissionCache();

    app = buildRouteApp('/api/admin/users', require('../../src/routes/adminUsers'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('refuses a non-super caller a super_admin invitation', async () => {
    const id = await mkInvitation('root@example.com', superRoleId);
    const res = await auth(request(app).delete(`/api/admin/users/invitations/${id}`), inviterTok);
    expect(res.status).toBe(403);
    expect(await exists(id)).toBe(true);
  });

  it('refuses a non-super caller an invitation to a role beyond its own permissions', async () => {
    const id = await mkInvitation('bigger@example.com', adminRoleId);
    const res = await auth(request(app).delete(`/api/admin/users/invitations/${id}`), inviterTok);
    expect(res.status).toBe(403);
    expect(await exists(id)).toBe(true);
  });

  it('never deletes an accepted invitation', async () => {
    const id = await mkInvitation('joined@example.com', juniorRoleId, { accepted_at: new Date().toISOString() });
    const res = await auth(request(app).delete(`/api/admin/users/invitations/${id}`), superTok);
    expect(res.status).toBe(409);
    expect(await exists(id)).toBe(true);
  });

  it('lets a non-super caller cancel a pending invitation within its reach', async () => {
    const id = await mkInvitation('pending@example.com', juniorRoleId);
    const res = await auth(request(app).delete(`/api/admin/users/invitations/${id}`), inviterTok);
    expect(res.status).toBe(200);
    expect(await exists(id)).toBe(false);
  });

  it('lets a super_admin cancel a pending super_admin invitation', async () => {
    const id = await mkInvitation('root2@example.com', superRoleId);
    const res = await auth(request(app).delete(`/api/admin/users/invitations/${id}`), superTok);
    expect(res.status).toBe(200);
    expect(await exists(id)).toBe(false);
  });
});
