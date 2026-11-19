'use strict';
/**
 * Migration 367: event codes (issue 2495).
 *
 *   events.access_code   short code a guest types on /code to reach the
 *                        gallery (6 characters from an alphabet without
 *                        0/O/1/I/L, or a 4-12 character code the admin
 *                        chose). Stored uppercase. NULL: no code.
 *
 * UNIQUE, so one code never opens two galleries; NULLs do not collide on
 * either engine. Backfills a code for every gallery that is not archived. The
 * alphabet is repeated from services/eventAccessCode.js on purpose: a
 * migration must not change when the service does.
 */
const crypto = require('crypto');

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const INDEX_NAME = 'events_access_code_unique';

function generate(taken) {
  for (;;) {
    let code = '';
    for (let i = 0; i < 6; i += 1) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
    if (!taken.has(code)) {
      taken.add(code);
      return code;
    }
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('events'))) return;

  if (!(await knex.schema.hasColumn('events', 'access_code'))) {
    await knex.schema.alterTable('events', (table) => {
      table.string('access_code', 12).nullable();
    });
    await knex.schema.alterTable('events', (table) => {
      table.unique(['access_code'], { indexName: INDEX_NAME });
    });
  }

  // Backfill. A re-run only fills rows still without a code. is_archived is a
  // boolean on PostgreSQL and 0/1 on SQLite; `false` binds as either.
  const taken = new Set(
    (await knex('events').whereNotNull('access_code').select('access_code')).map((row) => row.access_code)
  );
  const rows = await knex('events')
    .whereNull('access_code')
    .where((q) => q.where('is_archived', false).orWhereNull('is_archived'))
    .select('id');
  for (const { id } of rows) {
    await knex('events').where({ id }).whereNull('access_code').update({ access_code: generate(taken) });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('events'))) return;
  if (!(await knex.schema.hasColumn('events', 'access_code'))) return;
  await knex.schema.alterTable('events', (table) => {
    table.dropUnique(['access_code'], INDEX_NAME);
  });
  await knex.schema.alterTable('events', (table) => {
    table.dropColumn('access_code');
  });
};
