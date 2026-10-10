/**
 * Migration 281: an install that was in use before the upgrade keeps the
 * green email accent now that emails follow the brand; a fresh one does not.
 */
const knex = require('knex');
const migration = require('../../migrations/core/281_email_accent_keeps_green');
const { decodeSettingValue } = require('../helpers/settingValue');

async function bootDb({ wizardCompleted = false } = {}) {
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await db.schema.createTable('app_settings', (t) => {
    t.increments('id').primary();
    t.string('setting_key').unique();
    t.text('setting_value');
    t.string('setting_type');
    t.timestamp('updated_at');
  });
  await db.schema.createTable('email_queue', (t) => { t.increments('id').primary(); });
  await db.schema.createTable('events', (t) => { t.increments('id').primary(); });
  // Migration 161 seeds the flag false on an install without an admin; the
  // setup wizard flips it true. null leaves the row out.
  if (wizardCompleted !== null) {
    await db('app_settings').insert({ setting_key: 'setup_wizard_completed', setting_value: JSON.stringify(wizardCompleted), setting_type: 'boolean' });
  }
  return db;
}

describe('migration 281 on SQLite', () => {
  let db;
  const primary = async () => {
    const row = await db('app_settings').where({ setting_key: 'email_primary_color' }).first();
    return row ? decodeSettingValue(db, row.setting_value) : undefined;
  };

  afterEach(async () => { await db.destroy(); });

  it('leaves a fresh install to follow the brand', async () => {
    db = await bootDb();
    await migration.up(db);
    expect(await primary()).toBeUndefined();
  });

  it('pins the green on an install that has sent mail, and runs again', async () => {
    db = await bootDb();
    await db('email_queue').insert({});
    await migration.up(db);
    expect(await primary()).toBe('#5C8762');
    await migration.up(db);
    expect(await db('app_settings').where({ setting_key: 'email_primary_color' }).count({ c: '*' }).first()).toEqual({ c: 1 });
  });

  // email_queue rows go with their event, so an old install can have none.
  it('pins the green on a set-up install whose mail queue is empty', async () => {
    db = await bootDb({ wizardCompleted: true });
    await migration.up(db);
    expect(await primary()).toBe('#5C8762');
  });

  it('pins the green on an install with events but no queued mail', async () => {
    db = await bootDb();
    await db('events').insert({});
    await migration.up(db);
    expect(await primary()).toBe('#5C8762');
  });

  it('treats a missing setup flag (a restore from before migration 161) as in use', async () => {
    db = await bootDb({ wizardCompleted: null });
    await migration.up(db);
    expect(await primary()).toBe('#5C8762');
  });

  it('stores updated_at as an ISO string', async () => {
    db = await bootDb({ wizardCompleted: true });
    await migration.up(db);
    const row = await db('app_settings').where({ setting_key: 'email_primary_color' }).first('updated_at');
    expect(row.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('fills an empty stored value and keeps a colour the admin chose', async () => {
    db = await bootDb();
    await db('email_queue').insert({});
    await db('app_settings').insert({ setting_key: 'email_primary_color', setting_value: JSON.stringify(''), setting_type: 'general' });
    await migration.up(db);
    expect(await primary()).toBe('#5C8762');

    await db('app_settings').where({ setting_key: 'email_primary_color' }).update({ setting_value: JSON.stringify('#123456') });
    await migration.up(db);
    expect(await primary()).toBe('#123456');
  });

  it('pins the green over an invalid colour, which already rendered green', async () => {
    db = await bootDb();
    await db('email_queue').insert({});
    await db('app_settings').insert({ setting_key: 'email_primary_color', setting_value: JSON.stringify('url(x)'), setting_type: 'general' });
    await migration.up(db);
    expect(await primary()).toBe('#5C8762');
  });
});
