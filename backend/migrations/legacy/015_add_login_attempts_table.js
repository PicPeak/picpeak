exports.up = async function(knex) {
  const hasLoginAttemptsTable = await knex.schema.hasTable('login_attempts');
  
  if (!hasLoginAttemptsTable) {
    return knex.schema.createTable('login_attempts', table => {
      table.increments('id').primary();
      table.string('identifier').notNullable(); // username or email
      table.string('ip_address', 45).notNullable(); // IPv4 or IPv6
      table.text('user_agent');
      table.timestamp('attempt_time').defaultTo(knex.fn.now());
      table.boolean('success').defaultTo(false);
      
      // Indexes for performance
      table.index('identifier');
      table.index('attempt_time');
      table.index(['identifier', 'success', 'attempt_time']);
    });
  }
};

exports.down = function(knex) {
  return knex.schema.dropTableIfExists('login_attempts');
};