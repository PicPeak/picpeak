/**
 * Migration 372: an optional first-visit walkthrough per gallery (issue 2551).
 *
 * events.walkthrough_enabled: off by default, so existing galleries look
 * exactly as before. New galleries take the Settings > Events default
 * (app_settings `event_default_walkthrough_enabled`), applied at creation
 * like the other `event_default_*` keys. No app_settings row is seeded: the
 * settings save upserts, and a missing key reads as off.
 *
 * Additive, hasColumn-guarded, safe to re-run.
 */
exports.up = async function (knex) {
  if (await knex.schema.hasTable('events')
    && !(await knex.schema.hasColumn('events', 'walkthrough_enabled'))) {
    await knex.schema.alterTable('events', (t) => {
      t.boolean('walkthrough_enabled').notNullable().defaultTo(false);
    });
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasTable('events')
    && await knex.schema.hasColumn('events', 'walkthrough_enabled')) {
    await knex.schema.alterTable('events', (t) => {
      t.dropColumn('walkthrough_enabled');
    });
  }
};
