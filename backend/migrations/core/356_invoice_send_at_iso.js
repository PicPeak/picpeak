'use strict';
/**
 * Migration 356: invoices.scheduled_send_at as ISO text on SQLite.
 *
 * The invoice create paths stored the send date as epoch milliseconds and
 * the update route stored the editor's zone-less text. SQLite sorts every
 * number below every text value, so the scheduler matched only one of the
 * two shapes, and the invoice page crashed on the number. The code now
 * writes ISO text everywhere (toStoredTimestamp in utils/dateNormalize);
 * this rewrites the values already stored (utils/invoiceSendAt, which the
 * portable import runs again after loading an older archive). PostgreSQL
 * has a typed timestamp column and nothing to convert.
 *
 * A re-run finds nothing left to rewrite.
 */
const { isoSqliteInvoiceSendAt } = require('../../src/utils/invoiceSendAt');

exports.up = async function up(knex) {
  await isoSqliteInvoiceSendAt(knex);
};

// Back to epoch milliseconds for the ISO values: the code before this
// migration compares the column with a Date, which binds as a number on
// SQLite. Raw SQL for julianday() and typeof(), as in utils/invoiceSendAt.
// One way only: a stuck invoice that up() held as a draft, and text that was
// no date, stay without a send date (the invoice history records the hold).
exports.down = async function down(knex) {
  if (knex.client.config.client === 'pg') return;
  if (!(await knex.schema.hasTable('invoices'))) return;
  if (!(await knex.schema.hasColumn('invoices', 'scheduled_send_at'))) return;
  await knex.raw(`
    UPDATE invoices
       SET scheduled_send_at = CAST(ROUND((julianday(scheduled_send_at) - 2440587.5) * 86400000) AS INTEGER)
     WHERE typeof(scheduled_send_at) = 'text'
       AND scheduled_send_at LIKE '____-__-__T__:__:__%Z'
  `);
};
