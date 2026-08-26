/**
 * Backfilling captured_at on a library imported before #1172.
 *
 * The point of the endpoint, rather than a migration: it resolves originals
 * through resolvePhotoFilePath, which is the only path that reaches an
 * external row. The thumbnail regenerator resolves under
 * storage/events/active/<photo.path>, which never exists for those (#1129) —
 * so it cannot be the model.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const request = require('supertest');
const sharp = require('sharp');

describe('capture date backfill (#1172)', () => {
  let tmpDir; let db; let app; let mediaRoot;

  const writeJpegWithExif = async (abs, iso) => {
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    const exifDate = `${d.getUTCFullYear()}:${pad(d.getUTCMonth() + 1)}:${pad(d.getUTCDate())} `
      + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    await sharp({ create: { width: 60, height: 40, channels: 3, background: { r: 9, g: 9, b: 9 } } })
      .withExif({ IFD2: { DateTimeOriginal: exifDate } }).jpeg().toFile(abs);
  };

  const settle = async () => { for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 50)); const s = await status(); if (!s.body.isRunning) return s; } throw new Error('backfill did not settle'); };
  const status = () => request(app).get('/api/admin/photos/repair-capture-dates/status');

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-capfill-'));
    mediaRoot = path.join(tmpDir, 'media');
    await fs.promises.mkdir(mediaRoot, { recursive: true });

    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'data', 'db.sqlite');
    await fs.promises.mkdir(path.dirname(process.env.TEST_DATABASE_PATH), { recursive: true });
    process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
    process.env.EXTERNAL_MEDIA_ROOT = mediaRoot;
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'capfill-secret';

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

    app = express();
    app.use(express.json());
    app.use('/api/admin/photos', require('../../src/routes/adminPhotoDimensions'));
  }, 180000);

  afterAll(async () => {
    if (db) await db.destroy?.();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  async function seed({ relpath, exifIso, writeFile = true, archived = false }) {
    await db('photos').del();
    await db('events').del();
    const [e] = await db('events').insert({
      slug: 'capfill', event_type: 'wedding', event_name: 'capfill', event_date: '2026-01-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `capfill-${Math.random()}`, expires_at: new Date().toISOString(),
      source_mode: 'reference', external_path: 'trip', is_archived: archived,
    }).returning('id');
    const eventId = typeof e === 'object' ? e.id : e;
    if (writeFile) await writeJpegWithExif(path.join(mediaRoot, 'trip', relpath), exifIso);
    const [p] = await db('photos').insert({
      event_id: eventId, filename: path.basename(relpath), path: `capfill/${path.basename(relpath)}`,
      // Root-relative, as this branch stores it (#1163) — the file lives at
      // <mediaRoot>/trip/<relpath>.
      type: 'individual', source_origin: 'external', external_relpath: `trip/${relpath}`,
      uploaded_at: new Date().toISOString(), captured_at: null,
    }).returning('id');
    return { eventId, photoId: typeof p === 'object' ? p.id : p };
  }

  it('fills captured_at for an external photo the thumbnail regenerator cannot reach', async () => {
    const { photoId } = await seed({ relpath: 'a.jpg', exifIso: '2026-06-01T09:45:03Z' });

    const res = await request(app).post('/api/admin/photos/repair-capture-dates');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    const done = await settle();

    expect(done.body.lastResult.success).toBe(1);
    expect((await db('photos').where({ id: photoId }).first()).captured_at).toBeTruthy();
  });

  it('counts a photo with no EXIF separately from a failure', async () => {
    // "The mount is broken" and "these files carry no date" need different
    // answers from an operator, so they are not the same number.
    await db('photos').del(); await db('events').del();
    const { photoId } = await seed({ relpath: 'plain.jpg', exifIso: '2026-06-01T09:45:03Z', writeFile: false });
    await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 1, g: 1, b: 1 } } })
      .jpeg().toFile(path.join(mediaRoot, 'trip', 'plain.jpg'));

    await request(app).post('/api/admin/photos/repair-capture-dates');
    const done = await settle();

    expect(done.body.lastResult).toMatchObject({ success: 0, noExif: 1, failed: 0 });
    expect((await db('photos').where({ id: photoId }).first()).captured_at).toBeNull();
  });

  it('counts an unreachable original as a failure, not as missing EXIF', async () => {
    await seed({ relpath: 'gone.jpg', exifIso: '2026-06-01T09:45:03Z', writeFile: false });

    await request(app).post('/api/admin/photos/repair-capture-dates');
    const done = await settle();

    expect(done.body.lastResult).toMatchObject({ success: 0, noExif: 0, failed: 1 });
  });

  it('reports nothing to do once every photo has a date', async () => {
    const { photoId } = await seed({ relpath: 'b.jpg', exifIso: '2026-06-02T09:00:00Z' });
    await db('photos').where({ id: photoId }).update({ captured_at: new Date().toISOString() });

    const res = await request(app).post('/api/admin/photos/repair-capture-dates');

    expect(res.body.count).toBe(0);
    expect((await status()).body.withoutCaptureDate).toBe(0);
  });

  it('skips a watcher-imported video, which carries media_type "image"', async () => {
    // fileWatcher.processNewPhoto sets type='video' and a video/* mime but
    // never media_type (fileWatcher.js:128-130), so the row keeps the 'image'
    // default from migration 048. Filtering on media_type alone queued it every
    // run: extractCaptureDate returns null for a video, captured_at stays null,
    // and the backlog never cleared.
    const { eventId } = await seed({ relpath: 'clip.jpg', exifIso: '2026-06-01T09:45:03Z', writeFile: false });
    await db('photos').del();
    await db('photos').insert({
      event_id: eventId, filename: 'clip.mp4', path: 'capfill/clip.mp4',
      type: 'video', media_type: 'image', mime_type: 'video/mp4',
      source_origin: 'external', external_relpath: 'trip/clip.mp4',
      uploaded_at: new Date().toISOString(), captured_at: null,
    });

    const res = await request(app).post('/api/admin/photos/repair-capture-dates');
    expect(res.body.count).toBe(0);

    const s = await status();
    // And it is not counted as a permanent backlog either.
    expect(s.body.total).toBe(0);
    expect(s.body.withoutCaptureDate).toBe(0);
  });

  it('never reports more dated photos than it has photos', async () => {
    // Both counts come from one aggregate; as two queries an import committing
    // between them produced withCaptureDate > total and a negative backlog.
    const { photoId } = await seed({ relpath: 'counted.jpg', exifIso: '2026-06-05T08:00:00Z' });
    await db('photos').where({ id: photoId }).update({ captured_at: new Date().toISOString() });

    const s = await status();
    expect(s.body.total).toBe(1);
    expect(s.body.withCaptureDate).toBe(1);
    expect(s.body.withoutCaptureDate).toBe(0);
    expect(s.body.withoutCaptureDate).toBeGreaterThanOrEqual(0);
  });

  it('skips archived events instead of failing them on every run', async () => {
    // Archiving deletes the originals and keeps the rows, so an archived photo
    // can never get a date. Counting it would fail it every pass and leave the
    // status endpoint permanently reporting a backlog.
    await seed({ relpath: 'archived.jpg', exifIso: '2026-06-04T09:00:00Z', archived: true });

    const res = await request(app).post('/api/admin/photos/repair-capture-dates');

    expect(res.body.count).toBe(0);
    const s = await status();
    expect(s.body.total).toBe(0);
    expect(s.body.withoutCaptureDate).toBe(0);
    expect(s.body.isRunning).toBe(false);
  });

  it('does not overwrite a date written while it was running', async () => {
    // whereNull on the update: an import or a replacement finishing mid-run has
    // already written a better value than this pass would.
    const { photoId } = await seed({ relpath: 'c.jpg', exifIso: '2026-06-03T09:00:00Z' });
    const claimed = '2020-01-01T00:00:00.000Z';

    const res = await request(app).post('/api/admin/photos/repair-capture-dates');
    expect(res.body.count).toBe(1);
    await db('photos').where({ id: photoId }).update({ captured_at: claimed });
    const done = await settle();

    expect(new Date((await db('photos').where({ id: photoId }).first()).captured_at).toISOString()).toBe(claimed);
    expect(done.body.lastResult.success).toBe(0);
  });

  it('does not date a row whose file was replaced while it was reading (#1201)', async () => {
    // replacePhoto swaps a NEW file under an existing row and rewrites
    // path/filename (reachable from replace_by_name). The replacement carries
    // no date of its own, so captured_at is still NULL and the whereNull guard
    // alone would let the previous file's EXIF date land on it. The write is
    // fenced on the identity that was read, so the row is skipped instead —
    // and not counted as updated either.
    const { photoId } = await seed({ relpath: 'orig.jpg', exifIso: '2026-06-03T09:00:00Z' });

    const res = await request(app).post('/api/admin/photos/repair-capture-dates');
    expect(res.body.count).toBe(1);
    // Simulate the replacement landing before the loop writes.
    await db('photos').where({ id: photoId })
      .update({ path: 'capfill/replaced.jpg', filename: 'replaced.jpg' });
    const done = await settle();

    expect((await db('photos').where({ id: photoId }).first()).captured_at).toBeNull();
    expect(done.body.lastResult.success).toBe(0);
  });
});
