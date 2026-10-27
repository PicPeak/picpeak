'use strict';
const { addColumnIfNotExists } = require('../helpers');

exports.up = async function up(knex) {
  await knex('app_settings').insert({ setting_key: 'payments_configuration_lock', setting_type: 'payments', setting_value: '0' })
    .onConflict('setting_key').ignore();
  const fields = {
    provider_order_id: (t) => t.string('provider_order_id', 191).nullable(),
    checkout_scan_started_at: (t) => t.string('checkout_scan_started_at', 32).nullable(),
    checkout_scan_cursor: (t) => t.string('checkout_scan_cursor', 191).nullable(),
    recovery_attempts: (t) => t.integer('recovery_attempts').notNullable().defaultTo(0),
    recovery_next_at: (t) => t.string('recovery_next_at', 32).nullable(),
    recovery_error: (t) => t.string('recovery_error', 64).nullable(),
    recovery_needs_attention: (t) => t.boolean('recovery_needs_attention').notNullable().defaultTo(false),
  };
  for (const [name, define] of Object.entries(fields)) await addColumnIfNotExists(knex, 'photo_purchase_orders', name, define);
  await knex('photo_purchase_orders').where({ payment_provider: 'snipcart' }).whereNull('provider_order_id')
    .whereNull('checkout_token').update({ provider_order_id: knex.ref('order_id') });
  const name = 'photo_orders_provider_reference_unique';
  await knex.raw('CREATE UNIQUE INDEX IF NOT EXISTS ?? ON ?? (??, ??)',
    [name, 'photo_purchase_orders', 'payment_provider', 'provider_order_id']);
};

exports.down = async function down(knex) {
  if (await knex('photo_purchase_orders').whereNotNull('checkout_token').first('id')) {
    throw new Error('Cannot remove checkout recovery storage while checkout orders exist');
  }
  await knex.raw('DROP INDEX IF EXISTS ??', ['photo_orders_provider_reference_unique']);
  for (const name of ['recovery_needs_attention', 'recovery_error', 'recovery_next_at', 'recovery_attempts', 'checkout_scan_cursor', 'checkout_scan_started_at', 'provider_order_id']) {
    if (await knex.schema.hasColumn('photo_purchase_orders', name)) await knex.schema.alterTable('photo_purchase_orders', (t) => t.dropColumn(name));
  }
};
