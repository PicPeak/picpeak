const { addColumnIfNotExists } = require('../helpers');

exports.up = async function up(knex) {
  // Add tls_reject_unauthorized column to email_configs table
  // Default is true (validate certificates), false means ignore SSL/TLS certificate errors
  await addColumnIfNotExists(knex, 'email_configs', 'tls_reject_unauthorized', (table) => {
    table.boolean('tls_reject_unauthorized').defaultTo(true);
  });
};

exports.down = async function down(knex) {
  const hasColumn = await knex.schema.hasColumn('email_configs', 'tls_reject_unauthorized');
  if (hasColumn) {
    await knex.schema.alterTable('email_configs', (table) => {
      table.dropColumn('tls_reject_unauthorized');
    });
  }
};
