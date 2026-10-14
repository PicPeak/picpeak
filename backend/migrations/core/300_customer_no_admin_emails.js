'use strict';

/**
 * Migration 300: per-customer "no administrative emails" switch.
 *
 * When true, quote / contract / invoice / reminder / document-request mails
 * addressed to this customer are recorded in the email log as `suppressed`
 * instead of being sent. The documents themselves are issued as usual and
 * stay visible in the customer portal for a customer who has access.
 * Defaults to false, so every existing customer keeps receiving mail exactly
 * as before. Additive; safe to re-run.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customer_accounts'))) return;
  if (await knex.schema.hasColumn('customer_accounts', 'no_admin_emails')) return;
  await knex.schema.alterTable('customer_accounts', (table) => {
    table.boolean('no_admin_emails').notNullable().defaultTo(false);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('customer_accounts'))) return;
  if (!(await knex.schema.hasColumn('customer_accounts', 'no_admin_emails'))) return;
  await knex.schema.alterTable('customer_accounts', (table) => {
    table.dropColumn('no_admin_emails');
  });
};
