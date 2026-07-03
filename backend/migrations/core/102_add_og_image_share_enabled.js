/**
 * Migration: Per-event opt-in for using the gallery hero photo as the
 * Open Graph share image (#474).
 *
 * Background: galleryOgService already serves OG/Twitter Card meta
 * tags to social-crawler User-Agents (WhatsApp, Facebook, Slack,
 * Telegram, Discord, etc.) for /gallery/<slug> URLs — see
 * frontend/nginx.conf and backend/src/services/galleryOgService.js.
 * Today the og:image is always the brand logo, with the inline
 * rationale "no protected photo content."
 *
 * #474 asks for a hero/cover photo preview. The trade-off is that
 * the og:image is fetched unauthenticated by every link-preview
 * crawler, so any opted-in image is effectively public. We ship
 * this as a per-event boolean, default FALSE, so existing galleries
 * never start surfacing photos until the admin consciously flips it
 * on per gallery.
 *
 * When set to TRUE and the event has a hero_photo_id with a
 * generated thumbnail, galleryOgService points og:image at the new
 * /og/gallery/:slug/cover endpoint. With it set to FALSE (or no
 * hero photo selected) the brand logo is used as before.
 *
 * Idempotent: re-runs are no-ops.
 */

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('events'))) return;
  if (await knex.schema.hasColumn('events', 'og_image_share_enabled')) return;
  await knex.schema.alterTable('events', (table) => {
    // Default false everywhere so an upgrade never starts leaking the
    // hero photo of a password-protected gallery without admin intent.
    table.boolean('og_image_share_enabled').notNullable().defaultTo(false);
  });
};

exports.down = async function(knex) {
  if (!(await knex.schema.hasTable('events'))) return;
  if (!(await knex.schema.hasColumn('events', 'og_image_share_enabled'))) return;
  await knex.schema.alterTable('events', (table) => {
    table.dropColumn('og_image_share_enabled');
  });
};
