/**
 * Content hashes of external-media photos (issue 2194).
 *
 *  - the import stores the hash of the file in place, as the uploads do
 *  - a re-scan that finds the file edited in place stores the new bytes'
 *    hash and drops a recorded read error, so neither goes stale
 *  - the backfill hashes a reference photo in place on the share, and
 *    leaves one whose file changed since the last scan to the refresh
 *
 * Driven through the real import route against real files.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const request = require('supertest');
const sharp = require('sharp');

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

describe('content hashes of external photos (issue 2194)', () => {
  let tmpDir; let db; let app; let mediaRoot; let backfill;

  const writeJpeg = async (rel, color, width = 60, height = 40) => {
    const full = path.join(mediaRoot, rel);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toFile(full);
    return { full, bytes: await fs.promises.readFile(full) };
  };

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-exthash-'));
    mediaRoot = path.join(tmpDir, 'media');
    await fs.promises.mkdir(mediaRoot, { recursive: true });

    process.env.NODE_ENV = 'test';
    process.env.EXTERNAL_MEDIA_ROOT = mediaRoot;
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'exthash-secret';

    jest.resetModules();
    jest.doMock('../../src/middleware/auth', () => ({
      adminAuth: (req, _res, next) => { req.admin = { id: 1, username: 'tester', roleName: 'admin' }; next(); },
    }));
    jest.doMock('../../src/middleware/permissions', () => ({
      ...jest.requireActual('../../src/middleware/permissions'),
      requirePermission: () => (_req, _res, next) => next(),
    }));
    jest.doMock('../../src/middleware/ownership', () => ({
      ...jest.requireActual('../../src/middleware/ownership'),
      requireEventOwnership: (_req, _res, next) => next(),
    }));
    jest.doMock('../../src/services/imageProcessor', () => {
      const actual = jest.requireActual('../../src/services/imageProcessor');
      return {
        ...actual,
        generateThumbnail: jest.fn(async (_src, { outputBasename }) => `thumbnails/thumb_${outputBasename}`),
        ensureThumbnail: jest.fn(),
      };
    });
    jest.doMock('../../src/utils/logger', () => ({
      debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    }));

    ({ db } = await require('./helpers/crmDb').bootCrmDb());
    await require('./helpers/externalMediaFixture').seedExternalAdminFixture(db);
    backfill = require('../../src/services/contentHashBackfill');

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
    await fs.promises.rm(mediaRoot, { recursive: true, force: true });
    await fs.promises.mkdir(mediaRoot, { recursive: true });
    const [e] = await db('events').insert({
      slug: `exthash-${Math.random().toString(36).slice(2, 8)}`,
      event_type: 'wedding', event_name: 'exthash', event_date: '2026-01-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `exthash-${Math.random()}`, expires_at: new Date(Date.now() + 86400000).toISOString(),
      source_mode: 'reference',
    }).returning('id');
    return typeof e === 'object' ? e.id : e;
  }

  const runImport = (eventId) => request(app)
    .post(`/api/admin/external-media/events/${eventId}/import-external`)
    .send({ external_path: 'shoot', recursive: true });

  it('the import stores the hash of the file on the share', async () => {
    const eventId = await seedEvent();
    const { bytes } = await writeJpeg('shoot/a.jpg', { r: 10, g: 20, b: 30 });
    const res = await runImport(eventId);
    expect(res.body.imported).toBe(1);
    const photo = await db('photos').where({ event_id: eventId }).first();
    expect(photo.source_origin).toBe('external');
    expect(photo.content_sha256).toBe(sha(bytes));
  });

  it('a re-scan of a file edited in place stores the new hash and drops a recorded error', async () => {
    const eventId = await seedEvent();
    const { bytes: oldBytes } = await writeJpeg('shoot/a.jpg', { r: 10, g: 20, b: 30 });
    await runImport(eventId);
    const photo = await db('photos').where({ event_id: eventId }).first();
    await db('photos').where({ id: photo.id }).update({ content_sha256_error: 'EIO: old read failure' });

    const { bytes: newBytes } = await writeJpeg('shoot/a.jpg', { r: 240, g: 200, b: 10 }, 300, 500);
    expect(sha(newBytes)).not.toBe(sha(oldBytes));
    const res = await runImport(eventId);
    expect(res.body.refreshed).toBe(1);
    const after = await db('photos').where({ id: photo.id }).first();
    expect(after.content_sha256).toBe(sha(newBytes));
    expect(after.content_sha256_error).toBeNull();
  });

  it('the backfill hashes a reference photo in place, and leaves a changed file to the refresh', async () => {
    const eventId = await seedEvent();
    const { bytes: aBytes } = await writeJpeg('shoot/a.jpg', { r: 10, g: 20, b: 30 });
    await writeJpeg('shoot/b.jpg', { r: 50, g: 60, b: 70 });
    await runImport(eventId);
    // As a row imported before the import hashed: no hash.
    await db('photos').where({ event_id: eventId }).update({ content_sha256: null });
    const a = await db('photos').where({ event_id: eventId, filename: 'a.jpg' }).first();
    const b = await db('photos').where({ event_id: eventId, filename: 'b.jpg' }).first();

    // b is edited on the share after the last scan: the row still records
    // the old version, so its bytes are not the row's.
    await writeJpeg('shoot/b.jpg', { r: 200, g: 10, b: 10 }, 90, 90);

    const started = await backfill.start();
    expect(started.count).toBe(2);
    await started.run();

    expect((await db('photos').where({ id: a.id }).first()).content_sha256).toBe(sha(aBytes));
    const bAfter = await db('photos').where({ id: b.id }).first();
    expect(bAfter.content_sha256).toBeNull();
    // Not an error: the next re-scan refreshes it, hash included.
    expect(bAfter.content_sha256_error).toBeNull();
    expect((await backfill.status()).lastResult).toMatchObject({ hashed: 1, failed: 0, skipped: 1 });
  });
});
