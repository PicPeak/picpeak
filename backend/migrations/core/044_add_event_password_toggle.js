exports.up = async function (knex) {
  const hasColumn = await knex.schema.hasColumn('events', 'require_password');
  if (!hasColumn) {
    await knex.schema.table('events', (table) => {
      table.boolean('require_password').notNullable().defaultTo(true);
    });
    await knex('events').update({ require_password: true });
  }
};

exports.down = async function (knex) {
  const hasColumn = await knex.schema.hasColumn('events', 'require_password');
  if (hasColumn) {
    await knex.schema.table('events', (table) => {
      table.dropColumn('require_password');
    });
  }
};
