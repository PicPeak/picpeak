/**
 * Migration: Add created_by column to events table
 * This allows filtering events by owner for role-based access control
 */

exports.up = async function(knex) {
  // Add created_by column to events table
  await knex.schema.alterTable('events', (table) => {
    table.integer('created_by').unsigned().references('id').inTable('admin_users').onDelete('SET NULL');
  });
  
  // Set existing events to be owned by the first admin (super_admin)
  const superAdmin = await knex('admin_users').where('role_id', 1).first();
  if (superAdmin) {
    await knex('events').update({ created_by: superAdmin.id });
  }
};

exports.down = async function(knex) {
  await knex.schema.alterTable('events', (table) => {
    table.dropColumn('created_by');
  });
};
