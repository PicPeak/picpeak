/**
 * Migration: Add hero image anchor position and category-specific hero images
 *
 * Issue #162: Add hero_image_anchor column to events table for controlling
 *             how hero images are cropped (top/center/bottom)
 *
 * Issue #163: Add hero_photo_id column to photo_categories table for
 *             category-specific hero images
 */

exports.up = async function(knex) {
  // Add hero_image_anchor to events table (Issue #162)
  const hasHeroAnchor = await knex.schema.hasColumn('events', 'hero_image_anchor');
  if (!hasHeroAnchor) {
    await knex.schema.alterTable('events', function(table) {
      // Values: 'top', 'center', 'bottom' - defaults to 'center' for backward compatibility
      table.string('hero_image_anchor', 10).defaultTo('center');
    });
    console.log('Added hero_image_anchor column to events table');
  }

  // Add hero_photo_id to photo_categories table (Issue #163)
  const hasCategoryHero = await knex.schema.hasColumn('photo_categories', 'hero_photo_id');
  if (!hasCategoryHero) {
    await knex.schema.alterTable('photo_categories', function(table) {
      table.integer('hero_photo_id').references('id').inTable('photos').onDelete('SET NULL');
    });
    console.log('Added hero_photo_id column to photo_categories table');
  }
};

exports.down = async function(knex) {
  // Remove hero_image_anchor from events table
  const hasHeroAnchor = await knex.schema.hasColumn('events', 'hero_image_anchor');
  if (hasHeroAnchor) {
    await knex.schema.alterTable('events', function(table) {
      table.dropColumn('hero_image_anchor');
    });
  }

  // Remove hero_photo_id from photo_categories table
  const hasCategoryHero = await knex.schema.hasColumn('photo_categories', 'hero_photo_id');
  if (hasCategoryHero) {
    await knex.schema.alterTable('photo_categories', function(table) {
      table.dropColumn('hero_photo_id');
    });
  }
};
