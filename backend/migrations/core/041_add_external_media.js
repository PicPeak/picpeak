/**
 * Migration 041: Add external media reference support
 * - events.source_mode: 'managed' | 'reference'
 * - events.external_path: relative path under external media root
 * - photos.source_origin: 'managed' | 'external'
 * - photos.external_relpath: relative path within event.external_path
 */

const { addColumnIfNotExists } = require('../helpers');

exports.up = async function(knex) {
  console.log('Running migration: 041_add_external_media');

  // events.source_mode (default 'managed')
  await addColumnIfNotExists(knex, 'events', 'source_mode', (table) => {
    table.string('source_mode').notNullable().defaultTo('managed');
  });

  // events.external_path (nullable)
  await addColumnIfNotExists(knex, 'events', 'external_path', (table) => {
    table.text('external_path');
  });

  // photos.source_origin (default 'managed')
  await addColumnIfNotExists(knex, 'photos', 'source_origin', (table) => {
    table.string('source_origin').notNullable().defaultTo('managed');
  });

  // photos.external_relpath (nullable)
  await addColumnIfNotExists(knex, 'photos', 'external_relpath', (table) => {
    table.text('external_relpath');
  });

  // Helpful index for queries
  try {
    if (knex.client.config.client === 'pg') {
      await knex.raw("CREATE INDEX IF NOT EXISTS photos_event_source_idx ON photos (event_id, source_origin)");
    } else {
      await knex.schema.alterTable('photos', (table) => {
        table.index(['event_id', 'source_origin'], 'photos_event_source_idx');
      });
    }
  } catch (e) {
    console.log('Index creation skipped or failed (may already exist):', e.message);
  }

  console.log('Migration 041_add_external_media completed');
};

exports.down = async function(knex) {
  console.log('Rollback: 041_add_external_media');
  // Keep columns (safe rollback not removing data). Intentionally no-op.
};

