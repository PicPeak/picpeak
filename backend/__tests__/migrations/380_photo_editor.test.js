/**
 * Migration 380: the photo editor (issue 2619). Existing rows get no edit
 * (revision 0 applied), the presets table and the photoEditor flag (off)
 * appear; a second run changes nothing; down() removes all of it; both
 * directions skip a database without photos.
 */
const knex = require('knex');
const migration = require('../../migrations/core/380_photo_editor');

describe('migration 380 on SQLite', () => {
  let db;

  beforeEach(async () => {
    db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await db.schema.createTable('photos', (t) => {
      t.increments('id').primary();
      t.string('filename');
    });
    await db.schema.createTable('feature_flags', (t) => {
      t.string('key').primary();
      t.boolean('value');
    });
    await db('photos').insert({ filename: 'old.jpg' });
  });

  afterEach(async () => { await db.destroy(); });

  it('adds the edit columns with no edit on existing rows, the presets and the flag off', async () => {
    await migration.up(db);
    expect(await db('photos').first()).toMatchObject({
      filename: 'old.jpg', edit_params: null, edit_rev: 0, edit_applied_rev: 0, edit_render_path: null, edit_width: null, edit_height: null,
      edit_applied_params: null, edit_applied_width: null, edit_applied_height: null, edit_failed_rev: null, edit_error: null,
    });
    expect(await db.schema.hasTable('photo_edit_presets')).toBe(true);
    expect(await db('feature_flags').where({ key: 'photoEditor' }).first()).toMatchObject({ value: 0 });
  });

  it('is idempotent and keeps a flag an admin turned on', async () => {
    await migration.up(db);
    await db('feature_flags').where({ key: 'photoEditor' }).update({ value: true });
    await db('photo_edit_presets').insert({ name: 'Warm', params: '{}' });
    await migration.up(db);
    expect(await db('feature_flags').where({ key: 'photoEditor' }).first()).toMatchObject({ value: 1 });
    expect(await db('photo_edit_presets').count('id as n').first()).toMatchObject({ n: 1 });
  });

  it('down() removes everything, and both directions skip a database without photos', async () => {
    await migration.up(db);
    await migration.down(db);
    expect(await db.schema.hasColumn('photos', 'edit_params')).toBe(false);
    expect(await db.schema.hasColumn('photos', 'edit_failed_rev')).toBe(false);
    expect(await db.schema.hasTable('photo_edit_presets')).toBe(false);
    expect(await db('feature_flags').where({ key: 'photoEditor' }).first()).toBeUndefined();
    await expect(migration.down(db)).resolves.toBeUndefined();
    await db.schema.dropTable('photos');
    await expect(migration.up(db)).resolves.toBeUndefined();
    await expect(migration.down(db)).resolves.toBeUndefined();
  });
});
