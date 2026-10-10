const knex = require('knex');
const crypto = require('crypto');
const pgUrl = process.env.PICPEAK_PG_TEST_URL;
const pg = pgUrl ? describe : describe.skip;

pg('PostgreSQL media attempt fencing', () => {
  let owner, db, schema, attempts, capabilities;
  const ago = ms => new Date(Date.now() - ms).toISOString();
  beforeAll(async () => {
    schema = 'media_attempt_' + crypto.randomUUID().replace(/-/g, '');
    owner = knex({ client: 'pg', connection: pgUrl }); await owner.schema.createSchema(schema);
    db = knex({ client: 'pg', connection: pgUrl, searchPath: [schema], pool: { min: 0, max: 8 } });
    jest.doMock('../../src/database/db', () => ({ db }));
    await db.schema.createTable('photos', table => {
      table.increments('id'); table.integer('event_id'); table.string('path'); table.string('filename');
      table.string('media_type'); table.string('mime_type'); table.string('processing_status');
      table.timestamp('processing_started_at'); table.string('processing_error');
    });
    await require('../../migrations/core/247_image_work_budget').up(db);
    await require('../../migrations/core/248_media_execution_attempts').up(db);
    // Existing-schema/partially upgraded guard contract.
    await require('../../migrations/core/248_media_execution_attempts').up(db);
    attempts = require('../../src/services/mediaAttemptService');
    capabilities = require('../../src/services/mediaCapabilities');
    capabilities.set({ guard: false, leases: false });
  });
  afterAll(async () => {
    attempts?.assertDrained(); capabilities?.set(null); if (db) await db.destroy();
    if (owner) { await owner.schema.dropSchema(schema, true); await owner.destroy(); }
  });
  beforeEach(async () => { for (const table of ['media_process_attempts', 'photos']) await db(table).delete(); });
  async function seed() {
    const [row] = await db('photos').insert({ event_id: 1, path: 'ordinary.mp4', filename: 'ordinary.mp4', media_type: 'video',
      mime_type: 'video/mp4', processing_status: 'pending' }).returning('id');
    return row.id;
  }
  test('the migration knows none of the tables the layer below removed', async () => {
    for (const table of ['image_work_lock', 'image_work_reservations', 'media_video_work_reservations']) expect(await db.schema.hasTable(table)).toBe(false);
    expect(await db.schema.hasColumn('photos', 'processing_attempt_id')).toBe(true);
    // No web-rendition feature in this schema: its columns are not invented.
    expect(await db.schema.hasColumn('photos', 'web_attempt_id')).toBe(false);
  });
  test('SKIP LOCKED: concurrent workers each get a different row, and one row is never claimed twice', async () => {
    const ids = [await seed(), await seed(), await seed()];
    const same = await Promise.all([attempts.claimNext('photo', ids[0]), attempts.claimNext('photo', ids[0])]);
    expect(same.filter(Boolean)).toHaveLength(1);
    const others = await Promise.all([attempts.claimNext('photo'), attempts.claimNext('photo'), attempts.claimNext('photo')]);
    expect(others.filter(Boolean).map(row => row.id).sort()).toEqual(ids.slice(1));
    for (const claimed of [...same, ...others].filter(Boolean)) await attempts.execute(claimed, 'photo', async () => {});
    expect(await db('media_process_attempts')).toEqual([]);
  });
  test('fenced writes, recovery by age and by stopped heartbeat, and the attempt limit', async () => {
    const id = await seed(), first = await attempts.claimNext('photo', id);
    await db('photos').where({ id }).update({ processing_started_at: '2000-01-01T00:00:00Z' });
    // Its worker (this process) is alive: age alone does not take the row away.
    expect(await attempts.recover('photo', new Date().toISOString())).toBe(0);
    await attempts.execute(first, 'photo', async attempt => {
      await db('photos').where({ id }).update({ filename: 'replacement.mp4', processing_status: 'pending', processing_attempt_id: null });
      expect(await attempts.claimNext('photo', id)).toBeNull();
      expect(await attempts.guard(attempt, db, true).update({ processing_status: 'complete' })).toBe(0);
    });
    const second = await attempts.claimNext('photo', id);
    expect(second.processing_attempts).toBe(2);
    expect(second.processing_attempt_id).not.toBe(first.processing_attempt_id);
    await attempts.execute(second, 'photo', async () => {});
    // Left in 'processing' by a worker that died: no record any more, old enough.
    await db('photos').where({ id }).update({ processing_started_at: '2000-01-01T00:00:00Z' });
    expect(await attempts.recover('photo', new Date().toISOString())).toBe(1);
    // A record from an unknown host with a stopped heartbeat (timestamps come back as Date here).
    const stuck = await seed();
    await db('photos').where({ id: stuck }).update({ processing_status: 'processing', processing_attempt_id: 'a0000000-0000-4000-8000-000000000001', processing_started_at: ago(1000) });
    await db('media_process_attempts').insert({ id: 'a0000000-0000-4000-8000-000000000001', photo_id: stuck, kind: 'photo', owner_json: '{}', children_json: '[]',
      lease_path: '', lease_device: '', lease_inode: '', lease_filesystem: '', state: 'active', heartbeat_at: ago(attempts.HEARTBEAT_STALE_MS + 60000), created_at: ago(600000) });
    expect(await attempts.recover('photo', ago(600000))).toBe(1);
    await db('photos').where({ id }).update({ processing_attempts: attempts.MAX_ATTEMPTS });
    expect(await attempts.claimNext('photo', id)).toEqual({ exhausted: id });
    expect((await db('photos').where({ id }).first()).processing_status).toBe('failed');
    await db.transaction(trx => attempts.resetImportedMediaAttempts(trx));
    expect(await db('media_process_attempts')).toEqual([]);
  });
});
