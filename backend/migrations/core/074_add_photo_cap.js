const { addColumnIfNotExists } = require('../helpers');

exports.up = async function(knex) {
  console.log('Running migration: 074_add_photo_cap');
  await addColumnIfNotExists(knex, 'events', 'photo_cap', (table) => {
    table.integer('photo_cap').nullable().defaultTo(null);
  });
  console.log('Migration 074_add_photo_cap completed');
};

exports.down = async function(knex) {
  console.log('Rollback: 074_add_photo_cap');
};
