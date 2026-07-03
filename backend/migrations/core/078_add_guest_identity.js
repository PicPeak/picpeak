/**
 * Add guest identity layer for per-person photo selections (issue #292).
 *
 * Adds:
 *   - gallery_guests              — persistent guest profiles per event
 *   - guest_invites               — pre-minted invite tokens (Phase 3.3)
 *   - guest_verification_codes    — email-based identity recovery (Phase 3.2)
 *   - event_feedback_settings.identity_mode ('simple' | 'guest', default 'simple')
 *   - photo_feedback.guest_id FK  — links feedback to gallery_guests (nullable)
 *
 * All changes are additive. Existing events default to 'simple' mode so behavior
 * is unchanged. Legacy photo_feedback rows keep NULL guest_id.
 */

exports.up = async function(knex) {
  // 1. gallery_guests — persistent per-person identity within an event.
  const hasGalleryGuests = await knex.schema.hasTable('gallery_guests');
  if (!hasGalleryGuests) {
    await knex.schema.createTable('gallery_guests', (table) => {
      table.increments('id').primary();
      table.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
      table.string('name', 100).notNullable();
      table.string('email', 255);
      table.string('identifier', 64).notNullable(); // UUIDv4 issued server-side
      table.string('ip_address_last', 45);
      table.text('user_agent_last');
      table.timestamp('email_verified_at');
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('last_seen_at').defaultTo(knex.fn.now());
      table.boolean('is_deleted').defaultTo(false);

      table.unique(['event_id', 'identifier']);
      table.index(['event_id']);
      table.index(['event_id', 'email']);
    });
  }

  // 2. guest_invites — pre-minted one-time-use tokens for invited guests.
  const hasGuestInvites = await knex.schema.hasTable('guest_invites');
  if (!hasGuestInvites) {
    await knex.schema.createTable('guest_invites', (table) => {
      table.increments('id').primary();
      table.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
      table.integer('guest_id').notNullable().references('id').inTable('gallery_guests').onDelete('CASCADE');
      table.string('token', 64).notNullable().unique();
      table.integer('created_by_admin_id').references('id').inTable('admin_users');
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('redeemed_at');
      table.timestamp('revoked_at');

      table.index(['event_id']);
      table.index(['guest_id']);
    });
  }

  // 3. guest_verification_codes — short-lived codes for email-based recovery.
  const hasGuestVerificationCodes = await knex.schema.hasTable('guest_verification_codes');
  if (!hasGuestVerificationCodes) {
    await knex.schema.createTable('guest_verification_codes', (table) => {
      table.increments('id').primary();
      table.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
      table.string('email', 255).notNullable();
      table.string('code_hash', 128).notNullable(); // bcrypt hash of 6-digit code
      table.integer('attempts').defaultTo(0);
      table.timestamp('expires_at').notNullable();
      table.timestamp('consumed_at');
      table.timestamp('created_at').defaultTo(knex.fn.now());

      table.index(['event_id', 'email']);
      table.index(['expires_at']);
    });
  }

  // 4. event_feedback_settings.identity_mode
  const hasIdentityMode = await knex.schema.hasColumn('event_feedback_settings', 'identity_mode');
  if (!hasIdentityMode) {
    await knex.schema.alterTable('event_feedback_settings', (table) => {
      table.string('identity_mode', 16).notNullable().defaultTo('simple');
    });
    if (knex.client.config.client === 'pg') {
      await knex.raw(`
        ALTER TABLE event_feedback_settings
        ADD CONSTRAINT event_feedback_settings_identity_mode_check
        CHECK (identity_mode IN ('simple','guest'))
      `);
    }
  }

  // 5. photo_feedback.guest_id FK
  const hasGuestIdColumn = await knex.schema.hasColumn('photo_feedback', 'guest_id');
  if (!hasGuestIdColumn) {
    await knex.schema.alterTable('photo_feedback', (table) => {
      table.integer('guest_id').references('id').inTable('gallery_guests').onDelete('SET NULL');
      table.index(['guest_id']);
    });
  }
};

exports.down = async function(knex) {
  const hasGuestIdColumn = await knex.schema.hasColumn('photo_feedback', 'guest_id');
  if (hasGuestIdColumn) {
    await knex.schema.alterTable('photo_feedback', (table) => {
      table.dropColumn('guest_id');
    });
  }

  if (knex.client.config.client === 'pg') {
    await knex.raw('ALTER TABLE event_feedback_settings DROP CONSTRAINT IF EXISTS event_feedback_settings_identity_mode_check');
  }
  const hasIdentityMode = await knex.schema.hasColumn('event_feedback_settings', 'identity_mode');
  if (hasIdentityMode) {
    await knex.schema.alterTable('event_feedback_settings', (table) => {
      table.dropColumn('identity_mode');
    });
  }

  await knex.schema.dropTableIfExists('guest_verification_codes');
  await knex.schema.dropTableIfExists('guest_invites');
  await knex.schema.dropTableIfExists('gallery_guests');
};
