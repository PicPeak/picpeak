/**
 * Migration 359 adds an empty sender to queued mail, runs twice, rolls back
 * twice, and leaves the email_queue write guards in place on SQLite.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-mig359-')), 'db.sqlite');
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-mig359-storage-'));

const { bootCrmDb } = require('../integration/helpers/crmDb');
const migration = require('../../migrations/core/359_email_queue_sent_by_admin');

let db; let cleanup;
beforeAll(async () => { ({ db, cleanup } = await bootCrmDb()); }, 120000);
afterAll(async () => { if (cleanup) await cleanup(); });

const guardCount = async () => {
  if (db.client.config.client === 'pg') {
    const { rows } = await db.raw("SELECT tgname FROM pg_trigger WHERE tgrelid = 'email_queue'::regclass AND NOT tgisinternal");
    return rows.length;
  }
  const rows = await db('sqlite_master').where({ type: 'trigger', tbl_name: 'email_queue' }).select('name');
  return rows.length;
};

it('adds an empty sender, runs twice, rolls back twice and keeps the queue guards', async () => {
  expect(await db.schema.hasColumn('email_queue', 'sent_by_admin_id')).toBe(true);
  const guards = await guardCount();
  expect(guards).toBeGreaterThan(0);

  const [row] = await db('email_queue').insert({
    recipient_email: 'client@example.com', email_type: 'manual_message', status: 'sent',
    retry_count: 0, created_at: new Date().toISOString(), email_data: JSON.stringify({}),
  }).returning('id');
  const id = row?.id ?? row;

  await migration.down(db);
  await migration.down(db);
  expect(await db.schema.hasColumn('email_queue', 'sent_by_admin_id')).toBe(false);
  expect(await guardCount()).toBe(guards);

  await migration.up(db);
  await migration.up(db);
  expect(await db.schema.hasColumn('email_queue', 'sent_by_admin_id')).toBe(true);
  expect((await db('email_queue').where({ id }).first()).sent_by_admin_id).toBeNull();
  expect(await guardCount()).toBe(guards);
});

it('clears the sender, not the mail, when the admin is deleted', async () => {
  const [a] = await db('admin_users').insert({
    username: 'mig359', email: 'mig359@example.com', password_hash: 'x', must_change_password: false, created_at: new Date(),
  }).returning('id');
  const adminId = a?.id ?? a;
  const [row] = await db('email_queue').insert({
    recipient_email: 'client@example.com', email_type: 'manual_message', status: 'sent', sent_by_admin_id: adminId,
    retry_count: 0, created_at: new Date().toISOString(), email_data: JSON.stringify({}),
  }).returning('id');
  const id = row?.id ?? row;
  if (db.client.config.client !== 'pg') await db.raw('PRAGMA foreign_keys = ON');
  await db('admin_users').where({ id: adminId }).del();
  const kept = await db('email_queue').where({ id }).first();
  expect(kept).toBeTruthy();
  expect(kept.sent_by_admin_id).toBeNull();
});
