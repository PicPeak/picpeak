/**
 * Camera details in the gallery (issue 1733, D1).
 *
 *  - guests get `exif` on the photo list only with the per-event switch on;
 *    with it off the key is absent, not null
 *  - the admin list always carries it
 *  - the switch is stored through the event update
 *  - the capture-date backfill fills exif_json for existing photos, writes
 *    '{}' for a file that carries none, and reads neither kind again
 *  - the ingest paths that complete a row without the worker (chunked admin
 *    upload, API v1 upload, file watcher, S3 auto-import) read them too
 */
// processUploadedPhotos() holds a transaction across thumbnail generation,
// and on this suite's one-connection SQLite pool the thumbnail settings read
// then waits out the 60 s acquire timeout (see videoPlaceholderNoDbLookup).
// The chunked case below skips the thumbnail; everything else is the real module.
const mockThumbnail = { skip: false };
jest.mock('../../src/services/imageProcessor', () => {
  const actual = jest.requireActual('../../src/services/imageProcessor');
  return {
    ...actual,
    generateThumbnail: (...args) => (mockThumbnail.skip ? null : actual.generateThumbnail(...args)),
  };
});

// The watcher's 'add' handler is driven by hand; nothing is really watched.
const mockWatcherHandlers = {};
jest.mock('chokidar', () => ({
  watch: jest.fn(() => {
    const watcher = {
      on: jest.fn((event, handler) => { mockWatcherHandlers[event] = handler; return watcher; }),
      close: jest.fn().mockResolvedValue(),
    };
    return watcher;
  }),
}));

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'photo-exif-secret-at-least-32-characters';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

const EXIF = { make: 'FUJIFILM', model: 'X-T5', lens: 'XF33mmF1.4 R LM WR', focal_length: 33, aperture: 1.4, exposure_time: 0.004, iso: 160 };

