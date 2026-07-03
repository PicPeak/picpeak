/**
 * Migration: Move existing non-grid + 'standard' events to the new 'banner'
 * header style so their visual appearance is preserved.
 *
 * Until now, GalleryLayout.tsx coupled the colored hero banner to non-grid
 * layouts whenever headerStyle was 'standard'. The 'standard' look has been
 * decoupled from layout (it now means: compact inline header, no banner) and
 * a new 'banner' option has been added that adds the colored banner above
 * the standard header.
 *
 * In the same release, GalleryView.tsx stopped deriving controlsStyle from
 * the layout — non-grid events used to default to the sidebar drawer via
 * `theme.galleryLayout !== 'grid' || isHeroHeader`, and now require an
 * explicit `theme.controlsStyle === 'sidebar'`. To keep affected events
 * pixel-identical post-upgrade, this migration also sets controlsStyle to
 * 'sidebar' when it was previously unset on every event we flip to banner.
 *
 * To keep current galleries looking the same, every event whose effective
 * config was non-grid + standard gets migrated to non-grid + banner, and
 * its controlsStyle is pinned to whatever the runtime would have used
 * before the decoupling.
 */
const NON_GRID_LAYOUTS = ['masonry', 'carousel', 'timeline', 'mosaic'];

exports.up = async function(knex) {
  console.log('[Migration 086] Migrating non-grid standard headers to banner');

  const events = await knex('events')
    .where('header_style', 'standard')
    .whereNotNull('color_theme')
    .select('id', 'color_theme');

  let migratedCount = 0;
  let controlsPinnedCount = 0;

  for (const event of events) {
    try {
      if (!event.color_theme || !event.color_theme.startsWith('{')) {
        continue;
      }

      const theme = JSON.parse(event.color_theme);

      if (!NON_GRID_LAYOUTS.includes(theme.galleryLayout)) {
        continue;
      }

      const updatedTheme = { ...theme, headerStyle: 'banner' };

      // Preserve previous filter placement: before this release, non-grid
      // layouts implicitly rendered the sidebar drawer when controlsStyle
      // was unset. Pin it to 'sidebar' so the visual stays identical. Don't
      // overwrite explicit values the user may have set deliberately.
      if (!theme.controlsStyle) {
        updatedTheme.controlsStyle = 'sidebar';
        controlsPinnedCount++;
      }

      await knex('events')
        .where('id', event.id)
        .update({
          color_theme: JSON.stringify(updatedTheme),
          header_style: 'banner'
        });

      migratedCount++;
    } catch (err) {
      console.warn(`[Migration 086] Could not parse color_theme for event ${event.id}: ${err.message}`);
    }
  }

  console.log(`[Migration 086] Migrated ${migratedCount} events from standard to banner`);
  console.log(`[Migration 086] Pinned controlsStyle='sidebar' on ${controlsPinnedCount} events`);
};

exports.down = async function(knex) {
  console.log('[Migration 086] Reverting non-grid banner headers to standard');

  const events = await knex('events')
    .where('header_style', 'banner')
    .whereNotNull('color_theme')
    .select('id', 'color_theme');

  let revertedCount = 0;

  for (const event of events) {
    try {
      if (!event.color_theme || !event.color_theme.startsWith('{')) {
        continue;
      }

      const theme = JSON.parse(event.color_theme);

      // Only revert rows we would have migrated (non-grid + banner). Leaves
      // any banner events that were intentionally created on grid alone.
      if (!NON_GRID_LAYOUTS.includes(theme.galleryLayout)) {
        continue;
      }

      const revertedTheme = { ...theme, headerStyle: 'standard' };

      // Symmetric with up: if controlsStyle is currently 'sidebar', drop it
      // so the runtime falls back to whatever the older code would compute.
      // Cannot perfectly distinguish "we set this" from "user agreed", but
      // the scope is narrow (non-grid + banner) and rolling back is
      // intentionally restoring pre-migration state.
      if (revertedTheme.controlsStyle === 'sidebar') {
        delete revertedTheme.controlsStyle;
      }

      await knex('events')
        .where('id', event.id)
        .update({
          color_theme: JSON.stringify(revertedTheme),
          header_style: 'standard'
        });

      revertedCount++;
    } catch (err) {
      console.warn(`[Migration 086] Could not revert color_theme for event ${event.id}: ${err.message}`);
    }
  }

  console.log(`[Migration 086] Reverted ${revertedCount} events from banner to standard`);
};
