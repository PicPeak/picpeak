/**
 * Photo sales: before checkout, no photo of a priced gallery leaves the
 * server without the forced tiled mark, whatever the global watermark
 * setting says. Every route that renders a photo id at a viewable size is
 * covered (/hero included: it renders ANY photo id at 1920px), and a failed
 * mark never becomes the stored sales preview.
 */
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'sales-lock-test-secret';

const GLOBAL_OFF = { enabled: false, logoPath: null, position: 'bottom-right', opacity: 50, size: 15, companyName: 'Studio' };

describe('priced gallery media lock', () => {
  let db; let cleanup; let app; let jpeg;
  let watermarkService; let salesRenditions;
  let drawn;
  let event; let photoId; let token;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    watermarkService = require('../../src/services/watermarkService');
    salesRenditions = require('../../src/modules/photoSales/salesRenditions');
    jpeg = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: { r: 120, g: 160, b: 200 } } }).jpeg().toBuffer();

    const slug = 'sales-lock';
    const inserted = await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: 'Sales Lock',
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${slug}/share`,
      share_token: 'sales-lock-share',
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      allow_downloads: 1,
      is_priced: 1,
      photo_price: 5,
      created_at: new Date().toISOString(),
    }).returning('id');
    const id = inserted[0]?.id ?? inserted[0];
    const dir = path.join(process.env.STORAGE_PATH, 'events', 'active', slug);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'photo.jpg'), jpeg);
    const p = await db('photos').insert({
      event_id: id,
      filename: 'photo.jpg',
      path: `${slug}/photo.jpg`,
      type: 'individual',
      media_type: 'image',
      mime_type: 'image/jpeg',
      size_bytes: jpeg.length,
      uploaded_at: new Date().toISOString(),
    }).returning('id');
    photoId = p[0]?.id ?? p[0];
    event = await db('events').where({ id }).first();
    token = jwt.sign(
      { eventId: event.id, eventSlug: event.slug, type: 'gallery', accessLevel: 'guest' },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' }
    );

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
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
    jest.spyOn(watermarkService, 'getWatermarkSettings').mockResolvedValue({ ...GLOBAL_OFF });
    watermarkService.clearCache();
  });
  afterEach(() => jest.restoreAllMocks());

  const get = (url) => request(app).get(url).set('Authorization', `Bearer ${token}`);
  const expectForcedMark = () => {
    expect(drawn.length).toBeGreaterThanOrEqual(1);
    for (const settings of drawn) expect(settings).toMatchObject({ enabled: true, tiled: true });
  };

  test('the hero route marks any photo id with the global watermark off', async () => {
    const res = await get(`/api/gallery/${event.slug}/hero/${photoId}`);
    expect(res.status).toBe(200);
    expect(res.headers['x-hero-image']).toBe('true');
    expectForcedMark();
  });

  test('the preview and thumbnail routes mark the photo', async () => {
    // A no-op background job, so the test sees the on-the-fly render.
    jest.spyOn(salesRenditions, 'generateSalesPreviewForPhoto').mockResolvedValue({ success: false });
    expect((await get(`/api/gallery/${event.slug}/preview/${photoId}`)).status).toBe(200);
    expect((await get(`/api/gallery/${event.slug}/thumbnail/${photoId}`)).status).toBe(200);
    expectForcedMark();
  });

  test('the full-size photo route sends a guest to the marked preview', async () => {
    const res = await get(`/api/gallery/${event.slug}/photo/${photoId}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/api/gallery/${event.slug}/preview/${photoId}`);
  });

  test('a single download before checkout is the marked preview', async () => {
    const res = await get(`/api/gallery/${event.slug}/download/${photoId}`).buffer(true);
    expect(res.status).toBe(200);
    expectForcedMark();
    const { width } = await sharp(res.body).metadata();
    expect(width).toBeLessThan(2400);
  });

  test('a failed mark is never stored as the sales preview', async () => {
    watermarkService.applyWatermark.mockImplementation(async (input, settings, opts) => {
      drawn.push(settings);
      // What the old fail-open path did: hand back the clean input. Only a
      // fail-closed caller is allowed to see the error instead.
      if (opts?.failClosed) throw new Error('composite failed');
      return Buffer.isBuffer(input) ? input : fs.promises.readFile(input);
    });
    await db('photos').where({ id: photoId }).update({ photo_sales_preview_key: null, photo_sales_preview_path: null });

    const result = await salesRenditions.generateSalesPreviewForPhoto(photoId);

    expect(result.success).toBe(false);
    const row = await db('photos').where({ id: photoId }).first('photo_sales_preview_key', 'photo_sales_preview_path');
    expect(row).toEqual({ photo_sales_preview_key: null, photo_sales_preview_path: null });
  });
});
