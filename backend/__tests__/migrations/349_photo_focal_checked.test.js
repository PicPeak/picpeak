/**
 * Migration 349: which photos the focal point backfill still has to look at
 * (issue 2377). Rows without a point are marked 0, rows with one and rows
 * added later are 1; a second run changes nothing, down() removes the column.
 */
const knex = require('knex');
const migration = require('../../migrations/core/349_photo_focal_checked');

describe('migration 349 on SQLite', () => {
  let db;

  beforeEach(async () => {
    db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await db.schema.createTable('photos', (t) => {
      t.increments('id').primary();
      t.string('filename');
      t.double('focal_x');
      t.double('focal_y');
      t.string('focal_source', 16);
    });
    await db('photos').insert([
      { filename: 'old.jpg' },
      { filename: 'detected.jpg', focal_x: 0.7, focal_y: 0.4, focal_source: 'auto' },
    ]);
  });

  afterEach(async () => { await db.destroy(); });

  const checked = async () => (await db('photos').orderBy('id').select('filename', 'focal_checked'))
    .map((row) => [row.filename, row.focal_checked]);

  it('marks the rows without a point, and new rows as looked at', async () => {
    await migration.up(db);
    await db('photos').insert({ filename: 'new.jpg' });
    expect(await checked()).toEqual([['old.jpg', 0], ['detected.jpg', 1], ['new.jpg', 1]]);
  });

  it('leaves rows the backfill did alone on a second run', async () => {
    await migration.up(db);
    await db('photos').where({ filename: 'old.jpg' }).update({ focal_checked: 1 });
    await migration.up(db);
    expect(await checked()).toEqual([['old.jpg', 1], ['detected.jpg', 1]]);
  });

  it('down() removes the column, and both directions skip a database without photos', async () => {
    await migration.up(db);
    await migration.down(db);
    expect(await db.schema.hasColumn('photos', 'focal_checked')).toBe(false);
    await expect(migration.down(db)).resolves.toBeUndefined();
    await db.schema.dropTable('photos');
    await expect(migration.up(db)).resolves.toBeUndefined();
  });
});
