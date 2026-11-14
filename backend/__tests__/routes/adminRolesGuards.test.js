/**
 * Role-editor self-amplification guard (migration 175 / adminRoles).
 *
 * `roles.manage` must be a DELEGATION primitive, not root escalation: a
 * non-super_admin holder can only grant permissions their OWN role already
 * holds, and can't edit their own role. super_admin bypasses. Pins
 * userManagementService.createRole / updateRole (assertActorMayGrant).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-roleguard-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'roleguard-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-roleguard-storage-'));

const { bootCrmDb, seedMinimal, assignAdminRole } = require('../integration/helpers/crmDb');
const svc = require('../../src/services/userManagementService');
const { clearPermissionCache } = require('../../src/middleware/permissions');

describe('role editor — self-amplification guard', () => {
  let db; let cleanup;
  let superId; let mgrRoleId; let mgrId;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId: superId } = await seedMinimal(db));
    await assignAdminRole(db, superId, 'super_admin');

    // A non-super role that CAN manage roles but only holds a couple of perms.
    const mgrRole = await svc.createRole(
      { name: 'limited_mgr', permissions: ['roles.manage', 'events.view'] },
      superId,
    );
    mgrRoleId = mgrRole.id;
    const ins = await db('admin_users').insert({
      username: 'mgr', email: 'mgr@example.com', password_hash: 'x',
      role_id: mgrRoleId, must_change_password: false, created_at: new Date(),
    }).returning('id');
    mgrId = ins[0]?.id ?? ins[0];
    clearPermissionCache();
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('super_admin can grant any permission', async () => {
    const r = await svc.createRole(
      { name: 'power_role', permissions: ['settings.banking', 'users.delete'] },
      superId,
    );
    expect(r.permissions).toEqual(expect.arrayContaining(['settings.banking', 'users.delete']));
  });

  it('non-super cannot grant a permission its own role lacks', async () => {
    await expect(
      svc.createRole({ name: 'sneaky', permissions: ['events.view', 'settings.banking'] }, mgrId),
    ).rejects.toThrow(/only grant permissions your own role/i);
  });

  it('non-super can create a role within its own permissions', async () => {
    const r = await svc.createRole({ name: 'viewer_lite', permissions: ['events.view'] }, mgrId);
    expect(r.permissions).toEqual(['events.view']);
  });

  it('non-super cannot edit its own role', async () => {
    await expect(
      svc.updateRole(mgrRoleId, { permissions: ['roles.manage', 'events.view'] }, mgrId),
    ).rejects.toThrow(/cannot edit your own role/i);
  });

  it('non-super cannot escalate another role beyond its own permissions', async () => {
    const lite = await db('roles').where({ name: 'viewer_lite' }).first();
    await expect(
      svc.updateRole(lite.id, { permissions: ['settings.banking'] }, mgrId),
    ).rejects.toThrow(/only grant permissions your own role/i);
  });

  it('non-super cannot edit a role holding permissions it lacks', async () => {
    const adminRole = await db('roles').where({ name: 'admin' }).first();
    await expect(
      svc.updateRole(adminRole.id, { permissions: ['events.view'] }, mgrId),
    ).rejects.toThrow(/edit roles within your own permissions/i);
  });

  it('the built-in team_photographer name is reserved', async () => {
    await expect(
      svc.createRole({ name: 'team_photographer', permissions: [] }, superId),
    ).rejects.toThrow(/reserved/i);
  });
});
