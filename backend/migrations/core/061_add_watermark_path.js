/**
 * Migration 061: Add pre-generated watermark path to photos table
 * - photos.watermark_path: path to pre-generated watermarked image
 * - photos.watermark_generated_at: timestamp of watermark generation
 */

const { addColumnIfNotExists } = require('../helpers');

exports.up = async function(knex) {
  console.log('Running migration: 061_add_watermark_path');

  // photos.watermark_path (nullable - path to pre-generated watermarked image)
  await addColumnIfNotExists(knex, 'photos', 'watermark_path', (table) => {
    table.string('watermark_path', 512);
  });

  // photos.watermark_generated_at (nullable - when watermark was last generated)
  await addColumnIfNotExists(knex, 'photos', 'watermark_generated_at', (table) => {
    table.timestamp('watermark_generated_at');
  });

  console.log('Migration 061_add_watermark_path completed');
};

exports.down = async function(knex) {
  console.log('Rollback: 061_add_watermark_path');
  // Keep columns (safe rollback not removing data). Intentionally no-op.
};
