/**
 * Migration 123: seed `accounting.view` / `accounting.manage` permissions
 * and grant them to the super_admin + admin roles.
 *
 * Idempotent: inserts only missing permission names and only missing
 * (role_id, permission_id) grants (mirrors 107_crm_consolidated Section 13).
 */
const NEW_PERMISSIONS = [
  {
    name: 'accounting.view',
    display_name: 'View Accounting',
    category: 'accounting',
    description: 'View inbound documents, expenses and accounting reports',
  },
  {
    name: 'accounting.manage',
    display_name: 'Manage Accounting',
    category: 'accounting',
    description: 'Capture inbound documents, categorize expenses and re-bill to clients',
  },
];

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('permissions'))) return;

  const names = NEW_PERMISSIONS.map((p) => p.name);
  const existing = await knex('permissions').whereIn('name', names).select('name');
  const existingSet = new Set(existing.map((r) => r.name));
  const toInsert = NEW_PERMISSIONS.filter((p) => !existingSet.has(p.name));
  if (toInsert.length > 0) await knex('permissions').insert(toInsert);

  if (!(await knex.schema.hasTable('roles')) || !(await knex.schema.hasTable('role_permissions'))) {
    return;
  }
  const roles = await knex('roles').whereIn('name', ['super_admin', 'admin']).select('id');
  const perms = await knex('permissions').whereIn('name', names).select('id');
  if (!roles.length || !perms.length) return;

  const existingGrants = await knex('role_permissions')
    .whereIn('role_id', roles.map((r) => r.id))
    .whereIn('permission_id', perms.map((p) => p.id))
    .select('role_id', 'permission_id');
  const grantSet = new Set(existingGrants.map((g) => `${g.role_id}:${g.permission_id}`));

  const toGrant = [];
  for (const r of roles) {
    for (const p of perms) {
      if (!grantSet.has(`${r.id}:${p.id}`)) {
        toGrant.push({ role_id: r.id, permission_id: p.id });
      }
    }
  }
  if (toGrant.length > 0) await knex('role_permissions').insert(toGrant);
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('permissions'))) return;
  const names = NEW_PERMISSIONS.map((p) => p.name);
  const perms = await knex('permissions').whereIn('name', names).select('id');
  if (perms.length && (await knex.schema.hasTable('role_permissions'))) {
    await knex('role_permissions').whereIn('permission_id', perms.map((p) => p.id)).del();
  }
  await knex('permissions').whereIn('name', names).del();
};
