/**
 * Migration: Add optional event fields settings
 * These settings control whether customer name, customer email, and admin email
 * are required when creating new events.
 */

exports.up = async function(knex) {
  const settings = [
    { setting_key: 'event_require_customer_name', setting_value: JSON.stringify(true), setting_type: 'boolean' },
    { setting_key: 'event_require_customer_email', setting_value: JSON.stringify(true), setting_type: 'boolean' },
    { setting_key: 'event_require_admin_email', setting_value: JSON.stringify(true), setting_type: 'boolean' }
  ];

  for (const setting of settings) {
    const exists = await knex('app_settings').where('setting_key', setting.setting_key).first();
    if (!exists) {
      await knex('app_settings').insert({
        ...setting,
        updated_at: knex.fn.now()
      });
    }
  }
};

exports.down = function(knex) {
  return knex('app_settings')
    .whereIn('setting_key', [
      'event_require_customer_name',
      'event_require_customer_email',
      'event_require_admin_email'
    ])
    .del();
};
