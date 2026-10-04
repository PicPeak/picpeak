'use strict';

/**
 * Migration 261: per-admin dismissal state for the notification bell.
 *
 * The bell reads activity_logs, which is also the audit trail (contract
 * history, customer timelines, every admin's actions). "Clear all" used to
 * delete those rows for everyone; since the security PR it marks the
 * caller's visible rows read, which left it overlapping with "Mark all
 * read". This table gives the bell state of its own: a row here hides one
 * activity_logs entry from one admin's bell without touching the entry, its
 * read_at, or what any other admin sees.
 *
 * The FKs cascade on PostgreSQL; SQLite runs without PRAGMA foreign_keys, so
 * the event cascade (adminEvents/helpers.js) and the admin hard delete
 * (userManagementService.js) remove the rows explicitly.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('notification_dismissals')) return;
  if (!(await knex.schema.hasTable('activity_logs')) || !(await knex.schema.hasTable('admin_users'))) return;
  await knex.schema.createTable('notification_dismissals', (t) => {
    t.increments('id').primary();
    t.integer('admin_id').notNullable()
      .references('id').inTable('admin_users').onDelete('CASCADE');
    t.integer('activity_log_id').notNullable()
      .references('id').inTable('activity_logs').onDelete('CASCADE');
    t.datetime('dismissed_at').notNullable();
    t.unique(['admin_id', 'activity_log_id']);
    // The bell reads by admin (covered by the unique index); the download
    // summary bump and the SQLite cleanup on event deletion look rows up by
    // activity_log_id alone.
    t.index(['activity_log_id']);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('notification_dismissals'))) return;
  await knex.schema.dropTable('notification_dismissals');
};
