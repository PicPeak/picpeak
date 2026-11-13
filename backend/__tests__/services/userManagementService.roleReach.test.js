/**
 * A non-super actor reaches existing accounts and roles only when their
 * current permissions are within the actor's own. deleteAdminUser and
 * cancelInvitation already held that line; profile and role edits,
 * deactivate/activate and role edits now hold it too.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-rolereach-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'rolereach-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-rolereach-storage-'));

const { bootCrmDb, seedMinimal, assignAdminRole } = require('../integration/helpers/crmDb');
const svc = require('../../src/services/userManagementService');
const { clearPermissionCache } = require('../../src/middleware/permissions');

const REACH = /within your own permissions/;

let db; let cleanup; let superId;
let managerId; let managerRoleId;
let broadRoleId; let broadId;
let narrowRoleId; let narrowId;
let seq = 0;

async function addAdmin(roleId, extra = {}) {
  seq += 1;
  const [row] = await db('admin_users').insert({
    username: `reach_${seq}`, email: `reach_${seq}@example.com`, password_hash: 'x',
    role_id: roleId, is_active: true, must_change_password: false, created_at: new Date(), ...extra,
  }).returning('id');
  return row?.id ?? row;
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId: superId } = await seedMinimal(db));
  await assignAdminRole(db, superId, 'super_admin');

  // A delegated user manager: account and role management, nothing else.
  managerRoleId = (await svc.createRole({
    name: 'user_manager',
    permissions: ['users.view', 'users.edit', 'users.delete', 'users.create', 'roles.manage', 'events.view'],
  }, superId)).id;
  managerId = await addAdmin(managerRoleId);

  // Holds a permission the manager lacks.
  broadRoleId = (await svc.createRole({ name: 'broad_role', permissions: ['events.view', 'settings.banking'] }, superId)).id;
  broadId = await addAdmin(broadRoleId);

  // Within the manager's permissions.
  narrowRoleId = (await svc.createRole({ name: 'narrow_role', permissions: ['events.view'] }, superId)).id;
  narrowId = await addAdmin(narrowRoleId);
  clearPermissionCache();
}, 120000);

afterAll(async () => { if (cleanup) await cleanup(); });

describe('accounts above the actor', () => {
  it('cannot be renamed or re-emailed', async () => {
    await expect(svc.updateAdminUser(broadId, { username: 'renamed_by_manager' }, managerId, { roleName: 'user_manager' }))
      .rejects.toThrow(REACH);
    await expect(svc.updateAdminUser(broadId, { email: 'manager-picked@example.com' }, managerId, { roleName: 'user_manager' }))
      .rejects.toThrow(REACH);
    const row = await db('admin_users').where({ id: broadId }).first();
    expect(row.username).not.toBe('renamed_by_manager');
    expect(row.email).not.toBe('manager-picked@example.com');
  });

  it('cannot be moved to another role', async () => {
    await expect(svc.updateAdminUser(broadId, { role_id: narrowRoleId }, managerId, { roleName: 'user_manager' }))
      .rejects.toThrow(REACH);
    expect((await db('admin_users').where({ id: broadId }).first()).role_id).toBe(broadRoleId);
  });

  it('cannot be deactivated or activated', async () => {
    await expect(svc.deactivateAdminUser(broadId, managerId)).rejects.toThrow(REACH);
    expect([true, 1]).toContain((await db('admin_users').where({ id: broadId }).first()).is_active);

    await db('admin_users').where({ id: broadId }).update({ is_active: false });
    await expect(svc.activateAdminUser(broadId, managerId)).rejects.toThrow(REACH);
    expect([false, 0]).toContain((await db('admin_users').where({ id: broadId }).first()).is_active);
    await db('admin_users').where({ id: broadId }).update({ is_active: true });
  });

  it('stay manageable by a Super Admin', async () => {
    await svc.deactivateAdminUser(broadId, superId);
    await svc.activateAdminUser(broadId, superId);
    const updated = await svc.updateAdminUser(broadId, { username: 'renamed_by_super' }, superId, { roleName: 'super_admin' });
    expect(updated.username).toBe('renamed_by_super');
  });
});

describe('accounts within the actor\'s permissions', () => {
  it('can still be edited, deactivated and activated', async () => {
    const updated = await svc.updateAdminUser(narrowId, { username: 'narrow_renamed' }, managerId, { roleName: 'user_manager' });
    expect(updated.username).toBe('narrow_renamed');
    await svc.deactivateAdminUser(narrowId, managerId);
    await svc.activateAdminUser(narrowId, managerId);
    expect([true, 1]).toContain((await db('admin_users').where({ id: narrowId }).first()).is_active);
  });
});

describe('roles above the actor', () => {
  it('cannot have their permissions replaced or their details edited', async () => {
    await expect(svc.updateRole(broadRoleId, { permissions: ['events.view'] }, managerId))
      .rejects.toThrow(REACH);
    await expect(svc.updateRole(broadRoleId, { displayName: 'Renamed' }, managerId))
      .rejects.toThrow(REACH);
    const perms = await db('role_permissions')
      .join('permissions', 'permissions.id', 'role_permissions.permission_id')
      .where('role_permissions.role_id', broadRoleId)
      .pluck('permissions.name');
    expect(perms.sort()).toEqual(['events.view', 'settings.banking']);
  });

  it('a role within the actor\'s permissions can still be edited', async () => {
    const role = await svc.updateRole(narrowRoleId, { permissions: ['events.view', 'users.view'] }, managerId);
    expect(role).toBeTruthy();
  });

  it('a Super Admin can edit any non-super role', async () => {
    await expect(svc.updateRole(broadRoleId, { displayName: 'Broad' }, superId)).resolves.toBeTruthy();
  });
});
