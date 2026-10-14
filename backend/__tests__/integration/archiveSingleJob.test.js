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

  it('stops deleting once a job that stalled after publishing has lost its claim', async () => {
    const event = await makeEvent('stalled-cleanup');
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
      expect(result).toEqual({ success: false, error: expect.stringMatching(/being archived/) });
    } finally {
      claimSpy.mockRestore();
    }
    expect(mockStorage.copy).not.toHaveBeenCalled();
    expect((await db('events').where({ id: event.id }).first()).slug).toBe('rename-race');
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
