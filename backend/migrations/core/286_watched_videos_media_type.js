'use strict';

/**
 * Migration 286: videos imported by the watch folder before the fix were
 * stored with media_type 'image', because that insert never set the column
 * and it defaults to 'image'. The gallery then treated them as photos.
 *
 * Only the watcher writes type 'video' (other paths set media_type and keep
 * type for individual/collage), so type identifies these rows. Safe to re-run.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('photos'))) return;
  if (!(await knex.schema.hasColumn('photos', 'media_type'))) return;
  await knex('photos')
    .where({ type: 'video' })
    .andWhere(q => q.where({ media_type: 'image' }).orWhereNull('media_type'))
    .update({ media_type: 'video' });
};

// A data correction: putting 'image' back would only bring the bug back.
exports.down = async function down() {};
