'use strict';
/**
 * Migration 360: invoice_payment_check_tokens.recipient_admin_id.
 *
 * A payment-check link records a payment without a login, so it may only be
 * used while the admin it was mailed to may still record payments on the
 * invoice. The link now names that admin; a link mailed to the business
 * address carries none. No foreign key: a link whose admin row is gone must
 * stop working rather than be cleared into a business-address link.
 *
 * Existing links keep no recipient (who received them is not recorded) and
 * run out within their 72 hours. Additive and idempotent.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('invoice_payment_check_tokens'))) return;
  if (!(await knex.schema.hasColumn('invoice_payment_check_tokens', 'recipient_admin_id'))) {
    await knex.schema.alterTable('invoice_payment_check_tokens', (t) => {
      t.integer('recipient_admin_id').nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('invoice_payment_check_tokens'))) return;
  if (!(await knex.schema.hasColumn('invoice_payment_check_tokens', 'recipient_admin_id'))) return;
  await knex.schema.alterTable('invoice_payment_check_tokens', (t) => t.dropColumn('recipient_admin_id'));
};
