/**
 * Migration 311 adds photos.rendition_version and sets every existing row to
 * 0 (issue 2096). The column and the backfill must land together: on SQLite
 * the runners give a migration no transaction, and a backfill that failed
 * after the column was added would leave legacy rows at 1 for good, because
 * the re-run finds the column and skips.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const knexFactory = require('knex');

const migration = require('../../migrations/core/311_photos_rendition_version');

describe('migration 311 photos.rendition_version', () => {
  let knex;
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-311-'));
    knex = knexFactory({ client: 'sqlite3', connection: { filename: path.join(tmpDir, 'db.sqlite') }, useNullAsDefault: true });
    await knex.schema.createTable('photos', (t) => {
      t.increments('id');
      t.string('filename');
    });
    await knex('photos').insert([{ filename: 'a.jpg' }, { filename: 'b.jpg' }]);
  });

  afterEach(async () => {
    await knex.destroy();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  const versions = async () => Array.from(await knex('photos').orderBy('id').select('rendition_version'))
    .map((r) => Number(r.rendition_version));

  it('marks existing rows 0, new rows 1, and a re-run changes nothing', async () => {
    await migration.up(knex);
    expect(await versions()).toEqual([0, 0]);
    await knex('photos').insert({ filename: 'c.jpg' });
    await knex('photos').where({ id: 1 }).update({ rendition_version: 1 });
    await migration.up(knex);
    expect(await versions()).toEqual([1, 0, 1]);
  });

  it('rolls the column back when the backfill fails, so the retry still backfills', async () => {
    await knex.raw('CREATE TRIGGER block_update BEFORE UPDATE ON photos BEGIN SELECT RAISE(ABORT, \'database is locked\'); END');
    await expect(migration.up(knex)).rejects.toThrow(/locked/);
    expect(await knex.schema.hasColumn('photos', 'rendition_version')).toBe(false);

    await knex.raw('DROP TRIGGER block_update');
    await migration.up(knex);
    expect(await versions()).toEqual([0, 0]);
  });

  it('down() removes the column', async () => {
    await migration.up(knex);
    await migration.down(knex);
    expect(await knex.schema.hasColumn('photos', 'rendition_version')).toBe(false);
  });
});
