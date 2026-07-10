/**
 * Migration: Add hero logo customization settings to events table
 *
 * Allows per-event customization of the hero gallery logo:
 * - hero_logo_visible: Show/hide the logo overlay
 * - hero_logo_size: Logo size (small, medium, large, xlarge)
 * - hero_logo_position: Logo position (top, center, bottom)
 *
 * Addresses GitHub Issue #138: Add Option to customize the Hero gallery layout
 */

exports.up = async function (knex) {
  console.log('Adding hero logo settings to events table...');

  // Add hero_logo_visible column
  const hasVisibleColumn = await knex.schema.hasColumn('events', 'hero_logo_visible');
  if (!hasVisibleColumn) {
    await knex.schema.table('events', (table) => {
      table.boolean('hero_logo_visible').notNullable().defaultTo(true);
    });
    console.log('Added hero_logo_visible column');
  }

  // Add hero_logo_size column
  const hasSizeColumn = await knex.schema.hasColumn('events', 'hero_logo_size');
  if (!hasSizeColumn) {
    await knex.schema.table('events', (table) => {
      table.string('hero_logo_size', 20).notNullable().defaultTo('medium');
    });
    console.log('Added hero_logo_size column');
  }

  // Add hero_logo_position column
  const hasPositionColumn = await knex.schema.hasColumn('events', 'hero_logo_position');
  if (!hasPositionColumn) {
    await knex.schema.table('events', (table) => {
      table.string('hero_logo_position', 20).notNullable().defaultTo('top');
    });
    console.log('Added hero_logo_position column');
  }

  console.log('Migration 062_add_hero_logo_settings completed successfully');
};

exports.down = async function (knex) {
  console.log('Rolling back hero logo settings...');

  const hasVisibleColumn = await knex.schema.hasColumn('events', 'hero_logo_visible');
  if (hasVisibleColumn) {
    await knex.schema.table('events', (table) => {
      table.dropColumn('hero_logo_visible');
    });
  }

  const hasSizeColumn = await knex.schema.hasColumn('events', 'hero_logo_size');
  if (hasSizeColumn) {
    await knex.schema.table('events', (table) => {
      table.dropColumn('hero_logo_size');
    });
  }

  const hasPositionColumn = await knex.schema.hasColumn('events', 'hero_logo_position');
  if (hasPositionColumn) {
    await knex.schema.table('events', (table) => {
      table.dropColumn('hero_logo_position');
    });
  }

  console.log('Hero logo settings columns dropped');
};
