/**
 * Migration: Add header_style and hero_divider_style columns
 *
 * This migration decouples the hero header style from gallery layout,
 * allowing any combination of header style with any layout type.
 */

exports.up = async function(knex) {
  console.log('[Migration 065] Adding header_style and hero_divider_style columns');

  // Check if columns already exist
  const hasHeaderStyle = await knex.schema.hasColumn('events', 'header_style');
  const hasDividerStyle = await knex.schema.hasColumn('events', 'hero_divider_style');

  if (!hasHeaderStyle) {
    await knex.schema.alterTable('events', (table) => {
      table.string('header_style', 20).defaultTo('standard');
    });
    console.log('[Migration 065] Added header_style column');
  }

  if (!hasDividerStyle) {
    await knex.schema.alterTable('events', (table) => {
      table.string('hero_divider_style', 20).defaultTo('wave');
    });
    console.log('[Migration 065] Added hero_divider_style column');
  }

  // Migrate existing events with hero layout in color_theme
  console.log('[Migration 065] Migrating existing hero layouts...');

  const events = await knex('events')
    .whereNotNull('color_theme')
    .select('id', 'color_theme');

  let migratedCount = 0;

  for (const event of events) {
    try {
      // Skip if color_theme is not JSON
      if (!event.color_theme || !event.color_theme.startsWith('{')) {
        continue;
      }

      const theme = JSON.parse(event.color_theme);

      // Check if this event uses hero layout
      if (theme.galleryLayout === 'hero') {
        // Migrate: set headerStyle to 'hero' and galleryLayout to 'grid'
        const updatedTheme = {
          ...theme,
          headerStyle: 'hero',
          galleryLayout: 'grid',
          heroDividerStyle: theme.heroDividerStyle || 'wave'
        };

        await knex('events')
          .where('id', event.id)
          .update({
            color_theme: JSON.stringify(updatedTheme),
            header_style: 'hero',
            hero_divider_style: theme.heroDividerStyle || 'wave'
          });

        migratedCount++;
      }
    } catch (err) {
      // Invalid JSON in color_theme, skip
      console.warn(`[Migration 065] Could not parse color_theme for event ${event.id}: ${err.message}`);
    }
  }

  console.log(`[Migration 065] Migrated ${migratedCount} events from hero layout`);
  console.log('[Migration 065] Completed');
};

exports.down = async function(knex) {
  console.log('[Migration 065] Removing header_style and hero_divider_style columns');

  // First, migrate any hero header styles back to hero layout
  const events = await knex('events')
    .where('header_style', 'hero')
    .whereNotNull('color_theme')
    .select('id', 'color_theme');

  for (const event of events) {
    try {
      if (!event.color_theme || !event.color_theme.startsWith('{')) {
        continue;
      }

      const theme = JSON.parse(event.color_theme);

      // Revert: set galleryLayout back to 'hero'
      const revertedTheme = {
        ...theme,
        galleryLayout: 'hero'
      };

      // Remove the new properties
      delete revertedTheme.headerStyle;
      delete revertedTheme.heroDividerStyle;

      await knex('events')
        .where('id', event.id)
        .update({
          color_theme: JSON.stringify(revertedTheme)
        });
    } catch (err) {
      console.warn(`[Migration 065] Could not revert color_theme for event ${event.id}: ${err.message}`);
    }
  }

  // Remove the columns
  const hasHeaderStyle = await knex.schema.hasColumn('events', 'header_style');
  const hasDividerStyle = await knex.schema.hasColumn('events', 'hero_divider_style');

  if (hasHeaderStyle) {
    await knex.schema.alterTable('events', (table) => {
      table.dropColumn('header_style');
    });
  }

  if (hasDividerStyle) {
    await knex.schema.alterTable('events', (table) => {
      table.dropColumn('hero_divider_style');
    });
  }

  console.log('[Migration 065] Rollback completed');
};
