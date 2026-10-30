/**
 * Migration 339 (issue 2303): favorite_lists, photo_feedback.favorite_list_id
 * and event_feedback_settings.allow_favorite_lists. Existing favourites stay
 * NULL (the default list) without a backfill; up and down are re-runnable, and
 * down recounts the photos whose list favourites it drops.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const migration = require('../../migrations/core/339_favorite_lists');

describe('migration 339 — favourite lists', () => {
  let knex; let tmpDir;

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-mig339-'));
    knex = require('knex')({
      client: 'sqlite3',
      connection: { filename: path.join(tmpDir, 'db.sqlite') },
      useNullAsDefault: true,
    });
    await knex.schema.createTable('events', (t) => { t.increments('id'); });
    await knex.schema.createTable('gallery_guests', (t) => { t.increments('id'); t.integer('event_id'); });
    await knex.schema.createTable('event_feedback_settings', (t) => { t.increments('id'); t.integer('event_id'); });
    await knex.schema.createTable('photo_feedback', (t) => {
      t.increments('id');
      t.integer('event_id');
      t.integer('photo_id');
      t.string('feedback_type', 20);
      t.integer('guest_id');
      t.string('guest_identifier');
      t.boolean('is_hidden').defaultTo(false);
    });
    await knex.schema.createTable('photos', (t) => {
      t.increments('id');
      t.integer('favorite_count').defaultTo(0);
      t.integer('feedback_count').defaultTo(0);
    });
    await knex('events').insert({ id: 1 });
    await knex('event_feedback_settings').insert({ event_id: 1 });
    await knex('photos').insert([{ id: 7, favorite_count: 1, feedback_count: 1 }, { id: 8 }]);
    await knex('photo_feedback').insert({ event_id: 1, photo_id: 7, feedback_type: 'favorite', guest_identifier: 'g' });
  });

  afterAll(async () => {
    if (knex) await knex.destroy();
    if (tmpDir) await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  const indexes = async () => (await knex.raw('SELECT name FROM sqlite_master WHERE type = \'index\' AND tbl_name = \'photo_feedback\''))
    .map((row) => row.name);

  it('adds the table and both columns, leaves existing favourites in the default list, and re-runs', async () => {
    await migration.up(knex);
    await migration.up(knex);

    expect(await knex.schema.hasTable('favorite_lists')).toBe(true);
    expect(await knex.schema.hasColumn('photo_feedback', 'favorite_list_id')).toBe(true);
    expect(await indexes()).toContain('photo_feedback_favorite_list_idx');
    expect((await knex('photo_feedback').first()).favorite_list_id).toBeNull();
    // Off by default.
    expect(Boolean((await knex('event_feedback_settings').first()).allow_favorite_lists)).toBe(false);

    const [listId] = await knex('favorite_lists').insert({ event_id: 1, guest_identifier: 'g', name: 'Print' });
    await knex('photo_feedback').insert([
      { event_id: 1, photo_id: 7, feedback_type: 'favorite', guest_identifier: 'g', favorite_list_id: listId },
      // Saved only in the list: no favourite left once the list goes.
      { event_id: 1, photo_id: 8, feedback_type: 'favorite', guest_identifier: 'g', favorite_list_id: listId },
    ]);
    await knex('photos').where({ id: 8 }).update({ favorite_count: 1, feedback_count: 1 });
  });

  it('rolls back, dropping the favourites that sat in extra lists, and re-runs', async () => {
    await migration.down(knex);
    await migration.down(knex);

    expect(await knex.schema.hasTable('favorite_lists')).toBe(false);
    expect(await knex.schema.hasColumn('photo_feedback', 'favorite_list_id')).toBe(false);
    expect(await knex.schema.hasColumn('event_feedback_settings', 'allow_favorite_lists')).toBe(false);
    expect(await indexes()).not.toContain('photo_feedback_favorite_list_idx');
    // The default-list favourite survives; the list's copies are gone, and
    // the counters say so.
    expect(await knex('photo_feedback')).toHaveLength(1);
    const counts = await knex('photos').orderBy('id').select('id', 'favorite_count', 'feedback_count');
    expect(counts).toEqual([
      { id: 7, favorite_count: 1, feedback_count: 1 },
      { id: 8, favorite_count: 0, feedback_count: 0 },
    ]);

    await migration.up(knex);
    expect(await knex.schema.hasTable('favorite_lists')).toBe(true);
  });
});
