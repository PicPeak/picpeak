const { bootCrmDb } = require('../integration/helpers/crmDb');
const migration = require('../../migrations/core/241_rotate_legacy_transfer_upload_codes');

jest.setTimeout(120000);

let db;
let cleanup;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

test('rotates legacy transfer upload codes once and preserves current codes', async () => {
  const future = new Date(Date.now() + 86400000);
  const rows = await db('transfers').insert([
    {
      token: '1'.repeat(64), title: 'legacy', expires_at: future,
      is_active: true, allow_uploads: true, upload_token: 'ABC234',
    },
    {
      token: '2'.repeat(64), title: 'current', expires_at: future,
      is_active: true, allow_uploads: true, upload_token: 'ABCDEFG234',
    },
  ]).returning('id');
  const legacyId = rows[0]?.id ?? rows[0];
  const currentId = rows[1]?.id ?? rows[1];

  await migration.up(db);

  const legacy = await db('transfers').where({ id: legacyId }).first('upload_token');
  const current = await db('transfers').where({ id: currentId }).first('upload_token');
  expect(legacy.upload_token).toHaveLength(10);
  expect(legacy.upload_token).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/);
  expect(legacy.upload_token).not.toBe('ABC234');
  expect(current.upload_token).toBe('ABCDEFG234');

  await migration.up(db);
  expect((await db('transfers').where({ id: legacyId }).first('upload_token')).upload_token)
    .toBe(legacy.upload_token);
});
