/**
 * CLI test for scripts/reset-admin-mfa.js — break-glass MFA reset (#738).
 *
 * Boots a temp-SQLite DB, seeds an admin with MFA fully enabled, then runs
 * the script in a child process (--email <addr> --yes) pointed at the same
 * DB file, and asserts the four MFA columns are zeroed. The script runs in
 * its own process with its own knex connection; the parent connection is
 * idle during the spawn so the SQLite write lock isn't contended.
 */

const path = require('path');
const { execFileSync } = require('child_process');

const { bootCrmDb } = require('./helpers/crmDb');

jest.setTimeout(60000);

let db;
let cleanup;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
}, 60000);

afterAll(async () => {
  if (cleanup) await cleanup();
});

const SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'reset-admin-mfa.js');

async function seedEnrolledAdmin(email) {
  const inserted = await db('admin_users').insert({
    username: email.split('@')[0],
    email,
    password_hash: 'x',
    is_active: true,
    two_factor_enabled: true,
    two_factor_secret: 'iv.tag.ct',
    two_factor_recovery_codes: JSON.stringify(['$2b$10$fakehashfakehashfakehashfa']),
    two_factor_enrolled_at: new Date(),
    created_at: new Date(),
  }).returning('id');
  return inserted[0]?.id ?? inserted[0];
}

it('zeroes the four MFA columns for the targeted admin', async () => {
  const email = 'reset-me@example.com';
  const id = await seedEnrolledAdmin(email);

  execFileSync('node', [SCRIPT, '--email', email, '--yes'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TEST_DATABASE_PATH: process.env.TEST_DATABASE_PATH,
    },
    stdio: 'pipe',
  });

  const row = await db('admin_users').where({ id }).first();
  expect(Number(row.two_factor_enabled)).toBe(0);
  expect(row.two_factor_secret).toBeNull();
  expect(row.two_factor_recovery_codes).toBeNull();
  expect(row.two_factor_enrolled_at).toBeNull();
});

it('leaves a different admin untouched', async () => {
  const targetEmail = 'target@example.com';
  const bystanderEmail = 'bystander@example.com';
  const targetId = await seedEnrolledAdmin(targetEmail);
  const bystanderId = await seedEnrolledAdmin(bystanderEmail);

  execFileSync('node', [SCRIPT, '--email', targetEmail, '--yes'], {
    env: { ...process.env, NODE_ENV: 'test', TEST_DATABASE_PATH: process.env.TEST_DATABASE_PATH },
    stdio: 'pipe',
  });

  const target = await db('admin_users').where({ id: targetId }).first();
  const bystander = await db('admin_users').where({ id: bystanderId }).first();
  expect(Number(target.two_factor_enabled)).toBe(0);
  expect(Number(bystander.two_factor_enabled)).toBe(1);
  expect(bystander.two_factor_secret).toBe('iv.tag.ct');
});
