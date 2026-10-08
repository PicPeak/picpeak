const { bootCrmDb } = require('../integration/helpers/crmDb');
const migration = require('../../migrations/core/272_rotate_legacy_transfer_upload_codes');

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

test('leaves an empty upload code dead and logs the rotated transfers once', async () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const rows = await db('transfers').insert([
    {
      token: '3'.repeat(64), title: 'empty', expires_at: future,
      is_active: true, allow_uploads: false, upload_token: '',
    },
    {
      token: '4'.repeat(64), title: 'Logo request', expires_at: future,
      is_active: true, allow_uploads: true, upload_token: 'XYZ234',
    },
  ]).returning('id');
  const emptyId = rows[0]?.id ?? rows[0];
  const legacyId = rows[1]?.id ?? rows[1];

  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await migration.up(db);

    expect((await db('transfers').where({ id: emptyId }).first('upload_token')).upload_token)
      .toBe('');
    const rotated = (await db('transfers').where({ id: legacyId }).first('upload_token')).upload_token;
    expect(rotated).toHaveLength(10);

    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0][0];
    expect(line).toContain('Migration 272: rotated 1 legacy transfer upload code(s)');
    expect(line).toContain(`#${legacyId} "Logo request"`);
    expect(line).not.toContain(`#${emptyId} `);
    // The log names the transfer, never the credential.
    expect(line).not.toContain('XYZ234');
    expect(line).not.toContain(rotated);

    log.mockClear();
    await migration.up(db);
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});
