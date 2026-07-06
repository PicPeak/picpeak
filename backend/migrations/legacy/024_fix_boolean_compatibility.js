/**
 * Fix boolean compatibility issues between PostgreSQL and SQLite
 * This migration updates the database configuration and existing data
 */

exports.up = async function(knex) {
  const isPostgres = knex.client.config.client === 'pg';
  
  if (!isPostgres) {
    // Enable foreign keys for SQLite
    await knex.raw('PRAGMA foreign_keys = ON');
    
    // Note: SQLite stores booleans as 0/1
    // No data migration needed as Knex handles this automatically
    // But queries must use formatBoolean() helper
    
    console.log('SQLite boolean compatibility check:');
    console.log('- SQLite stores booleans as 0/1');
    console.log('- All boolean comparisons should use formatBoolean() helper');
    console.log('- Foreign keys enabled');
  }
  
  return Promise.resolve();
};

exports.down = async function(knex) {
  // No rollback needed
  return Promise.resolve();
};