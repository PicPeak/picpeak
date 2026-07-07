// Add enhanced image protection features

exports.up = async function(knex) {
  console.log('Adding enhanced image protection features...');
  
  // Add protection columns to events table
  const hasProtectionLevel = await knex.schema.hasColumn('events', 'protection_level');
  if (!hasProtectionLevel) {
    await knex.schema.table('events', (table) => {
      table.enum('protection_level', ['basic', 'standard', 'enhanced', 'maximum']).defaultTo('standard');
      table.integer('image_quality').defaultTo(85);
      table.boolean('add_fingerprint').defaultTo(true);
      table.boolean('enable_devtools_protection').defaultTo(true);
      table.boolean('use_canvas_rendering').defaultTo(false);
      table.integer('fragmentation_level').defaultTo(3);
      table.boolean('overlay_protection').defaultTo(true);
    });
  }
  
  // Create image access logs table
  const hasImageAccessLogs = await knex.schema.hasTable('image_access_logs');
  if (!hasImageAccessLogs) {
    await knex.schema.createTable('image_access_logs', (table) => {
      table.increments('id').primary();
      table.integer('photo_id').unsigned().notNullable();
      table.integer('event_id').unsigned().notNullable();
      table.string('client_ip', 45).notNullable();
      table.text('user_agent');
      table.string('access_type', 20).defaultTo('view'); // view, download, suspicious
      table.string('client_fingerprint', 32).notNullable();
      table.timestamp('accessed_at').defaultTo(knex.fn.now());
      table.json('metadata'); // Additional security metadata
      
      table.foreign('photo_id').references('id').inTable('photos').onDelete('CASCADE');
      table.foreign('event_id').references('id').inTable('events').onDelete('CASCADE');
      
      table.index(['photo_id', 'accessed_at']);
      table.index(['client_fingerprint', 'accessed_at']);
      table.index(['client_ip', 'accessed_at']);
    });
  }
  
  // Add protection settings to app_settings
  const protectionSettingExists = await knex('app_settings')
    .where('setting_key', 'default_protection_level')
    .first();
    
  if (!protectionSettingExists) {
    await knex('app_settings').insert([
      {
        setting_key: 'default_protection_level',
        setting_value: JSON.stringify('standard'),
        setting_type: 'security'
      },
      {
        setting_key: 'default_image_quality',
        setting_value: JSON.stringify(85),
        setting_type: 'security'
      },
      {
        setting_key: 'enable_devtools_protection',
        setting_value: JSON.stringify(true),
        setting_type: 'security'
      },
      {
        setting_key: 'max_image_requests_per_minute',
        setting_value: JSON.stringify(30),
        setting_type: 'security'
      },
      {
        setting_key: 'suspicious_activity_threshold',
        setting_value: JSON.stringify(10),
        setting_type: 'security'
      },
      {
        setting_key: 'enable_canvas_rendering',
        setting_value: JSON.stringify(false),
        setting_type: 'security'
      },
      {
        setting_key: 'default_fragmentation_level',
        setting_value: JSON.stringify(3),
        setting_type: 'security'
      }
    ]);
  }
  
  console.log('Enhanced image protection features added successfully');
};

exports.down = async function(knex) {
  console.log('Removing enhanced image protection features...');
  
  // Remove app settings
  await knex('app_settings')
    .whereIn('setting_key', [
      'default_protection_level',
      'default_image_quality',
      'enable_devtools_protection',
      'max_image_requests_per_minute',
      'suspicious_activity_threshold',
      'enable_canvas_rendering',
      'default_fragmentation_level'
    ])
    .delete();
  
  // Drop image access logs table
  const hasImageAccessLogs = await knex.schema.hasTable('image_access_logs');
  if (hasImageAccessLogs) {
    await knex.schema.dropTable('image_access_logs');
  }
  
  // Remove protection columns from events table
  const hasProtectionLevel = await knex.schema.hasColumn('events', 'protection_level');
  if (hasProtectionLevel) {
    await knex.schema.table('events', (table) => {
      table.dropColumn('protection_level');
      table.dropColumn('image_quality');
      table.dropColumn('add_fingerprint');
      table.dropColumn('enable_devtools_protection');
      table.dropColumn('use_canvas_rendering');
      table.dropColumn('fragmentation_level');
      table.dropColumn('overlay_protection');
    });
  }
  
  console.log('Enhanced image protection features removed');
};