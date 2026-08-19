/**
 * External imports are queued for face scanning, in the right order (#1090).
 *
 * Managed uploads are enqueued by photoProcessor, which writes face_status
 * 'pending' once a photo is processed (photoProcessor.js:573 — "the only
 * correct place to enqueue"). External media never goes through photoProcessor:
 * adminExternalMedia inserts rows directly, so they stayed NULL and were only
 * ever picked up by a manual Re-scan.
 *
 * The ordering matters as much as the enqueue. events.external_path is written
 * only AFTER the whole import loop, so marking rows 'pending' as they are
 * inserted publishes claimable work while the event still points at the old
 * directory — or none at all, on a first import. The face worker polls
 * continuously, would resolve those photos against the wrong path, and mark
 * them permanently 'failed', a state only an explicit Re-scan clears.
 *
 * This drives the real route rather than re-implementing it, so removing the
 * enqueue fails the first test and moving it back onto the insert fails the
 * second.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const request = require('supertest');

describe('external import queues faces (#1090)', () => {
  let tmpDir; let db; let app; let mediaRoot;
  // Recorded from inside the per-photo thumbnail call, i.e. mid-loop.
  let pendingSeenDuringLoop = 0;
  let externalPathDuringLoop;
  // When set to an event id, the mocked thumbnail call turns detection on
  // mid-loop, standing in for an admin flipping the toggle during an import.
  let flipFacesOnDuringLoop = null;

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-extenq-'));
    mediaRoot = path.join(tmpDir, 'media');
    await fs.promises.mkdir(path.join(mediaRoot, 'nas', 'individual'), { recursive: true });
    for (const name of ['a.jpg', 'b.jpg', 'c.jpg']) {
      await fs.promises.writeFile(path.join(mediaRoot, 'nas', 'individual', name), 'not-a-real-jpeg');
    }

    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'data', 'db.sqlite');
    await fs.promises.mkdir(path.dirname(process.env.TEST_DATABASE_PATH), { recursive: true });
    process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
    process.env.EXTERNAL_MEDIA_ROOT = mediaRoot;
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'extenq-secret';

    jest.resetModules();

    jest.doMock('../../src/middleware/auth', () => ({
      adminAuth: (req, _res, next) => { req.admin = { id: 1, username: 'tester', roleName: 'admin' }; next(); },
    }));
    jest.doMock('../../src/middleware/permissions', () => ({
      requirePermission: () => (_req, _res, next) => next(),
    }));
    jest.doMock('../../src/middleware/ownership', () => ({
      requireEventOwnership: (_req, _res, next) => next(),
    }));

    // Runs once per photo, inside the import loop — the only hook that can
    // observe the intermediate state the ordering bug would expose.
    jest.doMock('../../src/services/imageProcessor', () => ({
      generateThumbnail: jest.fn(async () => {
        const { db: liveDb } = require('../../src/database/db');
        const rows = await liveDb('photos').where({ face_status: 'pending' });
        pendingSeenDuringLoop += rows.length;
        const ev = await liveDb('events').first();
        externalPathDuringLoop = ev ? ev.external_path : undefined;
        if (flipFacesOnDuringLoop) {
          await liveDb('events').where({ id: flipFacesOnDuringLoop })
            .update({ face_recognition_enabled: true });
        }
        return 'thumbnails/mock.jpg';
      }),
      ensureThumbnail: jest.fn(),
    }));

    jest.doMock('../../src/utils/logger', () => ({
      debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    }));

    // bootCrmDb runs every migrations/core/*.up() directly — knex's Migrator
    // deadlocks on 001_init's nested initializeDatabase() call.
    ({ db } = await require('./helpers/crmDb').bootCrmDb());

    app = express();
    app.use(express.json());
    app.use('/api/admin/external-media', require('../../src/routes/adminExternalMedia'));
  }, 180000);

  afterAll(async () => {
    if (db) await db.destroy?.();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  async function seedEvent({ facesEnabled, flagOn }) {
    await db('feature_flags').insert({ key: 'faces', value: flagOn })
      .onConflict('key').merge()
      .catch(async () => { await db('feature_flags').where({ key: 'faces' }).update({ value: flagOn }); });
    // The flag read is TTL-cached (requireFeatureFlag.js:26-34); production
    // invalidates after every write, and so must this.
    require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();

    await db('photos').del();
    await db('events').del();
    const [e] = await db('events').insert({
      slug: `extenq-${Math.random().toString(36).slice(2, 8)}`,
      event_type: 'wedding',
      event_name: 'extenq',
      event_date: '2026-01-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: `extenq-${Math.random()}`,
      expires_at: new Date().toISOString(),
      face_recognition_enabled: facesEnabled,
      source_mode: 'reference',
    }).returning('id');

    pendingSeenDuringLoop = 0;
    externalPathDuringLoop = undefined;
    return typeof e === 'object' ? e.id : e;
  }

  async function runImport(eventId) {
    return request(app)
      .post(`/api/admin/external-media/events/${eventId}/import-external`)
      .send({ external_path: 'nas', recursive: true });
  }

  it('queues imported photos when detection is on', async () => {
    const eventId = await seedEvent({ facesEnabled: true, flagOn: true });

    const res = await runImport(eventId);
    expect(res.status).toBe(200);

    const photos = await db('photos').where({ event_id: eventId });
    expect(photos.length).toBeGreaterThan(0);
    // The regression: these stayed NULL and waited for a manual Re-scan.
    expect(photos.every((p) => p.face_status === 'pending')).toBe(true);
  });

  it('does not publish claimable rows before events.external_path is written', async () => {
    const eventId = await seedEvent({ facesEnabled: true, flagOn: true });

    await runImport(eventId);

    // Observed from inside the loop: nothing may be claimable yet, because the
    // event still resolves to the old (here: empty) directory. Marking rows on
    // insert would make this non-zero and leave photos permanently 'failed'.
    expect(pendingSeenDuringLoop).toBe(0);
    expect(externalPathDuringLoop).toBeFalsy();

    // ...and afterwards both are in place.
    const ev = await db('events').where({ id: eventId }).first();
    expect(ev.external_path).toBe('nas');
    expect((await db('photos').where({ event_id: eventId, face_status: 'pending' })).length)
      .toBe((await db('photos').where({ event_id: eventId })).length);
  });

  it('honours a toggle flipped DURING the import', async () => {
    // The setting is read after the loop, not before: on a large library the
    // loop runs for minutes, and the toggle endpoint only queues rows that
    // already existed when it fired. Reading it up front would strand every
    // photo imported after that moment at NULL forever.
    const eventId = await seedEvent({ facesEnabled: false, flagOn: true });
    flipFacesOnDuringLoop = eventId;

    await runImport(eventId);
    flipFacesOnDuringLoop = null;

    const photos = await db('photos').where({ event_id: eventId });
    expect(photos.length).toBeGreaterThan(0);
    expect(photos.every((p) => p.face_status === 'pending')).toBe(true);
  });

  it('leaves face_status untouched when the per-event toggle is off', async () => {
    const eventId = await seedEvent({ facesEnabled: false, flagOn: true });
    await runImport(eventId);
    const photos = await db('photos').where({ event_id: eventId });
    expect(photos.length).toBeGreaterThan(0);
    expect(photos.every((p) => p.face_status === null)).toBe(true);
  });

  it('leaves face_status untouched when the global flag is off', async () => {
    // Installs without the feature must never accumulate face_status rows —
    // the same invariant photoProcessor's guard protects.
    const eventId = await seedEvent({ facesEnabled: true, flagOn: false });
    await runImport(eventId);
    const photos = await db('photos').where({ event_id: eventId });
    expect(photos.length).toBeGreaterThan(0);
    expect(photos.every((p) => p.face_status === null)).toBe(true);
  });
});
