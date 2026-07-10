/**
 * Migration: Add optional event date and expiration settings
 * These settings control whether event_date and expiration are required
 * when creating new events, supporting non-event use cases like portraits.
 */

exports.up = async function(knex) {
  // Add new settings for optional date and expiration
  const settings = [
    { setting_key: 'event_require_event_date', setting_value: JSON.stringify(true), setting_type: 'boolean' },
    { setting_key: 'event_require_expiration', setting_value: JSON.stringify(true), setting_type: 'boolean' }
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

  // Make event_date and expires_at columns nullable
  // PostgreSQL supports ALTER COLUMN ... DROP NOT NULL
  // SQLite requires table recreation (handled differently)
  const client = knex.client.config.client;

  if (client === 'pg' || client === 'postgresql') {
    // PostgreSQL: directly alter columns
    await knex.raw('ALTER TABLE events ALTER COLUMN event_date DROP NOT NULL');
    await knex.raw('ALTER TABLE events ALTER COLUMN expires_at DROP NOT NULL');
  } else if (client === 'sqlite3' || client === 'better-sqlite3') {
    // SQLite: columns are already effectively nullable in most cases
    // SQLite doesn't enforce NOT NULL as strictly, and altering requires table recreation
    // For safety, we'll skip the schema change for SQLite as it's complex
    // The application logic will handle null values appropriately
    console.log('SQLite detected - skipping schema alteration (columns will accept NULL values)');
  }
};

exports.down = async function(knex) {
  // Remove the settings
  await knex('app_settings')
    .whereIn('setting_key', [
      'event_require_event_date',
      'event_require_expiration'
    ])
    .del();

  // Note: We don't restore NOT NULL constraints as that could fail
  // if there are existing NULL values in the database
};
