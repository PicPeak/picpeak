'use strict';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('events'))) return;
  if (!(await knex.schema.hasColumn('events', 'temporarily_disabled_at'))) {
    await knex.schema.alterTable('events', (table) => table.string('temporarily_disabled_at', 32).nullable());
  }
  // An older development install has no trustworthy earlier pause start.
  // Start tracking now, without reviving purchases that already expired.
  await knex('events').where({ temporarily_disabled: true }).whereNull('temporarily_disabled_at')
    .update({ temporarily_disabled_at: new Date().toISOString() });
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('events') && await knex.schema.hasColumn('events', 'temporarily_disabled_at')) {
    await knex.schema.alterTable('events', (table) => table.dropColumn('temporarily_disabled_at'));
  }
};
