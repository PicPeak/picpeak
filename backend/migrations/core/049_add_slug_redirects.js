/**
 * Migration: Add slug_redirects table for event rename feature
 * This table stores old slugs that should redirect to new slugs
 */

exports.up = function(knex) {
  return knex.schema.createTable('slug_redirects', (table) => {
    table.increments('id').primary();
    table.string('old_slug', 255).notNullable().unique();
    table.string('new_slug', 255).notNullable();
    table.integer('event_id').references('id').inTable('events').onDelete('CASCADE');
    table.timestamp('created_at').defaultTo(knex.fn.now());

    // Index for fast lookup
    table.index('old_slug');
  });
};

exports.down = function(knex) {
  return knex.schema.dropTableIfExists('slug_redirects');
};
