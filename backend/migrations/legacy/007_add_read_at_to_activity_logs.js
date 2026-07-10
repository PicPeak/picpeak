exports.up = async function(knex) {
  // Add read_at column to activity_logs table
  const hasReadAt = await knex.schema.hasColumn('activity_logs', 'read_at');
  if (!hasReadAt) {
    await knex.schema.table('activity_logs', (table) => {
      table.datetime('read_at').nullable();
    });
  }
};

exports.down = async function(knex) {
  await knex.schema.table('activity_logs', (table) => {
    table.dropColumn('read_at');
  });
};