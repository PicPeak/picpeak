'use strict';

// Independent of expiration, archiving and deletion: taking a gallery offline
// must leave its lifecycle and credentials intact.
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('events') && !(await knex.schema.hasColumn('events', 'temporarily_disabled'))) {
    await knex.schema.alterTable('events', (table) => {
      table.boolean('temporarily_disabled').notNullable().defaultTo(false);
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('events') && await knex.schema.hasColumn('events', 'temporarily_disabled')) {
    await knex.schema.alterTable('events', (table) => table.dropColumn('temporarily_disabled'));
  }
};
