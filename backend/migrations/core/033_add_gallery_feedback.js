// No helpers needed for boolean values

exports.up = async function(knex) {
  console.log('Adding gallery feedback tables...');
  
  // Check if tables and columns already exist
  const hasEventFeedbackSettingsTable = await knex.schema.hasTable('event_feedback_settings');
  const hasPhotoFeedbackTable = await knex.schema.hasTable('photo_feedback');
  const hasFeedbackRateLimitsTable = await knex.schema.hasTable('feedback_rate_limits');
  const hasFeedbackWordFiltersTable = await knex.schema.hasTable('feedback_word_filters');
  const hasFeedbackCountColumn = await knex.schema.hasColumn('photos', 'feedback_count');
  
  // Create event_feedback_settings table
  if (!hasEventFeedbackSettingsTable) {
    await knex.schema.createTable('event_feedback_settings', (table) => {
      table.increments('id').primary();
      table.integer('event_id').references('id').inTable('events').onDelete('CASCADE');
      table.boolean('feedback_enabled').defaultTo(false);
      table.boolean('allow_ratings').defaultTo(true);
      table.boolean('allow_likes').defaultTo(true);
      table.boolean('allow_comments').defaultTo(false);
      table.boolean('allow_favorites').defaultTo(true);
      table.boolean('require_name_email').defaultTo(false);
      table.boolean('moderate_comments').defaultTo(true);
      table.boolean('show_feedback_to_guests').defaultTo(true);
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());
      table.unique(['event_id']);
    });
  }

  // Create photo_feedback table
  if (!hasPhotoFeedbackTable) {
    await knex.schema.createTable('photo_feedback', (table) => {
      table.increments('id').primary();
      table.integer('photo_id').references('id').inTable('photos').onDelete('CASCADE');
      table.integer('event_id').references('id').inTable('events').onDelete('CASCADE');
      table.string('feedback_type', 20).notNullable();
      table.integer('rating');
      table.text('comment_text');
      table.string('guest_name', 100);
      table.string('guest_email', 255);
      table.string('guest_identifier', 64);
      table.string('ip_address', 45);
      table.text('user_agent');
      table.boolean('is_approved').defaultTo(true);
      table.boolean('is_hidden').defaultTo(false);
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());
      
      // Add indexes
      table.index(['photo_id']);
      table.index(['event_id']);
      table.index(['feedback_type']);
      table.index(['guest_identifier']);
      
      // Add check constraint for rating (PostgreSQL)
      if (knex.client.config.client === 'pg') {
        table.check('?? >= 1 AND ?? <= 5', ['rating', 'rating']);
      }
    });
  }

  // Create feedback_rate_limits table
  if (!hasFeedbackRateLimitsTable) {
    await knex.schema.createTable('feedback_rate_limits', (table) => {
      table.increments('id').primary();
      table.string('identifier', 64).notNullable();
      table.integer('event_id').references('id').inTable('events').onDelete('CASCADE');
      table.string('action_type', 20).notNullable();
      table.integer('action_count').defaultTo(1);
      table.timestamp('window_start').defaultTo(knex.fn.now());
      
      // Add indexes
      table.index(['identifier', 'event_id', 'action_type']);
      table.index(['window_start']);
    });
  }

  // Create feedback_word_filters table
  if (!hasFeedbackWordFiltersTable) {
    await knex.schema.createTable('feedback_word_filters', (table) => {
      table.increments('id').primary();
      table.string('word', 100).notNullable();
      table.string('severity', 20).defaultTo('moderate');
      table.boolean('is_active').defaultTo(true);
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.unique(['word']);
    });
  }

  // Add feedback summary columns to photos table
  if (!hasFeedbackCountColumn) {
    await knex.schema.alterTable('photos', (table) => {
      table.integer('feedback_count').defaultTo(0);
      table.integer('like_count').defaultTo(0);
      table.decimal('average_rating', 3, 2).defaultTo(0);
      table.integer('favorite_count').defaultTo(0);
    });
  }

  // Add feedback notification settings to app_settings
  const hasFeedbackNotificationEmail = await knex('app_settings')
    .where('setting_key', 'feedback_notification_email')
    .first();
    
  if (!hasFeedbackNotificationEmail) {
    await knex('app_settings').insert([
      {
        setting_key: 'feedback_notification_email',
        setting_value: JSON.stringify(''),
        setting_type: 'feedback'
      },
      {
        setting_key: 'feedback_rate_limits',
        setting_value: JSON.stringify({
          rating: { max: 100, window: 3600 }, // 100 ratings per hour
          comment: { max: 20, window: 3600 }, // 20 comments per hour
          like: { max: 200, window: 3600 } // 200 likes per hour
        }),
        setting_type: 'feedback'
      }
    ]);
  }
  
  console.log('Gallery feedback tables created successfully');
};

exports.down = async function(knex) {
  console.log('Removing gallery feedback tables...');
  
  // Remove feedback settings from app_settings
  await knex('app_settings')
    .whereIn('setting_key', ['feedback_notification_email', 'feedback_rate_limits'])
    .delete();

  // Remove feedback columns from photos table
  await knex.schema.alterTable('photos', (table) => {
    table.dropColumn('feedback_count');
    table.dropColumn('like_count');
    table.dropColumn('average_rating');
    table.dropColumn('favorite_count');
  });

  // Drop tables in reverse order
  await knex.schema.dropTableIfExists('feedback_word_filters');
  await knex.schema.dropTableIfExists('feedback_rate_limits');
  await knex.schema.dropTableIfExists('photo_feedback');
  await knex.schema.dropTableIfExists('event_feedback_settings');
  
  console.log('Gallery feedback tables removed');
};