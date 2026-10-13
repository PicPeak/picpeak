'use strict';

/**
 * Migration 292: blurred tile placeholders (issue 1733, B1).
 *
 *   photos.thumb_hash   A base64 ThumbHash of the photo's thumbnail: 28 to 36
 *                       characters holding its average colour, rough shape
 *                       and aspect ratio. Written when the thumbnail is
 *                       generated, shipped in the photo list and painted
 *                       behind the tile while the thumbnail loads. NULL means
 *                       "no placeholder", which is today's plain loading tile.
 *
 * Existing photos stay NULL: no backfill here. Filling them reads every
 * thumbnail through the storage backend, which may be unreachable at upgrade
 * time, so it is an admin-started maintenance job. Its maintenance_jobs row
 * is seeded here, for the reason 190 gives: the claim is a conditional UPDATE
 * and must find a row.
 *
 * Additive, nullable, hasColumn-guarded and safe to re-run.
 */

const THUMB_HASH_JOB = 'photo_thumb_hash_backfill';

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('photos') && !(await knex.schema.hasColumn('photos', 'thumb_hash'))) {
    await knex.schema.alterTable('photos', (table) => {
      table.string('thumb_hash', 64).nullable();
    });
  }

  if (await knex.schema.hasTable('maintenance_jobs')) {
    const existing = await knex('maintenance_jobs').where({ job_name: THUMB_HASH_JOB }).first();
    if (!existing) {
      await knex('maintenance_jobs').insert({ job_name: THUMB_HASH_JOB, is_running: false });
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('maintenance_jobs')) {
    await knex('maintenance_jobs').where({ job_name: THUMB_HASH_JOB }).del();
  }
  if (await knex.schema.hasTable('photos') && await knex.schema.hasColumn('photos', 'thumb_hash')) {
    await knex.schema.alterTable('photos', (table) => {
      table.dropColumn('thumb_hash');
    });
  }
};
