/**
 * Migration 362 marks admins that accepted an invitation and have no linked
 * single-sign-on identity as needing a confirmed email before SSO linking.
 * Accounts with a linked identity, and accounts that were not invited, keep
 * their value. Runs twice without change; down() leaves the rows alone.
 * Runs on SQLite, and on PostgreSQL with DATABASE_CLIENT=pg.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-mig362-')), 'db.sqlite');
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-mig362-storage-'));

const knex = require('knex');
const { bootCrmDb } = require('../integration/helpers/crmDb');
const { formatBoolean, parseBoolean } = require('../../src/utils/dbCompat');
const migration = require('../../migrations/core/362_invite_admins_email_link');

let db; let cleanup;
beforeAll(async () => { ({ db, cleanup } = await bootCrmDb()); }, 120000);
afterAll(async () => { if (cleanup) await cleanup(); });

const insertAdmin = async (username, extra) => {
  const [row] = await db('admin_users').insert({
    username, email: `${username}@example.com`, password_hash: 'x', must_change_password: formatBoolean(false),
    is_active: formatBoolean(true), created_at: new Date().toISOString(), email_link_eligible: formatBoolean(true), ...extra,
  }).returning('id');
  return row?.id ?? row;
};
const eligible = async (id) => parseBoolean((await db('admin_users').where({ id }).first()).email_link_eligible);

it('marks invited admins without a linked identity, and only them', async () => {
  const accepted = new Date().toISOString();
  const invited = await insertAdmin('mig362-invited', { invite_accepted_at: accepted });
  const linked = await insertAdmin('mig362-linked', {
    invite_accepted_at: accepted, external_issuer: 'https://idp.example.com', external_subject: 'sub-362',
  });
  const local = await insertAdmin('mig362-local', {});
  const alreadyOff = await insertAdmin('mig362-off', { invite_accepted_at: accepted, email_link_eligible: formatBoolean(false) });

  await migration.up(db);
  expect(await eligible(invited)).toBe(false);
  expect(await eligible(linked)).toBe(true);
  expect(await eligible(local)).toBe(true);
  expect(await eligible(alreadyOff)).toBe(false);

  // A second run and down() change nothing.
  await migration.up(db);
  await migration.down(db);
  expect(await eligible(invited)).toBe(false);
  expect(await eligible(linked)).toBe(true);
  expect(await eligible(local)).toBe(true);
});

it('skips a schema without the columns it reads or writes', async () => {
  const bare = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  try {
    await expect(migration.up(bare)).resolves.toBeUndefined();
    await bare.schema.createTable('admin_users', (t) => {
      t.increments('id').primary();
      t.string('email');
      t.datetime('invite_accepted_at');
    });
    await bare('admin_users').insert({ email: 'a@example.com', invite_accepted_at: new Date().toISOString() });
    await expect(migration.up(bare)).resolves.toBeUndefined();
    expect(await bare('admin_users').count('* as n').first()).toEqual({ n: 1 });
  } finally {
    await bare.destroy();
  }
});
