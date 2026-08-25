/**
 * External imports must record captured_at (#1172).
 *
 * Managed uploads get it from photoProcessor, which external media never goes
 * through — so every externally imported photo carried captured_at NULL, and
 * the gallery's "Date Taken" sort fell back to uploaded_at through its
 * COALESCE. On a library imported in two batches that ordered a 12-day trip by
 * which folder was imported first: the reporter's first two days landed at
 * positions 4204-5296 of 5555.
 *
 * Driven through the real route against real files carrying real EXIF, because
 * the whole question is whether the import reads the file it already has open.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const request = require('supertest');
const sharp = require('sharp');

describe('external import capture dates (#1172)', () => {
  let tmpDir; let db; let app; let mediaRoot;

  /**
   * A real JPEG carrying DateTimeOriginal.
   *
   * IFD2, not IFD0 — DateTimeOriginal lives in the Exif IFD, and exifr does not
   * see it anywhere else (IFD0 takes plain DateTime, which surfaces as
   * ModifyDate instead).
   */
  const writeJpegWithExif = async (rel, iso) => {
    const full = path.join(mediaRoot, rel);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    const exifDate = `${d.getUTCFullYear()}:${pad(d.getUTCMonth() + 1)}:${pad(d.getUTCDate())} `
      + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    await sharp({ create: { width: 60, height: 40, channels: 3, background: { r: 10, g: 20, b: 30 } } })
      .withExif({ IFD2: { DateTimeOriginal: exifDate } })
      .jpeg()
      .toFile(full);
    return full;
  };

  const writeJpegNoExif = async (rel) => {
    const full = path.join(mediaRoot, rel);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await sharp({ create: { width: 60, height: 40, channels: 3, background: { r: 200, g: 10, b: 10 } } })
      .jpeg().toFile(full);
  };

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-capdate-'));
    mediaRoot = path.join(tmpDir, 'media');
    await fs.promises.mkdir(mediaRoot, { recursive: true });

    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'data', 'db.sqlite');
    await fs.promises.mkdir(path.dirname(process.env.TEST_DATABASE_PATH), { recursive: true });
    process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
    process.env.EXTERNAL_MEDIA_ROOT = mediaRoot;
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'capdate-secret';

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
    jest.doMock('../../src/services/imageProcessor', () => {
      const actual = jest.requireActual('../../src/services/imageProcessor');
      return { ...actual, generateThumbnail: jest.fn(async () => 'thumbnails/mock.jpg'), ensureThumbnail: jest.fn() };
    });
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
    await fs.promises.rm(mediaRoot, { recursive: true, force: true });
    await fs.promises.mkdir(mediaRoot, { recursive: true });
    const [e] = await db('events').insert({
      slug: `capdate-${Math.random().toString(36).slice(2, 8)}`,
      event_type: 'wedding', event_name: 'capdate', event_date: '2026-01-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `capdate-${Math.random()}`, expires_at: new Date().toISOString(),
      source_mode: 'reference',
    }).returning('id');
    return typeof e === 'object' ? e.id : e;
  }

  const runImport = (eventId, external_path) => request(app)
    .post(`/api/admin/external-media/events/${eventId}/import-external`)
    .send({ external_path, recursive: true });

  it('records the EXIF capture date on import', async () => {
    const eventId = await seedEvent();
    await writeJpegWithExif('trip/a.jpg', '2026-06-01T09:45:03Z');

    await runImport(eventId, 'trip');

    const photo = await db('photos').where({ event_id: eventId }).first();
    expect(photo.captured_at).toBeTruthy();
    // NOT asserted as an absolute instant. EXIF carries a naive wall-clock
    // time and exifr resolves it against the HOST timezone, so the stored UTC
    // value differs between a CEST developer machine and a UTC runner. What
    // this fix is about is that the field is populated and orders correctly;
    // that captured_at is not a true instant is a separate, pre-existing
    // problem shared with managed uploads (#1172's own footnote).
    expect(new Date(photo.captured_at).getUTCFullYear()).toBe(2026);
    expect(new Date(photo.captured_at).getUTCMonth()).toBe(5); // June
  });

  it('imports a photo with no EXIF date rather than failing it', async () => {
    // Plenty of sources carry none; that must stay an import, not an error.
    const eventId = await seedEvent();
    await writeJpegNoExif('trip/plain.jpg');

    const res = await runImport(eventId, 'trip');

    expect(res.body.imported).toBe(1);
    const photo = await db('photos').where({ event_id: eventId }).first();
    expect(photo.captured_at).toBeNull();
  });

  it('orders a two-batch import by capture time, not by batch', async () => {
    // The reported shape: the FIRST days of the trip imported second. Sorting
    // on COALESCE(captured_at, uploaded_at) put them after the last days,
    // because uploaded_at is the import timestamp.
    const eventId = await seedEvent();
    await writeJpegWithExif('late/day12.jpg', '2026-06-12T10:00:00Z');
    await runImport(eventId, 'late');
    await writeJpegWithExif('early/day01.jpg', '2026-06-01T10:00:00Z');
    await runImport(eventId, 'early');

    const rows = await db('photos')
      .where({ event_id: eventId })
      .orderByRaw('COALESCE(captured_at, uploaded_at) asc')
      .select('filename');

    expect(rows.map((r) => r.filename)).toEqual(['day01.jpg', 'day12.jpg']);
  });
});
