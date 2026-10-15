/**
 * One archive job per gallery (issue 2012).
 *
 * POST /:id/archive checked is_archived and then awaited the whole job, and
 * is_archived is only set once the zip is uploaded. Every request (or bulk
 * archive, or expiry pass) arriving in that window started another job on the
 * same gallery, and the first one to finish deleted the originals the others
 * were still reading: NoSuchKey / ECONNRESET on S3. archiveEvent now takes a
 * per-gallery claim before it starts, and restore / delete / rename refuse
 * while one is live.
 */

const crypto = require('crypto');
const { Readable } = require('stream');
const express = require('express');
const request = require('supertest');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'archive-single-job-secret';

const bodies = new Map();
// Each storage read waits for this gate, so a test can hold a job mid-build.
let gate = Promise.resolve();
// The same for storage deletes, to hold a job in its cleanup.
let deleteGate = Promise.resolve();
let failList = false;

const mockStorage = {
  kind: () => 's3',
  list: jest.fn(async (prefix) => {
    if (failList) throw Object.assign(new Error('socket reset by peer'), { code: 'ECONNRESET' });
    return [...bodies.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ key, size: bodies.get(key).length, mtime: new Date() }));
  }),
  get: jest.fn(async (key) => {
    await gate;
    return Readable.from([bodies.get(key)]);
  }),
  stat: jest.fn(async () => null),
  copy: jest.fn(async () => undefined),
  rename: jest.fn(async () => undefined),
  exists: jest.fn(async () => true),
  putFromFile: jest.fn(async () => undefined),
  put: jest.fn(async () => undefined),
  delete: jest.fn(async () => { await deleteGate; }),
  resolveLocalPath: () => { throw new Error('not local'); },
};
jest.mock('../../src/services/storage', () => ({
  getStorage: () => mockStorage,
  initStorage: async () => mockStorage,
}));
jest.mock('../../src/services/emailProcessor', () => ({
  queueEmail: jest.fn(async () => undefined),
  getSupportEmail: jest.fn(async () => 'support@example.com'),
}));
jest.mock('../../src/services/workflows', () => ({
  isBuiltinFlowActive: async () => false,
  emitWorkflowEvent: async () => {},
}));
jest.mock('../../src/services/webhookService', () => ({
  fire: async () => {},
  buildEventSubject: (e) => e,
}));
jest.mock('../../src/middleware/auth', () => ({
  adminAuth: (req, _res, next) => {
    req.admin = { id: 1, username: 'tester' };
    require('../../src/database/crmAccess').withTrustedCrmAccess('archive single job fixture authentication', next);
  },
}));
jest.mock('../../src/middleware/permissions', () => ({
  requirePermission: () => (_req, _res, next) => next(),
}));
jest.mock('../../src/middleware/ownership', () => ({
  ...jest.requireActual('../../src/middleware/ownership'),
  requireEventOwnership: (_req, _res, next) => next(),
  requireEventOwner: (_req, _res, next) => next(),
  filterOwnedEventIds: async (_admin, ids) => ({ allowed: ids, denied: [] }),
}));

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

