exports.up = async function(knex) {
  // Add thumbnail settings to app_settings table
  const thumbnailSettings = [
    { setting_key: 'thumbnail_width', setting_value: 300, setting_type: 'number' },
    { setting_key: 'thumbnail_height', setting_value: 300, setting_type: 'number' },
    { setting_key: 'thumbnail_fit', setting_value: JSON.stringify('cover'), setting_type: 'string' },
    { setting_key: 'thumbnail_quality', setting_value: 85, setting_type: 'number' },
    { setting_key: 'thumbnail_format', setting_value: JSON.stringify('jpeg'), setting_type: 'string' }
  ];

  for (const setting of thumbnailSettings) {
    const exists = await knex('app_settings').where('setting_key', setting.setting_key).first();
    if (!exists) {
      await knex('app_settings').insert({
        ...setting,
        updated_at: knex.fn.now()
      });
    }
  }
};

exports.down = async function(knex) {
  // Remove thumbnail settings
  await knex('app_settings')
    .whereIn('setting_key', [
      'thumbnail_width',
      'thumbnail_height', 
      'thumbnail_fit',
      'thumbnail_quality',
      'thumbnail_format'
    ])
    .del();
};