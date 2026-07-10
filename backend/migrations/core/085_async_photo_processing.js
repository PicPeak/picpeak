/**
 * Async photo-processing infrastructure.
 *
 * Adds:
 *   - photos.processing_status     — enum: pending | processing | complete | failed
 *   - photos.processing_error      — text, populated on 'failed'
 *   - photos.processing_started_at — claim timestamp for janitor recovery
 *   - photos.upload_id             — groups all photos from one upload request
 *                                    so the frontend can poll/stream by group
 *
 * All existing rows default to 'complete' (they were processed synchronously
 * before this migration and there's nothing pending). New uploads insert
 * with 'pending' and a background worker (services/backgroundProcessor.js)
 * picks them up.
 *
 * Partial-style indexes keep lookups fast as the queue drains. We use plain
 * indexes here instead of postgres-specific WHERE clauses so the migration
 * works on SQLite too; the workload (only-pending rows) keeps the index small.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('photos'))) return;

  const hasStatus = await knex.schema.hasColumn('photos', 'processing_status');
  if (!hasStatus) {
    await knex.schema.alterTable('photos', (table) => {
      table.string('processing_status', 16).notNullable().defaultTo('complete');
      table.text('processing_error').nullable();
      table.timestamp('processing_started_at').nullable();
      table.string('upload_id', 64).nullable();
    });
  }

  // Indexes — wrap in try/catch so re-running the migration on a partially
  // applied schema is a no-op rather than an error.
  try {
    await knex.schema.alterTable('photos', (table) => {
      table.index(['processing_status'], 'idx_photos_processing_status');
    });
  } catch (_) { /* already exists */ }

  try {
    await knex.schema.alterTable('photos', (table) => {
      table.index(['upload_id'], 'idx_photos_upload_id');
    });
  } catch (_) { /* already exists */ }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('photos'))) return;

  // Drop indexes first (best-effort)
  try {
    await knex.schema.alterTable('photos', (t) => t.dropIndex([], 'idx_photos_upload_id'));
  } catch (_) { /* not present */ }
  try {
    await knex.schema.alterTable('photos', (t) => t.dropIndex([], 'idx_photos_processing_status'));
  } catch (_) { /* not present */ }

  if (await knex.schema.hasColumn('photos', 'upload_id')) {
    await knex.schema.alterTable('photos', (t) => t.dropColumn('upload_id'));
  }
  if (await knex.schema.hasColumn('photos', 'processing_started_at')) {
    await knex.schema.alterTable('photos', (t) => t.dropColumn('processing_started_at'));
  }
  if (await knex.schema.hasColumn('photos', 'processing_error')) {
    await knex.schema.alterTable('photos', (t) => t.dropColumn('processing_error'));
  }
  if (await knex.schema.hasColumn('photos', 'processing_status')) {
    await knex.schema.alterTable('photos', (t) => t.dropColumn('processing_status'));
  }
};
