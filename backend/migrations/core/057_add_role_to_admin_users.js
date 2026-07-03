/**
 * Migration: Add Role to Admin Users
 * Adds RBAC-related columns to the admin_users table:
 * - role_id: Foreign key to roles table
 * - created_by: Foreign key to admin_users (who invited this user)
 * - invite_token: Token for invitation acceptance (64 chars = 256 bits)
 * - invite_expires_at: When the invitation token expires
 * - invite_accepted_at: When the user accepted the invitation
 *
 * Also migrates existing admin users to super_admin role.
 */

exports.up = async function(knex) {
  console.log('Adding role columns to admin_users table...');

  // Check if columns already exist
  const hasRoleId = await knex.schema.hasColumn('admin_users', 'role_id');
  const hasCreatedBy = await knex.schema.hasColumn('admin_users', 'created_by');
  const hasInviteToken = await knex.schema.hasColumn('admin_users', 'invite_token');
  const hasInviteExpiresAt = await knex.schema.hasColumn('admin_users', 'invite_expires_at');
  const hasInviteAcceptedAt = await knex.schema.hasColumn('admin_users', 'invite_accepted_at');

  // Add new columns if they don't exist
  if (!hasRoleId || !hasCreatedBy || !hasInviteToken || !hasInviteExpiresAt || !hasInviteAcceptedAt) {
    await knex.schema.alterTable('admin_users', (table) => {
      if (!hasRoleId) {
        // Note: We add as nullable first, then set values, then alter to not null
        table.integer('role_id').unsigned().references('id').inTable('roles').onDelete('SET NULL');
      }
      if (!hasCreatedBy) {
        table.integer('created_by').unsigned().references('id').inTable('admin_users').onDelete('SET NULL');
      }
      if (!hasInviteToken) {
        // 64 characters = 32 bytes hex = 256 bits of entropy (cryptographically secure)
        table.string('invite_token', 64);
      }
      if (!hasInviteExpiresAt) {
        table.timestamp('invite_expires_at');
      }
      if (!hasInviteAcceptedAt) {
        table.timestamp('invite_accepted_at');
      }
    });

    console.log('Role columns added to admin_users table');
  }

  // Add index on invite_token for fast lookup
  const hasInviteTokenIndex = await knex.schema.hasColumn('admin_users', 'invite_token');
  if (hasInviteTokenIndex) {
    // Create index if it doesn't exist (safe for both PostgreSQL and SQLite)
    try {
      await knex.schema.alterTable('admin_users', (table) => {
        table.index(['invite_token']);
      });
    } catch (e) {
      // Index may already exist
      if (!e.message.includes('already exists')) {
        console.log('Note: invite_token index may already exist');
      }
    }
  }

  // Get super_admin role ID
  const superAdminRole = await knex('roles').where('name', 'super_admin').first();

  if (superAdminRole) {
    // Migrate existing admin users without a role to super_admin
    const usersWithoutRole = await knex('admin_users')
      .whereNull('role_id')
      .select('id');

    if (usersWithoutRole.length > 0) {
      await knex('admin_users')
        .whereNull('role_id')
        .update({ role_id: superAdminRole.id });

      console.log(`Migrated ${usersWithoutRole.length} existing admin user(s) to super_admin role`);
    }
  } else {
    console.log('Warning: super_admin role not found. Run migration 054 first.');
  }

  console.log('Admin users role migration completed successfully');
};

exports.down = async function(knex) {
  console.log('Removing role columns from admin_users table...');

  const hasRoleId = await knex.schema.hasColumn('admin_users', 'role_id');
  const hasCreatedBy = await knex.schema.hasColumn('admin_users', 'created_by');
  const hasInviteToken = await knex.schema.hasColumn('admin_users', 'invite_token');
  const hasInviteExpiresAt = await knex.schema.hasColumn('admin_users', 'invite_expires_at');
  const hasInviteAcceptedAt = await knex.schema.hasColumn('admin_users', 'invite_accepted_at');

  await knex.schema.alterTable('admin_users', (table) => {
    if (hasInviteAcceptedAt) {
      table.dropColumn('invite_accepted_at');
    }
    if (hasInviteExpiresAt) {
      table.dropColumn('invite_expires_at');
    }
    if (hasInviteToken) {
      table.dropColumn('invite_token');
    }
    if (hasCreatedBy) {
      table.dropColumn('created_by');
    }
    if (hasRoleId) {
      table.dropColumn('role_id');
    }
  });

  console.log('Role columns removed from admin_users table');
};
