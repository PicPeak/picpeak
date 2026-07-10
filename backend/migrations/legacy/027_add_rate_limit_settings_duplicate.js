exports.up = async function(knex) {
  // Add rate limit settings to app_settings
  const rateLimitSettings = [
    {
      setting_key: 'rate_limit_enabled',
      setting_value: JSON.stringify(true),
      setting_type: 'security'
    },
    {
      setting_key: 'rate_limit_window_minutes',
      setting_value: JSON.stringify(15),
      setting_type: 'security'
    },
    {
      setting_key: 'rate_limit_max_requests',
      setting_value: JSON.stringify(1000),
      setting_type: 'security'
    },
    {
      setting_key: 'rate_limit_auth_max_requests',
      setting_value: JSON.stringify(5),
      setting_type: 'security'
    },
    {
      setting_key: 'rate_limit_skip_authenticated',
      setting_value: JSON.stringify(true),
      setting_type: 'security'
    },
    {
      setting_key: 'rate_limit_public_endpoints_only',
      setting_value: JSON.stringify(false),
      setting_type: 'security'
    }
  ];

  // Insert settings if they don't exist
  for (const setting of rateLimitSettings) {
    const exists = await knex('app_settings')
      .where('setting_key', setting.setting_key)
      .first();
    
    if (!exists) {
      await knex('app_settings').insert({
        ...setting
      });
    }
  }
};

exports.down = async function(knex) {
  // Remove rate limit settings
  await knex('app_settings')
    .whereIn('setting_key', [
      'rate_limit_enabled',
      'rate_limit_window_minutes',
      'rate_limit_max_requests',
      'rate_limit_auth_max_requests',
      'rate_limit_skip_authenticated',
      'rate_limit_public_endpoints_only'
    ])
    .del();
};