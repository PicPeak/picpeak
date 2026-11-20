'use strict';
/**
 * Migration 367: event codes (issue 2495).
 *
 *   events.access_code   short code a guest types on /code to reach the
 *                        gallery (6 characters from an alphabet without
 *                        0/O/1/I/L, or a 6-12 character code the admin
 *                        chose). Stored uppercase. NULL: no code.
 *
 * UNIQUE, so one code never opens two galleries; NULLs do not collide on
 * either engine. No backfill: event codes are opt-in
 * (general_event_codes_enabled, default off), and a code on a gallery without
 * a password would make it reachable by guessing six characters instead of
 * its long share token. With the setting on, new galleries get a code and
 * the admin generates one for an existing gallery.
 */
const INDEX_NAME = 'events_access_code_unique';

// Column and index are guarded separately: SQLite migrations run without a
// transaction, so an interrupted run can leave the column without its index,
// and a rerun must still add the index.
async function hasIndex(knex, name) {
  if (knex.client.config.client === 'pg') {
    const result = await knex.raw(
      'SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND tablename = ? AND indexname = ?',
      ['events', name],
    );
    return result.rows.length > 0;
  }
  const rows = await knex.raw('SELECT 1 FROM sqlite_master WHERE type = \'index\' AND name = ?', [name]);
  return rows.length > 0;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('events'))) return;

  if (!(await knex.schema.hasColumn('events', 'access_code'))) {
    await knex.schema.alterTable('events', (table) => {
      table.string('access_code', 12).nullable();
    });
  }
  if (!(await hasIndex(knex, INDEX_NAME))) {
    await knex.schema.alterTable('events', (table) => {
      table.unique(['access_code'], { indexName: INDEX_NAME });
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('events'))) return;
  if (!(await knex.schema.hasColumn('events', 'access_code'))) return;
  if (await hasIndex(knex, INDEX_NAME)) {
    await knex.schema.alterTable('events', (table) => {
      table.dropUnique(['access_code'], INDEX_NAME);
    });
  }
  await knex.schema.alterTable('events', (table) => {
    table.dropColumn('access_code');
  });
};
