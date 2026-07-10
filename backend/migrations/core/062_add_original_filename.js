/**
 * Migration 062: Add original_filename to photos table
 * - photos.original_filename: preserves the original filename from upload
 *   This enables Lightroom integration by exporting filtered filenames
 */

const { addColumnIfNotExists } = require('../helpers');

exports.up = async function(knex) {
  console.log('Running migration: 062_add_original_filename');

  // photos.original_filename (nullable - original filename before renaming)
  await addColumnIfNotExists(knex, 'photos', 'original_filename', (table) => {
    table.string('original_filename', 512);
  });

  console.log('Migration 062_add_original_filename completed');
};

exports.down = async function(knex) {
  console.log('Rollback: 062_add_original_filename');
  // Keep column (safe rollback not removing data). Intentionally no-op.
};
