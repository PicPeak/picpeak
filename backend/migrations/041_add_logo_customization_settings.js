exports.up = async function(knex) {
  console.log('Running migration: 041_add_logo_customization_settings');
  
  // Add default logo customization settings
  const logoSettings = [
    {
      setting_key: 'branding_logo_size',
      setting_value: JSON.stringify('medium'),
      setting_type: 'branding',
      description: 'Logo size: small, medium, large, xlarge, or custom',
      created_at: new Date(),
      updated_at: new Date()
    },
    {
      setting_key: 'branding_logo_max_height',
      setting_value: JSON.stringify(48),
      setting_type: 'branding', 
      description: 'Maximum logo height in pixels (used when size is custom)',
      created_at: new Date(),
      updated_at: new Date()
    },
    {
      setting_key: 'branding_logo_position',
      setting_value: JSON.stringify('left'),
      setting_type: 'branding',
      description: 'Logo position in header: left, center, right',
      created_at: new Date(),
      updated_at: new Date()
    },
    {
      setting_key: 'branding_logo_display_header',
      setting_value: JSON.stringify(true),
      setting_type: 'branding',
      description: 'Show logo in gallery header',
      created_at: new Date(),
      updated_at: new Date()
    },
    {
      setting_key: 'branding_logo_display_hero',
      setting_value: JSON.stringify(true),
      setting_type: 'branding',
      description: 'Show logo in hero section (for non-grid layouts)',
      created_at: new Date(),
      updated_at: new Date()
    },
    {
      setting_key: 'branding_logo_display_mode',
      setting_value: JSON.stringify('logo_and_text'),
      setting_type: 'branding',
      description: 'Display mode: logo_only, text_only, logo_and_text',
      created_at: new Date(),
      updated_at: new Date()
    }
  ];

  // Insert settings that don't already exist
  for (const setting of logoSettings) {
    const exists = await knex('app_settings')
      .where('setting_key', setting.setting_key)
      .first();
    
    if (!exists) {
      await knex('app_settings').insert(setting);
      console.log(`Added setting: ${setting.setting_key}`);
    } else {
      console.log(`Setting already exists: ${setting.setting_key}`);
    }
  }

  console.log('Migration 041_add_logo_customization_settings completed');
};

exports.down = async function(knex) {
  console.log('Rolling back migration: 041_add_logo_customization_settings');
  
  // Remove the logo customization settings
  await knex('app_settings')
    .whereIn('setting_key', [
      'branding_logo_size',
      'branding_logo_max_height',
      'branding_logo_position',
      'branding_logo_display_header',
      'branding_logo_display_hero',
      'branding_logo_display_mode'
    ])
    .del();
  
  console.log('Rollback of 041_add_logo_customization_settings completed');
};