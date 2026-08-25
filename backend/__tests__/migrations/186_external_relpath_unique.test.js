/**
 * One row per external file per event (#1162).
 *
 * The migration has two halves and they fail differently: the cleanup can take
 * out the wrong row of a pair (losing a thumbnail, orphaning an event's hero),
 * and the index can fail to be created at all — leaving an install that looks
 * migrated and is still racing. Both are pinned here.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const migration = require('../../migrations/core/186_external_relpath_unique');

describe('migration 186 — unique (event_id, external_relpath) (#1162)', () => {
  let knex; let tmpDir;

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-mig186-'));
    knex = require('knex')({
      client: 'sqlite3',
      connection: { filename: path.join(tmpDir, 'db.sqlite') },
      useNullAsDefault: true,
    });
  });

  afterAll(async () => {
    if (knex) await knex.destroy();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    await knex.schema.dropTableIfExists('photos');
    await knex.schema.dropTableIfExists('events');
    await knex.schema.dropTableIfExists('photo_categories');
    await knex.schema.createTable('events', (t) => {
      t.increments('id').primary();
      t.integer('hero_photo_id');
    });
    await knex.schema.createTable('photo_categories', (t) => {
      t.increments('id').primary();
      t.integer('hero_photo_id');
    });
    await knex.schema.createTable('photos', (t) => {
      t.increments('id').primary();
      t.integer('event_id');
      t.string('external_relpath');
      t.string('thumbnail_path');
      t.string('source_origin').defaultTo('managed');
    });
  });

  const rows = () => knex('photos').orderBy('id', 'asc').select('*');

  it('collapses a duplicated pair to one row and leaves distinct paths alone', async () => {
    await knex('photos').insert([
      { event_id: 1, external_relpath: 'a/x.jpg', thumbnail_path: 't1', source_origin: 'external' },
      { event_id: 1, external_relpath: 'a/x.jpg', thumbnail_path: 't2', source_origin: 'external' },
      { event_id: 1, external_relpath: 'a/y.jpg', thumbnail_path: 't3', source_origin: 'external' },
    ]);

    await migration.up(knex);

    const after = await rows();
    expect(after.map((r) => r.external_relpath)).toEqual(['a/x.jpg', 'a/y.jpg']);
    // Lowest id survives when both sides are equally complete.
    expect(after[0].id).toBe(1);
  });

  it('does not collapse the same path across different events', async () => {
    // The constraint is per event. Two events referencing the same NAS folder
    // is a supported setup, and treating those as duplicates would delete one
    // event's entire library.
    await knex('photos').insert([
      { event_id: 1, external_relpath: 'a/x.jpg', source_origin: 'external' },
      { event_id: 2, external_relpath: 'a/x.jpg', source_origin: 'external' },
    ]);

    await migration.up(knex);

    expect(await knex('photos').count('* as c').first()).toEqual({ c: 2 });
  });

  it('never touches managed rows, however many carry NULL', async () => {
    // Every managed photo has external_relpath NULL. Grouping on it without
    // the NOT NULL filter would make them all one enormous "duplicate" group
    // and delete the entire library bar one row.
    await knex('photos').insert([
      { event_id: 1, external_relpath: null, source_origin: 'managed' },
      { event_id: 1, external_relpath: null, source_origin: 'managed' },
      { event_id: 1, external_relpath: null, source_origin: 'managed' },
    ]);

    await migration.up(knex);

    expect(await knex('photos').count('* as c').first()).toEqual({ c: 3 });
  });

  it('keeps the row that has a thumbnail, not merely the lowest id', async () => {
    // An import killed mid-flight leaves rows without a thumbnail. Dropping
    // the completed one would blank a tile in the grid for no reason.
    await knex('photos').insert([
      { event_id: 1, external_relpath: 'a/x.jpg', thumbnail_path: null, source_origin: 'external' },
      { event_id: 1, external_relpath: 'a/x.jpg', thumbnail_path: 'thumb.jpg', source_origin: 'external' },
    ]);

    await migration.up(knex);

    const after = await rows();
    expect(after).toHaveLength(1);
    expect(after[0].thumbnail_path).toBe('thumb.jpg');
  });

  it('repoints a hero that pointed at the row being removed', async () => {
    // events.hero_photo_id is ON DELETE SET NULL, so without this the cleanup
    // silently strips the event's hero image — a visible regression caused
    // entirely by the fix.
    await knex('photos').insert([
      { event_id: 1, external_relpath: 'a/x.jpg', thumbnail_path: 't', source_origin: 'external' },
      { event_id: 1, external_relpath: 'a/x.jpg', thumbnail_path: 't', source_origin: 'external' },
    ]);
    await knex('events').insert({ id: 1, hero_photo_id: 2 });
    await knex('photo_categories').insert({ id: 1, hero_photo_id: 2 });

    await migration.up(knex);

    expect((await knex('events').where({ id: 1 }).first()).hero_photo_id).toBe(1);
    expect((await knex('photo_categories').where({ id: 1 }).first()).hero_photo_id).toBe(1);
  });

  it('leaves a hero that pointed at the survivor untouched', async () => {
    await knex('photos').insert([
      { event_id: 1, external_relpath: 'a/x.jpg', thumbnail_path: 't', source_origin: 'external' },
      { event_id: 1, external_relpath: 'a/x.jpg', thumbnail_path: 't', source_origin: 'external' },
    ]);
    await knex('events').insert({ id: 1, hero_photo_id: 1 });

    await migration.up(knex);

    expect((await knex('events').where({ id: 1 }).first()).hero_photo_id).toBe(1);
  });

  it('makes a second insert of the same path impossible afterwards', async () => {
    // The whole point. Without this the route is still racing, and the
    // migration is recorded as applied.
    await knex('photos').insert({ event_id: 1, external_relpath: 'a/x.jpg', source_origin: 'external' });

    await migration.up(knex);

    await expect(
      knex('photos').insert({ event_id: 1, external_relpath: 'a/x.jpg', source_origin: 'external' })
    ).rejects.toThrow(/unique/i);
  });

  it('still admits managed rows once the index exists', async () => {
    await migration.up(knex);

    await knex('photos').insert([
      { event_id: 1, external_relpath: null, source_origin: 'managed' },
      { event_id: 1, external_relpath: null, source_origin: 'managed' },
    ]);

    expect(await knex('photos').count('* as c').first()).toEqual({ c: 2 });
  });

  it('is idempotent', async () => {
    await knex('photos').insert([
      { event_id: 1, external_relpath: 'a/x.jpg', source_origin: 'external' },
      { event_id: 1, external_relpath: 'a/x.jpg', source_origin: 'external' },
    ]);

    await migration.up(knex);
    const once = await rows();
    await migration.up(knex);

    expect(await rows()).toEqual(once);
  });

  it('rolls back to an unconstrained table', async () => {
    await migration.up(knex);
    await migration.down(knex);

    await knex('photos').insert([
      { event_id: 1, external_relpath: 'a/x.jpg', source_origin: 'external' },
      { event_id: 1, external_relpath: 'a/x.jpg', source_origin: 'external' },
    ]);
    expect(await knex('photos').count('* as c').first()).toEqual({ c: 2 });
  });

  it('no-ops before 041 has added the column', async () => {
    await knex.schema.dropTableIfExists('photos');
    await knex.schema.createTable('photos', (t) => { t.increments('id').primary(); });

    await expect(migration.up(knex)).resolves.toBeUndefined();
  });
});
