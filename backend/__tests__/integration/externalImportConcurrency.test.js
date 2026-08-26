/**
 * Two overlapping external imports insert every file twice (#1162).
 *
 * The route checked for an existing external_relpath and then inserted, with
 * an fs.stat and a `sharp().metadata()` read sitting in between. A reporter
 * double-clicked a slow import of a 6012-file tree and got 8004 rows.
 *
 * Both halves of the fix are driven here through the real route:
 *
 *   - the in-flight guard, which turns the second click into a 409 instead of
 *     a second full walk of the tree;
 *   - convergence when the guard cannot help (another replica, another
 *     process), which is the unique index from migration 186 firing and the
 *     loop counting a skip rather than dying or duplicating.
 *
 * The second is exercised by inserting a competing row from inside the mocked
 * `sharp().metadata()` call — literally inside the window the bug lived in.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const request = require('supertest');

describe('concurrent external imports (#1162)', () => {
  let tmpDir; let db; let app; let mediaRoot;
  // When set, the mocked sharp metadata read inserts this row first — the
  // other run winning the race between our SELECT and our INSERT.
  let stealDuringMetadata = null;
  let thumbnailDelayMs = 0;

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-extdup-'));
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
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'extdup-secret';

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

    // The window. In production this is a real decode of a NAS-hosted file —
    // hundreds of milliseconds during which the row we just proved absent can
    // appear. Standing in for the other run here makes that deterministic.
    jest.doMock('sharp', () => () => ({
      metadata: async () => {
        if (stealDuringMetadata) {
          const { db: liveDb } = require('../../src/database/db');
          await liveDb('photos').insert(stealDuringMetadata);
          stealDuringMetadata = null;
        }
        return { width: 100, height: 200 };
      },
    }));

    jest.doMock('../../src/services/imageProcessor', () => ({
      generateThumbnail: jest.fn(async () => {
        if (thumbnailDelayMs) await new Promise((r) => setTimeout(r, thumbnailDelayMs));
        return 'thumbnails/mock.jpg';
      }),
      ensureThumbnail: jest.fn(),
    }));

    jest.doMock('../../src/utils/logger', () => ({
      debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    }));

    ({ db } = await require('./helpers/crmDb').bootCrmDb());

    app = express();
    app.use(express.json());
    app.use('/api/admin/external-media', require('../../src/routes/adminExternalMedia'));
  }, 180000);

  afterAll(async () => {
    if (db) await db.destroy?.();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  async function seedEvent() {
    await db('photos').del();
    await db('events').del();
    stealDuringMetadata = null;
    thumbnailDelayMs = 0;
    const [e] = await db('events').insert({
      slug: `extdup-${Math.random().toString(36).slice(2, 8)}`,
      event_type: 'wedding',
      event_name: 'extdup',
      event_date: '2026-01-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: `extdup-${Math.random()}`,
      expires_at: new Date().toISOString(),
      source_mode: 'reference',
    }).returning('id');
    return typeof e === 'object' ? e.id : e;
  }

  const runImport = (eventId) => request(app)
    .post(`/api/admin/external-media/events/${eventId}/import-external`)
    .send({ external_path: 'nas', recursive: true });

  async function relpathCounts(eventId) {
    const rows = await db('photos').where({ event_id: eventId }).select('external_relpath');
    const counts = new Map();
    for (const r of rows) counts.set(r.external_relpath, (counts.get(r.external_relpath) || 0) + 1);
    return counts;
  }

  it('rejects a second import while the first is still running', async () => {
    const eventId = await seedEvent();
    // Enough to keep the first request inside its loop while the second
    // arrives — the "slow import looks hung, so I clicked again" case.
    thumbnailDelayMs = 20;

    const [first, second] = await Promise.all([runImport(eventId), runImport(eventId)]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    const rejected = first.status === 409 ? first : second;
    expect(rejected.body.error).toMatch(/already running/i);
  });

  it('leaves exactly one row per file after both runs', async () => {
    const eventId = await seedEvent();
    thumbnailDelayMs = 20;

    await Promise.all([runImport(eventId), runImport(eventId)]);

    const counts = await relpathCounts(eventId);
    expect(counts.size).toBe(3);
    expect([...counts.values()]).toEqual([1, 1, 1]);
  });

  it('releases the event once the import finishes, so a re-import still works', async () => {
    const eventId = await seedEvent();

    expect((await runImport(eventId)).status).toBe(200);
    // Not 409 — the guard is per run, not a permanent lock on the event.
    const second = await runImport(eventId);
    expect(second.status).toBe(200);
    expect(second.body.imported).toBe(0);
    expect(second.body.skipped).toBe(3);
  });

  it('converges when another writer wins the race mid-file', async () => {
    // The guard is in-process, so it cannot see a second replica. This is what
    // the unique index is for: the insert bounces, and the file is counted as
    // skipped rather than duplicated or lost to a 500.
    const eventId = await seedEvent();
    stealDuringMetadata = {
      event_id: eventId,
      filename: 'a.jpg',
      path: 'x/a.jpg',
      type: 'individual',
      source_origin: 'external',
      external_relpath: path.join('individual', 'a.jpg'),
    };

    const res = await runImport(eventId);

    expect(res.status).toBe(200);
    const counts = await relpathCounts(eventId);
    expect(counts.get(path.join('individual', 'a.jpg'))).toBe(1);
    // Two imported by us, one lost to the other writer and reported honestly.
    expect(res.body.imported).toBe(2);
    expect(res.body.skipped).toBe(1);
  });

  it('does not let one contended file abort the rest of the import', async () => {
    const eventId = await seedEvent();
    stealDuringMetadata = {
      event_id: eventId,
      filename: 'a.jpg',
      path: 'x/a.jpg',
      type: 'individual',
      source_origin: 'external',
      external_relpath: path.join('individual', 'a.jpg'),
    };

    await runImport(eventId);

    // All three files present — the contended one via the other writer's row.
    expect((await relpathCounts(eventId)).size).toBe(3);
  });
});