describe('one archive job per gallery', () => {
  let db; let cleanup; let app; let archiveEvent; let jobState; let logger;

  const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);
  const jobName = (id) => `event_archive:${id}`;
  // Each run uploads to a key of its own: events/archived/<slug>-<12 hex>.zip.
  const ownKey = (slug) => new RegExp(`^events/archived/${slug}-[0-9a-f]{12}\\.zip$`);
  const putKeys = (slug) => mockStorage.putFromFile.mock.calls
    .map(([key]) => key).filter((key) => ownKey(slug).test(key));
  const putCalls = (slug) => putKeys(slug).length;
  const waitForRead = () => new Promise((resolve) => {
    const tick = () => (mockStorage.get.mock.calls.length > 0 ? resolve() : setTimeout(tick, 5));
    tick();
  });
  const deletedKeys = () => mockStorage.delete.mock.calls.map(([key]) => key);

  async function makeEvent(slug, { photoCount = 3, expired = false } = {}) {
    const id = unwrap(await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: `Archive ${slug}`,
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: null,
      password_hash: 'x',
      share_link: `/gallery/${slug}/share`,
      share_token: `${slug}-share`,
      expires_at: new Date(Date.now() + (expired ? -1 : 30) * 864e5).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id'));
    for (let i = 0; i < photoCount; i += 1) {
      const filename = `photo-${i}.jpg`;
      bodies.set(`events/active/${slug}/${filename}`, crypto.randomBytes(1024));
      await db('photos').insert({
        event_id: id, filename, path: `events/active/${slug}/${filename}`, type: 'individual',
        source_origin: 'managed', mime_type: 'image/jpeg', uploaded_at: new Date().toISOString(),
      });
    }
    return db('events').where({ id }).first();
  }

  /** A live claim, as a job running on another replica holds it. */
  async function holdClaim(eventId) {
    await jobState.ensure(jobName(eventId));
    const token = await jobState.claim(jobName(eventId));
    expect(token).toBeTruthy();
    return token;
  }

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    ({ archiveEvent } = require('../../src/services/archiveService'));
    jobState = require('../../src/services/maintenanceJobState');
    logger = require('../../src/utils/logger');
    app = express();
    app.use(express.json());
    app.use('/admin/events', require('../../src/routes/adminEvents'));
    app.use('/admin/archives', require('../../src/routes/adminArchives'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(() => {
    require('../../src/database/crmAccess').enterTrustedCrmFixtureContext();
    gate = Promise.resolve();
    deleteGate = Promise.resolve();
    failList = false;
    jest.clearAllMocks();
  });

  it('runs exactly one of two concurrent archives of the same gallery', async () => {
    const event = await makeEvent('concurrent');
    let open;
    gate = new Promise((resolve) => { open = resolve; });

    const first = archiveEvent(event);
    // The first job is parked on its first storage read, mid-build.
    await new Promise((resolve) => {
      const tick = () => (mockStorage.get.mock.calls.length > 0 ? resolve() : setTimeout(tick, 5));
      tick();
    });
    // Without the claim the second job parks on the same gate; fail fast.
    const notRefused = new Promise((_, reject) => setTimeout(() => reject(new Error('second archive was not refused')), 2000));
    await expect(Promise.race([archiveEvent(event), notRefused]))
      .rejects.toMatchObject({ code: 'ARCHIVE_IN_PROGRESS', statusCode: 409 });
    open();
    await first;

    expect(mockStorage.list).toHaveBeenCalledTimes(1);
    expect(putCalls('concurrent')).toBe(1);
    const row = await db('events').where({ id: event.id }).first();
    expect(Boolean(row.is_archived)).toBe(true);
    expect(row.archive_path).toBe(putKeys('concurrent')[0]);
    // Released on success.
    expect((await jobState.read(jobName(event.id))).isRunning).toBe(false);
  });

  it('prunes the empty folders an archive leaves on local disk, and only the empty ones', async () => {
    const fsp = require('fs/promises');
    const os = require('os');
    const root = await fsp.mkdtemp(require('path').join(os.tmpdir(), 'picpeak-prune-'));
    const slug = require('path').join(root, 'gallery');
    await fsp.mkdir(require('path').join(slug, 'collages'), { recursive: true });
    await fsp.mkdir(require('path').join(slug, 'individual'), { recursive: true });
    await fsp.mkdir(require('path').join(slug, '.download-cache'), { recursive: true });
    await fsp.mkdir(require('path').join(slug, 'kept'), { recursive: true });
    await fsp.writeFile(require('path').join(slug, 'kept', 'late-upload.jpg'), 'x');
    await require('../../src/services/archiveService').pruneEmptyDirs(slug);
    expect(await fsp.readdir(slug)).toEqual(['kept']);
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('fails the finished download jobs whose cached archive it deletes', async () => {
    const event = await makeEvent('download-cache-jobs', { photoCount: 1 });
    const zipKey = 'events/active/download-cache-jobs/.download-cache/job-1.zip';
    bodies.set(zipKey, crypto.randomBytes(16));
    const [row] = await db('download_jobs').insert({
      token: crypto.randomBytes(32).toString('hex'), event_id: event.id, resolution: 'original',
      dedup_key: 'a'.repeat(64), status: 'ready', zip_path: zipKey,
      expires_at: new Date(Date.now() + 864e5).toISOString(), created_at: new Date().toISOString(),
    }).returning('id');
    const jobId = typeof row === 'object' ? row.id : row;
    await archiveEvent(event);
    expect(deletedKeys()).toContain(zipKey);
    expect((await db('download_jobs').where({ id: jobId }).first()).status).toBe('failed');
    const reusable = await require('../../src/services/downloadJobService').findReusable(event.id, 'a'.repeat(64));
    expect(reusable).toBeNull();
    bodies.delete(zipKey);
  });

  it('refuses a stale caller row once another job has archived the gallery', async () => {
    const event = await makeEvent('stale-row');
    await archiveEvent(event);
    mockStorage.putFromFile.mockClear();

    // `event` still says is_archived = 0: a second click that read the row
    // before the first job finished. Re-archiving would zip the emptied prefix
    // over the real archive.
    await expect(archiveEvent(event)).rejects.toMatchObject({ code: 'EVENT_ALREADY_ARCHIVED' });
    expect(putCalls('stale-row')).toBe(0);
  });

  it('takes over a claim whose holder stopped renewing', async () => {
    const event = await makeEvent('stale-claim');
    await holdClaim(event.id);
    // The holder died: its heartbeat is older than the lease.
    await db('maintenance_jobs').where({ job_name: jobName(event.id) })
      .update({ heartbeat_at: new Date(Date.now() - jobState.DEFAULT_STALE_MS - 60000).toISOString() });

    await archiveEvent(event);

    expect(Boolean((await db('events').where({ id: event.id }).first()).is_archived)).toBe(true);
  });

  it('releases the claim when the archive fails', async () => {
    const event = await makeEvent('fails');
    failList = true;
    await expect(archiveEvent(event)).rejects.toThrow('socket reset by peer');
    expect((await jobState.read(jobName(event.id))).isRunning).toBe(false);

    failList = false;
    await archiveEvent(event);
    expect(Boolean((await db('events').where({ id: event.id }).first()).is_archived)).toBe(true);
  });

  it('answers 409 ARCHIVE_IN_PROGRESS to a second archive request', async () => {
    const event = await makeEvent('route-single');
    await holdClaim(event.id);

    const res = await request(app).post(`/admin/events/${event.id}/archive`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ARCHIVE_IN_PROGRESS');
    expect(mockStorage.list).not.toHaveBeenCalled();
  });

  it('reports a claimed gallery as failed in a bulk archive and archives the rest', async () => {
    const held = await makeEvent('bulk-held');
    const free = await makeEvent('bulk-free');
    await holdClaim(held.id);

    const res = await request(app).post('/admin/events/bulk-archive').send({ eventIds: [held.id, free.id] });

    expect(res.status).toBe(200);
    expect(res.body.results.successful.map((r) => r.id)).toEqual([free.id]);
    expect(res.body.results.failed).toEqual([
      expect.objectContaining({ id: held.id, code: 'ARCHIVE_IN_PROGRESS' }),
    ]);
  });

  it('refuses restore, archive delete and gallery delete while the job runs', async () => {
    const event = await makeEvent('restore-held');
    // The job sets is_archived before it deletes the originals; this is that
    // window.
    await db('events').where({ id: event.id })
      .update({ is_archived: 1, archive_path: 'events/archived/restore-held.zip' });
    const token = await holdClaim(event.id);

    const restore = await request(app).post(`/admin/archives/${event.id}/restore`);
    expect(restore.status).toBe(409);
    expect(restore.body.code).toBe('ARCHIVE_IN_PROGRESS');

    const dropArchive = await request(app).delete(`/admin/archives/${event.id}`);
    expect(dropArchive.status).toBe(409);

    const dropEvent = await request(app).delete(`/admin/events/${event.id}`);
    expect(dropEvent.status).toBe(409);
    expect(dropEvent.body.code).toBe('ARCHIVE_IN_PROGRESS');

    expect(await db('events').where({ id: event.id }).first()).toBeTruthy();
    expect(Boolean((await db('events').where({ id: event.id }).first()).is_archived)).toBe(true);

    // Once the job is done, restore goes ahead (and fails later only because
    // this fixture has no real zip).
    await jobState.release(jobName(event.id), token);
    const after = await request(app).post(`/admin/archives/${event.id}/restore`);
    expect(after.status).not.toBe(409);
  });

  it('refuses to rename a gallery while it is being archived', async () => {
    const event = await makeEvent('rename-held');
    await holdClaim(event.id);
    const eventRenameService = require('../../src/services/eventRenameService');

    const result = await eventRenameService.validateRename(event.id, 'A brand new name');

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/being archived/);
  });

  it('refuses to extend a gallery while it is being archived', async () => {
    const event = await makeEvent('extend-held', { expired: true });
    let open;
    gate = new Promise((resolve) => { open = resolve; });
    const job = archiveEvent(event);
    await waitForRead();

    const res = await request(app).post(`/admin/events/${event.id}/extend`).send({ days: 30 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ARCHIVE_IN_PROGRESS');
    expect((await db('events').where({ id: event.id }).first()).expires_at).toBe(event.expires_at);
    open();
    await job;

    // Free again once the archive is done.
    const later = await makeEvent('extend-free', { expired: true });
    await request(app).post(`/admin/events/${later.id}/extend`).send({ days: 30 }).expect(200);
    expect((await jobState.read(jobName(later.id))).isRunning).toBe(false);
  });

  it('refuses a new expiry from the settings while the gallery is being archived', async () => {
    const event = await makeEvent('edit-expiry-held');
    const token = await holdClaim(event.id);
    const future = new Date(Date.now() + 90 * 864e5).toISOString();

    const res = await request(app).put(`/admin/events/${event.id}`).send({ expires_at: future });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ARCHIVE_IN_PROGRESS');
    expect((await db('events').where({ id: event.id }).first()).expires_at).toBe(event.expires_at);

    // Other edits, and an unchanged expiry, still save.
    await request(app).put(`/admin/events/${event.id}`)
      .send({ event_name: 'Renamed while archiving', expires_at: event.expires_at }).expect(200);
    expect((await db('events').where({ id: event.id }).first()).event_name).toBe('Renamed while archiving');
    await jobState.release(jobName(event.id), token);
  });

  it('refuses to reactivate a gallery while it is being archived', async () => {
    const event = await makeEvent('toggle-held');
    await db('events').where({ id: event.id }).update({ is_active: 0 });
    const token = await holdClaim(event.id);

    const res = await request(app).post(`/admin/events/${event.id}/toggle-status`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ARCHIVE_IN_PROGRESS');
    expect(Boolean((await db('events').where({ id: event.id }).first()).is_active)).toBe(false);

    await jobState.release(jobName(event.id), token);
    await request(app).post(`/admin/events/${event.id}/toggle-status`).expect(200);
    expect(Boolean((await db('events').where({ id: event.id }).first()).is_active)).toBe(true);
  });

  it('does not publish over the winner once its lease was taken over', async () => {
    const event = await makeEvent('lost-lease');
    let open;
    gate = new Promise((resolve) => { open = resolve; });
    const loser = archiveEvent(event);
    await waitForRead();

    // The loser stalled past the lease: another replica took the claim over,
    // archived the gallery and deleted the originals.
    await db('maintenance_jobs').where({ job_name: jobName(event.id) })
      .update({ heartbeat_at: new Date(Date.now() - jobState.DEFAULT_STALE_MS - 60000).toISOString() });
    await holdClaim(event.id);
    await db('events').where({ id: event.id })
      .update({ is_archived: 1, archive_path: 'events/archived/lost-lease-000000000000.zip' });

    open();
    await expect(loser).rejects.toMatchObject({ code: 'ARCHIVE_IN_PROGRESS' });

    // It uploaded to a key of its own, never over the winner's zip.
    expect(mockStorage.putFromFile.mock.calls.map(([key]) => key)).toEqual([expect.stringMatching(ownKey('lost-lease'))]);
    const [loserKey] = putKeys('lost-lease');
    expect(loserKey).not.toBe('events/archived/lost-lease-000000000000.zip');
    // Its own zip goes, nothing of the winner's or the gallery's does.
    expect(deletedKeys()).toStrictEqual([loserKey]);
    expect((await db('events').where({ id: event.id }).first()).archive_path)
      .toBe('events/archived/lost-lease-000000000000.zip');
  });

  it('does not publish once its lease was taken over, even before the new owner finishes', async () => {
    const event = await makeEvent('lost-lease-early');
    let open;
    gate = new Promise((resolve) => { open = resolve; });
    const loser = archiveEvent(event);
    await waitForRead();

    await db('maintenance_jobs').where({ job_name: jobName(event.id) })
      .update({ heartbeat_at: new Date(Date.now() - jobState.DEFAULT_STALE_MS - 60000).toISOString() });
    await holdClaim(event.id);

    open();
    await expect(loser).rejects.toMatchObject({ code: 'ARCHIVE_IN_PROGRESS' });

    const row = await db('events').where({ id: event.id }).first();
    expect(Boolean(row.is_archived)).toBe(false);
    expect(row.archive_path).toBeNull();
    expect(putKeys('lost-lease-early')).toHaveLength(1);
    expect(deletedKeys()).toStrictEqual(putKeys('lost-lease-early'));
    // The new owner's claim survives the loser's exit.
    expect((await jobState.read(jobName(event.id))).isRunning).toBe(true);
  });

  it('keeps an expired gallery a running archive holds in the next expiry pass', async () => {
    const event = await makeEvent('expired-held', { expired: true });
    const token = await holdClaim(event.id);
    const errorSpy = jest.spyOn(logger, 'error');
    const { checkExpirations } = require('../../src/services/expirationChecker');

    await checkExpirations();

    expect(mockStorage.list).not.toHaveBeenCalledWith(`events/active/${event.slug}`);
    expect(errorSpy.mock.calls.filter(([msg]) => String(msg).includes(event.slug))).toEqual([]);
    errorSpy.mockRestore();
    let row = await db('events').where({ id: event.id }).first();
    expect(Boolean(row.is_archived)).toBe(false);
    // Still active, so the next pass selects it again.
    expect(Boolean(row.is_active)).toBe(true);
    // The claim belongs to the other job still.
    expect((await jobState.read(jobName(event.id))).isRunning).toBe(true);

    // That archive fails and lets go: the next pass archives the gallery.
    await jobState.release(jobName(event.id), token);
    await checkExpirations();
    row = await db('events').where({ id: event.id }).first();
    expect(Boolean(row.is_archived)).toBe(true);
    expect(Boolean(row.is_active)).toBe(false);
    expect((await jobState.read(jobName(event.id))).isRunning).toBe(false);
  });

  it('leaves a gallery restored between the expiry query and the claim alone', async () => {
    const event = await makeEvent('expired-restored', { expired: true });
    const realClaim = jobState.claim;
    const claimSpy = jest.spyOn(jobState, 'claim').mockImplementation(async (name) => {
      // A manual archive and a restore both finished after this pass's query:
      // the restore made the gallery active again with a fresh expiry.
      if (name === jobName(event.id)) {
        await db('events').where({ id: event.id }).update({
          is_active: 1,
          expires_at: new Date(Date.now() + 30 * 864e5).toISOString(),
        });
      }
      return realClaim(name);
    });
    try {
      await require('../../src/services/expirationChecker').checkExpirations();
    } finally {
      claimSpy.mockRestore();
    }

    const row = await db('events').where({ id: event.id }).first();
    expect(Boolean(row.is_active)).toBe(true);
    expect(Boolean(row.is_archived)).toBe(false);
    expect(putCalls('expired-restored')).toBe(0);
  });

  // Moves the recorded expiry attempt back in time, as passes going by would.
  async function ageExpiryAttempt(eventId, hours) {
    const row = await db('maintenance_jobs').where({ job_name: jobName(eventId) }).first();
    const state = JSON.parse(row.last_result);
    state.expiry.at = new Date(Date.parse(state.expiry.at) - hours * 3600000).toISOString();
    await db('maintenance_jobs').where({ job_name: jobName(eventId) })
      .update({ last_result: JSON.stringify(state) });
  }
  const expiryAttempt = async (eventId) => {
    const row = await db('maintenance_jobs').where({ job_name: jobName(eventId) }).first();
    return JSON.parse(row?.last_result || '{}').expiry;
  };

  it('retries the archive of a gallery the expiry pass deactivated, with a backoff', async () => {
    const { checkExpirations } = require('../../src/services/expirationChecker');
    const { queueEmail } = require('../../src/services/emailProcessor');
    const event = await makeEvent('expired-retry', { expired: true });

    failList = true;
    await checkExpirations();
    let row = await db('events').where({ id: event.id }).first();
    expect(Boolean(row.is_active)).toBe(false);
    expect(Boolean(row.is_archived)).toBe(false);
    expect(await expiryAttempt(event.id)).toMatchObject({ attempts: 1 });
    const expiredMails = () => queueEmail.mock.calls.filter(([id, , type]) => id === event.id && type === 'gallery_expired');
    const announced = expiredMails().length;
    expect(announced).toBeGreaterThan(0);

    // Inside the backoff: left alone.
    failList = false;
    await checkExpirations();
    expect(Boolean((await db('events').where({ id: event.id }).first()).is_archived)).toBe(false);

    // Failing again doubles the wait.
    await ageExpiryAttempt(event.id, 1);
    failList = true;
    await checkExpirations();
    expect(await expiryAttempt(event.id)).toMatchObject({ attempts: 2 });
    await ageExpiryAttempt(event.id, 1);
    failList = false;
    await checkExpirations();
    expect(Boolean((await db('events').where({ id: event.id }).first()).is_archived)).toBe(false);

    await ageExpiryAttempt(event.id, 1);
    await checkExpirations();
    row = await db('events').where({ id: event.id }).first();
    expect(Boolean(row.is_archived)).toBe(true);
    expect(Boolean(row.is_active)).toBe(false);
    expect(await expiryAttempt(event.id)).toBeUndefined();
    // Announced once, on the first attempt.
    expect(expiredMails()).toHaveLength(announced);
  });

  it('does not retry when another pass made an attempt after this one selected the gallery', async () => {
    const { checkExpirations } = require('../../src/services/expirationChecker');
    const event = await makeEvent('expired-overlap', { expired: true });
    failList = true;
    await checkExpirations();
    failList = false;
    await ageExpiryAttempt(event.id, 2);

    const realClaim = jobState.claim;
    const claimSpy = jest.spyOn(jobState, 'claim').mockImplementation(async (name) => {
      // Another replica's pass retried (and failed) between this pass's query and its claim.
      if (name === jobName(event.id)) await ageExpiryAttempt(event.id, -2);
      return realClaim(name);
    });
    try {
      await checkExpirations();
    } finally {
      claimSpy.mockRestore();
    }

    expect(Boolean((await db('events').where({ id: event.id }).first()).is_archived)).toBe(false);
    expect(await expiryAttempt(event.id)).toMatchObject({ attempts: 1 });
  });

  it('does not retry once an admin toggled the gallery after the failed attempt', async () => {
    const { checkExpirations } = require('../../src/services/expirationChecker');
    const event = await makeEvent('expired-toggled', { expired: true });
    failList = true;
    await checkExpirations();
    failList = false;
    // Toggled on and off again through POST /:id/toggle-status, meant to stay off.
    await request(app).post(`/admin/events/${event.id}/toggle-status`).expect(200);
    await request(app).post(`/admin/events/${event.id}/toggle-status`).expect(200);
    // Reactivating cleared the retry record under the claim.
    expect(await expiryAttempt(event.id)).toBeUndefined();

    await checkExpirations();

    const row = await db('events').where({ id: event.id }).first();
    expect(Boolean(row.is_active)).toBe(false);
    expect(Boolean(row.is_archived)).toBe(false);
  });

  it('does not archive an expired gallery an admin deactivated', async () => {
    const event = await makeEvent('expired-admin-off', { expired: true });
    await db('events').where({ id: event.id }).update({ is_active: 0 });

    await require('../../src/services/expirationChecker').checkExpirations();

    expect(Boolean((await db('events').where({ id: event.id }).first()).is_archived)).toBe(false);
    expect(putCalls('expired-admin-off')).toBe(0);
  });

  it('does not retry a failed expiry archive once the gallery has a new expiry', async () => {
    const { checkExpirations } = require('../../src/services/expirationChecker');
    const event = await makeEvent('expired-reexpired', { expired: true });
    failList = true;
    await checkExpirations();
    failList = false;
    // Extended, deactivated by the admin, and expired again since: the
    // recorded attempt was for the old expiry.
    await db('events').where({ id: event.id })
      .update({ expires_at: new Date(Date.now() - 3600000).toISOString() });
    await ageExpiryAttempt(event.id, 2);

    await checkExpirations();

    expect(Boolean((await db('events').where({ id: event.id }).first()).is_archived)).toBe(false);
  });

  it('stops deleting once a job that stalled after publishing has lost its claim', async () => {
    const event = await makeEvent('stalled-cleanup');
    // Another gallery's archive names the slug's shared key, so no
    // shared-key zip is removed ahead of the originals.
    await db('events').insert({
      slug: 'stalled-cleanup-other', event_type: 'wedding', event_name: 'Other', event_date: '2026-08-01',
      host_email: 'host@example.com', password_hash: 'x', share_link: '/gallery/stalled-cleanup-other/share',
      share_token: 'stalled-cleanup-other-share', expires_at: new Date(Date.now() + 864e5).toISOString(),
      is_active: 0, is_archived: 1, is_draft: 0, archive_path: 'events/archived/stalled-cleanup.zip',
      created_at: new Date().toISOString(),
    });
    let open;
    deleteGate = new Promise((resolve) => { open = resolve; });
    const job = archiveEvent(event);
    // Published, parked on the first original's delete.
    await new Promise((resolve) => {
      const tick = () => (mockStorage.delete.mock.calls.length > 0 ? resolve() : setTimeout(tick, 5));
      tick();
    });
    expect(Boolean((await db('events').where({ id: event.id }).first()).is_archived)).toBe(true);

    // It stays suspended past its lease; a restore takes the claim and puts
    // the originals back under the same keys.
    await db('maintenance_jobs').where({ job_name: jobName(event.id) })
      .update({ heartbeat_at: new Date(Date.now() - jobState.DEFAULT_STALE_MS - 60000).toISOString() });
    await holdClaim(event.id);
    const realNow = Date.now;
    const later = realNow() + 60000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => later);
    try {
      open();
      await expect(job).rejects.toMatchObject({ code: 'ARCHIVE_IN_PROGRESS' });
    } finally {
      nowSpy.mockRestore();
    }

    // Only the delete already under way went out.
    expect(deletedKeys().filter((key) => key.startsWith('events/active/stalled-cleanup/'))).toHaveLength(1);
    expect((await jobState.read(jobName(event.id))).isRunning).toBe(true);
  });

  it('renames nothing when an archive takes the gallery after the validation', async () => {
    const event = await makeEvent('rename-race');
    const archiveService = require('../../src/services/archiveService');
    const realClaim = archiveService.claimArchive;
    const claimSpy = jest.spyOn(archiveService, 'claimArchive').mockImplementationOnce(async (id) => {
      await holdClaim(id);
      return realClaim(id);
    });
    const eventRenameService = require('../../src/services/eventRenameService');
    try {
      const result = await eventRenameService.renameEvent(event.id, 'A brand new name');
      expect(result).toEqual({ success: false, conflict: true, error: expect.stringMatching(/being archived/) });
    } finally {
      claimSpy.mockRestore();
    }
    expect(mockStorage.copy).not.toHaveBeenCalled();
    expect((await db('events').where({ id: event.id }).first()).slug).toBe('rename-race');
  });

  it('reports a concurrent rename as a conflict, not as an archive', async () => {
    const event = await makeEvent('rename-concurrent');
    const eventRenameService = require('../../src/services/eventRenameService');
    const results = await Promise.all([
      eventRenameService.renameEvent(event.id, 'First new name'),
      eventRenameService.renameEvent(event.id, 'Second new name'),
    ]);
    const lost = results.filter((r) => !r.success);
    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].conflict).toBe(true);
    expect(lost[0].error).toMatch(/renamed/);
  });

  it('stores a renamed gallery name in NFC', async () => {
    const event = await makeEvent('rename-nfc');
    const eventRenameService = require('../../src/services/eventRenameService');
    const result = await eventRenameService.renameEvent(event.id, 'Jo\u0308rg und Anna');
    expect(result.success).toBe(true);
    const row = await db('events').where({ id: event.id }).first();
    expect(row.event_name).toBe('J\u00f6rg und Anna');
  });

  it('gives a decomposed and a precomposed rename the same accent-free slug', async () => {
    const event = await makeEvent('rename-slug-nfd');
    const eventRenameService = require('../../src/services/eventRenameService');
    const result = await eventRenameService.renameEvent(event.id, 'Jo\u0308rg Slug');
    expect(result.success).toBe(true);
    expect(result.data.newSlug).toMatch(/^wedding-jorg-slug-/);
    // The NFC spelling of the same name is the same URL.
    const again = await eventRenameService.validateRename(event.id, 'J\u00f6rg Slug');
    expect(again).toMatchObject({ valid: false, error: expect.stringMatching(/same URL/) });
  });

  it('removes the archive claim row with the gallery', async () => {
    const event = await makeEvent('claim-row-delete');
    const eventRenameService = require('../../src/services/eventRenameService');
    expect((await eventRenameService.renameEvent(event.id, 'Claim row renamed')).success).toBe(true);
    expect(await db('maintenance_jobs').where({ job_name: jobName(event.id) }).first()).toBeTruthy();
    const res = await request(app).delete(`/admin/events/${event.id}`);
    expect(res.status).toBe(200);
    expect(await db('maintenance_jobs').where({ job_name: jobName(event.id) }).first()).toBeUndefined();
  });

  it('reports a claim taken over while the rename records its old zips as a conflict', async () => {
    const event = await makeEvent('rename-takeover');
    const archiveService = require('../../src/services/archiveService');
    const { AppError } = require('../../src/utils/errors');
    const recordSpy = jest.spyOn(archiveService, 'recordSupersededArchive').mockImplementationOnce(async () => {
      throw new AppError('The archive claim was taken over', 409, 'ARCHIVE_IN_PROGRESS');
    });
    const eventRenameService = require('../../src/services/eventRenameService');
    try {
      const result = await eventRenameService.renameEvent(event.id, 'Taken over name');
      expect(result).toMatchObject({ success: false, conflict: true });
    } finally {
      recordSpy.mockRestore();
    }
    expect((await db('events').where({ id: event.id }).first()).slug).toBe('rename-takeover');
  });

  it('finds an NFC gallery name with a decomposed search', async () => {
    const event = await makeEvent('search-nfc', { photoCount: 0 });
    await db('events').where({ id: event.id }).update({ event_name: 'J\u00f6rg sucht' });
    const res = await request(app).get('/admin/events').query({ search: 'Jo\u0308rg' });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('search-nfc');
  });

  it('still finds a gallery name saved decomposed before the change, with either spelling', async () => {
    const event = await makeEvent('search-nfd', { photoCount: 0 });
    await db('events').where({ id: event.id }).update({ event_name: 'Jo\u0308rg legacy' });
    for (const search of ['Jo\u0308rg legacy', 'J\u00f6rg legacy']) {
      const res = await request(app).get('/admin/events').query({ search });
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).toContain('search-nfd');
    }
  });

  it('finds an archived gallery by its name with either Unicode spelling', async () => {
    const event = await makeEvent('archive-search-nfc', { photoCount: 0 });
    await db('events').where({ id: event.id }).update({ event_name: 'J\u00f6rg im Archiv', is_archived: 1, is_active: 0 });
    for (const search of ['Jo\u0308rg im', 'J\u00f6rg im']) {
      const res = await request(app).get('/admin/archives').query({ search });
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).toContain('archive-search-nfc');
    }
  });

  it('removes an archive\'s unheld claim row with it, and leaves one a restore took meanwhile', async () => {
    const released = await makeEvent('archive-row-free', { photoCount: 0 });
    await jobState.ensure(jobName(released.id));
    await db('events').where({ id: released.id }).update({ is_archived: 1, is_active: 0 });
    expect((await request(app).delete(`/admin/archives/${released.id}`)).status).toBe(200);
    expect(await db('maintenance_jobs').where({ job_name: jobName(released.id) }).first()).toBeUndefined();

    const event = await makeEvent('archive-row-held', { photoCount: 0 });
    const zip = 'events/archived/archive-row-held-0123456789ab.zip';
    await db('events').where({ id: event.id }).update({ is_archived: 1, is_active: 0, archive_path: zip });
    let open;
    deleteGate = new Promise((resolve) => { open = resolve; });
    const pending = request(app).delete(`/admin/archives/${event.id}`).then((r) => r);
    // Past its running check, parked deleting the zip: a restore claims now.
    await new Promise((resolve) => {
      const tick = () => (deletedKeys().includes(zip) ? resolve() : setTimeout(tick, 5));
      tick();
    });
    const token = await holdClaim(event.id);
    open();
    expect((await pending).status).toBe(200);
    const row = await db('maintenance_jobs').where({ job_name: jobName(event.id) }).first();
    expect(row).toMatchObject({ claim_token: token });
    expect(Boolean(row.is_running)).toBe(true);
  });

  it('deletes the zip of an archive that finished between the delete and its claim', async () => {
    const event = await makeEvent('delete-race');
    const archiveService = require('../../src/services/archiveService');
    const realClaim = archiveService.claimArchive;
    const claimSpy = jest.spyOn(archiveService, 'claimArchive').mockImplementationOnce(async (id) => {
      // The archive job publishes and lets go just before the delete claims.
      await db('events').where({ id })
        .update({ is_archived: 1, archive_path: 'events/archived/delete-race-0123456789ab.zip' });
      return realClaim(id);
    });
    try {
      const res = await request(app).delete(`/admin/events/${event.id}`);
      expect(res.status).toBe(200);
    } finally {
      claimSpy.mockRestore();
    }
    expect(await db('events').where({ id: event.id }).first()).toBeUndefined();
    expect(deletedKeys()).toContain('events/archived/delete-race-0123456789ab.zip');
  });

  it('removes the upload of a run that died before publishing, on the next claim', async () => {
    const event = await makeEvent('abandoned');
    const deadKey = 'events/archived/abandoned-0123456789ab.zip';
    // A run recorded its upload, put the zip and died before publishing.
    await holdClaim(event.id);
    await db('maintenance_jobs').where({ job_name: jobName(event.id) }).update({
      last_result: JSON.stringify({ upload: deadKey }),
      heartbeat_at: new Date(Date.now() - jobState.DEFAULT_STALE_MS - 60000).toISOString(),
    });

    await archiveEvent(event);

    expect(deletedKeys()).toContain(deadKey);
    const row = await db('events').where({ id: event.id }).first();
    expect(row.archive_path).toMatch(ownKey('abandoned'));
    // Published and cleared: the next claim leaves the real archive alone.
    mockStorage.delete.mockClear();
    const lease = await require('../../src/services/archiveService').claimArchive(event.id);
    await lease.release();
    expect(deletedKeys()).toEqual([]);
  });

  it('keeps a recorded upload the event row names', async () => {
    const event = await makeEvent('published-lost-answer');
    const key = 'events/archived/published-lost-answer-0123456789ab.zip';
    // The publish committed but its answer was lost before the record cleared.
    await holdClaim(event.id);
    await db('maintenance_jobs').where({ job_name: jobName(event.id) }).update({
      last_result: JSON.stringify({ upload: key }),
      heartbeat_at: new Date(Date.now() - jobState.DEFAULT_STALE_MS - 60000).toISOString(),
    });
    await db('events').where({ id: event.id }).update({ is_archived: 1, archive_path: key });

    const lease = await require('../../src/services/archiveService').claimArchive(event.id);
    await lease.release();

    expect(deletedKeys()).toEqual([]);
  });

  /** A restore of this gallery brought `key` back and recorded it. */
  async function recordRestoredZip(eventId, key) {
    const { claimArchive, recordSupersededArchive } = require('../../src/services/archiveService');
    const lease = await claimArchive(eventId);
    await recordSupersededArchive(lease, key);
    await lease.release();
  }

  it('keeps a restored-from zip until the next archive is published, then removes it', async () => {
    const event = await makeEvent('superseded');
    const oldKey = 'events/archived/superseded-0123456789ab.zip';
    await recordRestoredZip(event.id, oldKey);

    // An archive that fails leaves it alone.
    failList = true;
    await expect(archiveEvent(event)).rejects.toThrow('socket reset by peer');
    expect(deletedKeys()).not.toContain(oldKey);

    failList = false;
    await archiveEvent(event);
    expect(deletedKeys()).toContain(oldKey);
    const { supersededArchives } = require('../../src/services/archiveService');
    expect(await supersededArchives(event.id)).toEqual([]);
  });

  it('removes restored-from zips with the gallery', async () => {
    const event = await makeEvent('superseded-delete');
    const oldKey = 'events/archived/superseded-delete-0123456789ab.zip';
    await recordRestoredZip(event.id, oldKey);

    const res = await request(app).delete(`/admin/events/${event.id}`);

    expect(res.status).toBe(200);
    expect(deletedKeys()).toContain(oldKey);
  });

  // A restore before per-run keys left the zip at events/archived/<slug>.zip
  // and recorded nothing; the next archive of the slug used to overwrite it.
  it('removes the zip a restore before per-run keys left at the shared key, once a newer archive is published', async () => {
    const event = await makeEvent('legacy-restored');
    await archiveEvent(event);
    expect(deletedKeys()).toContain('events/archived/legacy-restored.zip');
  });

  it('leaves a shared-key zip alone while another gallery\'s archive names it', async () => {
    const event = await makeEvent('legacy-named');
    const other = await makeEvent('legacy-named-other', { photoCount: 0 });
    await db('events').where({ id: other.id })
      .update({ is_archived: 1, is_active: 0, archive_path: 'events/archived/legacy-named.zip' });
    await archiveEvent(event);
    expect(deletedKeys()).not.toContain('events/archived/legacy-named.zip');
  });

  it('leaves a shared-key zip alone while another gallery keeps it as its restored-from zip', async () => {
    // Restored from its old shared-key archive since per-run keys, then
    // renamed: the slug is free again and taken by a new gallery.
    const restored = await makeEvent('legacy-renamed-away', { photoCount: 0 });
    await recordRestoredZip(restored.id, 'events/archived/legacy-reused.zip');
    const event = await makeEvent('legacy-reused');
    await archiveEvent(event);
    const res = await request(app).delete(`/admin/events/${event.id}`);
    expect(res.status).toBe(200);
    expect(deletedKeys()).not.toContain('events/archived/legacy-reused.zip');
  });

  it('records the shared-key zip of the old slug on rename, and removes it with the next archive', async () => {
    const event = await makeEvent('legacy-before-rename');
    const eventRenameService = require('../../src/services/eventRenameService');
    const result = await eventRenameService.renameEvent(event.id, 'Legacy after rename');
    expect(result.success).toBe(true);
    const { supersededArchives } = require('../../src/services/archiveService');
    expect(await supersededArchives(event.id)).toEqual(['events/archived/legacy-before-rename.zip']);

    await archiveEvent(await db('events').where({ id: event.id }).first());
    expect(deletedKeys()).toContain('events/archived/legacy-before-rename.zip');
    expect(await supersededArchives(event.id)).toEqual([]);
  });

  it('removes the shared-key zip with the gallery', async () => {
    const event = await makeEvent('legacy-delete');
    const res = await request(app).delete(`/admin/events/${event.id}`);
    expect(res.status).toBe(200);
    expect(deletedKeys()).toContain('events/archived/legacy-delete.zip');
  });

  it('removes the shared-key zip when the archive is deleted', async () => {
    const event = await makeEvent('legacy-archive-delete', { photoCount: 0 });
    const ownArchive = 'events/archived/legacy-archive-delete-0123456789ab.zip';
    await db('events').where({ id: event.id }).update({ is_archived: 1, is_active: 0, archive_path: ownArchive });
    const res = await request(app).delete(`/admin/archives/${event.id}`);
    expect(res.status).toBe(200);
    expect(deletedKeys()).toEqual(expect.arrayContaining([ownArchive, 'events/archived/legacy-archive-delete.zip']));
  });

  it('checks the claim before its first cleanup delete', async () => {
    const event = await makeEvent('stall-before-cleanup');
    const oldKey = 'events/archived/stall-before-cleanup-0123456789ab.zip';
    await recordRestoredZip(event.id, oldKey);
    let open;
    deleteGate = new Promise((resolve) => { open = resolve; });
    const job = archiveEvent(event);
    // Published, parked removing the superseded zip, before any original.
    await new Promise((resolve) => {
      const tick = () => (mockStorage.delete.mock.calls.length > 0 ? resolve() : setTimeout(tick, 5));
      tick();
    });
    expect(deletedKeys()).toEqual([oldKey]);

    // It stays suspended past its lease and a restore takes the gallery.
    await db('maintenance_jobs').where({ job_name: jobName(event.id) })
      .update({ heartbeat_at: new Date(Date.now() - jobState.DEFAULT_STALE_MS - 60000).toISOString() });
    await holdClaim(event.id);
    open();

    await expect(job).rejects.toMatchObject({ code: 'ARCHIVE_IN_PROGRESS' });
    expect(deletedKeys().filter((key) => key.startsWith('events/active/'))).toEqual([]);
  });

  it('refuses to record a restored-from zip once the claim has moved on', async () => {
    const event = await makeEvent('record-lost');
    const { claimArchive, recordSupersededArchive } = require('../../src/services/archiveService');
    const lease = await claimArchive(event.id);
    await db('maintenance_jobs').where({ job_name: jobName(event.id) })
      .update({ heartbeat_at: new Date(Date.now() - jobState.DEFAULT_STALE_MS - 60000).toISOString() });
    await holdClaim(event.id);

    await expect(recordSupersededArchive(lease, 'events/archived/record-lost-0123456789ab.zip'))
      .rejects.toMatchObject({ code: 'ARCHIVE_IN_PROGRESS' });
    await lease.release();
  });

  it('keeps an abandoned upload it failed to remove for the next publish', async () => {
    const event = await makeEvent('abandoned-stuck');
    const deadKey = 'events/archived/abandoned-stuck-0123456789ab.zip';
    await holdClaim(event.id);
    await db('maintenance_jobs').where({ job_name: jobName(event.id) }).update({
      last_result: JSON.stringify({ upload: deadKey }),
      heartbeat_at: new Date(Date.now() - jobState.DEFAULT_STALE_MS - 60000).toISOString(),
    });
    mockStorage.delete.mockImplementationOnce(async () => { throw new Error('AccessDenied'); });

    const { claimArchive, supersededArchives } = require('../../src/services/archiveService');
    const lease = await claimArchive(event.id);
    await lease.release();
    expect(await supersededArchives(event.id)).toEqual([deadKey]);

    await archiveEvent(event);
    expect(deletedKeys().filter((key) => key === deadKey)).toHaveLength(2);
    expect(await supersededArchives(event.id)).toEqual([]);
  });

  it('keeps the archive key within archive_path for the longest slugs', async () => {
    // 235 characters: the longest slug whose `<slug>.zip` key fit before.
    const slug = `long-${'x'.repeat(230)}`;
    const event = await makeEvent(slug, { photoCount: 1 });

    await archiveEvent(event);

    const row = await db('events').where({ id: event.id }).first();
    expect(row.archive_path.length).toBeLessThanOrEqual(255);
    expect(row.archive_path).toMatch(/^events\/archived\/long-x+-[0-9a-f]{12}\.zip$/);
  });

  it('builds the archive of a slug too long to name a temp file after', async () => {
    // 250 characters: `<8 hex>-<slug>.zip` passed the 255-byte file name limit.
    const slug = `long-${'y'.repeat(245)}`;
    const event = await makeEvent(slug, { photoCount: 1 });

    await archiveEvent(event);

    expect(Boolean((await db('events').where({ id: event.id }).first()).is_archived)).toBe(true);
  });

  it('keeps a removed abandoned upload on record, as a stalled run can still land it', async () => {
    const event = await makeEvent('abandoned-late');
    const deadKey = 'events/archived/abandoned-late-0123456789ab.zip';
    await holdClaim(event.id);
    await db('maintenance_jobs').where({ job_name: jobName(event.id) }).update({
      last_result: JSON.stringify({ upload: deadKey }),
      heartbeat_at: new Date(Date.now() - jobState.DEFAULT_STALE_MS - 60000).toISOString(),
    });

    const { claimArchive, supersededArchives } = require('../../src/services/archiveService');
    const lease = await claimArchive(event.id);
    await lease.release();

    expect(deletedKeys()).toEqual([deadKey]);
    expect(await supersededArchives(event.id)).toEqual([deadKey]);
  });

  it('leaves the next owner\'s upload alone once its own claim has moved on', async () => {
    const event = await makeEvent('abandoned-overtaken');
    const liveKey = 'events/archived/abandoned-overtaken-0123456789ab.zip';
    const realClaim = jobState.claim;
    const claimSpy = jest.spyOn(jobState, 'claim').mockImplementationOnce(async (name) => {
      const token = await realClaim(name);
      // This claimer stalls past its lease right away; the next owner takes
      // over and records the zip it is uploading.
      await db('maintenance_jobs').where({ job_name: name })
        .update({ heartbeat_at: new Date(Date.now() - jobState.DEFAULT_STALE_MS - 60000).toISOString() });
      const next = await realClaim(name);
      await db('maintenance_jobs').where({ job_name: name, claim_token: next })
        .update({ last_result: JSON.stringify({ upload: liveKey }) });
      return token;
    });
    try {
      const lease = await require('../../src/services/archiveService').claimArchive(event.id);
      await lease.release();
    } finally {
      claimSpy.mockRestore();
    }

    expect(deletedKeys()).toEqual([]);
    const row = await db('maintenance_jobs').where({ job_name: jobName(event.id) }).first();
    expect(JSON.parse(row.last_result)).toEqual({ upload: liveKey });
  });
});
