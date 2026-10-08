// Existing filesystem/face/cap tests are not authorization tests. Give their
// previously implicit global source access an explicit, persisted fixture actor.
async function seedExternalAdminFixture(db) {
  const { formatBoolean } = require('../../../src/utils/dbCompat');
  const role = await db('roles').where({ name: 'super_admin' }).first();
  if (!role) throw new Error('SuperAdmin fixture role missing');
  await db('admin_users').insert({
    id: 1, username: 'external-fixture', email: 'external@fixture.invalid',
    password_hash: 'fixture-only', role_id: role.id, is_active: formatBoolean(true), must_change_password: formatBoolean(false),
  }).onConflict('id').merge({ role_id: role.id, is_active: formatBoolean(true), must_change_password: formatBoolean(false) });
}
module.exports = { seedExternalAdminFixture };
