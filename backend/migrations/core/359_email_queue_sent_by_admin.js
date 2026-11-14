'use strict';
/**
 * Migration 359: email_queue.sent_by_admin_id.
 *
 * The admin who wrote and sent a message from the Messages composer. Sent
 * mail is reached through its gallery (middleware/emailQueueOwnership); a
 * composed message usually has no gallery, so without its sender it would
 * belong to nobody but the Super Admins. The sender reaches the rows they
 * sent. NULL for every row written before this migration and for system
 * mail, which keep the gallery rule. Deleting the admin keeps the row.
 *
 * Additive and idempotent. Altering email_queue may rebuild the table on
 * SQLite, which drops its account-recovery write guards (migration 273), so
 * they are put back afterwards, as migration 346 does.
 */
const isPg = (knex) => knex.client.config.client === 'pg';

async function restoreSqliteGuards(knex) {
  if (isPg(knex)) return;
  const { installAccountRecoveryWriteGuards } = require('../../src/services/accountRecoveryStorageHardening');
  await installAccountRecoveryWriteGuards(knex);
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_queue'))) return;
  if (await knex.schema.hasColumn('email_queue', 'sent_by_admin_id')) return;
  await knex.schema.alterTable('email_queue', (t) => {
    t.integer('sent_by_admin_id').nullable()
      .references('id').inTable('admin_users').onDelete('SET NULL');
    t.index(['sent_by_admin_id']);
  });
  await restoreSqliteGuards(knex);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('email_queue'))) return;
  if (!(await knex.schema.hasColumn('email_queue', 'sent_by_admin_id'))) return;
  await knex.schema.alterTable('email_queue', (t) => {
    t.dropIndex(['sent_by_admin_id']);
    if (isPg(knex)) t.dropForeign(['sent_by_admin_id']);
    t.dropColumn('sent_by_admin_id');
  });
  await restoreSqliteGuards(knex);
};
