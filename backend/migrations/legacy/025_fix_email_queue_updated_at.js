/**
 * Fix email_queue table by ensuring it doesn't have updated_at column
 * This migration addresses the PostgreSQL error where queries are trying to update
 * a non-existent updated_at column
 */

exports.up = async function(knex) {
  // First, check if the column exists
  const hasUpdatedAt = await knex.schema.hasColumn('email_queue', 'updated_at');
  
  if (hasUpdatedAt) {
    console.log('Found updated_at column in email_queue table, removing it...');
    await knex.schema.table('email_queue', (table) => {
      table.dropColumn('updated_at');
    });
  }
  
  // Also ensure the table has all required columns
  const hasCreatedAt = await knex.schema.hasColumn('email_queue', 'created_at');
  if (!hasCreatedAt) {
    console.log('Adding missing created_at column to email_queue table...');
    await knex.schema.table('email_queue', (table) => {
      table.datetime('created_at').defaultTo(knex.fn.now());
    });
  }
  
  console.log('email_queue table schema fixed');
};

exports.down = async function(knex) {
  // In the down migration, we don't add back updated_at since it shouldn't exist
  // This is intentionally left minimal
};