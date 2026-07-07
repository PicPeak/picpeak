// Fix missing columns identified in GitHub issues

exports.up = async function(knex) {
  console.log('Adding missing columns to database tables...');
  
  // Add must_change_password column to admin_users table
  const hasMustChangePassword = await knex.schema.hasColumn('admin_users', 'must_change_password');
  if (!hasMustChangePassword) {
    console.log('Adding must_change_password column to admin_users table...');
    await knex.schema.table('admin_users', (table) => {
      table.boolean('must_change_password').defaultTo(false);
    });
  }
  
  // Add password_changed_at column to admin_users table
  const hasPasswordChangedAt = await knex.schema.hasColumn('admin_users', 'password_changed_at');
  if (!hasPasswordChangedAt) {
    console.log('Adding password_changed_at column to admin_users table...');
    await knex.schema.table('admin_users', (table) => {
      table.datetime('password_changed_at');
    });
  }
  
  // Add require_moderation column to event_feedback_settings table
  const hasEventFeedbackSettings = await knex.schema.hasTable('event_feedback_settings');
  if (hasEventFeedbackSettings) {
    const hasRequireModeration = await knex.schema.hasColumn('event_feedback_settings', 'require_moderation');
    if (!hasRequireModeration) {
      console.log('Adding require_moderation column to event_feedback_settings table...');
      await knex.schema.table('event_feedback_settings', (table) => {
        table.boolean('require_moderation').defaultTo(true);
      });
    }
  }
  
  // Add host_name column to events table if missing
  const hasHostName = await knex.schema.hasColumn('events', 'host_name');
  if (!hasHostName) {
    console.log('Adding host_name column to events table...');
    await knex.schema.table('events', (table) => {
      table.string('host_name');
    });
  }
  
  console.log('Missing columns have been added successfully');
};

exports.down = async function(knex) {
  console.log('Removing added columns...');
  
  // Remove must_change_password column from admin_users table
  const hasMustChangePassword = await knex.schema.hasColumn('admin_users', 'must_change_password');
  if (hasMustChangePassword) {
    await knex.schema.table('admin_users', (table) => {
      table.dropColumn('must_change_password');
    });
  }
  
  // Remove password_changed_at column from admin_users table
  const hasPasswordChangedAt = await knex.schema.hasColumn('admin_users', 'password_changed_at');
  if (hasPasswordChangedAt) {
    await knex.schema.table('admin_users', (table) => {
      table.dropColumn('password_changed_at');
    });
  }
  
  // Remove require_moderation column from event_feedback_settings table
  const hasEventFeedbackSettings = await knex.schema.hasTable('event_feedback_settings');
  if (hasEventFeedbackSettings) {
    const hasRequireModeration = await knex.schema.hasColumn('event_feedback_settings', 'require_moderation');
    if (hasRequireModeration) {
      await knex.schema.table('event_feedback_settings', (table) => {
        table.dropColumn('require_moderation');
      });
    }
  }
  
  // Remove host_name column from events table
  const hasHostName = await knex.schema.hasColumn('events', 'host_name');
  if (hasHostName) {
    await knex.schema.table('events', (table) => {
      table.dropColumn('host_name');
    });
  }
  
  console.log('Columns removed');
};