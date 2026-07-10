/**
 * Migration: Add indexes for photo filtering performance
 * These indexes optimize queries that filter by feedback metrics
 */

exports.up = async function(knex) {
  // Add comment_count column if it doesn't exist
  const hasCommentCount = await knex.schema.hasColumn('photos', 'comment_count');
  if (!hasCommentCount) {
    await knex.schema.alterTable('photos', (table) => {
      table.integer('comment_count').defaultTo(0);
    });
  }

  // Add indexes for common filter queries
  // Note: PostgreSQL supports partial indexes, SQLite does not
  const client = knex.client.config.client;

  if (client === 'pg' || client === 'postgresql') {
    // Partial indexes for PostgreSQL
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_photos_rating_filter
      ON photos(event_id, average_rating)
      WHERE average_rating > 0
    `);

    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_photos_likes_filter
      ON photos(event_id, like_count)
      WHERE like_count > 0
    `);

    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_photos_favorites_filter
      ON photos(event_id, favorite_count)
      WHERE favorite_count > 0
    `);

    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_photos_comments_filter
      ON photos(event_id, comment_count)
      WHERE comment_count > 0
    `);
  } else {
    // Regular indexes for SQLite
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_photos_rating_filter
      ON photos(event_id, average_rating)
    `);

    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_photos_likes_filter
      ON photos(event_id, like_count)
    `);

    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_photos_favorites_filter
      ON photos(event_id, favorite_count)
    `);

    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_photos_comments_filter
      ON photos(event_id, comment_count)
    `);
  }

  // Create export_jobs table for tracking large exports
  const hasExportJobs = await knex.schema.hasTable('export_jobs');
  if (!hasExportJobs) {
    await knex.schema.createTable('export_jobs', (table) => {
      table.increments('id').primary();
      table.string('job_id', 50).unique().notNullable();
      table.integer('event_id').references('id').inTable('events').onDelete('CASCADE');
      table.integer('admin_user_id').references('id').inTable('admin_users').onDelete('SET NULL');
      table.string('format', 20).notNullable();
      table.string('status', 20).defaultTo('pending');
      table.integer('progress').defaultTo(0);
      table.integer('total_photos');
      table.json('options');
      table.string('file_path', 500);
      table.bigInteger('file_size');
      table.text('error_message');
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('completed_at');
    });
  }
};

exports.down = async function(knex) {
  // Drop indexes
  await knex.raw('DROP INDEX IF EXISTS idx_photos_rating_filter');
  await knex.raw('DROP INDEX IF EXISTS idx_photos_likes_filter');
  await knex.raw('DROP INDEX IF EXISTS idx_photos_favorites_filter');
  await knex.raw('DROP INDEX IF EXISTS idx_photos_comments_filter');

  // Drop export_jobs table
  await knex.schema.dropTableIfExists('export_jobs');

  // Note: We don't remove comment_count column as it might have data
};
