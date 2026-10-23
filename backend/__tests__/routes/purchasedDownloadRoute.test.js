/**
 * Photo sales: the emailed purchase link must download the bought originals
 * on its own. Buyers open that email on whatever device they read mail on,
 * which has usually never logged into the gallery, so the download cannot go
 * through the gallery routes (they answer 401 without a gallery session).
 *
 * GET /api/gallery/purchased-downloads/:accessToken/photos/:photoId is
 * authorized by the purchase link alone, and only for photos of that order
 * while the order and the photo's purchase row are unexpired.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-purchase-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'purchase-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-purchase-storage-'));

const { Readable } = require('stream');

const SLUG = 'priced-gallery';
const TOKEN = 'a'.repeat(48);
const EXPIRED_TOKEN = 'b'.repeat(48);
const mockOriginal = Buffer.from('ORIGINAL-BYTES-of-the-bought-photo');

const mockStorage = {
  kind: () => 's3',
  stat: jest.fn(async () => ({ size: mockOriginal.length, mtime: new Date('2026-10-01T10:00:00Z') })),
  get: jest.fn(async () => Readable.from([mockOriginal])),
  delete: jest.fn(async () => undefined),
  exists: jest.fn(async () => true),
};

jest.mock('../../src/services/storage', () => ({
  getStorage: () => mockStorage,
  initStorage: async () => mockStorage,
}));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const binary = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('purchased photo download by purchase link', () => {
  let db; let cleanup; let app; let boughtId; let otherId; let trashedId;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const ev = await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Priced',
      event_date: '2026-10-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/s`,
      share_token: 'priced-share',
      expires_at: new Date(Date.now() + 30 * 864e5).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      require_password: 1,
      allow_downloads: 1,
      is_priced: 1,
      photo_price: 5,
      created_at: new Date().toISOString(),
    }).returning('id');
    const eventId = ev[0]?.id ?? ev[0];

    const insertPhoto = async (filename, extra = {}) => {
      const row = await db('photos').insert({
        event_id: eventId,
        filename,
        path: `${SLUG}/${filename}`,
        type: 'individual',
        source_origin: 'managed',
        mime_type: 'image/jpeg',
        uploaded_at: new Date().toISOString(),
        ...extra,
      }).returning('id');
      return row[0]?.id ?? row[0];
    };
    boughtId = await insertPhoto('bought.jpg');
    otherId = await insertPhoto('other.jpg');
    trashedId = await insertPhoto('trashed.jpg', { deleted_at: new Date().toISOString() });

    const future = new Date(Date.now() + 7 * 864e5).toISOString();
    const past = new Date(Date.now() - 864e5).toISOString();
    const order = (orderId, token, expiresAt) => ({
      order_id: orderId,
      gallery_id: eventId,
      buyer_email: 'buyer@example.com',
      total_cents: 500,
      currency: 'EUR',
      status: 'completed',
      purchased_at: new Date().toISOString(),
      expires_at: expiresAt,
      access_token: token,
    });
    const purchase = (orderId, token, photoId, expiresAt) => ({
      order_id: orderId,
      gallery_id: eventId,
      photo_id: photoId,
      buyer_email: 'buyer@example.com',
      purchased_at: new Date().toISOString(),
      expires_at: expiresAt,
      access_token: token,
      amount_cents: 500,
    });
    await db('photo_purchase_orders').insert([order('order-1', TOKEN, future), order('order-2', EXPIRED_TOKEN, past)]);
    await db('photo_purchases').insert([
      purchase('order-1', TOKEN, boughtId, future),
      purchase('order-1', TOKEN, trashedId, future),
      purchase('order-2', EXPIRED_TOKEN, boughtId, past),
    ]);

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('downloads the bought original without any gallery session', async () => {
    const res = await request(app)
      .get(`/api/gallery/purchased-downloads/${TOKEN}/photos/${boughtId}`)
      .buffer(true)
      .parse(binary);

    expect(res.status).toBe(200);
    expect(res.body.equals(mockOriginal)).toBe(true);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(mockStorage.get).toHaveBeenCalledWith(`events/active/${SLUG}/bought.jpg`);
  });

  it('lists the purchase-link download URL on the purchase page', async () => {
    const res = await request(app).get(`/api/gallery/purchased-downloads/${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.photos.map((p) => p.photo_url))
      .toEqual([`/api/gallery/purchased-downloads/${TOKEN}/photos/${boughtId}`]);
  });

  it('refuses a photo of the gallery that this order did not buy', async () => {
    const res = await request(app).get(`/api/gallery/purchased-downloads/${TOKEN}/photos/${otherId}`);
    expect(res.status).toBe(403);
  });

  it('refuses an expired purchase link', async () => {
    const res = await request(app).get(`/api/gallery/purchased-downloads/${EXPIRED_TOKEN}/photos/${boughtId}`);
    expect(res.status).toBe(403);
  });

  it('refuses an unknown purchase link', async () => {
    const res = await request(app).get(`/api/gallery/purchased-downloads/${'c'.repeat(48)}/photos/${boughtId}`);
    expect(res.status).toBe(403);
  });

  it('does not hand out a photo that was moved to the trash', async () => {
    const res = await request(app).get(`/api/gallery/purchased-downloads/${TOKEN}/photos/${trashedId}`);
    expect(res.status).toBe(404);
  });
});
