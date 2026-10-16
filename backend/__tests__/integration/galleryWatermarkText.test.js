/**
 * A gallery's own watermark text reaches every renderer (issue 2095).
 *
 * The downloads, the ZIPs, the gallery view and the stored watermark files
 * all draw the same text, the URLs and ETags change with it, and changing it
 * re-cuts the gallery's stored watermarks.
 */
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'watermark-text-test-secret';

const GLOBAL = { enabled: true, logoPath: null, position: 'bottom-right', opacity: 50, size: 15, companyName: 'Global Studio' };

describe('gallery watermark text (issue 2095)', () => {
  let db;
  let cleanup;
  let app;
  let adminToken;
  let jpeg;
  let watermarkService;
  let generator;
  let slugCounter = 0;
  let drawn;

  const galleryToken = (event) => jwt.sign(
    { eventId: event.id, eventSlug: event.slug, type: 'gallery', accessLevel: 'client' },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' }
  );

  async function makeEvent({ text = null, watermarkDownloads = 0, photos = 2 } = {}) {
    slugCounter += 1;
    const slug = `wm-text-${slugCounter}`;
    const inserted = await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: `Watermark Text ${slugCounter}`,
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${slug}/share`,
      share_token: `wm-text-share-${slugCounter}`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      allow_downloads: 1,
      watermark_downloads: watermarkDownloads,
      watermark_text: text,
      created_at: new Date().toISOString(),
    }).returning('id');
    const id = inserted[0]?.id ?? inserted[0];
    const dir = path.join(process.env.STORAGE_PATH, 'events', 'active', slug);
    await fs.promises.mkdir(dir, { recursive: true });
    const photoIds = [];
    for (let i = 0; i < photos; i += 1) {
      const filename = `photo-${i}.jpg`;
      await fs.promises.writeFile(path.join(dir, filename), jpeg);
      const p = await db('photos').insert({
        event_id: id,
        filename,
        path: `${slug}/${filename}`,
        type: 'individual',
        media_type: 'image',
        mime_type: 'image/jpeg',
        size_bytes: jpeg.length,
        uploaded_at: new Date(Date.now() - i * 1000).toISOString(),
      }).returning('id');
      photoIds.push(p[0]?.id ?? p[0]);
    }
    const event = await db('events').where({ id }).first();
    return { event, photoIds, token: galleryToken(event) };
  }

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    watermarkService = require('../../src/services/watermarkService');
    generator = require('../../src/services/watermarkGeneratorService');
    jpeg = await sharp({ create: { width: 320, height: 200, channels: 3, background: { r: 200, g: 80, b: 40 } } }).jpeg().toBuffer();

    const superRole = await db('roles').where({ name: 'super_admin' }).first();
    const [rootId] = await db('admin_users').insert({
      username: 'wm-text-admin',
      email: 'wm-text-admin@example.com',
      password_hash: await bcrypt.hash('WmTextAdmin123', 4),
      role_id: superRole.id,
      is_active: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).returning('id').then((r) => [r[0]?.id || r[0]]);
    adminToken = jwt.sign(
      { id: rootId, username: 'wm-text-admin', type: 'admin', role: 'super_admin', loginTime: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' }
    );

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
    app.use('/api/admin/events', require('../../src/routes/adminEvents'));
  }, 120000);

  afterAll(async () => {
    await require('../../src/services/isolatedSharp').shutdown();
    if (cleanup) await cleanup();
  });

  beforeEach(() => {
    drawn = [];
    const real = watermarkService.applyWatermark.bind(watermarkService);
    jest.spyOn(watermarkService, 'applyWatermark').mockImplementation((input, settings, opts) => {
      drawn.push(settings);
      return real(input, settings, opts);
    });
    watermarkService.clearCache();
  });
  afterEach(() => jest.restoreAllMocks());

  const withGlobal = (settings) => jest.spyOn(watermarkService, 'getWatermarkSettings').mockResolvedValue({ ...settings });

  test('single, all and selected downloads draw the gallery text (event-only flag)', async () => {
    withGlobal({ ...GLOBAL, enabled: false });
    const { event, photoIds, token } = await makeEvent({ text: 'Anna & Ben', watermarkDownloads: 1 });
    const auth = (r) => r.set('Authorization', `Bearer ${token}`);

    await auth(request(app).get(`/api/gallery/${event.slug}/download/${photoIds[0]}`)).expect(200);
    await auth(request(app).get(`/api/gallery/${event.slug}/download-all`)).buffer(true).expect(200);
    await auth(request(app).post(`/api/gallery/${event.slug}/download-selected`).send({ photo_ids: photoIds })).buffer(true).expect(200);

    expect(drawn.length).toBeGreaterThanOrEqual(1 + photoIds.length * 2);
    for (const settings of drawn) {
      expect(settings).toMatchObject({ enabled: true, text: 'Anna & Ben', companyName: 'Global Studio' });
    }
  });

  test('without a gallery text, downloads fall back to the company name', async () => {
    withGlobal({ ...GLOBAL, enabled: false });
    const { event, photoIds, token } = await makeEvent({ text: '', watermarkDownloads: 1 });
    await request(app).get(`/api/gallery/${event.slug}/download/${photoIds[0]}`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]).not.toHaveProperty('text');
    expect(watermarkService.watermarkLabel(drawn[0])).toBe('Global Studio');
  });

  test('the cached ZIP draws the gallery text', async () => {
    withGlobal({ ...GLOBAL, enabled: false });
    const { event } = await makeEvent({ text: 'Zip Text', watermarkDownloads: 1 });
    const zip = require('../../src/services/downloadZipService');
    const result = await zip.generateZip(event.id);
    expect(result).toMatchObject({ success: true });
    expect(drawn.length).toBeGreaterThanOrEqual(2);
    for (const settings of drawn) expect(settings.text).toBe('Zip Text');
    await zip.cleanup(event.id);
  });

  test('the gallery view draws the gallery text, and its URLs and ETags carry it', async () => {
    withGlobal(GLOBAL);
    jest.spyOn(generator, 'generateForPhoto').mockResolvedValue({ success: false });
    const { event, photoIds, token } = await makeEvent({ text: 'View Text' });
    const auth = (r) => r.set('Authorization', `Bearer ${token}`);

    const res = await auth(request(app).get(`/api/gallery/${event.slug}/photo/${photoIds[0]}`)).expect(200);
    expect(drawn.at(-1).text).toBe('View Text');
    const etag = res.headers.etag;

    const list = await auth(request(app).get(`/api/gallery/${event.slug}/photos`)).expect(200);
    const url = list.body.photos[0].url || list.body.photos[0].preview_url || list.body.photos[0].thumbnail_url;
    const wm = new URL(url, 'http://x').searchParams.get('wm');
    expect(wm).toBe(watermarkService.versionTag({ ...GLOBAL, text: 'View Text' }));
    expect(wm).not.toBe(watermarkService.versionTag(GLOBAL));

    await db('events').where({ id: event.id }).update({ watermark_text: 'Other Text' });
    const after = await auth(request(app).get(`/api/gallery/${event.slug}/photo/${photoIds[0]}`)
      .set('If-None-Match', etag)).expect(200);
    expect(after.headers.etag).not.toBe(etag);
    expect(drawn.at(-1).text).toBe('Other Text');
  });

  test('the hero ETag changes with the gallery text', async () => {
    withGlobal(GLOBAL);
    const { event, photoIds, token } = await makeEvent({ text: 'Hero One', photos: 1 });
    const hero = (etag) => {
      const r = request(app).get(`/api/gallery/${event.slug}/hero/${photoIds[0]}`).set('Authorization', `Bearer ${token}`);
      return etag ? r.set('If-None-Match', etag) : r;
    };
    const first = await hero().expect(200);
    expect(first.headers['x-hero-image']).toBe('true');
    await hero(first.headers.etag).expect(304);
    await db('events').where({ id: event.id }).update({ watermark_text: 'Hero Two' });
    const second = await hero(first.headers.etag).expect(200);
    expect(second.headers.etag).not.toBe(first.headers.etag);
    expect(drawn.at(-1).text).toBe('Hero Two');
  });

  test('stored watermark files are cut with the gallery text', async () => {
    withGlobal(GLOBAL);
    const { photoIds } = await makeEvent({ text: 'Stored Text', photos: 1 });
    const result = await generator.generateForPhoto(photoIds[0]);
    expect(result.success).toBe(true);
    expect(drawn.at(-1).text).toBe('Stored Text');
  });

  test('changing the text through the admin re-cuts the gallery\'s stored watermarks', async () => {
    withGlobal(GLOBAL);
    const { event, photoIds } = await makeEvent({ text: 'Before', photos: 2 });
    for (const id of photoIds) await generator.generateForPhoto(id);
    const before = await db('photos').whereIn('id', photoIds).select('id', 'watermark_path');
    expect(before.every((p) => p.watermark_path)).toBe(true);

    const regenerate = jest.spyOn(generator, 'regenerateForEvent');
    // Unchanged text: nothing to re-cut.
    await request(app).put(`/api/admin/events/${event.id}`).set('Authorization', `Bearer ${adminToken}`)
      .send({ watermark_text: ' Before ' }).expect(200);
    expect(regenerate).not.toHaveBeenCalled();

    drawn = [];
    await request(app).put(`/api/admin/events/${event.id}`).set('Authorization', `Bearer ${adminToken}`)
      .send({ watermark_text: 'After' }).expect(200);
    expect(regenerate).toHaveBeenCalledWith(event.id);
    await regenerate.mock.results[0].value;

    expect(drawn).toHaveLength(photoIds.length);
    for (const settings of drawn) expect(settings.text).toBe('After');
    const after = await db('photos').whereIn('id', photoIds).select('id', 'watermark_path');
    expect(after.every((p) => p.watermark_path)).toBe(true);
  });

  test('changing the text re-cuts the stored watermarks and drops the old files', async () => {
    withGlobal(GLOBAL);
    const { event, photoIds } = await makeEvent({ text: 'Before', photos: 2 });
    for (const id of photoIds) await generator.generateForPhoto(id);
    const before = await db('photos').whereIn('id', photoIds).select('id', 'watermark_path');
    const remove = jest.spyOn(watermarkService, 'deleteWatermarkFile');

    await db('events').where({ id: event.id }).update({ watermark_text: 'After' });
    await generator.regenerateForEvent(event.id);
    const after = await db('photos').whereIn('id', photoIds).select('id', 'watermark_path');
    for (const row of after) {
      const old = before.find((b) => b.id === row.id).watermark_path;
      expect(row.watermark_path).not.toBe(old);
      expect(watermarkService.storedWatermarkCurrent(row.watermark_path, { text: 'After' })).toBe(true);
      expect(remove).toHaveBeenCalledWith(old);
    }
  });

  test('a stored watermark cut with another text is not served; the photo is marked on the fly', async () => {
    withGlobal(GLOBAL);
    const queued = jest.spyOn(generator, 'generateForPhoto').mockResolvedValue({ success: false });
    const { event, photoIds, token } = await makeEvent({ text: 'Old', photos: 1 });
    queued.mockRestore();
    await generator.generateForPhoto(photoIds[0]);
    const { watermark_path: stored } = await db('photos').where({ id: photoIds[0] }).first();
    expect(stored).toBeTruthy();

    // The text changed; the stored file (cut with "Old") is still recorded,
    // as it is until the re-cut reaches this photo.
    await db('events').where({ id: event.id }).update({ watermark_text: 'New' });
    jest.spyOn(generator, 'generateForPhoto').mockResolvedValue({ success: false });
    drawn = [];
    await request(app).get(`/api/gallery/${event.slug}/photo/${photoIds[0]}`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(drawn).toHaveLength(1);
    expect(drawn[0].text).toBe('New');
    expect(generator.generateForPhoto).toHaveBeenCalledWith(photoIds[0]);
  });

  test('a job that queued before a text change cuts the current text', async () => {
    withGlobal(GLOBAL);
    const { event, photoIds } = await makeEvent({ text: 'Queued', photos: 1 });
    // The batch read its rows (and the old text) before the admin's change.
    const row = await db('photos').join('events', 'photos.event_id', 'events.id')
      .where('photos.id', photoIds[0]).select('photos.*', 'events.slug', 'events.source_mode', 'events.external_path').first();
    await db('events').where({ id: event.id }).update({ watermark_text: 'Current' });
    const result = await generator.processPhotoWatermark({ ...row, watermark_text: 'Queued' }, GLOBAL);
    expect(result.success).toBe(true);
    expect(drawn.at(-1).text).toBe('Current');
    const { watermark_path: stored } = await db('photos').where({ id: photoIds[0] }).first();
    expect(watermarkService.storedWatermarkCurrent(stored, { text: 'Current' })).toBe(true);
  });

  test('two overlapping cuts with different texts leave no file behind unnamed', async () => {
    withGlobal(GLOBAL);
    const { photoIds } = await makeEvent({ text: 'P', photos: 1 });
    await generator.generateForPhoto(photoIds[0]);
    // Both jobs read the photo while it still named the first file.
    const snapshot = await db('photos').where({ id: photoIds[0] }).first();
    const keyA = watermarkService.watermarkKey(snapshot, null, { text: 'A' });
    const keyB = watermarkService.watermarkKey(snapshot, null, { text: 'B' });
    const remove = jest.spyOn(watermarkService, 'deleteWatermarkFile').mockResolvedValue(true);

    expect((await generator.recordWatermark(snapshot, { success: true, watermarkPath: keyA })).success).toBe(true);
    expect(remove).toHaveBeenCalledWith(snapshot.watermark_path);
    expect((await generator.recordWatermark(snapshot, { success: true, watermarkPath: keyB })).success).toBe(true);
    // The second displaced A, which its snapshot never named.
    expect(remove).toHaveBeenCalledWith(keyA);
    expect((await db('photos').where({ id: photoIds[0] }).first()).watermark_path).toBe(keyB);
  });

  test('an attempt-named watermark with a gallery text is still recognised as an attempt\'s file', async () => {
    const attempt = { id: '0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b' };
    const photo = { id: 9, filename: 'a.jpg', source_origin: 'managed' };
    const key = watermarkService.watermarkKey(photo, attempt, { text: 'Anna' });
    expect(key.endsWith(`_${attempt.id}.jpg`)).toBe(true);
    expect(watermarkService.storedWatermarkCurrent(key, { text: 'Anna' })).toBe(true);
    expect(watermarkService.storedWatermarkCurrent(key, {})).toBe(false);
    const storage = { delete: jest.fn(async () => {}) };
    await require('../../src/services/mediaAttemptService').dropSuperseded(storage, key, 'watermarks/other.jpg');
    expect(storage.delete).toHaveBeenCalledWith(key);
  });

  test('the stored key carries the text; a file without one only matches a gallery without one', () => {
    const photo = { id: 9, filename: 'a.jpg', source_origin: 'managed' };
    const plain = watermarkService.watermarkKey(photo);
    const anna = watermarkService.watermarkKey(photo, null, { text: 'Anna' });
    expect(anna).not.toBe(plain);
    expect(anna.endsWith('.jpg')).toBe(true);
    expect(watermarkService.storedWatermarkCurrent(plain, {})).toBe(true);
    expect(watermarkService.storedWatermarkCurrent(plain, { text: 'Anna' })).toBe(false);
    expect(watermarkService.storedWatermarkCurrent(anna, { text: 'Anna' })).toBe(true);
    expect(watermarkService.storedWatermarkCurrent(anna, { text: 'Ben' })).toBe(false);
    expect(watermarkService.storedWatermarkCurrent(anna, {})).toBe(false);
  });
});
