'use strict';

/**
 * Migration 258: remember the focal point a hero rendition was cut at
 * (issue 1737).
 *
 * The hero tier is a 1920x1080 cover crop and it was always cut at the
 * centre; events.hero_image_anchor only reached the gallery as CSS
 * object-position, which can move within that centre crop but never reach
 * the top or bottom of a portrait source. The crop now follows the anchor,
 * and this column records which one the stored file was cut at, so
 * ensureHeroImage regenerates it once the event's anchor changes. NULL is
 * the pre-258 centre crop.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('photos'))) return;
  if (await knex.schema.hasColumn('photos', 'hero_anchor')) return;
  await knex.schema.alterTable('photos', (t) => t.string('hero_anchor', 16));
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('photos'))) return;
  if (!(await knex.schema.hasColumn('photos', 'hero_anchor'))) return;
  await knex.schema.alterTable('photos', (t) => t.dropColumn('hero_anchor'));
};
