'use strict';

/**
 * When a queued mail was first deferred by a mail server outage
 * (services/emailProcessor.js). A deferral spends none of the mail's three
 * attempts, so this caps it: three days after its first deferral the mail goes
 * back to the attempt cap and can end as failed mail an admin sees.
 *
 * Kept on the row, not in memory, so a restart or another mail getting through
 * does not start the count again. NULL for every mail never deferred.
 * Written with queueTimestamp like scheduled_at: epoch milliseconds on SQLite.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_queue'))) return;
  if (!(await knex.schema.hasColumn('email_queue', 'deferred_since'))) {
    await knex.schema.alterTable('email_queue', (table) => table.timestamp('deferred_since').nullable());
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('email_queue') && await knex.schema.hasColumn('email_queue', 'deferred_since')) {
    await knex.schema.alterTable('email_queue', (table) => table.dropColumn('deferred_since'));
  }
};
