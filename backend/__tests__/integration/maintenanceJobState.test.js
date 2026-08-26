/**
 * Shared run state for the maintenance sweeps (#1181).
 *
 * The behaviour that matters here cannot be observed from one process holding
 * a module-level flag, which is exactly why the flag moved into the database.
 * A second replica is simulated the only way that is honest in a single-process
 * test: by asserting on the shared row itself, and by driving claim() twice —
 * a second caller getting null is precisely what a second replica gets.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const request = require('supertest');

describe('maintenance job state (#1181)', () => {
  let tmpDir; let db; let app; let jobs;

  const dimStatus = () => request(app).get('/api/admin/photos/repair-dimensions/status');
  const capStatus = () => request(app).get('/api/admin/photos/repair-capture-dates/status');

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-mjs-'));
    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'data', 'db.sqlite');
    await fs.promises.mkdir(path.dirname(process.env.TEST_DATABASE_PATH), { recursive: true });
    process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'mjs-secret';

    jest.resetModules();
    jest.doMock('../../src/middleware/auth', () => ({
      adminAuth: (req, _res, next) => { req.admin = { id: 1, username: 'tester', roleName: 'admin' }; next(); },
    }));
    jest.doMock('../../src/middleware/permissions', () => ({
      requirePermission: () => (_req, _res, next) => next(),
    }));
    jest.doMock('../../src/utils/logger', () => ({
      debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    }));

    ({ db } = await require('./helpers/crmDb').bootCrmDb());
    jobs = require('../../src/services/maintenanceJobState');

    app = express();
    app.use(express.json());
    app.use('/api/admin/photos', require('../../src/routes/adminPhotoDimensions'));
  }, 180000);

  afterAll(async () => {
    if (db) await db.destroy?.();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    await db('maintenance_jobs').update({
      is_running: false, started_at: null, heartbeat_at: null, finished_at: null, last_result: null, owner: null, claim_token: null,
    });
  });

  test('the lease table is kept out of .picpeak archives', () => {
    // It is live state, not data. An archive taken mid-sweep would otherwise
    // carry is_running = true and a claim token owned by a process on the
    // SOURCE install; restored inside the staleness window, the target reports
    // the job as running and refuses new POSTs with no runner to release it.
    // The importer filters on this same set, so archives written before the
    // exclusion are skipped on restore too.
    const { EXCLUDED_TABLES } = require('../../src/services/picpeakExportService');
    expect(EXCLUDED_TABLES.has('maintenance_jobs')).toBe(true);
  });

  test('the migration seeds a row for each job', async () => {
    const names = await db('maintenance_jobs').pluck('job_name');
    expect(names.sort()).toEqual(['photo_capture_date_backfill', 'photo_dimension_repair']);
  });

  test('a second claim is refused while the first is alive', async () => {
    expect(await jobs.claim(jobs.JOB_DIMENSION_REPAIR)).toEqual(expect.any(String));
    // What a second replica's POST does. Nothing about the first claim lives in
    // this process, so this is the same question the other replica asks.
    expect(await jobs.claim(jobs.JOB_DIMENSION_REPAIR)).toBeNull();
  });

  test('the two jobs claim independently', async () => {
    expect(await jobs.claim(jobs.JOB_DIMENSION_REPAIR)).toEqual(expect.any(String));
    expect(await jobs.claim(jobs.JOB_CAPTURE_DATE_BACKFILL)).toEqual(expect.any(String));
  });

  test('each claim gets a distinct token', async () => {
    const first = await jobs.claim(jobs.JOB_DIMENSION_REPAIR);
    await jobs.release(jobs.JOB_DIMENSION_REPAIR, first);
    const second = await jobs.claim(jobs.JOB_DIMENSION_REPAIR);
    // Same process, same pid — so an owner string would have collided here and
    // the fencing below would be worthless.
    expect(second).not.toBe(first);
  });

  test('a claim whose heartbeat has gone quiet can be taken over', async () => {
    expect(await jobs.claim(jobs.JOB_DIMENSION_REPAIR)).toEqual(expect.any(String));
    expect(await jobs.claim(jobs.JOB_DIMENSION_REPAIR)).toBeNull();

    // The replica holding it was killed: no release, no further heartbeats.
    const longAgo = new Date(Date.now() - jobs.DEFAULT_STALE_MS - 60000).toISOString();
    await db('maintenance_jobs').where({ job_name: jobs.JOB_DIMENSION_REPAIR }).update({ heartbeat_at: longAgo });

    expect(await jobs.claim(jobs.JOB_DIMENSION_REPAIR)).toEqual(expect.any(String));
  });

  test('a superseded runner cannot renew its lease', async () => {
    const oldToken = await jobs.claim(jobs.JOB_DIMENSION_REPAIR);
    const longAgo = new Date(Date.now() - jobs.DEFAULT_STALE_MS - 60000).toISOString();
    await db('maintenance_jobs').where({ job_name: jobs.JOB_DIMENSION_REPAIR }).update({ heartbeat_at: longAgo });
    const newToken = await jobs.claim(jobs.JOB_DIMENSION_REPAIR);
    expect(newToken).toEqual(expect.any(String));

    // The old runner is still alive and mid-loop. Its renewal must tell it so,
    // which is what makes the route loop stop instead of running alongside the
    // new owner.
    expect(await jobs.heartbeat(jobs.JOB_DIMENSION_REPAIR, oldToken)).toBe(false);
    expect(await jobs.heartbeat(jobs.JOB_DIMENSION_REPAIR, newToken)).toBe(true);
  });

  test('a superseded runner cannot release the new owner\'s claim', async () => {
    const oldToken = await jobs.claim(jobs.JOB_CAPTURE_DATE_BACKFILL);
    const longAgo = new Date(Date.now() - jobs.DEFAULT_STALE_MS - 60000).toISOString();
    await db('maintenance_jobs').where({ job_name: jobs.JOB_CAPTURE_DATE_BACKFILL }).update({ heartbeat_at: longAgo });
    const newToken = await jobs.claim(jobs.JOB_CAPTURE_DATE_BACKFILL);

    // The old runner finishes late and tries to write its result. Unfenced,
    // this cleared is_running under the new owner and let a THIRD sweep start.
    expect(await jobs.release(jobs.JOB_CAPTURE_DATE_BACKFILL, oldToken, { success: 999, noExif: 0, failed: 0 })).toBe(false);

    const state = await jobs.read(jobs.JOB_CAPTURE_DATE_BACKFILL);
    expect(state.isRunning).toBe(true);
    expect(state.lastResult).toBeNull();
    // And the row is still the new owner's to release.
    expect(await jobs.release(jobs.JOB_CAPTURE_DATE_BACKFILL, newToken, { success: 1, noExif: 0, failed: 0 })).toBe(true);
  });

  test('a stale run reads as not running, so the button comes back', async () => {
    await jobs.claim(jobs.JOB_DIMENSION_REPAIR);
    expect((await jobs.read(jobs.JOB_DIMENSION_REPAIR)).isRunning).toBe(true);

    const longAgo = new Date(Date.now() - jobs.DEFAULT_STALE_MS - 60000).toISOString();
    await db('maintenance_jobs').where({ job_name: jobs.JOB_DIMENSION_REPAIR }).update({ heartbeat_at: longAgo });

    // is_running is still true in the row — nothing released it — but a status
    // poll must not leave the operator staring at a job that cannot finish.
    expect((await db('maintenance_jobs').where({ job_name: jobs.JOB_DIMENSION_REPAIR }).first()).is_running).toBeTruthy();
    expect((await jobs.read(jobs.JOB_DIMENSION_REPAIR)).isRunning).toBe(false);
  });

  test('a heartbeat keeps a long run claimed', async () => {
    const token = await jobs.claim(jobs.JOB_DIMENSION_REPAIR);
    const longAgo = new Date(Date.now() - jobs.DEFAULT_STALE_MS - 60000).toISOString();
    await db('maintenance_jobs').where({ job_name: jobs.JOB_DIMENSION_REPAIR }).update({ heartbeat_at: longAgo });

    expect(await jobs.heartbeat(jobs.JOB_DIMENSION_REPAIR, token)).toBe(true);

    expect(await jobs.claim(jobs.JOB_DIMENSION_REPAIR)).toBeNull();
    expect((await jobs.read(jobs.JOB_DIMENSION_REPAIR)).isRunning).toBe(true);
  });

  test('release stores the result and read gives it back parsed', async () => {
    const token = await jobs.claim(jobs.JOB_CAPTURE_DATE_BACKFILL);
    await jobs.release(jobs.JOB_CAPTURE_DATE_BACKFILL, token, { success: 3, noExif: 2, failed: 1 });

    const state = await jobs.read(jobs.JOB_CAPTURE_DATE_BACKFILL);
    expect(state.isRunning).toBe(false);
    expect(state.lastResult).toEqual({ success: 3, noExif: 2, failed: 1 });
  });

  test('releasing without a result keeps the previous run visible', async () => {
    const first = await jobs.claim(jobs.JOB_CAPTURE_DATE_BACKFILL);
    await jobs.release(jobs.JOB_CAPTURE_DATE_BACKFILL, first, { success: 7, noExif: 0, failed: 0 });

    // The "nothing to do" path: claimed, found no candidates, released. It must
    // not blank the numbers the last real run reported.
    const second = await jobs.claim(jobs.JOB_CAPTURE_DATE_BACKFILL);
    await jobs.release(jobs.JOB_CAPTURE_DATE_BACKFILL, second);

    expect((await jobs.read(jobs.JOB_CAPTURE_DATE_BACKFILL)).lastResult).toEqual({ success: 7, noExif: 0, failed: 0 });
  });

  test('a malformed result does not take the status endpoint down', async () => {
    await db('maintenance_jobs').where({ job_name: jobs.JOB_DIMENSION_REPAIR }).update({ last_result: 'not json' });
    const state = await jobs.read(jobs.JOB_DIMENSION_REPAIR);
    expect(state.lastResult).toBeNull();
    expect(state.isRunning).toBe(false);
  });

  test('both status endpoints report the shared row, not process memory', async () => {
    await jobs.claim(jobs.JOB_DIMENSION_REPAIR);
    const capToken = await jobs.claim(jobs.JOB_CAPTURE_DATE_BACKFILL);
    await jobs.release(jobs.JOB_CAPTURE_DATE_BACKFILL, capToken, { success: 1, noExif: 0, failed: 0 });

    // Written straight to the row, exactly as another replica would have.
    const dim = await dimStatus();
    expect(dim.status).toBe(200);
    expect(dim.body.isRunning).toBe(true);

    const cap = await capStatus();
    expect(cap.status).toBe(200);
    expect(cap.body.isRunning).toBe(false);
    expect(cap.body.lastResult).toEqual({ success: 1, noExif: 0, failed: 0 });
  });

  test('a POST is refused while another replica holds the claim', async () => {
    // The claim was taken by "another replica" — this process knows nothing
    // about it beyond the row.
    await jobs.claim(jobs.JOB_CAPTURE_DATE_BACKFILL);

    const res = await request(app).post('/api/admin/photos/repair-capture-dates');
    expect(res.status).toBe(409);

    const dimRes = await request(app).post('/api/admin/photos/repair-dimensions');
    // The other job is untouched by that claim, so it is free to start.
    expect(dimRes.status).toBe(200);
  });

  test('the no-op path releases the claim it took', async () => {
    // No photos at all, so both endpoints take their "nothing to do" exit.
    await db('photos').del();

    const res = await request(app).post('/api/admin/photos/repair-capture-dates');
    expect(res.body.count).toBe(0);

    const row = await db('maintenance_jobs').where({ job_name: jobs.JOB_CAPTURE_DATE_BACKFILL }).first();
    expect(row.is_running).toBeFalsy();
    // ...and a second POST is therefore accepted rather than 409ing forever.
    expect((await request(app).post('/api/admin/photos/repair-capture-dates')).status).toBe(200);
  });
});
