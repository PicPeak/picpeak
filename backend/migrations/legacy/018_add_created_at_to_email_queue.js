exports.up = async function(knex) {
  // Check if created_at column already exists
  const hasCreatedAt = await knex.schema.hasColumn('email_queue', 'created_at');
  
  if (!hasCreatedAt) {
    await knex.schema.table('email_queue', (table) => {
      table.datetime('created_at').defaultTo(knex.fn.now());
    });
    
    // Update existing rows to have a created_at value based on scheduled_at
    await knex('email_queue')
      .whereNull('created_at')
      .update({
        created_at: knex.ref('scheduled_at')
      });
  }
};

exports.down = async function(knex) {
  await knex.schema.table('email_queue', (table) => {
    table.dropColumn('created_at');
  });
};