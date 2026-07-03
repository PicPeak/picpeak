exports.up = async function(knex) {
  await knex.schema.alterTable('events', (table) => {
    table.string('host_email', 255).nullable().alter();
    table.string('admin_email', 255).nullable().alter();
  });
};

exports.down = async function(knex) {
  await knex.schema.alterTable('events', (table) => {
    table.string('host_email', 255).notNullable().defaultTo('').alter();
    table.string('admin_email', 255).notNullable().defaultTo('').alter();
  });
};
