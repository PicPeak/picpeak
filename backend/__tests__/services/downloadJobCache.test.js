const knex = require('knex');
const crypto = require('crypto');
const { retireReadyJobs } = require('../../src/services/downloadJobCache');

const engines = [['SQLite', 'sqlite3']];
if (process.env.PICPEAK_PG_TEST_URL) engines.push(['PostgreSQL', 'pg']);

describe.each(engines)('replaceable download cache on %s', (_name, client) => {
  let db, owner, schema, eventId;
  beforeEach(async () => {
    if (client === 'pg') {
      schema = 'download_cache_' + crypto.randomUUID().replace(/-/g, '');
      owner = knex({ client, connection: process.env.PICPEAK_PG_TEST_URL });
      await owner.schema.createSchema(schema);
      db = knex({ client, connection: process.env.PICPEAK_PG_TEST_URL, searchPath: [schema] });
    } else db = knex({ client, connection: { filename: ':memory:' }, useNullAsDefault: true });
    await db.schema.createTable('events', (t) => { t.increments('id'); });
    await db.schema.createTable('download_jobs', (t) => {
      t.increments('id'); t.integer('event_id'); t.string('token'); t.string('status');
      t.timestamp('created_at'); t.timestamp('completed_at'); t.timestamp('expires_at'); t.text('error');
    });
    await db.schema.createTable('download_job_recipients', (t) => {
      t.increments('id'); t.integer('job_id'); t.timestamp('notified_at');
    });
    await db.schema.createTable('email_queue', (t) => {
      t.increments('id'); t.integer('event_id'); t.string('email_type'); t.string('status'); t.json('email_data');
    });
    const [row] = await db('events').insert({}).returning('id');
    eventId = row.id ?? row;
  });
  afterEach(async () => {
    if (db) await db.destroy();
    if (owner) { await owner.schema.dropSchema(schema, true); await owner.destroy(); }
  });
  async function job(offset = 0, gallery = eventId, status = 'ready') {
    const [row] = await db('download_jobs').insert({
      event_id: gallery, token: crypto.randomBytes(32).toString('hex'), status,
      created_at: new Date(Date.now() - 60000 + offset * 1000).toISOString(),
      expires_at: new Date(Date.now() + 3600e3).toISOString(),
    }).returning('*');
    return row;
  }
  const reserve = (needed) => db.transaction(async (trx) => {
    if (client === 'pg') await trx('events').where({ id: eventId }).forUpdate().first();
    return retireReadyJobs(trx, eventId, needed);
  });

  it('retires the oldest ready file only, preserving its original token and retention', async () => {
    const foreign = await job(-10, eventId + 1);
    const first = await job();
    const later = await job(1);
    await job(-20, eventId, 'building');
    expect((await reserve(1)).map((row) => row.id)).toEqual([first.id]);
    expect(await db('download_jobs').where({ id: first.id }).first()).toMatchObject({
      status: 'failed', token: first.token, expires_at: first.expires_at,
    });
    expect((await db('download_jobs').where({ id: later.id }).first()).status).toBe('ready');
    expect((await db('download_jobs').where({ id: foreign.id }).first()).status).toBe('ready');
  });

  it('protects pending recipients and queued JSON mail; a sent notification may be replaced', async () => {
    const waiting = await job(), queued = await job(1), replaceable = await job(2);
    await db('download_job_recipients').insert([{ job_id: waiting.id, notified_at: null },
      { job_id: queued.id, notified_at: new Date().toISOString() }]);
    await db('email_queue').insert({ event_id: eventId, email_type: 'download_ready', status: 'pending',
      email_data: JSON.stringify({ gallery_link: 'https://example.test/?download_job=' + queued.token }) });
    expect((await reserve(1)).map((row) => row.id)).toEqual([replaceable.id]);
    await db('email_queue').update({ status: 'sent' });
    expect((await reserve(1)).map((row) => row.id)).toEqual([queued.id]);
    expect(await db('download_job_recipients').where({ job_id: queued.id })).toHaveLength(1);
    expect((await db('download_jobs').where({ id: waiting.id }).first()).status).toBe('ready');
  });

  it('does not partly retire files when there is insufficient replaceable capacity', async () => {
    const waiting = await job(), other = await job(1);
    await db('download_job_recipients').insert({ job_id: waiting.id });
    expect(await reserve(2)).toBeNull();
    expect((await db('download_jobs').whereIn('id', [waiting.id, other.id])).map((row) => row.status))
      .toEqual(['ready', 'ready']);
  });
});
