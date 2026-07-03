/**
 * Migration: Add Permissions Table
 * Creates the permissions table for granular access control.
 *
 * Permission categories:
 * - events: View, create, edit, delete, archive events
 * - photos: View, upload, edit, delete, download photos
 * - archives: View, restore, download, delete archives
 * - analytics: View analytics and statistics
 * - email: View, edit, send emails
 * - branding: View and edit branding settings
 * - cms: View and edit CMS pages
 * - settings: View and edit application settings
 * - backup: View, create, restore, delete backups
 * - users: View, create, edit, delete admin users (Super Admin only)
 * - activity: View and export activity logs
 */

exports.up = async function(knex) {
  console.log('Creating permissions table...');

  // Check if table already exists
  const hasPermissionsTable = await knex.schema.hasTable('permissions');

  if (!hasPermissionsTable) {
    await knex.schema.createTable('permissions', (table) => {
      table.increments('id').primary();
      table.string('name', 100).unique().notNullable(); // 'events.create', 'users.manage', etc.
      table.string('display_name', 150).notNullable();
      table.string('category', 50).notNullable(); // 'events', 'photos', 'users', 'settings'
      table.text('description');
      table.timestamp('created_at').defaultTo(knex.fn.now());

      // Indexes for efficient lookups
      table.index(['name']);
      table.index(['category']);
    });

    console.log('Permissions table created');
  }

  // Check for existing permissions
  const existingPermissions = await knex('permissions').select('name');
  const existingPermissionNames = existingPermissions.map(p => p.name);

  // Define all permissions
  const permissions = [
    // Events
    { name: 'events.view', display_name: 'View Events', category: 'events', description: 'View event list and details' },
    { name: 'events.create', display_name: 'Create Events', category: 'events', description: 'Create new events' },
    { name: 'events.edit', display_name: 'Edit Events', category: 'events', description: 'Edit existing events' },
    { name: 'events.delete', display_name: 'Delete Events', category: 'events', description: 'Delete events' },
    { name: 'events.archive', display_name: 'Archive Events', category: 'events', description: 'Archive and restore events' },

    // Photos
    { name: 'photos.view', display_name: 'View Photos', category: 'photos', description: 'View photos in events' },
    { name: 'photos.upload', display_name: 'Upload Photos', category: 'photos', description: 'Upload photos to events' },
    { name: 'photos.edit', display_name: 'Edit Photos', category: 'photos', description: 'Edit photo metadata and categories' },
    { name: 'photos.delete', display_name: 'Delete Photos', category: 'photos', description: 'Delete photos from events' },
    { name: 'photos.download', display_name: 'Download Photos', category: 'photos', description: 'Download photos and bulk export' },

    // Archives
    { name: 'archives.view', display_name: 'View Archives', category: 'archives', description: 'View archived events' },
    { name: 'archives.restore', display_name: 'Restore Archives', category: 'archives', description: 'Restore archived events' },
    { name: 'archives.download', display_name: 'Download Archives', category: 'archives', description: 'Download archive files' },
    { name: 'archives.delete', display_name: 'Delete Archives', category: 'archives', description: 'Permanently delete archives' },

    // Analytics
    { name: 'analytics.view', display_name: 'View Analytics', category: 'analytics', description: 'View analytics and statistics' },

    // Email
    { name: 'email.view', display_name: 'View Email Settings', category: 'email', description: 'View email configuration' },
    { name: 'email.edit', display_name: 'Edit Email Settings', category: 'email', description: 'Configure email settings and templates' },
    { name: 'email.send', display_name: 'Send Emails', category: 'email', description: 'Send and resend gallery emails' },

    // Branding & CMS
    { name: 'branding.view', display_name: 'View Branding', category: 'branding', description: 'View branding settings' },
    { name: 'branding.edit', display_name: 'Edit Branding', category: 'branding', description: 'Edit branding and theme settings' },
    { name: 'cms.view', display_name: 'View CMS Pages', category: 'cms', description: 'View CMS content pages' },
    { name: 'cms.edit', display_name: 'Edit CMS Pages', category: 'cms', description: 'Edit CMS content pages' },

    // Settings
    { name: 'settings.view', display_name: 'View Settings', category: 'settings', description: 'View application settings' },
    { name: 'settings.edit', display_name: 'Edit Settings', category: 'settings', description: 'Modify application settings' },

    // Backup
    { name: 'backup.view', display_name: 'View Backups', category: 'backup', description: 'View backup status and history' },
    { name: 'backup.create', display_name: 'Create Backups', category: 'backup', description: 'Create new backups' },
    { name: 'backup.restore', display_name: 'Restore Backups', category: 'backup', description: 'Restore from backups' },
    { name: 'backup.delete', display_name: 'Delete Backups', category: 'backup', description: 'Delete backup files' },

    // User Management (Super Admin only)
    { name: 'users.view', display_name: 'View Users', category: 'users', description: 'View admin user list' },
    { name: 'users.create', display_name: 'Create Users', category: 'users', description: 'Invite new admin users' },
    { name: 'users.edit', display_name: 'Edit Users', category: 'users', description: 'Edit admin user details and roles' },
    { name: 'users.delete', display_name: 'Delete Users', category: 'users', description: 'Deactivate or delete admin users' },

    // Activity Logs
    { name: 'activity.view', display_name: 'View Activity Logs', category: 'activity', description: 'View system activity logs' },
    { name: 'activity.export', display_name: 'Export Activity Logs', category: 'activity', description: 'Export activity logs' }
  ];

  // Filter out already existing permissions
  const permissionsToInsert = permissions.filter(p => !existingPermissionNames.includes(p.name));

  if (permissionsToInsert.length > 0) {
    await knex('permissions').insert(permissionsToInsert);
    console.log(`Inserted ${permissionsToInsert.length} permissions`);
  }

  console.log('Permissions table migration completed successfully');
};

exports.down = async function(knex) {
  console.log('Removing permissions table...');

  // Note: This will fail if there are foreign key references
  // The role_permissions table must be rolled back first
  await knex.schema.dropTableIfExists('permissions');

  console.log('Permissions table removed');
};
