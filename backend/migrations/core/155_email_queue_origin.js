/**
 * Messages Phase 3 — distinguish human-composed sends from system mail.
 *
 * `origin` is 'system' for everything the app queues automatically (invoices,
 * reminders, gallery notices — the Automated stream) and 'manual' for emails an
 * admin composed/edited in the Messages composer (replies + document messages —
 * the Customers ▸ Sent stream). Existing rows default to 'system'.
 */
exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('email_queue', 'origin');
  if (!has) {
    await knex.schema.alterTable('email_queue', (t) => {
      t.string('origin', 16).defaultTo('system');
    });
  }
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('email_queue', 'origin');
  if (has) {
    await knex.schema.alterTable('email_queue', (t) => {
      t.dropColumn('origin');
    });
  }
};
