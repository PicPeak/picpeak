/**
 * Migration: Lightbox medium-resolution preview tier (#492).
 *
 * Adds:
 *   - photos.preview_path  (nullable VARCHAR) — storage key for the
 *     per-photo preview JPEG; populated lazily by ensurePreviewImage
 *     on first lightbox open (or eagerly by the regenerate-previews
 *     admin endpoint). Mirrors photos.thumbnail_path / hero_path.
 *   - app_settings.lightbox_preview_enabled (boolean, default false)
 *     — opt-in toggle. Off by default because the new tier costs
 *     ~200–500 KB per photo on disk; admins flip it on once they've
 *     decided the perf win is worth the storage.
 *
 * No backfill of existing photos here — preview generation is lazy
 * by design and a separate "Regenerate previews" admin button covers
 * eager backfill when an admin wants to warm the cache for an
 * existing gallery.
 *
 * Idempotent: every step checks for existing state.
 */

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('photos'))) return;

  if (!(await knex.schema.hasColumn('photos', 'preview_path'))) {
    await knex.schema.alterTable('photos', (table) => {
      table.string('preview_path');
    });
  }

  if (!(await knex.schema.hasTable('app_settings'))) return;
  const existing = await knex('app_settings')
    .where('setting_key', 'lightbox_preview_enabled')
    .first();
  if (!existing) {
    await knex('app_settings').insert({
      setting_key: 'lightbox_preview_enabled',
      // SQLite stores TEXT, Postgres JSONB — JSON-stringify so both
      // backends round-trip a recognisable boolean shape, matching
      // how other branding_* boolean settings are stored today.
      setting_value: JSON.stringify(false),
      setting_type: 'thumbnail',
      updated_at: new Date(),
    });
  }
};

exports.down = async function(knex) {
  if (await knex.schema.hasTable('app_settings')) {
    await knex('app_settings')
      .where('setting_key', 'lightbox_preview_enabled')
      .del();
  }
  if (await knex.schema.hasTable('photos') && await knex.schema.hasColumn('photos', 'preview_path')) {
    await knex.schema.alterTable('photos', (table) => {
      table.dropColumn('preview_path');
    });
  }
};
