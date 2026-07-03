const {
  DEFAULT_PUBLIC_SITE_HTML,
} = require('../../src/constants/publicSiteDefaults');

exports.up = async function(knex) {
  const defaults = [
    {
      setting_key: 'general_public_site_enabled',
      setting_value: JSON.stringify(false),
      setting_type: 'general'
    },
    {
      setting_key: 'general_public_site_html',
      setting_value: JSON.stringify(DEFAULT_PUBLIC_SITE_HTML.trim()),
      setting_type: 'general'
    },
    {
      setting_key: 'general_public_site_custom_css',
      setting_value: JSON.stringify(''),
      setting_type: 'general'
    }
  ];

  for (const setting of defaults) {
    const exists = await knex('app_settings')
      .where('setting_key', setting.setting_key)
      .first();

    if (!exists) {
      await knex('app_settings').insert({
        ...setting,
        updated_at: knex.fn.now()
      });
    }
  }
};

exports.down = async function(knex) {
  await knex('app_settings')
    .whereIn('setting_key', [
      'general_public_site_enabled',
      'general_public_site_html',
      'general_public_site_custom_css'
    ])
    .del();
};
