/**
 * Served photos carry the type of the bytes they ship (issue 2178).
 *
 * The watermark re-encodes a GIF/HEIC/TIFF as JPEG, but the routes labelled
 * the result with the stored type, and the download kept the original's
 * extension: a browser naming the file from its MIME type saved JPEG bytes
 * as .gif. The external-photo fallback went through res.sendFile, which
 * guesses from the extension and calls a .heic application/octet-stream.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'content-type-test-secret';
const EXTERNAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-ctype-ext-'));
process.env.EXTERNAL_MEDIA_ROOT = EXTERNAL_ROOT;

const GLOBAL = { enabled: true, logoPath: null, position: 'bottom-right', opacity: 50, size: 15, companyName: 'Studio' };

describe('served photo content types (issue 2178)', () => {
  let db;
  let cleanup;
  let app;
  let gif;
  let png;
  let watermarkService;
  let generator;
  let slugCounter = 0;

  const galleryToken = (event) => jwt.sign(
    { eventId: event.id, eventSlug: event.slug, type: 'gallery', accessLevel: 'client' },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' }
  );

  async function makeEvent({ watermarkDownloads = 0 } = {}) {
    slugCounter += 1;
    const slug = `ctype-${slugCounter}`;
    const inserted = await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: `Content Type ${slugCounter}`,
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${slug}/share`,
      share_token: `ctype-share-${slugCounter}`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      allow_downloads: 1,
      watermark_downloads: watermarkDownloads,
      created_at: new Date().toISOString(),
    }).returning('id');
    const id = inserted[0]?.id ?? inserted[0];
    const event = await db('events').where({ id }).first();
    return { event, token: galleryToken(event) };
  }

  async function addPhoto(event, filename, bytes, mimeType, { external = false } = {}) {
    const dir = external
      ? path.join(EXTERNAL_ROOT, event.slug)
      : path.join(process.env.STORAGE_PATH, 'events', 'active', event.slug);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, filename), bytes);
    const p = await db('photos').insert({
      event_id: event.id,
      filename,
      path: `${event.slug}/${filename}`,
      type: 'individual',
      media_type: 'image',
      mime_type: mimeType,
      size_bytes: bytes.length,
      uploaded_at: new Date().toISOString(),
      ...(external ? { source_origin: 'external', external_relpath: `${event.slug}/${filename}` } : {}),
    }).returning('id');
    return p[0]?.id ?? p[0];
  }

  const binary = (r) => r.buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  const isJpeg = (buffer) => buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    watermarkService = require('../../src/services/watermarkService');
    generator = require('../../src/services/watermarkGeneratorService');
    const base = sharp({ create: { width: 320, height: 200, channels: 3, background: { r: 200, g: 80, b: 40 } } });
    gif = await base.clone().gif().toBuffer();
    png = await base.clone().png().toBuffer();

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 120000);

  afterAll(async () => {
    await require('../../src/services/isolatedSharp').shutdown();
    if (cleanup) await cleanup();
    fs.rmSync(EXTERNAL_ROOT, { recursive: true, force: true });
  });

  beforeEach(() => watermarkService.clearCache());
  afterEach(() => jest.restoreAllMocks());

  const withGlobal = (settings) => jest.spyOn(watermarkService, 'getWatermarkSettings').mockResolvedValue({ ...settings });

  test('a watermarked GIF download is labelled and named as the JPEG it became', async () => {
    withGlobal({ ...GLOBAL, enabled: false });
    const { event, token } = await makeEvent({ watermarkDownloads: 1 });
    const photoId = await addPhoto(event, 'party.gif', gif, 'image/gif');

    const res = await binary(request(app).get(`/api/gallery/${event.slug}/download/${photoId}`)
      .set('Authorization', `Bearer ${token}`)).expect(200);
    expect(isJpeg(res.body)).toBe(true);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['content-disposition']).toContain('filename="party.jpg"');
  });

  test('a watermarked PNG download keeps its type and name', async () => {
    withGlobal({ ...GLOBAL, enabled: false });
    const { event, token } = await makeEvent({ watermarkDownloads: 1 });
    const photoId = await addPhoto(event, 'logo.png', png, 'image/png');

    const res = await request(app).get(`/api/gallery/${event.slug}/download/${photoId}`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toContain('filename="logo.png"');
  });

  test('the on-the-fly watermarked view of a GIF is labelled JPEG', async () => {
    withGlobal({ ...GLOBAL, enabled: false });
    const { event, token } = await makeEvent({ watermarkDownloads: 1 });
    const photoId = await addPhoto(event, 'view.gif', gif, 'image/gif');

    const res = await binary(request(app).get(`/api/gallery/${event.slug}/photo/${photoId}`)
      .set('Authorization', `Bearer ${token}`)).expect(200);
    expect(isJpeg(res.body)).toBe(true);
    expect(res.headers['content-type']).toBe('image/jpeg');
  });

  test('the stored watermark of an external GIF is labelled JPEG', async () => {
    withGlobal(GLOBAL);
    const { event, token } = await makeEvent();
    const photoId = await addPhoto(event, 'stored.gif', gif, 'image/gif', { external: true });
    expect(await generator.generateForPhoto(photoId)).toMatchObject({ success: true });
    const { watermark_path: stored } = await db('photos').where({ id: photoId }).first();
    expect(stored).toMatch(/\.gif$/);

    const spy = jest.spyOn(watermarkService, 'applyWatermark');
    const res = await binary(request(app).get(`/api/gallery/${event.slug}/photo/${photoId}`)
      .set('Authorization', `Bearer ${token}`)).expect(200);
    // Served from the stored file, not re-rendered.
    expect(spy).not.toHaveBeenCalled();
    expect(isJpeg(res.body)).toBe(true);
    expect(res.headers['content-type']).toBe('image/jpeg');
  });

  test('the stored watermark of a managed GIF is labelled JPEG', async () => {
    withGlobal(GLOBAL);
    const { event, token } = await makeEvent();
    const photoId = await addPhoto(event, 'managed.gif', gif, 'image/gif');
    expect(await generator.generateForPhoto(photoId)).toMatchObject({ success: true });

    const spy = jest.spyOn(watermarkService, 'applyWatermark');
    const res = await binary(request(app).get(`/api/gallery/${event.slug}/photo/${photoId}`)
      .set('Authorization', `Bearer ${token}`)).expect(200);
    expect(spy).not.toHaveBeenCalled();
    expect(isJpeg(res.body)).toBe(true);
    expect(res.headers['content-type']).toBe('image/jpeg');
  });

  test('a stored watermark that kept the original GIF bytes stays labelled GIF', async () => {
    withGlobal(GLOBAL);
    const { event, token } = await makeEvent();
    const photoId = await addPhoto(event, 'untouched.gif', gif, 'image/gif');
    // applyWatermark hands back the original when it has nothing to draw.
    const original = jest.spyOn(watermarkService, 'applyWatermark').mockResolvedValue(gif);
    expect(await generator.generateForPhoto(photoId)).toMatchObject({ success: true });
    original.mockRestore();

    const spy = jest.spyOn(watermarkService, 'applyWatermark');
    const res = await binary(request(app).get(`/api/gallery/${event.slug}/photo/${photoId}`)
      .set('Authorization', `Bearer ${token}`)).expect(200);
    expect(spy).not.toHaveBeenCalled();
    expect(res.body.subarray(0, 3).toString()).toBe('GIF');
    expect(res.headers['content-type']).toBe('image/gif');
  });

  test('an unwatermarked external HEIC carries the resolved type, not sendFile\'s guess', async () => {
    withGlobal({ ...GLOBAL, enabled: false });
    const { event, token } = await makeEvent();
    // The bytes are never decoded on this path; only the label is checked.
    const photoId = await addPhoto(event, 'phone.heic', png, 'image/heic', { external: true });

    const res = await request(app).get(`/api/gallery/${event.slug}/photo/${photoId}`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.headers['content-type']).toBe('image/heic');
  });
});
