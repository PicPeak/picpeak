/**
 * Migration 226: customer groups (#1443).
 *
 * Two tables:
 *
 *   customer_groups          The catalogue an admin manages: name, optional
 *                            description, a colour, a manual sort order and an
 *                            archived flag. Archiving is the way out of a group
 *                            that is still on customers — the group keeps
 *                            showing on the customers that carry it, and stops
 *                            being offered for new assignments. Deleting is
 *                            refused while a group has members
 *                            (customerGroupsService.remove), so no customer
 *                            record ever depends on a delete.
 *   customer_group_members   The many-to-many join: one customer can be in any
 *                            number of groups, one group holds any number of
 *                            customers. The customer side CASCADEs. The group
 *                            side RESTRICTs: the service refuses to delete a
 *                            group with members, and on PostgreSQL the
 *                            database backs that against an assignment landing
 *                            between the check and the delete. A customer is
 *                            anonymised in place rather than deleted, so
 *                            erasure clears their memberships itself
 *                            (customerAccountsService.eraseCustomer).
 *
 * A group is referenced by id, so renaming or recolouring one changes nothing
 * on a customer record.
 *
 * Reading groups needs `customers.view`, because that is what it takes to see
 * the customers they organise. Managing the catalogue and the assignments
 * needs `customers.groups.manage`, granted to super_admin and admin (the 225
 * pattern), so a role that may edit a customer record doesn't silently gain
 * the catalogue everyone else's overview is filtered by.
 *
 * Every step is hasTable-guarded and safe to re-run.
 */

const NEW_PERMISSIONS = [
  {
    name: 'customers.groups.manage',
    display_name: 'Manage Customer Groups',
    category: 'clients',
    description: 'Create, rename, recolour, reorder and archive customer groups, and assign customers to them.',
  },
];

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('customer_groups'))) {
    const hasAdmins = await knex.schema.hasTable('admin_users');
    await knex.schema.createTable('customer_groups', (t) => {
      t.increments('id').primary();
      t.string('name', 80).notNullable();
      // The name lowercased in JS (customerGroupsService.nameKey), and what
      // uniqueness hangs on. SQL LOWER() is ASCII-only on SQLite, so "Ärzte"
      // and "ärzte" were two groups there and one on PostgreSQL. Wider than
      // `name` because lowercasing can lengthen a string ("İ" → "i̇").
      t.string('name_key', 255).notNullable();
      t.string('description', 500);
      // #rrggbb. The UI offers a palette that holds up in both themes and
      // shows the colour as a dot beside the name, never as the only
      // carrier of meaning (customerGroupsService.normalizeColor).
      t.string('color', 7).notNullable().defaultTo('#6B7280');
      t.integer('sort_order').notNullable().defaultTo(0);
      t.boolean('is_archived').notNullable().defaultTo(false);
      if (hasAdmins) {
        t.integer('created_by_admin_id').unsigned()
          .references('id').inTable('admin_users').onDelete('SET NULL');
      }
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());
      t.index(['sort_order'], 'customer_groups_sort_idx');
      t.unique(['name_key'], 'customer_groups_name_key_unique');
    });
  }

  if (!(await knex.schema.hasTable('customer_group_members'))) {
    await knex.schema.createTable('customer_group_members', (t) => {
      t.increments('id').primary();
      t.integer('group_id').unsigned().notNullable()
        .references('id').inTable('customer_groups').onDelete('RESTRICT');
      t.integer('customer_account_id').unsigned().notNullable()
        .references('id').inTable('customer_accounts').onDelete('CASCADE');
      t.timestamp('assigned_at').defaultTo(knex.fn.now());
      t.unique(['group_id', 'customer_account_id'], 'customer_group_members_unique');
      t.index(['customer_account_id'], 'customer_group_members_customer_idx');
    });
  }

  const hasPermissions = await knex.schema.hasTable('permissions');
  const hasRoles = await knex.schema.hasTable('roles');
  const hasRolePermissions = await knex.schema.hasTable('role_permissions');
  if (!hasPermissions || !hasRoles || !hasRolePermissions) return;

  const existing = await knex('permissions')
    .whereIn('name', NEW_PERMISSIONS.map((p) => p.name))
    .select('name');
  const have = new Set(existing.map((r) => r.name));
  const toInsert = NEW_PERMISSIONS.filter((p) => !have.has(p.name));
  if (toInsert.length > 0) {
    await knex('permissions').insert(toInsert);
  }

  const permIds = (await knex('permissions')
    .whereIn('name', NEW_PERMISSIONS.map((p) => p.name))
    .select('id')).map((p) => p.id);
  if (permIds.length === 0) return;

  for (const roleName of ['super_admin', 'admin']) {
    const role = await knex('roles').where({ name: roleName }).first();
    if (!role) continue;
    const granted = await knex('role_permissions')
      .where({ role_id: role.id })
      .whereIn('permission_id', permIds)
      .select('permission_id');
    const hasGrant = new Set(granted.map((r) => r.permission_id));
    const inserts = permIds
      .filter((id) => !hasGrant.has(id))
      .map((id) => ({ role_id: role.id, permission_id: id }));
    if (inserts.length > 0) {
      await knex('role_permissions').insert(inserts);
    }
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasTable('customer_group_members')) {
    await knex.schema.dropTable('customer_group_members');
  }
  if (await knex.schema.hasTable('customer_groups')) {
    await knex.schema.dropTable('customer_groups');
  }
  if (await knex.schema.hasTable('permissions')) {
    const perms = await knex('permissions')
      .whereIn('name', NEW_PERMISSIONS.map((p) => p.name))
      .select('id');
    const ids = perms.map((p) => p.id);
    if (ids.length > 0) {
      if (await knex.schema.hasTable('role_permissions')) {
        await knex('role_permissions').whereIn('permission_id', ids).del();
      }
      await knex('permissions').whereIn('id', ids).del();
    }
  }
};
