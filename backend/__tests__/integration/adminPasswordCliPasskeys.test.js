/**
 * The command-line password resets and passkeys (issue 1733).
 *
 * scripts/set-admin-password.js and the existing-account branch of
 * scripts/create-admin.js are resets done by an operator, not by the account's
 * owner. A passkey signs in without the password, so one that survived either
 * script would leave the account open to whoever the reset was meant to lock
 * out. Each script runs in a child process against the same SQLite file, like
 * resetAdminMfaCli.test.js.
 */

const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { bootCrmDb } = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
}, 120000);

afterAll(async () => {
  if (cleanup) await cleanup();
});

// Generated per run; meets set-admin-password.js's strength rules.
const newPassword = () => `Aa1!${crypto.randomBytes(9).toString('hex')}`;
const script = (name) => path.resolve(__dirname, '..', '..', 'scripts', name);
const run = (name, args) => execFileSync('node', [script(name), ...args], {
  env: { ...process.env, NODE_ENV: 'test', TEST_DATABASE_PATH: process.env.TEST_DATABASE_PATH },
  stdio: 'pipe',
});

async function seedAdmin(username) {
  const inserted = await db('admin_users').insert({
    username, email: `${username}@example.com`, password_hash: 'old-hash', is_active: true,
    created_at: new Date().toISOString(),
  }).returning('id');
  return inserted[0]?.id ?? inserted[0];
}

const passkey = (adminId, n) => ({
  admin_user_id: adminId, credential_id: `cli-${adminId}-${n}`, public_key: 'AQ', counter: 0,
  name: `k${n}`, created_at: new Date().toISOString(),
});

const passkeysOf = (adminId) => db('admin_webauthn_credentials').where({ admin_user_id: adminId });

it('set-admin-password.js removes the passkeys of the account it resets and nobody else\'s', async () => {
  await db('admin_users').where({ username: 'admin' }).del();
  const adminId = await seedAdmin('admin');
  const bystanderId = await seedAdmin('cli-bystander-1');
  await db('admin_webauthn_credentials').insert([passkey(adminId, 1), passkey(adminId, 2), passkey(bystanderId, 1)]);

  run('set-admin-password.js', [newPassword()]);

  expect((await db('admin_users').where({ id: adminId }).first()).password_hash).not.toBe('old-hash');
  expect(await passkeysOf(adminId)).toHaveLength(0);
  expect(await passkeysOf(bystanderId)).toHaveLength(1);
});

it('create-admin.js removes the passkeys of an existing account whose password it resets', async () => {
  const targetId = await seedAdmin('cli-target');
  const bystanderId = await seedAdmin('cli-bystander-2');
  await db('admin_webauthn_credentials').insert([passkey(targetId, 1), passkey(bystanderId, 1)]);

  run('create-admin.js', ['--email', 'cli-target@example.com', '--password', newPassword()]);

  expect((await db('admin_users').where({ id: targetId }).first()).password_hash).not.toBe('old-hash');
  expect(await passkeysOf(targetId)).toHaveLength(0);
  expect(await passkeysOf(bystanderId)).toHaveLength(1);
});
