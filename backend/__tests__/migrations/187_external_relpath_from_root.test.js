/**
 * Folding the event's base path into every external row (#1163).
 *
 * Two things can go wrong and both are silent, which is why they are pinned
 * here rather than left to review: folding a path that was ALREADY folded
 * (every original moves), and "repairing" a healthy install because the media
 * root happened to be unmounted when the migration ran (every original moves).
 *
 * The repair itself is driven against a real temp directory tree, because the
 * whole mechanism is "is this file actually there" and a mocked fs would only
 * be testing the mock.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

describe('migration 187 — external_relpath from the media root (#1163)', () => {
  let knex; let tmpDir; let mediaRoot; let migration;

  /** Writes `bytes` bytes and returns the size, so fixtures can record it the
   *  way an import would have. */
  const touch = async (rel, bytes = 8) => {
    const full = path.join(mediaRoot, rel);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, Buffer.alloc(bytes));
    return bytes;
  };

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-mig187-'));
    mediaRoot = path.join(tmpDir, 'media');
    await fs.promises.mkdir(mediaRoot, { recursive: true });
    process.env.EXTERNAL_MEDIA_ROOT = mediaRoot;

    // The service caches the root on first call, so it must not have been
    // resolved before EXTERNAL_MEDIA_ROOT was set above.
    jest.resetModules();
    migration = require('../../migrations/core/187_external_relpath_from_root');

    knex = require('knex')({
      client: 'sqlite3',
      connection: { filename: path.join(tmpDir, 'db.sqlite') },
      useNullAsDefault: true,
    });
  });

  afterAll(async () => {
    if (knex) await knex.destroy();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    delete process.env.EXTERNAL_MEDIA_ROOT;
  });

  beforeEach(async () => {
    await knex.schema.dropTableIfExists('photos');
    await knex.schema.dropTableIfExists('events');
    await knex.schema.dropTableIfExists('app_settings');
    await knex.schema.createTable('events', (t) => {
      t.increments('id').primary();
      t.string('external_path');
    });
    await knex.schema.createTable('photos', (t) => {
      t.increments('id').primary();
      t.integer('event_id');
      t.string('external_relpath');
      t.integer('size_bytes');
      t.string('source_origin').defaultTo('managed');
    });
    await knex.schema.createTable('app_settings', (t) => {
      t.increments('id').primary();
      t.string('setting_key');
      t.text('setting_value');
      t.string('setting_type');
      t.string('updated_at');
    });
    await fs.promises.rm(mediaRoot, { recursive: true, force: true });
    await fs.promises.mkdir(mediaRoot, { recursive: true });
  });

  const relpaths = async () =>
    (await knex('photos').orderBy('id', 'asc').select('external_relpath'))
      .map((r) => r.external_relpath);

  it('folds the base path into every row of a healthy event', async () => {
    await touch('Trip/Leknes/a.jpg');
    await touch('Trip/Leknes/b.jpg');
    await knex('events').insert({ id: 1, external_path: 'Trip' });
    await knex('photos').insert([
      { event_id: 1, external_relpath: 'Leknes/a.jpg', source_origin: 'external' },
      { event_id: 1, external_relpath: 'Leknes/b.jpg', source_origin: 'external' },
    ]);

    await migration.up(knex);

    expect(await relpaths()).toEqual(['Trip/Leknes/a.jpg', 'Trip/Leknes/b.jpg']);
  });

  it('repairs rows an earlier import had rebased', async () => {
    // The reported shape: a parent imported first, a child imported second, so
    // events.external_path is the child and the parent's rows resolve into a
    // path that does not exist.
    const oldSize = await touch('Trip/Leknes/old.jpg', 11);   // from the first import
    const newSize = await touch('Trip/Sub/new.jpg', 22);      // from the second
    await knex('events').insert({ id: 1, external_path: 'Trip/Sub' });
    await knex('photos').insert([
      { event_id: 1, external_relpath: 'Leknes/old.jpg', size_bytes: oldSize, source_origin: 'external' },
      { event_id: 1, external_relpath: 'new.jpg', size_bytes: newSize, source_origin: 'external' },
    ]);

    await migration.up(knex);

    // The old row is placed where the file actually is; the new one keeps
    // resolving exactly where it resolved before.
    expect(await relpaths()).toEqual(['Trip/Leknes/old.jpg', 'Trip/Sub/new.jpg']);
  });

  it('refuses an ancestor whose file is a different size', async () => {
    // The dangerous case: the row's own file was simply deleted, and an
    // UNRELATED file one directory up happens to share its name. Adopting it
    // would make downloads serve the wrong original — worse than a dead link.
    await touch('Trip/photo.jpg', 999);
    await knex('events').insert({ id: 1, external_path: 'Trip/Sub' });
    await knex('photos').insert({
      event_id: 1, external_relpath: 'photo.jpg', size_bytes: 42, source_origin: 'external',
    });

    await migration.up(knex);

    expect(await relpaths()).toEqual(['Trip/Sub/photo.jpg']);
  });

  it('refuses an ancestor when the row records no size to check against', async () => {
    // Nothing to verify provenance with, so the row stays where it resolves
    // today rather than adopting a same-named stranger.
    await touch('Trip/photo.jpg', 100);
    await knex('events').insert({ id: 1, external_path: 'Trip/Sub' });
    await knex('photos').insert({
      event_id: 1, external_relpath: 'photo.jpg', size_bytes: null, source_origin: 'external',
    });

    await migration.up(knex);

    expect(await relpaths()).toEqual(['Trip/Sub/photo.jpg']);
  });

  it('leaves nothing folded when a rewrite fails partway', async () => {
    // Without a transaction, a crash between the first event's UPDATE and the
    // marker leaves mixed formats behind — and the next run folds the already
    // folded rows a second time, putting every original one directory deeper.
    await touch('A/one.jpg');
    await touch('B/two.jpg');
    await knex('events').insert([
      { id: 1, external_path: 'A' },
      { id: 2, external_path: 'B' },
    ]);
    await knex('photos').insert([
      { event_id: 1, external_relpath: 'one.jpg', source_origin: 'external' },
      { event_id: 2, external_relpath: 'two.jpg', source_origin: 'external' },
    ]);
    // app_settings is written last, in the same transaction as the rewrites.
    await knex.schema.dropTableIfExists('app_settings_backup');
    await knex.raw('CREATE TRIGGER fail_marker BEFORE INSERT ON app_settings '
      + "BEGIN SELECT RAISE(ABORT, 'boom'); END");

    await expect(migration.up(knex)).rejects.toThrow(/boom/);

    await knex.raw('DROP TRIGGER fail_marker');
    // Every row still base-relative, and no marker — so a retry is correct.
    expect(await relpaths()).toEqual(['one.jpg', 'two.jpg']);
    expect(await knex('app_settings').where('setting_key', 'external_relpath_root_relative').first())
      .toBeUndefined();
  });

  it('leaves a row it cannot place resolving where it resolves today', async () => {
    // Never guess below current behaviour: a file that is genuinely gone must
    // not have its path rewritten to some other file that happens to exist.
    await touch('Trip/Sub/present.jpg');
    await knex('events').insert({ id: 1, external_path: 'Trip/Sub' });
    await knex('photos').insert([
      { event_id: 1, external_relpath: 'present.jpg', source_origin: 'external' },
      { event_id: 1, external_relpath: 'vanished.jpg', source_origin: 'external' },
    ]);

    await migration.up(knex);

    expect(await relpaths()).toEqual(['Trip/Sub/present.jpg', 'Trip/Sub/vanished.jpg']);
  });

  it('folds without repairing when the media root is unmounted', async () => {
    // An unmounted share leaves the mountpoint as an empty directory, so every
    // file looks missing. Repairing off that signal would move every original
    // on a perfectly healthy install.
    await knex('events').insert({ id: 1, external_path: 'Trip/Sub' });
    await knex('photos').insert([
      { event_id: 1, external_relpath: 'Leknes/a.jpg', source_origin: 'external' },
    ]);
    // mediaRoot is empty — see beforeEach.

    await migration.up(knex);

    expect(await relpaths()).toEqual(['Trip/Sub/Leknes/a.jpg']);
  });

  it('leaves managed rows alone', async () => {
    await touch('Trip/a.jpg');
    await knex('events').insert({ id: 1, external_path: 'Trip' });
    await knex('photos').insert([
      { event_id: 1, external_relpath: null, source_origin: 'managed' },
      { event_id: 1, external_relpath: 'a.jpg', source_origin: 'external' },
    ]);

    await migration.up(knex);

    expect(await relpaths()).toEqual([null, 'Trip/a.jpg']);
  });

  it('leaves an event with no base path alone — its rows are already root-relative', async () => {
    await touch('a.jpg');
    await knex('events').insert({ id: 1, external_path: null });
    await knex('photos').insert({ event_id: 1, external_relpath: 'a.jpg', source_origin: 'external' });

    await migration.up(knex);

    expect(await relpaths()).toEqual(['a.jpg']);
  });

  it('folds each event with its own base', async () => {
    await touch('A/one.jpg');
    await touch('B/two.jpg');
    await knex('events').insert([
      { id: 1, external_path: 'A' },
      { id: 2, external_path: 'B' },
    ]);
    await knex('photos').insert([
      { event_id: 1, external_relpath: 'one.jpg', source_origin: 'external' },
      { event_id: 2, external_relpath: 'two.jpg', source_origin: 'external' },
    ]);

    await migration.up(knex);

    expect(await relpaths()).toEqual(['A/one.jpg', 'B/two.jpg']);
  });

  it('tolerates a base path with stray slashes', async () => {
    await touch('Trip/a.jpg');
    await knex('events').insert({ id: 1, external_path: '/Trip/' });
    await knex('photos').insert({ event_id: 1, external_relpath: 'a.jpg', source_origin: 'external' });

    await migration.up(knex);

    expect(await relpaths()).toEqual(['Trip/a.jpg']);
  });

  it('does not fold twice when run again', async () => {
    // The failure this guards is total: every original on the install moves one
    // directory deeper, and there is no undo.
    await touch('Trip/a.jpg');
    await knex('events').insert({ id: 1, external_path: 'Trip' });
    await knex('photos').insert({ event_id: 1, external_relpath: 'a.jpg', source_origin: 'external' });

    await migration.up(knex);
    await migration.up(knex);

    expect(await relpaths()).toEqual(['Trip/a.jpg']);
  });

  it('does not fold twice when the base repeats in the relpath', async () => {
    // The inference this migration deliberately does NOT use: `Trip/x.jpg`
    // under base `Trip` already "starts with the base", but has not been
    // folded — it is a subfolder that shares its parent's name.
    await touch('Trip/Trip/x.jpg');
    await knex('events').insert({ id: 1, external_path: 'Trip' });
    await knex('photos').insert({ event_id: 1, external_relpath: 'Trip/x.jpg', source_origin: 'external' });

    await migration.up(knex);

    expect(await relpaths()).toEqual(['Trip/Trip/x.jpg']);
  });

  it('rollback does not clear the marker, so a re-run cannot double-fold', async () => {
    await touch('Trip/a.jpg');
    await knex('events').insert({ id: 1, external_path: 'Trip' });
    await knex('photos').insert({ event_id: 1, external_relpath: 'a.jpg', source_origin: 'external' });

    await migration.up(knex);
    await migration.down(knex);
    await migration.up(knex);

    expect(await relpaths()).toEqual(['Trip/a.jpg']);
  });

  it('no-ops before 041 has added the column', async () => {
    await knex.schema.dropTableIfExists('photos');
    await knex.schema.createTable('photos', (t) => { t.increments('id').primary(); });

    await expect(migration.up(knex)).resolves.toBeUndefined();
  });
});
