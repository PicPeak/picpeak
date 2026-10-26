'use strict';

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('events') && !(await knex.schema.hasColumn('events', 'client_pin_entry_enabled'))) {
    await knex.schema.alterTable('events', (table) => {
      table.boolean('client_pin_entry_enabled').notNullable().defaultTo(false);
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('events') && await knex.schema.hasColumn('events', 'client_pin_entry_enabled')) {
    await knex.schema.alterTable('events', (table) => { table.dropColumn('client_pin_entry_enabled'); });
  }
};
