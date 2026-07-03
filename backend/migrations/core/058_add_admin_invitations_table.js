/**
 * Migration: Add Admin Invitations Table
 * Creates the admin_invitations table for managing pending admin user invitations.
 *
 * Security features:
 * - Token is 64 characters (32 bytes hex = 256 bits of entropy)
 * - Tokens are unique and indexed for fast lookup
 * - Invitations have expiration timestamps
 * - Tracks who invited whom and when accepted
 * - Foreign key constraints with appropriate CASCADE behavior
 */

exports.up = async function(knex) {
  console.log('Creating admin_invitations table...');

  // Check if table already exists
  const hasAdminInvitationsTable = await knex.schema.hasTable('admin_invitations');

  if (!hasAdminInvitationsTable) {
    await knex.schema.createTable('admin_invitations', (table) => {
      table.increments('id').primary();

      // Email of the invited user
      table.string('email', 255).notNullable();

      // Invitation token - 64 characters = 32 bytes hex = 256 bits of entropy
      // Cryptographically secure for one-time use tokens
      table.string('token', 64).unique().notNullable();

      // Role to assign when invitation is accepted
      table.integer('role_id').unsigned().references('id').inTable('roles').onDelete('CASCADE').notNullable();

      // Who created this invitation
      table.integer('invited_by').unsigned().references('id').inTable('admin_users').onDelete('CASCADE').notNullable();

      // When the invitation expires (typically 7 days from creation)
      table.timestamp('expires_at').notNullable();

      // When the invitation was accepted (null if pending)
      table.timestamp('accepted_at');

      // The admin_user ID created when invitation was accepted (for audit trail)
      table.integer('accepted_user_id').unsigned().references('id').inTable('admin_users').onDelete('SET NULL');

      // When the invitation was created
      table.timestamp('created_at').defaultTo(knex.fn.now());

      // Indexes for efficient lookups
      table.index(['token']); // Fast token validation
      table.index(['email']); // Check for existing invitations by email
      table.index(['expires_at']); // Cleanup expired invitations
      table.index(['invited_by']); // List invitations by inviter
      table.index(['accepted_at']); // Filter pending vs accepted
    });

    console.log('Admin invitations table created');
  }

  console.log('Admin invitations table migration completed successfully');
};

exports.down = async function(knex) {
  console.log('Removing admin_invitations table...');

  await knex.schema.dropTableIfExists('admin_invitations');

  console.log('Admin invitations table removed');
};
