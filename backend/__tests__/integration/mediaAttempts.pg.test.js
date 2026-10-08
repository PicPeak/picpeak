const knex = require('knex');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const pgUrl = process.env.PICPEAK_PG_TEST_URL;
const pg = pgUrl && process.platform === 'linux' ? describe : describe.skip;

pg('PostgreSQL media admission and attempt fencing', () => {
  let owner, db, schema, root, attempts, admission, runner, previousStorage, previousHost;
  beforeAll(async () => {
    schema = 'media_attempt_' + crypto.randomUUID().replace(/-/g, '');
    owner = knex({ client: 'pg', connection: pgUrl }); await owner.schema.createSchema(schema);
    db = knex({ client: 'pg', connection: pgUrl, searchPath: [schema], pool: { min: 0, max: 8 } });
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-media-pg-'));
    previousStorage = process.env.STORAGE_PATH; previousHost = process.env.MEDIA_PROCESS_HOST_ID;
    process.env.STORAGE_PATH = root; process.env.MEDIA_PROCESS_HOST_ID = 'owned-media-postgres-host-0001';
    jest.doMock('../../src/database/db', () => ({ db }));
    await db.schema.createTable('photos', table => {
      table.increments('id'); table.integer('event_id'); table.string('path'); table.string('filename');
      table.string('media_type'); table.string('mime_type'); table.string('processing_status');
      table.timestamp('processing_started_at'); table.string('processing_error');
    });
    await require('../../migrations/core/268_image_work_budget').up(db);
    await require('../../migrations/core/273_media_execution_attempts').up(db);
    // Existing-schema/partially upgraded guard contract.
    await require('../../migrations/core/273_media_execution_attempts').up(db);
    attempts = require('../../src/services/mediaAttemptService');
    admission = require('../../src/services/mediaWorkAdmission'); runner = require('../../src/services/nativeProcessRunner');
  });
  afterAll(async () => {
    attempts?.assertDrained(); await runner?.stop(); if (db) await db.destroy();
    if (owner) { await owner.schema.dropSchema(schema, true); await owner.destroy(); }
    if (root) await fs.rm(root, { recursive: true, force: true });
    if (previousStorage === undefined) delete process.env.STORAGE_PATH; else process.env.STORAGE_PATH = previousStorage;
    if (previousHost === undefined) delete process.env.MEDIA_PROCESS_HOST_ID; else process.env.MEDIA_PROCESS_HOST_ID = previousHost;
  });
  beforeEach(async () => {
    runner.start();
    for (const table of ['media_process_attempts', 'media_video_work_reservations', 'image_work_reservations', 'photos']) await db(table).delete();
  });
  async function seed() {
    const [row] = await db('photos').insert({ event_id: 1, path: 'ordinary.mp4', filename: 'ordinary.mp4', media_type: 'video',
      mime_type: 'video/mp4', processing_status: 'pending' }).returning('id');
    const reservation = await admission.reserve(1, { decodedBytes: 2048, work: 1024 }, { bytes: 2048, work: 1024 });
    await db.transaction(async trx => {
      await require('../../src/services/imageWorkAdmission').attach(reservation, row.id, trx); await admission.attach(reservation, row.id, trx);
    });
    return row.id;
  }
  test('concurrent requests serialize aggregate decoded/CPU work', async () => {
    const max = require('../../src/services/mediaProcessPolicy').configuration().maxWork;
    const outcomes = await Promise.allSettled(Array.from({ length: 6 }, () =>
      admission.reserve(1, { decodedBytes: 1024, work: max }, { bytes: 1024, work: max })));
    expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(4);
    expect(outcomes.filter(item => item.status === 'rejected').every(item => item.reason.code === 'MEDIA_RESOURCE_LIMIT')).toBe(true);
    expect(await db('media_video_work_reservations')).toHaveLength(4);
  });
  test('SKIP LOCKED, actual native child registration and finite recovery preserve unique ownership', async () => {
    const id = await seed(), claims = await Promise.all([attempts.claimNext('photo', id), attempts.claimNext('photo', id)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const first = claims.find(Boolean);
    await db('photos').where({ id }).update({ processing_started_at: '2000-01-01T00:00:00Z' });
    expect(await attempts.recover('photo', new Date().toISOString())).toBe(0);
    await attempts.execute(first, 'photo', async attempt => {
      await runner.run('/bin/true', []);
      await db('photos').where({ id }).update({ filename: 'replacement.mp4', processing_status: 'pending', processing_attempt_id: null });
      expect(await attempts.claimNext('photo', id)).toBeNull();
      expect(await attempts.guard(attempt, db, true).update({ processing_status: 'complete' })).toBe(0);
    });
    const record = await db('media_process_attempts').where({ id: first.processing_attempt_id }).first();
    expect(record.state).toBe('terminated'); expect(JSON.parse(record.children_json)).toHaveLength(1);
    expect(JSON.parse(record.children_json)[0].terminated).toBe(true);
    const second = await attempts.claimNext('photo', id); expect(second.processing_attempts).toBe(2);
    expect(second.processing_attempt_id).not.toBe(first.processing_attempt_id);
    await attempts.execute(second, 'photo', async () => {});
    await db('photos').where({ id }).update({ processing_started_at: '2000-01-01T00:00:00Z' });
    expect(await attempts.recover('photo', new Date().toISOString())).toBe(1);
    expect((await db('photos').where({ id }).first()).processing_status).toBe('failed');
    expect(await db('media_video_work_reservations')).toEqual([]);
    await db.transaction(trx => attempts.resetImportedMediaAttempts(trx));
    expect(await db('media_process_attempts')).toEqual([]);
  });
});
