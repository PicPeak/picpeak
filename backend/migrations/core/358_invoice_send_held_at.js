'use strict';
/**
 * Migration 358: invoices.send_held_at (issue 2456).
 *
 * Migration 356, and the portable import of an older archive, hold a
 * scheduled invoice whose send date passed without sending: the send date is
 * cleared, so it shows as a draft. The automatic product append
 * (albumProducts/billing) extends exactly such unarmed drafts, but the admin
 * had finished and armed this one. send_held_at marks the hold; the append
 * skips a marked invoice, and a new send date or the send clears it.
 *
 * Backfill: the invoices 356 held are found by the hold's history row and
 * marked with its time, unless they moved since (utils/invoiceSendAt
 * markHeldInvoices). Additive and idempotent.
 */
const { markHeldInvoices } = require('../../src/utils/invoiceSendAt');

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('invoices'))) return;
  if (!(await knex.schema.hasColumn('invoices', 'send_held_at'))) {
    await knex.schema.alterTable('invoices', (t) => t.timestamp('send_held_at').nullable());
  }
  await markHeldInvoices(knex);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('invoices'))) return;
  if (!(await knex.schema.hasColumn('invoices', 'send_held_at'))) return;
  await knex.schema.alterTable('invoices', (t) => t.dropColumn('send_held_at'));
};
