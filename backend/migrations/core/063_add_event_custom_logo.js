/**
 * Migration: Add custom logo support to events table
 *
 * Allows per-event custom logo that overrides the global branding logo:
 * - hero_logo_url: Public path to the uploaded custom logo
 * - hero_logo_path: Full filesystem path to the custom logo
 *
 * Logo priority: Event custom logo > Global branding logo > Default PicPeak logo
 *
 * Addresses GitHub Issue #138: Per-event custom logo option
 */

exports.up = async function (knex) {
  console.log('Adding custom logo columns to events table...');

  const hasUrlColumn = await knex.schema.hasColumn('events', 'hero_logo_url');
  if (!hasUrlColumn) {
    await knex.schema.table('events', (table) => {
      table.string('hero_logo_url', 500).nullable().defaultTo(null);
    });
    console.log('Added hero_logo_url column');
  }

  const hasPathColumn = await knex.schema.hasColumn('events', 'hero_logo_path');
  if (!hasPathColumn) {
    await knex.schema.table('events', (table) => {
      table.string('hero_logo_path', 500).nullable().defaultTo(null);
    });
    console.log('Added hero_logo_path column');
  }

  console.log('Migration 063_add_event_custom_logo completed successfully');
};

exports.down = async function (knex) {
  console.log('Rolling back custom logo columns...');

  const hasUrlColumn = await knex.schema.hasColumn('events', 'hero_logo_url');
  if (hasUrlColumn) {
    await knex.schema.table('events', (table) => {
      table.dropColumn('hero_logo_url');
    });
  }

  const hasPathColumn = await knex.schema.hasColumn('events', 'hero_logo_path');
  if (hasPathColumn) {
    await knex.schema.table('events', (table) => {
      table.dropColumn('hero_logo_path');
    });
  }

  console.log('Custom logo columns dropped');
};
