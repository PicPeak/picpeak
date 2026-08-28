/**
 * Migration 185: gallery folders (#1160).
 *
 * Adds `is_folder` to `photo_categories`. A category has always been a FILTER —
 * every photo stays in the main grid and picking a category narrows it. A folder
 * is a CONTAINER: its photos leave the root grid entirely and are only shown once
 * the guest clicks into the folder.
 *
 * One column is enough because the surrounding features already built the rest:
 *   - `hero_photo_id` (#163, migration 066)      → the folder cover image
 *   - `allow_downloads` (#640, migration 135)    → per-folder download rules
 *   - `display_order` + `event_category_order`   → folder ordering (#782, 159/160)
 *   - `photos.category_id` is single-valued      → a photo lives in one folder
 *
 * Deliberately NOT added: `parent_id`. The request (D#1086) is "root → Selects
 * folder", which is depth one, i.e. plain containment. Folders-inside-folders
 * stays out until someone actually asks for it.
 *
 * No backfill: `false` IS the preserved behaviour, so every existing category
 * keeps filtering exactly as before and folders are opt-in per category.
 *
 * Additive + hasColumn-guarded, matching migration 159.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('photo_categories'))) return;

  if (!(await knex.schema.hasColumn('photo_categories', 'is_folder'))) {
    await knex.schema.alterTable('photo_categories', (t) => {
      t.boolean('is_folder').notNullable().defaultTo(false);
    });
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('photo_categories'))) return;
  if (await knex.schema.hasColumn('photo_categories', 'is_folder')) {
    await knex.schema.alterTable('photo_categories', (t) => t.dropColumn('is_folder'));
  }
};
