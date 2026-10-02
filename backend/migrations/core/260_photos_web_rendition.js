'use strict';

/**
 * Migration 260: a browser-playable copy of a video (issue 1430, item 8).
 *
 * The guest player is a bare <video src> of the original, and an HEVC phone
 * recording plays nowhere but Safari. With the setting on, a queue probes
 * each video and, for anything a browser will not decode (HEVC, a QuickTime
 * container, an MP4 whose moov atom sits at the end), writes an H.264/AAC
 * faststart MP4 next to it. The gallery streams that copy; the download
 * stays the original.
 *
 *   web_path        storage key of the copy, NULL when none exists
 *   web_status      NULL (never looked at) | pending | processing | complete
 *                   | skipped (the original already plays) | failed
 *   web_started_at  claim time, for the queue's stuck-row janitor
 *   web_error       why the last attempt failed
 *
 * Same claim/janitor shape as face_status (migration 177), so the index on
 * the status column is the one the worker polls on.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('photos'))) return;
  if (await knex.schema.hasColumn('photos', 'web_path')) return;
  await knex.schema.alterTable('photos', (t) => {
    t.string('web_path', 512);
    t.string('web_status', 16);
    t.string('web_started_at', 32);
    t.text('web_error');
    t.index(['web_status'], 'photos_web_status_idx');
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('photos'))) return;
  if (!(await knex.schema.hasColumn('photos', 'web_path'))) return;
  await knex.schema.alterTable('photos', (t) => {
    t.dropIndex(['web_status'], 'photos_web_status_idx');
    t.dropColumn('web_path');
    t.dropColumn('web_status');
    t.dropColumn('web_started_at');
    t.dropColumn('web_error');
  });
};
