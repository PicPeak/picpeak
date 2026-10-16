/**
 * The photo trash on PostgreSQL (issue 1733, migration 294): the guarded
 * statements under real concurrency. Gated on PICPEAK_PG_TEST_URL; runs in a
 * schema of its own and drops it afterwards.
 */
const knex = require('knex');
const crypto = require('crypto');

const pgUrl = process.env.PICPEAK_PG_TEST_URL;
const pg = pgUrl ? describe : describe.skip;

pg('PostgreSQL photo trash', () => {
  let owner; let db; let schema; let photoTrash;
  const mockDeleted = [];
  const event = { id: 1, slug: 'pg-trash', photo_cap: null };
  const past = () => new Date(Date.now() - 60000).toISOString();

  beforeAll(async () => {
    schema = `photo_trash_${crypto.randomUUID().replace(/-/g, '')}`;
    owner = knex({ client: 'pg', connection: pgUrl });
    await owner.schema.createSchema(schema);
    db = knex({ client: 'pg', connection: pgUrl, searchPath: [schema], pool: { min: 0, max: 12 } });
    jest.doMock('../../src/database/db', () => ({ db }));
    // The hard delete's file and face steps are not what is under test.
    jest.doMock('../../src/services/storage', () => ({
      getStorage: () => ({ delete: async (key) => { mockDeleted.push(key); } }),
    }));
    jest.doMock('../../src/services/imageProcessor', () => ({ deletePreviewTiers: async () => {}, deleteThumbnailTiers: async () => {} }));
    jest.doMock('../../src/services/faceProcessor', () => ({ purgePhotoFaces: async () => {} }));
    jest.doMock('../../src/services/externalImportService', () => ({ recordExclusions: async () => {} }));

    await db.schema.createTable('events', (table) => {
      table.increments('id'); table.string('slug'); table.integer('photo_cap'); table.string('source_mode');
      // Read by the hard delete's event lock (heroPhotoLock, issue 2108).
      table.integer('hero_photo_id');
    });
    await db.schema.createTable('admin_users', (table) => { table.increments('id'); table.string('username'); });
    await db.schema.createTable('photos', (table) => {
      table.increments('id'); table.integer('event_id'); table.string('path'); table.string('filename');
      table.string('media_type'); table.bigInteger('size_bytes'); table.string('thumbnail_path'); table.string('hero_path');
      table.string('preview_path'); table.string('web_path'); table.string('watermark_path'); table.string('source_origin');
      table.string('external_relpath'); table.string('moderation_status');
      table.string('hls_status'); table.string('hls_path');
    });
    await db.schema.createTable('photo_tags', (table) => { table.increments('id'); table.integer('photo_id'); table.string('tag'); });
    await db('events').insert({ id: event.id, slug: event.slug });

    const migration = require('../../migrations/core/294_photo_trash');
    await migration.up(db);
    // Safe to re-run.
    await migration.up(db);
    photoTrash = require('../../src/services/photoTrash');
  });

  afterAll(async () => {
    if (db) await db.destroy();
    if (owner) { await owner.schema.dropSchema(schema, true); await owner.destroy(); }
  });

  beforeEach(async () => { await db('photos').delete(); mockDeleted.length = 0; });

  async function seed(n = 1) {
    const rows = Array.from({ length: n }, () => {
      const filename = `${crypto.randomUUID()}.jpg`;
      return { event_id: event.id, filename, path: `${event.slug}/${filename}`, media_type: 'image', size_bytes: 10 };
    });
    return (await db('photos').insert(rows).returning(['id', 'event_id', 'filename', 'path']));
  }
  const originalsDeleted = (photo) => mockDeleted.filter((key) => key === `events/active/${photo.path}`).length;

  test('the migration adds the columns and both indexes, twice over', async () => {
    for (const column of ['deleted_at', 'purge_after', 'deleted_by_admin_id']) {
      expect(await db.schema.hasColumn('photos', column)).toBe(true);
    }
    const indexes = (await db.raw('select indexname from pg_indexes where schemaname = ? and tablename = ?', [schema, 'photos']))
      .rows.map((r) => r.indexname);
    expect(indexes).toEqual(expect.arrayContaining(['idx_photos_event_deleted_at', 'idx_photos_trash_purge_after']));
  });

  test('trash and restore are one row each, and timestamps come back as the instants written', async () => {
    const [photo] = await seed();
    const at = Date.now();
    expect(await photoTrash.trashPhoto(photo, null, 30, at)).toBe(true);
    expect(await photoTrash.trashPhoto(photo, null, 30, at)).toBe(false);
    const [listed] = await photoTrash.listTrash(event.id);
    expect(listed).toMatchObject({ id: photo.id, deleted_at: new Date(at).toISOString(), size_bytes: 10 });
    expect(Date.parse(listed.purge_after) - at).toBe(30 * 86400000);
    expect(await photoTrash.restorePhotos(event, [photo.id])).toEqual({ restored: [photo.id], failed: [] });
    expect(await photoTrash.restorePhotos(event, [photo.id])).toEqual({ restored: [], failed: [{ id: photo.id, code: 'NOT_IN_TRASH' }] });
  });

  test('concurrent trashing of one photo: one request wins', async () => {
    const [photo] = await seed();
    const results = await Promise.all(Array.from({ length: 8 }, () => photoTrash.trashPhoto(photo, null, 30)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test('a restore racing a purge: the photo is either back whole or deleted once', async () => {
    const photos = await seed(20);
    for (const photo of photos) await photoTrash.trashPhoto(photo, null, 30);
    const outcomes = await Promise.all(photos.map(async (photo, i) => {
      const calls = [photoTrash.restorePhotos(event, [photo.id]), photoTrash.purgePhoto(event, photo)];
      const [restored, purged] = await Promise.all(i % 2 ? calls : [calls[1], calls[0]]).then((r) => (i % 2 ? r : [r[1], r[0]]));
      return { photo, restored: restored.restored.length === 1, purged };
    }));
    for (const { photo, restored, purged } of outcomes) {
      expect(restored).not.toBe(purged);
      const row = await db('photos').where({ id: photo.id }).first();
      if (restored) {
        expect(row).toMatchObject({ deleted_at: null, purge_after: null });
        expect(originalsDeleted(photo)).toBe(0);
      } else {
        expect(row).toBeUndefined();
        expect(originalsDeleted(photo)).toBe(1);
      }
    }
  });

  test('concurrent sweeps purge each due photo once and leave the rest', async () => {
    const due = await seed(30);
    const [fresh] = await seed();
    for (const photo of [...due, fresh]) await photoTrash.trashPhoto(photo, null, 30);
    await db('photos').whereIn('id', due.map((p) => p.id)).update({ purge_after: past() });

    const counts = await Promise.all([photoTrash.purgeExpired(), photoTrash.purgeExpired(), photoTrash.purgeExpired()]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(30);
    for (const photo of due) expect(originalsDeleted(photo)).toBe(1);
    expect(originalsDeleted(fresh)).toBe(0);
    expect((await db('photos').select('id')).map((r) => r.id)).toEqual([fresh.id]);
  });

  test('a purge claim left by a crash is taken over by exactly one sweep, a fresh one by none', async () => {
    const [crashed, running] = await seed(2);
    for (const photo of [crashed, running]) await photoTrash.trashPhoto(photo, null, 30);
    await db('photos').where({ id: crashed.id }).update({ purge_after: null, deleted_at: new Date(Date.now() - 3600000).toISOString() });
    await db('photos').where({ id: running.id }).update({ purge_after: null, deleted_at: new Date().toISOString() });

    const counts = await Promise.all([photoTrash.purgeExpired(), photoTrash.purgeExpired()]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(originalsDeleted(crashed)).toBe(1);
    expect((await db('photos').select('id')).map((r) => r.id)).toEqual([running.id]);
    expect(await photoTrash.restorePhotos(event, [running.id])).toEqual({ restored: [], failed: [{ id: running.id, code: 'NOT_IN_TRASH' }] });
  });

  test('restores and the cap: concurrent restores never pass it together', async () => {
    const capped = { ...event, photo_cap: 3 };
    const photos = await seed(6);
    for (const photo of photos) await photoTrash.trashPhoto(photo, null, 30);
    const results = await Promise.all(photos.map((photo) => photoTrash.restorePhotos(capped, [photo.id])));
    expect(results.filter((r) => r.restored.length === 1)).toHaveLength(3);
    expect(results.filter((r) => r.failed[0]?.code === 'PHOTO_CAP_REACHED')).toHaveLength(3);
    expect(Number((await db('photos').whereNull('deleted_at').count('id as c').first()).c)).toBe(3);
  });
});
