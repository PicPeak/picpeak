/**
 * Unit tests for the per-file upload size limit getter (general_max_file_size_mb),
 * added so the admin's "Max File Size (MB)" setting applies to guest uploads
 * (#613 follow-up — mat1990dj). Real in-memory SQLite app_settings so the
 * read/parse/cache path runs exactly as in production.
 */
const knex = require('knex');

let db;
let svc;

beforeEach(async () => {
  db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await db.schema.createTable('app_settings', (t) => {
    t.increments('id');
    t.string('setting_key').notNullable().unique();
    t.text('setting_value');
    t.string('setting_type');
    t.timestamp('updated_at');
  });
  jest.resetModules();
  jest.doMock('../../src/database/db', () => ({ db }));
  svc = require('../../src/services/uploadSettings');
  svc.clearMaxFileSizeCache();
});

afterEach(async () => {
  jest.dontMock('../../src/database/db');
  await db.destroy();
});

async function setLimit(mb) {
  await db('app_settings')
    .insert({ setting_key: 'general_max_file_size_mb', setting_value: JSON.stringify(mb), setting_type: 'general', updated_at: new Date() })
    .onConflict('setting_key').merge({ setting_value: JSON.stringify(mb) });
  svc.clearMaxFileSizeCache();
}

test('defaults to 50MB when the setting is absent', async () => {
  expect(await svc.getMaxFileSizeMb()).toBe(50);
  expect(await svc.getMaxFileSizeBytes()).toBe(50 * 1024 * 1024);
});

test('honours a configured value (e.g. 500MB video)', async () => {
  await setLimit(500);
  expect(await svc.getMaxFileSizeMb()).toBe(500);
  expect(await svc.getMaxFileSizeBytes()).toBe(500 * 1024 * 1024);
});

test('clamps a nonsense value to the default and caps absurd values at the ceiling', async () => {
  await setLimit(0);
  expect(await svc.getMaxFileSizeMb()).toBe(50); // 0 → default
  await setLimit(99_999_999);
  expect(await svc.getMaxFileSizeMb()).toBe(svc.MAX_ALLOWED_FILE_SIZE_MB); // ceiling
});

test('videos read their own key and default to 500MB, independent of the photo cap', async () => {
  await setLimit(50);
  expect(await svc.getMaxVideoSizeMb()).toBe(500);
  expect(await svc.getMaxVideoSizeBytes()).toBe(500 * 1024 * 1024);

  await db('app_settings')
    .insert({ setting_key: 'general_max_video_size_mb', setting_value: JSON.stringify(2000), setting_type: 'general', updated_at: new Date() })
    .onConflict('setting_key').merge({ setting_value: JSON.stringify(2000) });
  svc.clearMaxVideoSizeCache();

  expect(await svc.getMaxVideoSizeMb()).toBe(2000);
  expect(await svc.getMaxFileSizeMb()).toBe(50); // photo cap untouched
});

test('clamps the video cap: nonsense falls back to 500, absurd hits the ceiling', async () => {
  const setVideoLimit = async (mb) => {
    await db('app_settings')
      .insert({ setting_key: 'general_max_video_size_mb', setting_value: JSON.stringify(mb), setting_type: 'general', updated_at: new Date() })
      .onConflict('setting_key').merge({ setting_value: JSON.stringify(mb) });
    svc.clearMaxVideoSizeCache();
  };

  await setVideoLimit(0);
  expect(await svc.getMaxVideoSizeMb()).toBe(500);
  await setVideoLimit(99_999_999);
  expect(await svc.getMaxVideoSizeMb()).toBe(svc.MAX_ALLOWED_FILE_SIZE_MB);
});

test('caches for the TTL — a mid-window DB change is not seen until the cache is cleared', async () => {
  await setLimit(200);
  expect(await svc.getMaxFileSizeMb()).toBe(200);
  // change the DB but do NOT clear cache
  await db('app_settings').where({ setting_key: 'general_max_file_size_mb' }).update({ setting_value: JSON.stringify(300) });
  expect(await svc.getMaxFileSizeMb()).toBe(200); // still cached
  svc.clearMaxFileSizeCache();
  expect(await svc.getMaxFileSizeMb()).toBe(300); // refreshed
});
