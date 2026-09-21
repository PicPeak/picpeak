'use strict';

/**
 * Migration 230: a name on a photo (issue 1561).
 *
 * One mechanism for every source of a credit, so the guest-uploader name and
 * the photographer credit share one column, one filter and one export path:
 *
 *   photos.credit_name        Display string. Sanitised and capped at 100
 *                             characters when it is written, never at render.
 *   photos.credit_source      'guest' | 'exif' | 'manual' | null. 'manual' is
 *                             the admin's correction and nothing overwrites it.
 *   photos.uploader_guest_id  The gallery_guests row that uploaded the photo.
 *                             ON DELETE SET NULL; credit_name is kept apart
 *                             from it so the name renders without a join.
 *   events.guest_name_mode    'off' (default) | 'optional' | 'required' — the
 *                             upload dialog's name step.
 *   events.show_credits_to_guests
 *                             Default off: names are recorded for the admin,
 *                             and guests see them only when this is on.
 *
 * Existing photos stay without a credit: no backfill here. The EXIF backfill
 * is an admin endpoint, because the originals may sit on a mount that is not
 * available at upgrade time. Its maintenance_jobs row is seeded here, for the
 * reason 190 gives: the claim is a conditional UPDATE and must find a row.
 *
 * Additive, hasColumn-guarded and safe to re-run.
 */

const { addColumnIfNotExists, createIndexIfNotExists } = require('../helpers');

const CREDIT_JOB = 'photo_credit_backfill';

exports.up = async function up(knex) {
  await addColumnIfNotExists(knex, 'photos', 'credit_name', (table) => {
    table.string('credit_name', 100).nullable();
  });
  await addColumnIfNotExists(knex, 'photos', 'credit_source', (table) => {
    table.string('credit_source', 16).nullable();
  });
  await addColumnIfNotExists(knex, 'photos', 'uploader_guest_id', (table) => {
    table.integer('uploader_guest_id').nullable()
      .references('id').inTable('gallery_guests').onDelete('SET NULL');
  });
  // The "By" filter and the per-name counts group on this within one event.
  await createIndexIfNotExists(knex, 'photos', ['event_id', 'credit_name'], 'idx_photos_event_credit_name');

  await addColumnIfNotExists(knex, 'events', 'guest_name_mode', (table) => {
    table.string('guest_name_mode', 16).notNullable().defaultTo('off');
  });
  await addColumnIfNotExists(knex, 'events', 'show_credits_to_guests', (table) => {
    table.boolean('show_credits_to_guests').notNullable().defaultTo(false);
  });

  if (await knex.schema.hasTable('maintenance_jobs')) {
    const existing = await knex('maintenance_jobs').where({ job_name: CREDIT_JOB }).first();
    if (!existing) {
      await knex('maintenance_jobs').insert({ job_name: CREDIT_JOB, is_running: false });
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('maintenance_jobs')) {
    await knex('maintenance_jobs').where({ job_name: CREDIT_JOB }).del();
  }
  if (await knex.schema.hasTable('photos')) {
    try {
      await knex.schema.alterTable('photos', (t) => t.dropIndex(['event_id', 'credit_name'], 'idx_photos_event_credit_name'));
    } catch (e) {
      // Index never created (older SQLite path) — nothing to drop.
    }
    for (const column of ['uploader_guest_id', 'credit_source', 'credit_name']) {
      if (await knex.schema.hasColumn('photos', column)) {
        await knex.schema.alterTable('photos', (t) => t.dropColumn(column));
      }
    }
  }
  for (const column of ['show_credits_to_guests', 'guest_name_mode']) {
    if (await knex.schema.hasColumn('events', column)) {
      await knex.schema.alterTable('events', (t) => t.dropColumn(column));
    }
  }
};