describe('camera details (issue 1733, D1)', () => {
  let db; let cleanup; let app; let adminToken; let counter = 0;

  const admin = (req) => req.set('Cookie', [`admin_token=${adminToken}`]).set('Authorization', `Bearer ${adminToken}`);

  async function makeEvent(overrides = {}) {
    counter += 1;
    const slug = `exif-test-${counter}`;
    const inserted = await db('events').insert({
      slug, event_type: 'wedding', event_name: `Exif Test ${counter}`, event_date: '2026-08-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `/gallery/${slug}/share`, share_token: `exif-share-${counter}`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_at: new Date().toISOString(),
      ...overrides,
    }).returning('id');
    const event = await db('events').where({ id: inserted[0]?.id ?? inserted[0] }).first();
    await fs.promises.mkdir(path.join(process.env.STORAGE_PATH, 'events', 'active', slug), { recursive: true });
    const token = jwt.sign({ eventId: event.id, eventSlug: slug, type: 'gallery' }, process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' });
    return { event, token };
  }

  async function addPhoto(event, name, fields = {}, bytes = null) {
    if (bytes) await fs.promises.writeFile(path.join(process.env.STORAGE_PATH, 'events', 'active', event.slug, name), bytes);
    const r = await db('photos').insert({
      event_id: event.id, filename: name, path: `${event.slug}/${name}`, type: 'individual',
      media_type: 'image', mime_type: 'image/jpeg', uploaded_at: new Date().toISOString(), ...fields,
    }).returning('id');
    return r[0]?.id ?? r[0];
  }

  const guestPhotos = async (event, token) => {
    const res = await request(app).get(`/api/gallery/${event.slug}/photos`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return Object.fromEntries(res.body.photos.map((p) => [p.filename, p]));
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    const superRole = await db('roles').where({ name: 'super_admin' }).first();
    const rootId = await db('admin_users').insert({
      username: 'exif-admin', email: 'exif-admin@example.com',
      password_hash: await bcrypt.hash('ExifAdmin123', 4), role_id: superRole.id, is_active: 1,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).returning('id').then((r) => r[0]?.id || r[0]);
    adminToken = jwt.sign(
      { id: rootId, username: 'exif-admin', type: 'admin', role: 'super_admin', loginTime: Date.now() },
      process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' }
    );
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
    app.use('/api/admin/photos', require('../../src/routes/adminPhotoDimensions'));
    app.use('/api/admin/photos', require('../../src/routes/adminPhotos'));
    app.use('/api/admin/events', require('../../src/routes/adminEvents'));
    app.use('/api/v1', require('../../src/routes/v1/events'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('leaves the key out for guests while the switch is off', async () => {
    const { event, token } = await makeEvent();
    await addPhoto(event, 'a.jpg', { exif_json: JSON.stringify(EXIF) });
    const photos = await guestPhotos(event, token);
    expect(photos['a.jpg']).not.toHaveProperty('exif');
    expect(JSON.stringify(photos['a.jpg'])).not.toContain('X-T5');
  });

  it('sends the parsed object to guests with the switch on, null where a photo has none', async () => {
    const { event, token } = await makeEvent({ show_exif_to_guests: 1 });
    await addPhoto(event, 'a.jpg', { exif_json: JSON.stringify(EXIF) });
    await addPhoto(event, 'b.jpg', { exif_json: '{}' });
    await addPhoto(event, 'c.jpg');
    const photos = await guestPhotos(event, token);
    expect(photos['a.jpg'].exif).toEqual(EXIF);
    expect(photos['b.jpg'].exif).toBeNull();
    expect(photos['c.jpg'].exif).toBeNull();
    expect(photos['a.jpg']).not.toHaveProperty('exif_json');
  });

  it('always sends it to the admin, and stores the switch through the event update', async () => {
    const { event, token } = await makeEvent();
    await addPhoto(event, 'a.jpg', { exif_json: JSON.stringify(EXIF) });

    const list = await admin(request(app).get(`/api/admin/photos/${event.id}/photos`));
    expect(list.status).toBe(200);
    expect(list.body.photos[0].exif).toEqual(EXIF);

    const bad = await admin(request(app).put(`/api/admin/events/${event.id}`)).send({ show_exif_to_guests: 'sometimes' });
    expect(bad.status).toBe(400);
    const ok = await admin(request(app).put(`/api/admin/events/${event.id}`)).send({ show_exif_to_guests: true });
    expect(ok.status).toBe(200);
    expect(Boolean((await db('events').where({ id: event.id }).first()).show_exif_to_guests)).toBe(true);
    expect((await guestPhotos(event, token))['a.jpg'].exif).toEqual(EXIF);
  });

  it('the upload worker reads them, and a replacement swaps them for the new file\'s', async () => {
    const { processPhoto } = require('../../src/services/photoProcessor');
    const { replacePhoto } = require('../../src/services/photoReplacementService');
    const { event } = await makeEvent();
    const image = sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 10, g: 120, b: 200 } } }).jpeg();
    const shot = await image.clone().withExif({ IFD0: { Model: 'X-T5' }, IFD2: { ISOSpeedRatings: '160' } }).toBuffer();

    const id = await addPhoto(event, 'up.jpg', { processing_status: 'pending', size_bytes: shot.length }, shot);
    await processPhoto(id);
    expect(JSON.parse((await db('photos').where({ id }).first()).exif_json)).toEqual({ model: 'X-T5', iso: 160 });

    const temp = path.join(process.env.STORAGE_PATH, 'replace-exif.jpg');
    await fs.promises.writeFile(temp, await image.clone().toBuffer());
    const result = await replacePhoto(await db('photos').where({ id }).first(), temp,
      { originalFilename: 'new.jpg', mimeType: 'image/jpeg', event });
    expect(result.success).toBe(true);
    expect((await db('photos').where({ id }).first()).exif_json).toBe('{}');
  }, 30000);

  it('the paths that complete a row without the worker read them too', async () => {
    const { event } = await makeEvent();
    const dir = path.join(process.env.STORAGE_PATH, 'events', 'active', event.slug);
    const shot = await sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 10, g: 120, b: 200 } } })
      .jpeg().withExif({ IFD0: { Model: 'X-T5' }, IFD2: { ISOSpeedRatings: '160', ExposureTime: '1/3200', DateTimeOriginal: '2021:06:15 14:30:00' } }).toBuffer();
    const expected = { model: 'X-T5', iso: 160, exposure_time: 0.0003125 };
    // The capture date too, which the worker would otherwise read. exifr
    // reads the EXIF wall-clock time as local time.
    const captured = new Date(2021, 5, 15, 14, 30, 0).getTime();
    const stored = async (where) => {
      const row = await db('photos').where({ event_id: event.id, ...where }).first();
      expect(row).toBeTruthy();
      expect(new Date(row.captured_at).getTime()).toBe(captured);
      return row.exif_json && JSON.parse(row.exif_json);
    };

    // Chunked admin upload (adminPhotos.js hands the assembled file here).
    const { processUploadedPhotos } = require('../../src/services/photoProcessor');
    const temp = path.join(process.env.STORAGE_PATH, 'chunked-exif.jpg');
    await fs.promises.writeFile(temp, shot);
    mockThumbnail.skip = true;
    let uploaded;
    try {
      [uploaded] = await processUploadedPhotos(
        [{ path: temp, originalname: 'chunked.jpg', mimetype: 'image/jpeg', size: shot.length }], event.id
      );
    } finally {
      mockThumbnail.skip = false;
    }
    expect(await stored({ id: uploaded.id })).toEqual(expected);

    // API v1 upload.
    const { generateApiToken } = require('../../src/middleware/apiTokenAuth');
    const owner = await db('admin_users').where({ username: 'exif-admin' }).first();
    const { plaintext, hashed } = generateApiToken();
    await db('api_tokens').insert({
      name: 'exif-token', hashed_token: hashed, scopes: 'admin', created_by: owner.id, created_at: new Date().toISOString(),
    });
    const v1 = await request(app).post(`/api/v1/events/${event.id}/photos`)
      .set('Authorization', `Bearer ${plaintext}`).attach('photo', shot, 'v1.jpg');
    expect(v1.status).toBe(201);
    expect(await stored({ original_filename: 'v1.jpg' })).toEqual(expected);

    // File watcher: a file dropped into the gallery's folder.
    const { startFileWatcher, stopFileWatcher } = require('../../src/services/fileWatcher');
    await fs.promises.writeFile(path.join(dir, 'watched.jpg'), shot);
    startFileWatcher();
    mockWatcherHandlers.add(path.join(dir, 'watched.jpg'));
    await stopFileWatcher();
    expect(await stored({ filename: 'watched.jpg' })).toEqual(expected);

    // S3 auto-import: a key is imported on the second poll that lists it.
    const { processEvent } = require('../../src/services/s3AutoImporter').__test;
    await fs.promises.writeFile(path.join(dir, 'bucket.jpg'), shot);
    const bucket = { list: async () => [{ key: `events/active/${event.slug}/bucket.jpg`, size: shot.length }] };
    await processEvent(event, bucket);
    await processEvent(event, bucket);
    expect(await stored({ filename: 'bucket.jpg' })).toEqual(expected);
  }, 30000);

  it('backfills existing photos once and does not read them again', async () => {
    await db('photos').del();
    const { event } = await makeEvent();
    const image = sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 10, g: 120, b: 200 } } }).jpeg();
    const withExif = await image.clone().withExif({
      IFD0: { Make: 'FUJIFILM', Model: 'X-T5' },
      IFD2: { DateTimeOriginal: '2026:06:01 09:45:03', FNumber: '14/10', ISOSpeedRatings: '160', BodySerialNumber: 'SER123456' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 0/1' },
    }).toBuffer();
    const full = await addPhoto(event, 'full.jpg', {}, withExif);
    const plain = await addPhoto(event, 'plain.jpg', { captured_at: '2026-06-01T09:45:03.000Z' }, await image.clone().toBuffer());
    // Already read: must not be touched, and must not be a candidate.
    const done = await addPhoto(event, 'done.jpg', { captured_at: '2026-06-01T09:45:03.000Z', exif_json: JSON.stringify(EXIF) });

    const before = await admin(request(app).get('/api/admin/photos/repair-capture-dates/status'));
    expect(before.body).toMatchObject({ total: 3, withoutCaptureDate: 1, pending: 2 });

    const run = await admin(request(app).post('/api/admin/photos/repair-capture-dates'));
    expect(run.body.count).toBe(2);
    let state;
    for (let i = 0; i < 150; i++) {
      // eslint-disable-next-line no-await-in-loop
      state = (await admin(request(app).get('/api/admin/photos/repair-capture-dates/status'))).body;
      if (!state.isRunning) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(state.isRunning).toBe(false);
    expect(state.lastResult).toMatchObject({ success: 1, failed: 0, exif: 2 });
    expect(state.pending).toBe(0);

    const fullRow = await db('photos').where({ id: full }).first();
    expect(JSON.parse(fullRow.exif_json)).toEqual({ make: 'FUJIFILM', model: 'X-T5', aperture: 1.4, iso: 160 });
    expect(fullRow.exif_json).not.toMatch(/SER123456|gps|latitude/i);
    expect(fullRow.captured_at).toBeTruthy();
    expect((await db('photos').where({ id: plain }).first()).exif_json).toBe('{}');
    expect(JSON.parse((await db('photos').where({ id: done }).first()).exif_json)).toEqual(EXIF);

    const again = await admin(request(app).post('/api/admin/photos/repair-capture-dates'));
    expect(again.body.count).toBe(0);
  });
});
