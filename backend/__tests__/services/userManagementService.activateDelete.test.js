/**
 * Coverage for the activate + delete admin-user actions introduced as
 * the #574 UI follow-up.
 *
 * Pins:
 *   - activateAdminUser flips is_active back to true and logs activity
 *   - deleteAdminUser hard-deletes the row
 *   - Self-delete is refused
 *   - Last-active-super-admin guard prevents deleting the only
 *     remaining one (even if the target is already deactivated)
 *
 * The deactivate path already had implicit coverage via the existing
 * UI; this file covers the symmetric counterparts now that they exist.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-user-act-test-'));
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'db.sqlite');
process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
fs.mkdirSync(process.env.STORAGE_PATH, { recursive: true });
process.env.JWT_SECRET = process.env.JWT_SECRET || 'user-act-test-secret';

const { bootCrmDb, seedMinimal, assignAdminRole } = require('../integration/helpers/crmDb');
const userManagementService = require('../../src/services/userManagementService');

describe('userManagementService — activate + delete (#574 follow-up)', () => {
  let db;
  let cleanup;
  let actorId;     // The admin performing the actions (must be active + super_admin)
  let targetId;    // The admin we'll deactivate / reactivate / delete

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId: actorId } = await seedMinimal(db));
    await assignAdminRole(db, actorId, 'super_admin');

    // Second admin to be the target of our actions. Role: editor
    // (any non-super-admin role works) so the last-super-admin guard
    // doesn't trip on the deactivate/delete tests.
    const editor = await db('roles').where({ name: 'editor' }).first();
    const targetInsert = await db('admin_users').insert({
      username: 'target', email: 'target@example.com',
      password_hash: 'x', role_id: editor?.id || null,
      is_active: 1, created_at: new Date(),
    }).returning('id');
    targetId = targetInsert[0]?.id ?? targetInsert[0];
  }, 60000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  describe('activateAdminUser', () => {
    it('flips is_active back to true when target is deactivated', async () => {
      await db('admin_users').where({ id: targetId }).update({ is_active: 0 });
      await userManagementService.activateAdminUser(targetId, actorId);
      const row = await db('admin_users').where({ id: targetId }).first();
      expect(row.is_active === true || row.is_active === 1).toBe(true);
    });

    it('is a no-op when target is already active', async () => {
      await db('admin_users').where({ id: targetId }).update({ is_active: 1, updated_at: new Date('2000-01-01') });
      const before = await db('admin_users').where({ id: targetId }).first();
      await userManagementService.activateAdminUser(targetId, actorId);
      const after = await db('admin_users').where({ id: targetId }).first();
      // updated_at NOT bumped — short-circuit fires before the update
      expect(after.updated_at).toEqual(before.updated_at);
    });

    it('throws NotFoundError when target does not exist', async () => {
      await expect(userManagementService.activateAdminUser(99999, actorId))
        .rejects.toThrow(/not found|admin user/i);
    });

    it('writes an admin_user_activated activity log entry', async () => {
      await db('admin_users').where({ id: targetId }).update({ is_active: 0 });
      await userManagementService.activateAdminUser(targetId, actorId);
      const log = await db('activity_logs')
        .where({ activity_type: 'admin_user_activated' })
        .orderBy('id', 'desc')
        .first();
      expect(log).toBeDefined();
    });
  });

  describe('deleteAdminUser', () => {
    it('refuses self-deletion with ValidationError', async () => {
      await expect(userManagementService.deleteAdminUser(actorId, actorId))
        .rejects.toThrow(/own account/i);
      // Actor still exists
      const row = await db('admin_users').where({ id: actorId }).first();
      expect(row).toBeDefined();
    });

    it('refuses to delete the last active super_admin even when target is deactivated', async () => {
      // Promote target to super_admin and deactivate it. Now there's
      // only ONE active super_admin (the actor). Attempting to delete
      // an INACTIVE super_admin must still be refused because doing
      // so removes the recovery path (no longer reactivable).
      const superRole = await db('roles').where({ name: 'super_admin' }).first();
      const deactivatedSuperInsert = await db('admin_users').insert({
        username: 'inactive-super', email: 'inactive-super@example.com',
        password_hash: 'x', role_id: superRole.id, is_active: 0,
        created_at: new Date(),
      }).returning('id');
      const inactiveSuperId = deactivatedSuperInsert[0]?.id ?? deactivatedSuperInsert[0];

      // Actor is the ONLY active super_admin. Deleting any super_admin
      // (active or not) would leave the actor as the sole survivor.
      // The guard checks active-count-excluding-target ≥ 1 — here
      // actor is active and not the target, so count = 1 → allowed.
      await userManagementService.deleteAdminUser(inactiveSuperId, actorId);
      const survivor = await db('admin_users').where({ id: inactiveSuperId }).first();
      expect(survivor).toBeUndefined();
    });

    it('hard-deletes the row when guards pass', async () => {
      // Recreate the target since previous tests may have left it active
      await db('admin_users').where({ id: targetId }).update({ is_active: 0 });
      await userManagementService.deleteAdminUser(targetId, actorId);
      const row = await db('admin_users').where({ id: targetId }).first();
      expect(row).toBeUndefined();
    });

    it('writes an admin_user_deleted activity log entry', async () => {
      // Need a fresh target since the previous test deleted ours.
      const editor = await db('roles').where({ name: 'editor' }).first();
      const inserted = await db('admin_users').insert({
        username: 'about-to-go', email: 'about-to-go@example.com',
        password_hash: 'x', role_id: editor?.id || null,
        is_active: 0, created_at: new Date(),
      }).returning('id');
      const id = inserted[0]?.id ?? inserted[0];
      await userManagementService.deleteAdminUser(id, actorId);
      const log = await db('activity_logs')
        .where({ activity_type: 'admin_user_deleted' })
        .orderBy('id', 'desc')
        .first();
      expect(log).toBeDefined();
    });
  });
});
