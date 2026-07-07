/**
 * Migration 069: Add hero image path to photos table
 * - photos.hero_path: path to hero-optimized image (1920x1080) for gallery headers
 */

const { addColumnIfNotExists } = require('../helpers');

exports.up = async function(knex) {
  console.log('Running migration: 069_add_hero_path');

  // photos.hero_path (nullable - path to hero-optimized image)
  await addColumnIfNotExists(knex, 'photos', 'hero_path', (table) => {
    table.string('hero_path', 512);
  });

  console.log('Migration 069_add_hero_path completed');
};

exports.down = async function(knex) {
  console.log('Rollback: 069_add_hero_path');
  // Keep columns (safe rollback not removing data). Intentionally no-op.
};
