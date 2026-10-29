/**
 * Content-hash backfill (issue 2194), managed storage.
 *
 * Pins the contract:
 *  - migration 338 seeds the job row and adds the error and pause columns
 *  - only rows without a hash are read, videos included, through the
 *    storage backend
 *  - a pause stops the run before the next file, and a later start resumes
 *    with the rest, never reading a finished original again
 *  - a run that died mid-way is taken over by the next start the same way
 *  - an unreadable original is recorded and skipped, and not tried again
 *    until the admin asks for a retry
 *  - nothing starts by itself; the routes start, pause and report
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const { bootCrmDb } = require('./helpers/crmDb');

jest.mock('../../src/middleware/auth', () => ({
  adminAuth: (req, _res, next) => { req.admin = { id: 1, username: 'tester', roleName: 'super_admin' }; next(); },
}));
jest.mock('../../src/middleware/permissions', () => ({
  ...jest.requireActual('../../src/middleware/permissions'),
  requirePermission: () => (_req, _res, next) => next(),
}));

const JOB = 'photo_content_hash_backfill';
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

describe('content-hash backfill (issue 2194)', () => {
  let db; let cleanup; let app; let backfill; let maintenanceJobs; let storage;
  let counter = 0;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    backfill = require('../../src/services/contentHashBackfill');
    maintenanceJobs = require('../../src/services/maintenanceJobState');
    storage = require('../../src/services/storage').getStorage();
    app = express();
    app.use(express.json());
    app.use('/api/admin/photos', require('../../src/routes/adminPhotoDimensions'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  afterEach(async () => {
    jest.restoreAllMocks();
    await db('photos').del();
    await db('maintenance_jobs').where({ job_name: JOB })
      .update({ is_running: false, claim_token: null, pause_requested: false, last_result: null });
  });

  async function makeEvent() {
    counter += 1;
    const slug = `content-hash-${counter}`;
    const inserted = await db('events').insert({
      slug, event_type: 'wedding', event_name: `Content Hash ${counter}`, event_date: '2026-08-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `/gallery/${slug}/share`, share_token: `content-hash-share-${counter}`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_at: new Date().toISOString(),
    }).returning('id');
    return db('events').where({ id: inserted[0]?.id ?? inserted[0] }).first();
  }

  // A row as the watcher or a pre-290 upload left it: a file in storage, no hash.
  async function addPhoto(event, bytes, fields = {}) {
    counter += 1;
    const filename = `p-${counter}.${fields.media_type === 'video' ? 'mp4' : 'jpg'}`;
    const dir = path.join(process.env.STORAGE_PATH, 'events', 'active', event.slug);
    await fs.promises.mkdir(dir, { recursive: true });
    if (bytes !== null) await fs.promises.writeFile(path.join(dir, filename), bytes);
    const r = await db('photos').insert({
      event_id: event.id, filename, path: `${event.slug}/${filename}`, type: 'individual',
      media_type: 'image', mime_type: 'image/jpeg', size_bytes: bytes ? bytes.length : 0,
      uploaded_at: new Date().toISOString(), source_origin: 'managed', ...fields,
    }).returning('id');
    const id = r[0]?.id ?? r[0];
    return { id, key: `events/active/${event.slug}/${filename}`, full: path.join(dir, filename) };
  }

  const row = (id) => db('photos').where({ id }).first();

  async function startAndRun(opts) {
    const started = await backfill.start(opts);
    expect(started).not.toBeNull();
    if (started.run) await started.run();
    return started;
  }

  it('seeds the job row and the columns it needs (migration 338)', async () => {
    expect(await db('maintenance_jobs').where({ job_name: JOB }).first()).toBeTruthy();
    expect(await db.schema.hasColumn('photos', 'content_sha256_error')).toBe(true);
    expect(await db.schema.hasColumn('maintenance_jobs', 'pause_requested')).toBe(true);
    // Re-runs.
    await require('../../migrations/core/338_content_hash_backfill').up(db);
  });

  it('reads only the originals without a hash, videos included, through storage', async () => {
    const event = await makeEvent();
    const image = Buffer.from('image bytes one');
    const video = Buffer.from('video bytes, streamed like any original');
    const a = await addPhoto(event, image);
    const done = await addPhoto(event, Buffer.from('already hashed'), { content_sha256: 'f'.repeat(64) });
    const v = await addPhoto(event, video, { media_type: 'video', mime_type: 'video/mp4', type: 'video' });
    const get = jest.spyOn(storage, 'get');

    const started = await startAndRun();
    expect(started.count).toBe(2);

    expect((await row(a.id)).content_sha256).toBe(sha(image));
    expect((await row(v.id)).content_sha256).toBe(sha(video));
    expect((await row(done.id)).content_sha256).toBe('f'.repeat(64));
    expect(get.mock.calls.map((c) => c[0]).sort()).toEqual([a.key, v.key].sort());
    const state = await backfill.status();
    expect(state).toMatchObject({ hashed: 3, pending: 0, unreadable: 0, isRunning: false });
    expect(state.lastResult).toMatchObject({ hashed: 2, failed: 0, paused: false });
  });

  it('pauses before the next file, and a later start resumes without reading finished rows', async () => {
    const event = await makeEvent();
    const first = Buffer.from('first original');
    const p1 = await addPhoto(event, first);
    const p2 = await addPhoto(event, Buffer.from('second original'));
    const p3 = await addPhoto(event, Buffer.from('third original'));

    // The pause button, pressed while the first file is being read.
    const realGet = storage.get.bind(storage);
    const get = jest.spyOn(storage, 'get').mockImplementationOnce(async (key) => {
      expect(await maintenanceJobs.requestPause(JOB)).toBe(true);
      expect((await backfill.status()).pausing).toBe(true);
      return realGet(key);
    });

    await startAndRun();
    expect(get).toHaveBeenCalledTimes(1);
    expect((await row(p1.id)).content_sha256).toBe(sha(first));
    expect((await row(p2.id)).content_sha256).toBeNull();
    expect((await row(p3.id)).content_sha256).toBeNull();
    const paused = await backfill.status();
    expect(paused).toMatchObject({ isRunning: false, paused: true, pending: 2, hashed: 1 });
    expect(paused.lastResult).toMatchObject({ hashed: 1, paused: true });

    // Resume. The finished original's bytes change on disk: a re-read would
    // show in its hash.
    await fs.promises.writeFile(p1.full, 'edited after it was hashed');
    get.mockClear();
    const resumed = await startAndRun();
    expect(resumed.count).toBe(2);
    expect(get.mock.calls.map((c) => c[0])).toEqual([p2.key, p3.key]);
    expect((await row(p1.id)).content_sha256).toBe(sha(first));
    expect((await row(p2.id)).content_sha256).toBe(sha(Buffer.from('second original')));
    expect((await row(p3.id)).content_sha256).toBe(sha(Buffer.from('third original')));
    expect((await backfill.status()).paused).toBe(false);
  });

  it('a run that died mid-way leaves the rest for the next start, finished rows untouched', async () => {
    const event = await makeEvent();
    const first = Buffer.from('read before the crash');
    const p1 = await addPhoto(event, first);
    const p2 = await addPhoto(event, Buffer.from('never reached'));

    // The process dies after the first file: the claim is never released.
    const token = await maintenanceJobs.claim(JOB);
    let reads = 0;
    const get = jest.spyOn(storage, 'get').mockImplementation(async (key) => { reads += 1; return fs.createReadStream(path.join(process.env.STORAGE_PATH, key)); });
    await backfill.__test.run(token, { lost: () => reads >= 1, stop: () => {} });
    expect((await row(p1.id)).content_sha256).toBe(sha(first));
    expect((await row(p2.id)).content_sha256).toBeNull();

    // After the restart its lease has gone stale.
    await db('maintenance_jobs').where({ job_name: JOB })
      .update({ heartbeat_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
    await fs.promises.writeFile(p1.full, 'edited after it was hashed');
    get.mockClear();
    const resumed = await startAndRun();
    expect(resumed.count).toBe(1);
    expect(get.mock.calls.map((c) => c[0])).toEqual([p2.key]);
    expect((await row(p1.id)).content_sha256).toBe(sha(first));
    expect((await row(p2.id)).content_sha256).toBe(sha(Buffer.from('never reached')));
  });

  it('a pause request a dead runner never read does not stop the next run', async () => {
    const event = await makeEvent();
    const p = await addPhoto(event, Buffer.from('bytes'));
    await db('maintenance_jobs').where({ job_name: JOB }).update({ pause_requested: true });
    await startAndRun();
    expect((await row(p.id)).content_sha256).toBe(sha(Buffer.from('bytes')));
  });

  it('a pause asked for right after the claim is honoured, not cleared by the start', async () => {
    const event = await makeEvent();
    const p = await addPhoto(event, Buffer.from('bytes'));
    // Another replica presses pause the moment this start holds the job.
    const realClaim = maintenanceJobs.claim.bind(maintenanceJobs);
    jest.spyOn(maintenanceJobs, 'claim').mockImplementationOnce(async (...args) => {
      const token = await realClaim(...args);
      expect(await maintenanceJobs.requestPause(JOB)).toBe(true);
      return token;
    });
    await startAndRun();
    expect((await row(p.id)).content_sha256).toBeNull();
    expect((await backfill.status()).paused).toBe(true);
  });

  it('a pause left by a runner that crashed does not stop the run that takes over', async () => {
    const event = await makeEvent();
    const p = await addPhoto(event, Buffer.from('bytes'));
    // Paused, then the process died before it read the request or released.
    await maintenanceJobs.claim(JOB);
    expect(await maintenanceJobs.requestPause(JOB)).toBe(true);
    await db('maintenance_jobs').where({ job_name: JOB })
      .update({ heartbeat_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
    await startAndRun();
    expect((await row(p.id)).content_sha256).toBe(sha(Buffer.from('bytes')));
  });

  it('a runner whose claim was taken over mid-read writes nothing', async () => {
    const event = await makeEvent();
    const p = await addPhoto(event, Buffer.from('read by the old runner'));
    const token = await maintenanceJobs.claim(JOB);
    // While the old runner reads, its lease goes stale and another start takes over.
    jest.spyOn(storage, 'get').mockImplementationOnce(async (key) => {
      await db('maintenance_jobs').where({ job_name: JOB }).update({ claim_token: 'taken-over' });
      return fs.createReadStream(path.join(process.env.STORAGE_PATH, key));
    });
    await backfill.__test.run(token, { lost: () => false, stop: () => {} });
    expect((await row(p.id)).content_sha256).toBeNull();
  });

  it('records an unreadable original, skips it, and only tries it again on a retry', async () => {
    const event = await makeEvent();
    const missing = await addPhoto(event, null);
    const good = await addPhoto(event, Buffer.from('readable'));

    await startAndRun();
    const failed = await row(missing.id);
    expect(failed.content_sha256).toBeNull();
    expect(failed.content_sha256_error).toMatch(/ENOENT|no such file/i);
    expect((await row(good.id)).content_sha256).toBe(sha(Buffer.from('readable')));
    const state = await backfill.status();
    expect(state).toMatchObject({ unreadable: 1, pending: 0 });
    expect(state.lastResult).toMatchObject({ hashed: 1, failed: 1 });

    // A plain start does not loop on it.
    const again = await backfill.start();
    expect(again).toMatchObject({ count: 0, run: null });

    // The file is back; the retry reads it.
    await fs.promises.writeFile(missing.full, 'restored');
    const retried = await startAndRun({ retryUnreadable: true });
    expect(retried.count).toBe(1);
    const fixed = await row(missing.id);
    expect(fixed.content_sha256).toBe(sha(Buffer.from('restored')));
    expect(fixed.content_sha256_error).toBeNull();
  });

  it('starts, pauses and reports through the admin routes', async () => {
    const event = await makeEvent();
    const p = await addPhoto(event, Buffer.from('via the route'));

    // Nothing running: nothing to pause.
    expect((await request(app).post('/api/admin/photos/repair-content-hashes/pause')).status).toBe(409);
    const before = await request(app).get('/api/admin/photos/repair-content-hashes/status');
    expect(before.body).toMatchObject({ pending: 1, hashed: 0, isRunning: false, paused: false });
    // Nothing started by itself.
    expect((await row(p.id)).content_sha256).toBeNull();

    const res = await request(app).post('/api/admin/photos/repair-content-hashes').send({});
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    const deadline = Date.now() + 15000;
    let state;
    do {
      // eslint-disable-next-line no-await-in-loop
      state = (await request(app).get('/api/admin/photos/repair-content-hashes/status')).body;
      if (!state.isRunning && state.hashed === 1) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 50));
    } while (Date.now() < deadline);
    expect(state).toMatchObject({ hashed: 1, pending: 0, isRunning: false });
    expect((await row(p.id)).content_sha256).toBe(sha(Buffer.from('via the route')));
  });
});
