/**
 * Migration 071: Add captured_at column to photos table
 * - Stores the original capture date from EXIF metadata
 * - Enables sorting photos by capture date instead of upload date
 */

const { addColumnIfNotExists } = require('../helpers');

exports.up = async function(knex) {
  console.log('Running migration: 071_add_captured_at');

  // Add captured_at column to photos table
  await addColumnIfNotExists(knex, 'photos', 'captured_at', (table) => {
    table.datetime('captured_at').nullable();
  });

  // Add index for sorting performance
  const indexExists = await knex.schema.hasIndex
    ? await knex.schema.hasIndex('photos', 'idx_photos_captured_at')
    : false;

  if (!indexExists) {
    // Use raw query for index creation with IF NOT EXISTS
    const client = knex.client.config.client;
    if (client === 'pg') {
      await knex.raw('CREATE INDEX IF NOT EXISTS idx_photos_captured_at ON photos(captured_at)');
    } else if (client === 'sqlite3' || client === 'better-sqlite3') {
      // SQLite doesn't support IF NOT EXISTS for indexes, so we need to check first
      const existingIndexes = await knex.raw("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_photos_captured_at'");
      if (existingIndexes.length === 0) {
        await knex.raw('CREATE INDEX idx_photos_captured_at ON photos(captured_at)');
      }
    }
  }

  console.log('Migration 071_add_captured_at completed');
};

exports.down = async function(knex) {
  console.log('Rollback: 071_add_captured_at');
  // Keep column for safe rollback (intentionally no-op)
};
