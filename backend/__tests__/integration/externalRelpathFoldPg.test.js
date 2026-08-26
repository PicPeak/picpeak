/**
 * PostgreSQL integration test for the external-path fold (#1163).
 *
 * Gated the same way as picpeakRestorePg: runs only when PICPEAK_PG_TEST_URL
 * points at a throwaway Postgres DB, e.g.
 *   PICPEAK_PG_TEST_URL="postgres://picpeak:picpeak_secure_pass_2024@127.0.0.1:7102/picpeak_fold_test" \
 *     npx jest __tests__/integration/externalRelpathFoldPg.test.js
 *
 * This exists because of a defect SQLite could not have caught. The two-pass
 * rewrite parks each row on a temporary value, and that value was first written
 * with a leading NUL. SQLite stores NUL in TEXT without complaint; Postgres
 * rejects it outright ("invalid byte sequence for encoding UTF8"), so migration
 * 187 would have rolled back on exactly the installs needing the repair — and
 * only on the engine most of them run.
 *
 * The staging value is therefore an engine-level contract, not an
 * implementation detail, and it is pinned here on the engine that constrains it.
 */

const knex = require('knex');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PG_URL = process.env.PICPEAK_PG_TEST_URL;
const maybe = PG_URL ? describe : describe.skip;

maybe('external relpath fold on Postgres', () => {
  let pgDb; let mediaRoot; let fold;

  const touch = async (rel, bytes) => {
    const full = path.join(mediaRoot, rel);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, Buffer.alloc(bytes));
    return bytes;
  };

  beforeAll(async () => {
    mediaRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-foldpg-'));
    process.env.EXTERNAL_MEDIA_ROOT = mediaRoot;
    jest.resetModules();
    ({ foldExternalRelpaths: fold } = require('../../src/services/externalRelpathFold'));

    pgDb = knex({ client: 'pg', connection: PG_URL });
  }, 60000);

  afterAll(async () => {
    if (pgDb) await pgDb.destroy();
    await fs.promises.rm(mediaRoot, { recursive: true, force: true }).catch(() => {});
    delete process.env.EXTERNAL_MEDIA_ROOT;
  });

  beforeEach(async () => {
    await pgDb.raw('DROP TABLE IF EXISTS photos, events, app_settings CASCADE');
    await pgDb.schema.createTable('events', (t) => {
      t.increments('id');
      t.text('external_path');
    });
    await pgDb.schema.createTable('photos', (t) => {
      t.increments('id');
      t.integer('event_id');
      t.text('external_relpath');
      t.bigInteger('size_bytes');
      t.string('source_origin').defaultTo('managed');
    });
    await pgDb.schema.createTable('app_settings', (t) => {
      t.increments('id');
      t.string('setting_key');
      t.text('setting_value');
      t.string('setting_type');
      t.string('updated_at');
    });
    await fs.promises.rm(mediaRoot, { recursive: true, force: true });
    await fs.promises.mkdir(mediaRoot, { recursive: true });
  });

  const relpaths = async () =>
    (await pgDb('photos').orderBy('id').select('external_relpath')).map((r) => r.external_relpath);

  it('completes the two-pass repair that a NUL staging value would abort', async () => {
    // The exact shape that forces staging: `photo.jpg` repairs up to
    // `Trip/photo.jpg`, while the row already holding `Trip/photo.jpg` folds
    // deeper. Every final value is distinct, but a final value equals another
    // row's current one, so the rewrite has to park first.
    const a = await touch('Trip/photo.jpg', 11);
    const b = await touch('Trip/Sub/Trip/photo.jpg', 22);
    await pgDb('events').insert({ id: 1, external_path: 'Trip/Sub' });
    await pgDb('photos').insert([
      { event_id: 1, external_relpath: 'photo.jpg', size_bytes: a, source_origin: 'external' },
      { event_id: 1, external_relpath: 'Trip/photo.jpg', size_bytes: b, source_origin: 'external' },
    ]);

    await fold(pgDb);

    expect(await relpaths()).toEqual(['Trip/photo.jpg', 'Trip/Sub/Trip/photo.jpg']);
  });

  it('leaves no staging value behind', async () => {
    await touch('Trip/a.jpg', 8);
    await pgDb('events').insert({ id: 1, external_path: 'Trip' });
    await pgDb('photos').insert({ event_id: 1, external_relpath: 'a.jpg', size_bytes: 8, source_origin: 'external' });

    await fold(pgDb);

    const rows = await relpaths();
    expect(rows).toEqual(['Trip/a.jpg']);
    expect(rows.some((r) => r.includes('staging'))).toBe(false);
  });

  it('folds and marks in one transaction', async () => {
    await touch('Trip/a.jpg', 8);
    await pgDb('events').insert({ id: 1, external_path: 'Trip' });
    await pgDb('photos').insert({ event_id: 1, external_relpath: 'a.jpg', size_bytes: 8, source_origin: 'external' });

    await fold(pgDb);
    // Second run is a no-op: the marker committed with the rewrites.
    await fold(pgDb);

    expect(await relpaths()).toEqual(['Trip/a.jpg']);
  });
});
