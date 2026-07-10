// Add download control features to events table

exports.up = async function(knex) {
  console.log('Adding download control columns to events table...');
  
  // Add download control columns to events table
  const hasAllowDownloads = await knex.schema.hasColumn('events', 'allow_downloads');
  if (!hasAllowDownloads) {
    await knex.schema.table('events', (table) => {
      table.boolean('allow_downloads').defaultTo(true);
      table.boolean('disable_right_click').defaultTo(false);
      table.boolean('watermark_downloads').defaultTo(false);
      table.text('watermark_text');
    });
  }
  
  // Add download control settings to app_settings
  const downloadSettingExists = await knex('app_settings')
    .where('setting_key', 'default_allow_downloads')
    .first();
    
  if (!downloadSettingExists) {
    await knex('app_settings').insert([
      {
        setting_key: 'default_allow_downloads',
        setting_value: JSON.stringify(true),
        setting_type: 'gallery'
      },
      {
        setting_key: 'default_disable_right_click',
        setting_value: JSON.stringify(false),
        setting_type: 'gallery'
      },
      {
        setting_key: 'default_watermark_downloads',
        setting_value: JSON.stringify(false),
        setting_type: 'gallery'
      }
    ]);
  }
  
  console.log('Download control features added successfully');
};

exports.down = async function(knex) {
  console.log('Removing download control columns...');
  
  // Remove app settings
  await knex('app_settings')
    .whereIn('setting_key', [
      'default_allow_downloads',
      'default_disable_right_click', 
      'default_watermark_downloads'
    ])
    .delete();
  
  // Remove columns from events table
  const hasAllowDownloads = await knex.schema.hasColumn('events', 'allow_downloads');
  if (hasAllowDownloads) {
    await knex.schema.table('events', (table) => {
      table.dropColumn('allow_downloads');
      table.dropColumn('disable_right_click');
      table.dropColumn('watermark_downloads');
      table.dropColumn('watermark_text');
    });
  }
  
  console.log('Download control columns removed');
};