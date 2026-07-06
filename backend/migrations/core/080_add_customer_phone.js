const { addColumnIfNotExists } = require('../helpers');

/**
 * #322 — optional phone-number field on events. Off by default; surfaced
 * only when the global `event_phone_field_enabled` app setting is true,
 * so existing deployments see no UI change unless the admin opts in.
 */
exports.up = async function up(knex) {
  await addColumnIfNotExists(knex, 'events', 'customer_phone', (table) => {
    table.string('customer_phone', 32).nullable();
  });

  // Seed the global enable flag (default false).
  const exists = await knex('app_settings')
    .where('setting_key', 'event_phone_field_enabled')
    .first();
  if (!exists) {
    await knex('app_settings').insert({
      setting_key: 'event_phone_field_enabled',
      setting_value: JSON.stringify(false),
      setting_type: 'boolean'
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('events', 'customer_phone')) {
    await knex.schema.alterTable('events', (table) => {
      table.dropColumn('customer_phone');
    });
  }
  await knex('app_settings').where('setting_key', 'event_phone_field_enabled').delete();
};
