/**
 * Let identity_mode hold 'shared' (#1197).
 *
 * Migration 078 created the column with a Postgres CHECK constraint pinned to
 * the two modes that existed then:
 *
 *   CHECK (identity_mode IN ('simple','guest'))
 *
 * SQLite never got one — 078 guards that statement on `client === 'pg'` — so
 * the third mode saves happily there and fails on Postgres, which is what the
 * default production install runs. Widening the validator without this
 * migration means the feature cannot be switched on at all in production, and
 * no SQLite test can see it.
 *
 * DROP then ADD rather than an in-place edit: Postgres has no ALTER CONSTRAINT
 * for a CHECK, and IF EXISTS makes the pair safe to re-run from either state.
 */

exports.up = async function (knex) {
  if (knex.client.config.client !== 'pg') return;

  const hasColumn = await knex.schema.hasColumn('event_feedback_settings', 'identity_mode');
  if (!hasColumn) return;

  await knex.raw('ALTER TABLE event_feedback_settings DROP CONSTRAINT IF EXISTS event_feedback_settings_identity_mode_check');
  await knex.raw(`
    ALTER TABLE event_feedback_settings
    ADD CONSTRAINT event_feedback_settings_identity_mode_check
    CHECK (identity_mode IN ('simple','guest','shared'))
  `);
};

exports.down = async function (knex) {
  if (knex.client.config.client !== 'pg') return;

  const hasColumn = await knex.schema.hasColumn('event_feedback_settings', 'identity_mode');
  if (!hasColumn) return;

  // Any event actually using the mode has to come back to a value the old
  // constraint accepts, or the ADD below fails and the down() cannot complete.
  // 'simple' rather than 'guest': it is the column default and the mode that
  // needs nothing of the guest identity machinery. The shared colour rows stay
  // where they are — they simply stop being read, exactly as they do when an
  // operator switches the mode by hand.
  await knex('event_feedback_settings').where({ identity_mode: 'shared' }).update({ identity_mode: 'simple' });

  await knex.raw('ALTER TABLE event_feedback_settings DROP CONSTRAINT IF EXISTS event_feedback_settings_identity_mode_check');
  await knex.raw(`
    ALTER TABLE event_feedback_settings
    ADD CONSTRAINT event_feedback_settings_identity_mode_check
    CHECK (identity_mode IN ('simple','guest'))
  `);
};
