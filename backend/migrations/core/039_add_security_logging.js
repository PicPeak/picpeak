// Add security logging and monitoring tables

exports.up = async function(knex) {
  console.log('Adding security logging and monitoring tables...');
  
  // Create security logs table for general security events
  const hasSecurityLogs = await knex.schema.hasTable('security_logs');
  if (!hasSecurityLogs) {
    await knex.schema.createTable('security_logs', (table) => {
      table.increments('id').primary();
      table.string('event_type', 50).notNullable(); // rate_limit_exceeded, suspicious_activity, etc.
      table.string('client_ip', 45).notNullable();
      table.string('client_fingerprint', 32);
      table.text('user_agent');
      table.string('request_path');
      table.string('request_method', 10);
      table.json('details'); // Additional event details
      table.timestamp('timestamp').defaultTo(knex.fn.now());
      
      // Indexes for performance
      table.index(['event_type', 'timestamp']);
      table.index(['client_ip', 'timestamp']);
      table.index(['client_fingerprint', 'timestamp']);
    });
  }
  
  // Add security monitoring settings to app_settings
  const securitySettings = [
    {
      setting_key: 'security_monitoring_enabled',
      setting_value: JSON.stringify(true),
      setting_type: 'security'
    },
    {
      setting_key: 'max_image_requests_per_5_minutes',
      setting_value: JSON.stringify(100),
      setting_type: 'security'
    },
    {
      setting_key: 'max_image_requests_per_hour',
      setting_value: JSON.stringify(500),
      setting_type: 'security'
    },
    {
      setting_key: 'block_suspicious_ips',
      setting_value: JSON.stringify(true),
      setting_type: 'security'
    },
    {
      setting_key: 'log_security_events_to_db',
      setting_value: JSON.stringify(true),
      setting_type: 'security'
    },
    {
      setting_key: 'auto_block_threshold',
      setting_value: JSON.stringify(5),
      setting_type: 'security'
    }
  ];

  for (const setting of securitySettings) {
    const exists = await knex('app_settings')
      .where('setting_key', setting.setting_key)
      .first();
      
    if (!exists) {
      await knex('app_settings').insert(setting);
    }
  }
  
  // Add mime_type column to photos table if it doesn't exist
  const hasMimeType = await knex.schema.hasColumn('photos', 'mime_type');
  if (!hasMimeType) {
    await knex.schema.table('photos', (table) => {
      table.string('mime_type', 100);
    });
    
    // Update existing photos with default mime type
    await knex('photos')
      .whereNull('mime_type')
      .update({ mime_type: 'image/jpeg' });
  }
  
  console.log('Security logging and monitoring tables added successfully');
};

exports.down = async function(knex) {
  console.log('Removing security logging and monitoring tables...');
  
  // Remove security settings
  await knex('app_settings')
    .whereIn('setting_key', [
      'security_monitoring_enabled',
      'max_image_requests_per_5_minutes', 
      'max_image_requests_per_hour',
      'block_suspicious_ips',
      'log_security_events_to_db',
      'auto_block_threshold'
    ])
    .delete();
  
  // Drop security logs table
  const hasSecurityLogs = await knex.schema.hasTable('security_logs');
  if (hasSecurityLogs) {
    await knex.schema.dropTable('security_logs');
  }
  
  // Remove mime_type column from photos table
  const hasMimeType = await knex.schema.hasColumn('photos', 'mime_type');
  if (hasMimeType) {
    await knex.schema.table('photos', (table) => {
      table.dropColumn('mime_type');
    });
  }
  
  console.log('Security logging and monitoring tables removed');
};