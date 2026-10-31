const knex = require('knex');
const crypto = require('crypto');

const engines = [['SQLite', 'sqlite3']];
if (process.env.PICPEAK_PG_TEST_URL) engines.push(['PostgreSQL', 'pg']);

// Exercise the real createJob/admission/eviction path on both engines. Only
// photo/rendition resolution and the actual ZIP build are outside this test:
// two service instances compete for the same four retained ready archives.
describe.each(engines)('concurrent download-job admission on %s', (_name, client) => {
  let db, owner, schema, JobService, storage;
  const mockedModules = ['database/db', 'services/downloadRendition', 'services/storage',
    'services/folderTreeService', 'utils/downloadResolutions', 'utils/logger'];

  beforeAll(async () => {
    if (client === 'pg') {
      schema = `download_admission_${crypto.randomUUID().replace(/-/g, '')}`;
      owner = knex({ client, connection: process.env.PICPEAK_PG_TEST_URL });
      await owner.schema.createSchema(schema);
      db = knex({ client, connection: process.env.PICPEAK_PG_TEST_URL, searchPath: [schema], pool: { min: 0, max: 6 } });
    } else db = knex({ client, connection: { filename: ':memory:' }, useNullAsDefault: true });
    await db.schema.createTable('events', (table) => { table.increments('id'); table.string('slug'); });
    await db.schema.createTable('photos', (table) => { table.increments('id'); table.integer('event_id'); });
    await require('../../migrations/core/173_add_download_resolutions').up(db);
    await require('../../migrations/core/324_download_job_delivery').up(db);
    await db.schema.createTable('download_job_recipients', (table) => {
      table.increments('id'); table.integer('job_id'); table.timestamp('notified_at');
    });
    await db.schema.createTable('email_queue', (table) => {
      table.increments('id'); table.integer('event_id'); table.string('email_type');
      table.string('status'); table.json('email_data');
    });

    storage = { delete: jest.fn(async () => undefined) };
    jest.resetModules();
    jest.doMock('../../src/database/db', () => ({ db }));
    jest.doMock('../../src/services/downloadRendition', () => ({ resolveWatermarkSettings: async () => null }));
    jest.doMock('../../src/services/storage', () => ({ getStorage: () => storage }));
    jest.doMock('../../src/services/folderTreeService', () => ({ downloadBlockedFolderIds: async () => [] }));
    jest.doMock('../../src/utils/downloadResolutions', () => ({ getDownloadGlobals: async () => ({ job_retention_hours: 1 }) }));
    jest.doMock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    JobService = require('../../src/services/downloadJobService').constructor;
  });

  afterAll(async () => {
    for (const name of mockedModules) jest.dontMock(`../../src/${name}`);
    if (db) await db.destroy();
    if (owner) { await owner.schema.dropSchema(schema, true); await owner.destroy(); }
  });

  it('replaces distinct ready archives through concurrent createJob calls without overbooking', async () => {
    const [event] = await db('events').insert({ slug: 'concurrent-cache' }).returning('*');
    const photos = await db('photos').insert(Array.from({ length: 6 }, () => ({ event_id: event.id }))).returning('id');
    const ready = [];
    for (let i = 0; i < 4; i += 1) {
      const token = crypto.randomBytes(32).toString('hex');
      const [job] = await db('download_jobs').insert({
        event_id: event.id, token, resolution: 'original', photo_ids: JSON.stringify([photos[i].id]),
        dedup_key: crypto.randomBytes(32).toString('hex'), status: 'ready',
        zip_path: `events/active/${event.slug}/.download-cache/job-${token}.zip`,
        created_at: new Date(Date.now() - 60000 + i * 1000).toISOString(),
        expires_at: new Date(Date.now() + 3600e3).toISOString(),
      }).returning('*');
      ready.push(job);
    }
    let finishBuilds;
    const building = new Promise((resolve) => { finishBuilds = resolve; });
    const workers = [new JobService(), new JobService()];
    for (const worker of workers) {
      jest.spyOn(worker, 'photoQuery').mockImplementation((eventId, ids) =>
        db('photos').where({ event_id: eventId }).whereIn('id', ids));
      jest.spyOn(worker, '_build').mockReturnValue(building);
      jest.spyOn(worker, 'isDeliverableToAnyone').mockResolvedValue(true);
    }
    try {
      const admitted = await Promise.all(workers.map((worker, index) => worker.createJob({
        event, resolution: 'original', photoIds: [photos[index + 4].id], accessLevel: 'guest',
      })));
      expect(new Set(admitted.map((job) => job.id)).size).toBe(2);
      expect(admitted.every((job) => job.status === 'pending')).toBe(true);
      expect(await db('download_jobs').where({ event_id: event.id }).whereIn('status', ['pending', 'building', 'ready']))
        .toHaveLength(4);
      const retired = await db('download_jobs').where({ event_id: event.id, status: 'failed' }).orderBy('id');
      expect(retired.map((job) => job.id)).toEqual(ready.slice(0, 2).map((job) => job.id));
      expect(retired.every((job) => job.zip_path === null)).toBe(true);
      expect(new Set(storage.delete.mock.calls.map(([key]) => key)))
        .toEqual(new Set(ready.slice(0, 2).map((job) => job.zip_path)));
    } finally {
      finishBuilds();
      await Promise.all(workers.flatMap((worker) => [...worker.liveBuilds.values()]));
      jest.restoreAllMocks();
    }
  });
});
