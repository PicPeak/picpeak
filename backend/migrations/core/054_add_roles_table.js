/**
 * Migration: Add Roles Table
 * Creates the roles table for RBAC multi-administrator support.
 *
 * Default roles:
 * - super_admin (priority 100): Full system access including user management
 * - admin (priority 80): Full event and photo management
 * - editor (priority 50): Can edit events and photos but not create or delete
 * - viewer (priority 20): Read-only access to dashboard and events
 */

exports.up = async function(knex) {
  console.log('Creating roles table...');

  // Check if table already exists
  const hasRolesTable = await knex.schema.hasTable('roles');

  if (!hasRolesTable) {
    await knex.schema.createTable('roles', (table) => {
      table.increments('id').primary();
      table.string('name', 50).unique().notNullable(); // 'super_admin', 'admin', 'editor', 'viewer'
      table.string('display_name', 100).notNullable(); // 'Super Admin', 'Admin', etc.
      table.text('description');
      table.boolean('is_system').defaultTo(false); // System roles cannot be deleted
      table.integer('priority').defaultTo(0); // Higher = more privileged (for hierarchy)
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      // Index for name lookups
      table.index(['name']);
      // Index for priority-based ordering
      table.index(['priority']);
    });

    console.log('Roles table created');
  }

  // Insert default system roles
  const existingRoles = await knex('roles').select('name');
  const existingRoleNames = existingRoles.map(r => r.name);

  const defaultRoles = [
    {
      name: 'super_admin',
      display_name: 'Super Admin',
      description: 'Full system access including user management',
      is_system: true,
      priority: 100
    },
    {
      name: 'admin',
      display_name: 'Admin',
      description: 'Full event and photo management',
      is_system: true,
      priority: 80
    },
    {
      name: 'editor',
      display_name: 'Editor',
      description: 'Can edit events and photos but not create or delete',
      is_system: true,
      priority: 50
    },
    {
      name: 'viewer',
      display_name: 'Viewer',
      description: 'Read-only access to dashboard and events',
      is_system: true,
      priority: 20
    }
  ];

  const rolesToInsert = defaultRoles.filter(role => !existingRoleNames.includes(role.name));

  if (rolesToInsert.length > 0) {
    await knex('roles').insert(rolesToInsert);
    console.log(`Inserted ${rolesToInsert.length} default roles`);
  }

  console.log('Roles table migration completed successfully');
};

exports.down = async function(knex) {
  console.log('Removing roles table...');

  // Note: This will fail if there are foreign key references
  // The role_permissions and admin_users tables must be rolled back first
  await knex.schema.dropTableIfExists('roles');

  console.log('Roles table removed');
};
