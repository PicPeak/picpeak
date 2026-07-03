/**
 * Migration: Add Role Permissions Junction Table
 * Creates the junction table mapping permissions to roles.
 *
 * Role permission mappings:
 * - super_admin: All permissions
 * - admin: Events, Photos, Archives, Analytics, Email, Branding, CMS, Settings (view), Backup (view/create), Activity (view)
 * - editor: View/Create/Edit own events and photos, Analytics (view), Activity (view)
 * - viewer: View-only access to events, photos, archives, analytics, branding, cms
 */

exports.up = async function(knex) {
  console.log('Creating role_permissions junction table...');

  // Check if table already exists
  const hasRolePermissionsTable = await knex.schema.hasTable('role_permissions');

  if (!hasRolePermissionsTable) {
    await knex.schema.createTable('role_permissions', (table) => {
      table.integer('role_id').unsigned().references('id').inTable('roles').onDelete('CASCADE');
      table.integer('permission_id').unsigned().references('id').inTable('permissions').onDelete('CASCADE');
      table.primary(['role_id', 'permission_id']);

      // Indexes for efficient lookups
      table.index(['role_id']);
      table.index(['permission_id']);
    });

    console.log('Role permissions junction table created');
  }

  // Get role and permission IDs
  const roles = await knex('roles').select('id', 'name');
  const permissions = await knex('permissions').select('id', 'name');

  if (roles.length === 0 || permissions.length === 0) {
    console.log('No roles or permissions found, skipping permission mappings');
    return;
  }

  const roleMap = Object.fromEntries(roles.map(r => [r.name, r.id]));
  const permMap = Object.fromEntries(permissions.map(p => [p.name, p.id]));

  // Define role-permission mappings
  const rolePermissions = {
    super_admin: permissions.map(p => p.name), // All permissions
    admin: [
      // Events - full access
      'events.view', 'events.create', 'events.edit', 'events.delete', 'events.archive',
      // Photos - full access
      'photos.view', 'photos.upload', 'photos.edit', 'photos.delete', 'photos.download',
      // Archives - full access
      'archives.view', 'archives.restore', 'archives.download', 'archives.delete',
      // Analytics - view only
      'analytics.view',
      // Email - full access
      'email.view', 'email.edit', 'email.send',
      // Branding - full access
      'branding.view', 'branding.edit',
      // CMS - full access
      'cms.view', 'cms.edit',
      // Settings - view only
      'settings.view',
      // Backup - view and create only
      'backup.view', 'backup.create',
      // Activity - view only
      'activity.view'
    ],
    editor: [
      // Events - view, create, and edit (can only see their own events)
      'events.view', 'events.create', 'events.edit',
      // Photos - view, upload, edit (no delete)
      'photos.view', 'photos.upload', 'photos.edit',
      // Analytics - view only
      'analytics.view',
      // Activity - view only
      'activity.view'
    ],
    viewer: [
      // Events - view only
      'events.view',
      // Photos - view only
      'photos.view',
      // Archives - view only
      'archives.view',
      // Analytics - view only
      'analytics.view',
      // Branding - view only
      'branding.view',
      // CMS - view only
      'cms.view'
    ]
  };

  // Check for existing mappings to avoid duplicates
  const existingMappings = await knex('role_permissions').select('role_id', 'permission_id');
  const existingSet = new Set(existingMappings.map(m => `${m.role_id}-${m.permission_id}`));

  // Build insert list
  const inserts = [];
  for (const [roleName, perms] of Object.entries(rolePermissions)) {
    for (const permName of perms) {
      if (roleMap[roleName] && permMap[permName]) {
        const key = `${roleMap[roleName]}-${permMap[permName]}`;
        if (!existingSet.has(key)) {
          inserts.push({
            role_id: roleMap[roleName],
            permission_id: permMap[permName]
          });
        }
      }
    }
  }

  if (inserts.length > 0) {
    // Insert in batches to avoid hitting database limits
    const batchSize = 50;
    for (let i = 0; i < inserts.length; i += batchSize) {
      const batch = inserts.slice(i, i + batchSize);
      await knex('role_permissions').insert(batch);
    }
    console.log(`Inserted ${inserts.length} role-permission mappings`);
  }

  console.log('Role permissions junction table migration completed successfully');
};

exports.down = async function(knex) {
  console.log('Removing role_permissions junction table...');

  await knex.schema.dropTableIfExists('role_permissions');

  console.log('Role permissions junction table removed');
};
