const { addColumnIfNotExists, createIndexIfNotExists } = require('../helpers');

exports.up = async function(knex) {
  // Add visibility column to photos table
  await addColumnIfNotExists(knex, 'photos', 'visibility', (table) => {
    table.string('visibility', 20).defaultTo('visible').notNullable();
  });

  // Add client access columns to events table
  await addColumnIfNotExists(knex, 'events', 'client_access_enabled', (table) => {
    table.boolean('client_access_enabled').defaultTo(false);
  });

  await addColumnIfNotExists(knex, 'events', 'client_password_hash', (table) => {
    table.string('client_password_hash', 255).nullable();
  });

  await addColumnIfNotExists(knex, 'events', 'client_share_token', (table) => {
    table.string('client_share_token', 64).nullable().unique();
  });

  // Index for filtering photos by visibility
  await createIndexIfNotExists(knex, 'photos', ['event_id', 'visibility'], 'idx_photos_event_visibility');
};

exports.down = async function(knex) {
  // Safe rollback - intentionally no-op to avoid data loss
};
