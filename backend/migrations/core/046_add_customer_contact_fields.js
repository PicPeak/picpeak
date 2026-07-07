const { addColumnIfNotExists } = require('../helpers');

exports.up = async function up(knex) {
  await addColumnIfNotExists(knex, 'events', 'customer_name', (table) => {
    table.string('customer_name');
  });

  await addColumnIfNotExists(knex, 'events', 'customer_email', (table) => {
    table.string('customer_email');
  });

  // Backfill new columns from legacy host_* fields
  const client = knex?.client?.config?.client;

  if (client === 'pg') {
    await knex.raw(`
      UPDATE events
      SET customer_name = COALESCE(customer_name, host_name),
          customer_email = COALESCE(customer_email, host_email)
    `);
  } else {
    // SQLite fallback
    await knex('events').update({
      customer_name: knex.raw('COALESCE(customer_name, host_name)'),
      customer_email: knex.raw('COALESCE(customer_email, host_email)')
    });
  }
};

exports.down = async function down(knex) {
  const hasCustomerName = await knex.schema.hasColumn('events', 'customer_name');
  if (hasCustomerName) {
    await knex.schema.alterTable('events', (table) => {
      table.dropColumn('customer_name');
    });
  }

  const hasCustomerEmail = await knex.schema.hasColumn('events', 'customer_email');
  if (hasCustomerEmail) {
    await knex.schema.alterTable('events', (table) => {
      table.dropColumn('customer_email');
    });
  }
};
