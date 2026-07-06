/**
 * Migration: configurable business hours on the business profile.
 *
 * Adds two columns to the singleton business_profile row (id=1):
 *
 *   business_hours              TEXT  — JSON, per-ISO-weekday opening
 *                                       blocks. Shape:
 *                                         {"1":[{"start":"09:00","end":"12:00"},
 *                                               {"start":"13:00","end":"18:00"}],
 *                                          ...,"7":[]}
 *                                       Keys are ISO weekdays 1=Mon … 7=Sun;
 *                                       a day with no blocks is closed.
 *                                       Multiple blocks per day model lunch
 *                                       breaks (Google-style).
 *   scheduled_email_floor_enabled BOOLEAN default TRUE — master switch for
 *                                       holding scheduled emails until the
 *                                       next open block.
 *
 * business_hours defaults to NULL (no hours configured). A null / empty
 * schedule makes the scheduled-email floor a no-op, so existing installs
 * keep today's behaviour — emails send at their requested instant until
 * the admin actually defines opening hours (migration-preserve-state).
 *
 * The timezone the blocks are interpreted in is the EXISTING
 * business_profile.timezone column (added earlier for the admin calendar)
 * — no new tz column. The whole business-hours definition lives on the
 * business profile, which is where the admin edits it.
 *
 * Idempotent: each column guarded by hasColumn so a re-run is a no-op.
 */

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('business_profile'))) return;

  if (!(await knex.schema.hasColumn('business_profile', 'business_hours'))) {
    await knex.schema.alterTable('business_profile', (table) => {
      table.text('business_hours');
    });
  }

  if (!(await knex.schema.hasColumn('business_profile', 'scheduled_email_floor_enabled'))) {
    await knex.schema.alterTable('business_profile', (table) => {
      table.boolean('scheduled_email_floor_enabled').notNullable().defaultTo(true);
    });
  }
};

exports.down = async function(knex) {
  if (!(await knex.schema.hasTable('business_profile'))) return;

  if (await knex.schema.hasColumn('business_profile', 'scheduled_email_floor_enabled')) {
    await knex.schema.alterTable('business_profile', (table) => {
      table.dropColumn('scheduled_email_floor_enabled');
    });
  }
  if (await knex.schema.hasColumn('business_profile', 'business_hours')) {
    await knex.schema.alterTable('business_profile', (table) => {
      table.dropColumn('business_hours');
    });
  }
};
