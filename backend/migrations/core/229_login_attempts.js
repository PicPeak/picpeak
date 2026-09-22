// Fresh installs run the core chain only. Older installs may already have
// this table from legacy migration 015; preserve their attempt history.
exports.up = async function(knex) {
  if (await knex.schema.hasTable('login_attempts')) return;
  await knex.schema.createTable('login_attempts', (table) => {
    table.increments('id').primary();
    table.string('identifier').notNullable();
    table.string('ip_address', 45).notNullable();
    table.text('user_agent');
    table.timestamp('attempt_time').defaultTo(knex.fn.now());
    table.boolean('success').defaultTo(false);
    table.index('identifier');
    table.index('attempt_time');
    table.index(['identifier', 'success', 'attempt_time']);
  });
};

// This table also belongs to the legacy chain. Keep security history on rollback.
exports.down = async function() {};
