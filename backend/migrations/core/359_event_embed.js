'use strict';
/**
 * Migration 359: embed a gallery on another website (issue 1112).
 *
 *   events.embed_token            the token in the embed URL
 *                                 /gallery/:slug/embed/:token. NULL until the
 *                                 admin creates the embed; rotating it kills
 *                                 every page that embeds the old one.
 *   events.embed_allowed_origins  JSON array of origins allowed to frame the
 *                                 embed (CSP frame-ancestors). NULL or empty:
 *                                 any site.
 *
 * Only a gallery without a password can be embedded; the routes check that,
 * not the schema. The `embed` feature flag (off) is the kill-switch.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('events')) {
    if (!(await knex.schema.hasColumn('events', 'embed_token'))) {
      await knex.schema.alterTable('events', (table) => {
        // Unique, like show_share_token: one link never opens two galleries.
        table.string('embed_token', 64).nullable().unique();
      });
    }
    if (!(await knex.schema.hasColumn('events', 'embed_allowed_origins'))) {
      await knex.schema.alterTable('events', (table) => {
        table.text('embed_allowed_origins').nullable();
      });
    }
  }

  if (await knex.schema.hasTable('feature_flags')) {
    const flag = await knex('feature_flags').where({ key: 'embed' }).first();
    if (!flag) await knex('feature_flags').insert({ key: 'embed', value: false });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('events')) {
    for (const column of ['embed_allowed_origins', 'embed_token']) {
      if (await knex.schema.hasColumn('events', column)) {
        await knex.schema.alterTable('events', (table) => table.dropColumn(column));
      }
    }
  }
  if (await knex.schema.hasTable('feature_flags')) {
    await knex('feature_flags').where({ key: 'embed' }).del();
  }
};
