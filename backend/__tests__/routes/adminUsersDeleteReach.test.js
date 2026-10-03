/**
 * DELETE /api/admin/users/:id — a delegated users.delete holder's reach.
 *
 * Deleting an admin SET NULLs events.created_by, and ownerless events are
 * readable by every admin (middleware/ownership.js), so a non-super caller
 * must not be able to delete an owner and inherit their galleries, nor an
 * account whose role carries permissions the caller lacks. super_admin keeps
 * both abilities.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-users-delete-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'users-delete-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-users-delete-storage-'));

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('../integration/helpers/crmDb');
const svc = require('../../src/services/userManagementService');
const { clearPermissionCache } = require('../../src/middleware/permissions');

describe('DELETE /api/admin/users/:id — target reach', () => {
  let db; let cleanup; let app;
  let superId; let superTok; let removerTok;
  let juniorRoleId; let adminRoleId;

  const auth = (req, tok) => req.set('Authorization', `Bearer ${tok}`);
  const insertId = async (table, row) => {
    const ins = await db(table).insert(row).returning('id');
    return ins[0]?.id ?? ins[0];
  };
  const insertAdmin = (username, role_id) => insertId('admin_users', {
    username, email: `${username}@example.com`, password_hash: 'x', role_id,
    must_change_password: false, is_active: true, created_at: new Date().toISOString(),
  });
  const mkEvent = (slug, createdBy) => insertId('events', {
    slug, event_type: 'wedding', event_name: `Event ${slug}`, event_date: '2026-08-01',
    host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
    share_link: `/gallery/${slug}/share`, share_token: `${slug}-share`,
    expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
    is_active: 1, is_archived: 0, is_draft: 0, created_by: createdBy,
    created_at: new Date().toISOString(),
  });
  const exists = async (id) => Boolean(await db('admin_users').where({ id }).first());

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId: superId } = await seedMinimal(db));
    await assignAdminRole(db, superId, 'super_admin');
    superTok = mintAdminToken(superId);

    const junior = await svc.createRole({ name: 'junior', permissions: ['events.view'] }, superId);
    juniorRoleId = junior.id;
    adminRoleId = (await db('roles').where({ name: 'admin' }).first()).id;

    // The delegated account manager: holds the junior role's permissions
    // plus the user lifecycle ones, far less than the built-in admin role.
    const remover = await svc.createRole(
      { name: 'remover', permissions: ['events.view', 'users.view', 'users.delete'] },
      superId,
    );
    removerTok = mintAdminToken(await insertAdmin('remover', remover.id));
    clearPermissionCache();

    app = buildRouteApp('/api/admin/users', require('../../src/routes/adminUsers'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('refuses a non-super caller an account that still owns events', async () => {
    const owner = await insertAdmin('owner', juniorRoleId);
    const eventId = await mkEvent('owned', owner);

    const res = await auth(request(app).delete(`/api/admin/users/${owner}`), removerTok);
    expect(res.status).toBe(409);
    expect(await exists(owner)).toBe(true);
    expect((await db('events').where({ id: eventId }).first()).created_by).toBe(owner);
  });

  it('refuses a non-super caller an account that still owns projects', async () => {
    const owner = await insertAdmin('project-owner', juniorRoleId);
    await insertId('projects', {
      name: 'theirs', status: 'active', created_by: owner,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });

    const res = await auth(request(app).delete(`/api/admin/users/${owner}`), removerTok);
    expect(res.status).toBe(409);
    expect(await exists(owner)).toBe(true);
  });

  it('refuses a non-super caller an account whose role exceeds its own permissions', async () => {
    const bigger = await insertAdmin('bigger', adminRoleId);

    const res = await auth(request(app).delete(`/api/admin/users/${bigger}`), removerTok);
    expect(res.status).toBe(403);
    expect(await exists(bigger)).toBe(true);
  });

  it('lets a non-super caller delete a contained account that owns nothing', async () => {
    const target = await insertAdmin('plain', juniorRoleId);

    const res = await auth(request(app).delete(`/api/admin/users/${target}`), removerTok);
    expect(res.status).toBe(200);
    expect(await exists(target)).toBe(false);
  });

  it('lets a super_admin delete an owner', async () => {
    const owner = await insertAdmin('owner-for-super', adminRoleId);
    await mkEvent('owned-super', owner);

    const res = await auth(request(app).delete(`/api/admin/users/${owner}`), superTok);
    expect(res.status).toBe(200);
    expect(await exists(owner)).toBe(false);
  });
});
