'use strict';

/**
 * Migration 296: adaptive video streaming (issue 1733, D4).
 *
 * With `general_video_adaptive_streaming` on, a queue transcodes each video
 * into an HLS ladder under hls/<photoId>/<attemptId>/ and the gallery player
 * streams that instead of range-requesting one file. The same claim, attempt
 * and janitor shape as the web copy (migrations 260 and 279), so the columns
 * mirror web_*:
 *
 *   hls_path        storage prefix of the published ladder, NULL when none
 *   hls_status      NULL (never looked at) | pending | processing | complete
 *                   | skipped (too long or too large) | failed
 *   hls_started_at  claim time, for the stuck-row janitor
 *   hls_error       why the last attempt failed, or why it was skipped
 *   hls_attempt_id  the attempt that owns the row (execution fencing)
 *   hls_attempts    claims so far
 *   hls_retry_at    not due before this time after a "not now"
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('photos'))) return;
  if (await knex.schema.hasColumn('photos', 'hls_status')) return;
  await knex.schema.alterTable('photos', (t) => {
    t.string('hls_path', 512);
    t.string('hls_status', 16);
    t.string('hls_started_at', 32);
    t.text('hls_error');
    t.string('hls_attempt_id', 36);
    t.integer('hls_attempts').notNullable().defaultTo(0);
    t.timestamp('hls_retry_at').nullable();
    t.index(['hls_status'], 'photos_hls_status_idx');
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('photos'))) return;
  if (!(await knex.schema.hasColumn('photos', 'hls_status'))) return;
  await knex.schema.alterTable('photos', (t) => {
    t.dropIndex(['hls_status'], 'photos_hls_status_idx');
  });
  for (const column of ['hls_path', 'hls_status', 'hls_started_at', 'hls_error', 'hls_attempt_id', 'hls_attempts', 'hls_retry_at']) {
    await knex.schema.alterTable('photos', (t) => t.dropColumn(column));
  }
};
