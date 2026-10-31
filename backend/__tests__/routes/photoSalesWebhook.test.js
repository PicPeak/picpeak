/**
 * Photo sales: the money path. The Snipcart webhook grants a purchase link
 * only for a paid order of signed, sellable photos of a gallery that is on
 * sale, at the price and in the currency the database says; it refunds and
 * records anything else, and revokes a granted order that Snipcart later
 * reports refunded (even partly), charged back or cancelled. The price check
 * answers the database price for signed photos only.
 *
 * Snipcart is stubbed at fetch: request-token validation, the order read
 * (the source of truth) and the refund call.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-sales-webhook-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'sales-webhook-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-sales-webhook-storage-'));
process.env.SNIPCART_SECRET_API_KEY = 'sk_test_webhook';

jest.mock('../../src/services/emailProcessor', () => ({
  ...jest.requireActual('../../src/services/emailProcessor'),
  queueEmail: jest.fn(async () => undefined),
}));
jest.mock('../../src/utils/frontendUrl', () => ({
  getFrontendBaseUrl: async () => 'https://photos.example.com',
  getFrontendBaseUrlSync: () => 'https://photos.example.com',
}));
jest.mock('../../src/services/galleryPauseService', () => {
  const actual = jest.requireActual('../../src/services/galleryPauseService');
  return { ...actual, lockGallery: jest.fn(actual.lockGallery) };
});

const crypto = require('crypto');
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const { signPhotoSale } = require('../../src/modules/photoSales/sellable');
const { queueEmail } = require('../../src/services/emailProcessor');

// Snipcart, as far as these routes can see it.
const snipcart = { tokenValid: true, refundOk: true, orders: new Map(), refunds: [] };
global.fetch = jest.fn(async (url, init = {}) => {
  if (url.includes('/api/requestvalidation/')) {
    return { ok: snipcart.tokenValid, status: snipcart.tokenValid ? 200 : 401 };
  }
  const match = url.match(/^https:\/\/app\.snipcart\.com\/api\/orders\/([^/]+)(\/refunds)?$/);
  if (match && match[2]) {
    snipcart.refunds.push({ token: decodeURIComponent(match[1]), body: JSON.parse(init.body) });
    return { ok: snipcart.refundOk, status: snipcart.refundOk ? 201 : 500 };
  }
  if (match) {
    const order = snipcart.orders.get(decodeURIComponent(match[1]));
    return order ? { ok: true, status: 200, json: async () => order } : { ok: false, status: 404 };
  }
  throw new Error(`unexpected fetch ${url}`);
});

describe('photo sales webhook and price check', () => {
  let db; let cleanup; let app;
  const ids = {};
  let orderSeq = 0;

  const insertEvent = async (slug, extra = {}) => {
    const row = await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: `Sales ${slug}`,
      event_date: '2026-10-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: `/gallery/${slug}/s`,
      share_token: `${slug}-share`,
      expires_at: new Date(Date.now() + 30 * 864e5).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      require_password: 1,
      allow_downloads: 1,
      is_priced: 1,
      photo_price: 5,
      free_photo_count: 0,
      created_at: new Date().toISOString(),
      ...extra,
    }).returning('id');
    return row[0]?.id ?? row[0];
  };

  const insertPhoto = async (eventId, filename, extra = {}) => {
    const row = await db('photos').insert({
      event_id: eventId,
      filename,
      path: `x/${filename}`,
      type: 'individual',
      source_origin: 'managed',
      media_type: 'image',
      mime_type: 'image/jpeg',
      uploaded_at: new Date().toISOString(),
      ...extra,
    }).returning('id');
    return row[0]?.id ?? row[0];
  };

  const line = (slug, photoId, { sig = signPhotoSale(photoId), quantity = 1 } = {}) => ({
    id: `${slug}-photo-${photoId}`,
    quantity,
    url: `https://photos.example.com/api/gallery/${slug}/price-check?photoId=${photoId}${sig ? `&sig=${sig}` : ''}`,
    customFields: [{ name: 'photoId', value: String(photoId) }],
  });

  /** An order as Snipcart's API returns it; registered so the webhook can read it. */
  const snipcartOrder = (lines, overrides = {}) => {
    orderSeq += 1;
    const order = {
      token: `order-${orderSeq}`,
      email: 'buyer@example.com',
      currency: 'eur',
      paymentStatus: 'Paid',
      status: 'Processed',
      discounts: [],
      items: lines,
      total: 5 * lines.length,
      ...overrides,
    };
    snipcart.orders.set(order.token, order);
    return order;
  };

  const deliver = (eventName, token, headers = { 'x-snipcart-requesttoken': 'valid-token' }) => request(app)
    .post('/api/gallery/snipcart-webhook')
    .set({ 'Content-Type': 'application/json', ...headers })
    .send(JSON.stringify({ eventName, mode: 'Live', content: { token } }));

  const stored = (token) => db('photo_purchase_orders').where({ order_id: token }).first();

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    ids.event = await insertEvent('on-sale');
    ids.photo = await insertPhoto(ids.event, 'a.jpg');
    ids.photo2 = await insertPhoto(ids.event, 'b.jpg', { photo_price: 2.5 });
    ids.hidden = await insertPhoto(ids.event, 'hidden.jpg', { visibility: 'hidden' });
    ids.pending = await insertPhoto(ids.event, 'pending.jpg', { visibility: 'hidden', moderation_status: 'pending' });
    ids.video = await insertPhoto(ids.event, 'clip.mp4', { media_type: 'video', mime_type: 'video/mp4' });

    ids.inactive = await insertEvent('closed', { is_active: 0, allow_downloads: 0 });
    ids.inactivePhoto = await insertPhoto(ids.inactive, 'c.jpg');
    ids.expired = await insertEvent('expired', { expires_at: new Date(Date.now() - 864e5).toISOString() });
    ids.expiredPhoto = await insertPhoto(ids.expired, 'd.jpg');

    app = express();
    // Mounted like server.js: the webhook ahead of the body parsers.
    app.use('/api/gallery', require('../../src/routes/gallery/snipcartWebhook'));
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(() => {
    snipcart.tokenValid = true;
    snipcart.refundOk = true;
    snipcart.refunds = [];
    queueEmail.mockClear();
  });

  describe('authentication', () => {
    it('refuses a request without a valid Snipcart request token', async () => {
      snipcart.tokenValid = false;
      const order = snipcartOrder([line('on-sale', ids.photo)]);
      const res = await deliver('order.completed', order.token);
      expect(res.status).toBe(401);
      expect(await stored(order.token)).toBeUndefined();
    });

    it('never accepts the development HMAC in production', async () => {
      snipcart.tokenValid = false;
      process.env.SNIPCART_WEBHOOK_SECRET = 'dev-secret';
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const body = JSON.stringify({
          eventName: 'order.completed',
          content: { ...snipcartOrder([line('on-sale', ids.photo)]), token: 'forged-1' },
        });
        const signature = crypto.createHmac('sha256', 'dev-secret').update(body).digest('hex');
        const res = await request(app).post('/api/gallery/snipcart-webhook')
          .set({ 'Content-Type': 'application/json', 'x-snipcart-signature': signature })
          .send(body);
        expect(res.status).toBe(401);
        expect(await stored('forged-1')).toBeUndefined();
      } finally {
        process.env.NODE_ENV = previous;
        delete process.env.SNIPCART_WEBHOOK_SECRET;
      }
    });
  });

  describe('granting', () => {
    it.each([true, false])('uses the locked gallery snapshot for the email when paused becomes %s before settlement', async (paused) => {
      const slug = `email-race-${paused}`;
      const eventId = await insertEvent(slug, { temporarily_disabled: !paused });
      const photoId = await insertPhoto(eventId, 'email-race.jpg');
      const cutoff = new Date(Date.now() + 2 * 864e5).toISOString();
      const { lockGallery } = require('../../src/services/galleryPauseService');
      lockGallery.mockImplementationOnce(async (trx, id) => {
        // The initial validation has read the old state. Model an admin save
        // committed before the settlement acquires its gallery lock.
        await trx('events').where({ id }).update({ temporarily_disabled: paused, expires_at: cutoff,
          event_name: 'Updated gallery', temporarily_disabled_at: paused ? new Date().toISOString() : null });
        return jest.requireActual('../../src/services/galleryPauseService').lockGallery(trx, id);
      });
      const order = snipcartOrder([line(slug, photoId)]);
      await deliver('order.completed', order.token).expect(200);
      expect((await stored(order.token)).status).toBe('completed');
      expect(snipcart.refunds).toHaveLength(0);
      expect(queueEmail).toHaveBeenCalledTimes(1);
      expect(queueEmail.mock.calls[0].slice(0, 3)).toEqual([null, order.email,
        paused ? 'photo_purchase_paused' : 'photo_purchase_access']);
      expect(queueEmail.mock.calls[0][3]).toMatchObject({ gallery_name: 'Updated gallery', expires_at: cutoff });
      if (paused) expect(queueEmail.mock.calls[0][3].expiry_date).toEqual(expect.anything());
      else expect(queueEmail.mock.calls[0][3].expiry_date).toBeUndefined();
      if (paused) expect(new Date(queueEmail.mock.calls[0][3].expiry_date).toISOString()).toBe(cutoff);
    });

    it('honours a valid in-flight purchase while paused, confirms it without file links, and never refunds for the pause', async () => {
      const purchasedAt = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(purchasedAt);
      try {
        const eventId = await insertEvent('paused-checkout', { temporarily_disabled: true,
          temporarily_disabled_at: new Date(purchasedAt - 3600e3).toISOString(), purchase_access_days: 1 });
        const photoId = await insertPhoto(eventId, 'paused.jpg');
        await request(app).get(`/api/gallery/paused-checkout/price-check?photoId=${photoId}&sig=${signPhotoSale(photoId)}`).expect(403);
        await db('app_settings').insert({ setting_key: 'branding_support_email', setting_value: JSON.stringify('help@example.test'), setting_type: 'branding' })
          .onConflict('setting_key').merge();
        const order = snipcartOrder([line('paused-checkout', photoId)]);
        await deliver('order.completed', order.token).expect(200);
        await deliver('order.completed', order.token).expect(200);
        const granted = await stored(order.token);
        expect(granted.status).toBe('completed');
        expect(snipcart.refunds).toHaveLength(0);
        expect(await db('photo_purchases').where({ order_id: order.token })).toHaveLength(1);
        expect(queueEmail).toHaveBeenCalledTimes(1);
        expect(queueEmail.mock.calls[0].slice(0, 3)).toEqual([null, order.email, 'photo_purchase_paused']);
        expect(queueEmail.mock.calls[0][3]).toMatchObject({ support_email: 'help@example.test' });

        const page = await request(app).get(`/api/gallery/purchased-downloads/${granted.access_token}`).expect(200);
        expect(page.body).toMatchObject({ temporarily_disabled: true, order_id: order.token, photo_count: 1,
          support_email: 'help@example.test', expires_at: granted.expires_at, photos: [] });
        expect(page.body.download_url).toBeUndefined();
        expect(page.headers['cache-control']).toContain('no-store');
        const denied = await request(app).get(`/api/gallery/purchased-downloads/${granted.access_token}/photos/${photoId}`).expect(403);
        expect(denied.body.code).toBe('GALLERY_TEMPORARILY_DISABLED');

        clock.mockReturnValue(purchasedAt + 2 * 864e5);
        // The buyer's original day of access is preserved even after its raw
        // deadline passes during the pause. Only time since this grant counts.
        const paused = await request(app).get(`/api/gallery/purchased-downloads/${granted.access_token}`).expect(200);
        expect(paused.body.expires_at).toBe(new Date(purchasedAt + 3 * 864e5).toISOString());
        const { updateGalleryAvailability } = require('../../src/services/galleryPauseService');
        await updateGalleryAvailability(eventId, { temporarily_disabled: false }, (trx, patch) =>
          trx('events').where({ id: eventId }).update(patch));
        await request(app).get(`/api/gallery/paused-checkout/price-check?photoId=${photoId}&sig=${signPhotoSale(photoId)}`).expect(200);
        const restored = await request(app).get(`/api/gallery/purchased-downloads/${granted.access_token}`).expect(200);
        expect(restored.body.photos.map((photo) => photo.id)).toEqual([photoId]);
        expect((await stored(order.token)).expires_at).toBe(new Date(purchasedAt + 3 * 864e5).toISOString());
      } finally { clock.mockRestore(); }
    });

    it('grants a paid order read from Snipcart, and keeps the token out of the response', async () => {
      const order = snipcartOrder([line('on-sale', ids.photo), line('on-sale', ids.photo2)], { total: 7.5 });
      const res = await deliver('order.completed', order.token);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      const row = await stored(order.token);
      expect(row).toMatchObject({ status: 'completed', total_cents: 750, currency: 'EUR' });
      const purchases = await db('photo_purchases').where({ order_id: order.token }).orderBy('photo_id');
      expect(purchases.map((p) => [p.photo_id, p.amount_cents])).toEqual([[ids.photo, 500], [ids.photo2, 250]]);
      expect(queueEmail).toHaveBeenCalledTimes(1);

      const page = await request(app).get(`/api/gallery/purchased-downloads/${row.access_token}`);
      expect(page.status).toBe(200);
      expect(page.body.photo_ids.sort()).toEqual([ids.photo, ids.photo2].sort());
    });

    it('still refunds an invalid payment during a pause', async () => {
      const eventId = await insertEvent('invalid-paused', { temporarily_disabled: true });
      const photoId = await insertPhoto(eventId, 'invalid-paused.jpg');
      const order = snipcartOrder([line('invalid-paused', photoId)], { total: 0.01 });
      await deliver('order.completed', order.token).expect(200);
      expect((await stored(order.token)).status).toBe('refunded');
      expect(snipcart.refunds).toHaveLength(1);
      expect(queueEmail).not.toHaveBeenCalled();
    });

    it('trusts Snipcart over the webhook body', async () => {
      const order = snipcartOrder([line('on-sale', ids.photo)], { total: 0.01 });
      // The body claims the right total; the order Snipcart holds does not.
      const res = await request(app).post('/api/gallery/snipcart-webhook')
        .set({ 'Content-Type': 'application/json', 'x-snipcart-requesttoken': 'valid-token' })
        .send(JSON.stringify({ eventName: 'order.completed', content: { ...order, total: 5 } }));
      expect(res.status).toBe(200);
      expect(await stored(order.token)).toMatchObject({ status: 'refunded' });
    });

    it('creates nothing on a duplicate delivery', async () => {
      const order = snipcartOrder([line('on-sale', ids.photo)]);
      await deliver('order.completed', order.token).expect(200);
      await deliver('order.completed', order.token).expect(200);
      expect(await db('photo_purchase_orders').where({ order_id: order.token })).toHaveLength(1);
      expect(await db('photo_purchases').where({ order_id: order.token })).toHaveLength(1);
      expect(queueEmail).toHaveBeenCalledTimes(1);
    });

    it('never grants access past the gallery\'s expiry', async () => {
      const galleryEnd = new Date(Date.now() + 2 * 864e5).toISOString();
      const eventId = await insertEvent('ends-soon', { expires_at: galleryEnd, purchase_access_days: 30 });
      const photoId = await insertPhoto(eventId, 'e.jpg');
      const order = snipcartOrder([line('ends-soon', photoId)]);
      await deliver('order.completed', order.token).expect(200);

      expect(await stored(order.token)).toMatchObject({ status: 'completed', expires_at: galleryEnd });
      const rows = await db('photo_purchases').where({ order_id: order.token });
      expect(rows.map((r) => r.expires_at)).toEqual([galleryEnd]);
    });

    it('answers 502 when the order cannot be read from Snipcart, so it is delivered again', async () => {
      const res = await deliver('order.completed', 'unknown-order');
      expect(res.status).toBe(502);
      expect(await stored('unknown-order')).toBeUndefined();
    });
  });

  describe('payment status', () => {
    it('waits for a deferred payment and grants it once Snipcart reports it paid', async () => {
      const order = snipcartOrder([line('on-sale', ids.photo)], { paymentStatus: 'Deferred' });
      await deliver('order.completed', order.token).expect(200);
      expect(await stored(order.token)).toBeUndefined();

      order.paymentStatus = 'Paid';
      await deliver('order.paymentStatus.changed', order.token).expect(200);
      expect(await stored(order.token)).toMatchObject({ status: 'completed' });
    });

    it.each([
      ['Refunded', 'order.paymentStatus.changed', 'refunded'],
      ['ChargedBack', 'order.paymentStatus.changed', 'charged_back'],
      ['Cancelled', 'order.status.changed', 'cancelled'],
    ])('revokes a granted order whose payment becomes %s', async (paymentStatus, eventName, status) => {
      const order = snipcartOrder([line('on-sale', ids.photo)]);
      await deliver('order.completed', order.token).expect(200);
      const granted = await stored(order.token);

      if (eventName === 'order.status.changed') order.status = 'Cancelled';
      else order.paymentStatus = paymentStatus;
      await deliver(eventName, order.token).expect(200);

      expect(await stored(order.token)).toMatchObject({ status });
      const page = await request(app).get(`/api/gallery/purchased-downloads/${granted.access_token}`);
      expect(page.status).toBe(403);
      const file = await request(app).get(`/api/gallery/purchased-downloads/${granted.access_token}/photos/${ids.photo}`);
      expect(file.status).toBe(403);
      // The in-gallery purchase token runs on the purchase rows: expired too.
      const rows = await db('photo_purchases').where({ order_id: order.token });
      expect(rows.every((r) => new Date(r.expires_at).getTime() <= Date.now())).toBe(true);
    });
  });

  it('revokes a granted order that Snipcart refunds in part', async () => {
    const order = snipcartOrder([line('on-sale', ids.photo), line('on-sale', ids.photo2)], { total: 7.5 });
    await deliver('order.completed', order.token).expect(200);
    const granted = await stored(order.token);

    // A partial refund leaves the payment status at Paid.
    order.refundsAmount = 2.5;
    await deliver('order.refund.created', order.token).expect(200);

    expect(await stored(order.token)).toMatchObject({ status: 'refunded' });
    const page = await request(app).get(`/api/gallery/purchased-downloads/${granted.access_token}`);
    expect(page.status).toBe(403);
  });

  describe('the audit refunds and records what it refuses', () => {
    const expectRefused = async (order) => {
      await deliver('order.completed', order.token).expect(200);
      const row = await stored(order.token);
      expect(row).toMatchObject({ status: 'refunded' });
      expect(await db('photo_purchases').where({ order_id: order.token })).toHaveLength(0);
      expect(snipcart.refunds).toContainEqual(expect.objectContaining({ token: order.token }));
      expect(queueEmail).not.toHaveBeenCalled();
      return row;
    };

    it('a total that differs from the database price', async () => {
      const order = snipcartOrder([line('on-sale', ids.photo)], { total: 1 });
      await expectRefused(order);
      expect(snipcart.refunds[0].body.amount).toBe(1);
    });

    it('another currency, even at the nominal amount', async () => {
      await expectRefused(snipcartOrder([line('on-sale', ids.photo)], { currency: 'jpy' }));
    });

    it.each([
      ['a client-only photo', 'hidden'],
      ['a photo under review', 'pending'],
      ['a video', 'video'],
    ])('%s', async (_label, key) => {
      await expectRefused(snipcartOrder([line('on-sale', ids[key])]));
    });

    it('a line without a valid sale signature', async () => {
      await expectRefused(snipcartOrder([line('on-sale', ids.photo, { sig: null })]));
      await expectRefused(snipcartOrder([line('on-sale', ids.photo, { sig: signPhotoSale(ids.photo2) })]));
    });

    it('a photo of another gallery named in this gallery\'s URL', async () => {
      await expectRefused(snipcartOrder([line('on-sale', ids.inactivePhoto)]));
    });

    it('two copies of one photo', async () => {
      await expectRefused(snipcartOrder([line('on-sale', ids.photo, { quantity: 2 })], { total: 10 }));
    });

    it.each([['inactive', 'closed', 'inactivePhoto'], ['expired', 'expired', 'expiredPhoto']])(
      'a gallery that is %s',
      async (_label, slug, photoKey) => {
        await expectRefused(snipcartOrder([line(slug, ids[photoKey])]));
      }
    );

    it('records a refund that Snipcart did not accept', async () => {
      snipcart.refundOk = false;
      const order = snipcartOrder([line('on-sale', ids.photo)], { total: 1 });
      await deliver('order.completed', order.token).expect(200);
      expect(await stored(order.token)).toMatchObject({ status: 'refund_failed' });
    });

    it('never records a refund it did not make', async () => {
      const order = snipcartOrder([line('on-sale', ids.photo, { sig: null })], { total: undefined });
      await deliver('order.completed', order.token).expect(200);
      expect(await stored(order.token)).toMatchObject({ status: 'refund_failed' });
      expect(snipcart.refunds).toHaveLength(0);
    });

    it('refunds a refused order once when two deliveries race', async () => {
      const order = snipcartOrder([line('on-sale', ids.photo)], { total: 1 });
      const results = await Promise.all([
        deliver('order.completed', order.token),
        deliver('order.paymentStatus.changed', order.token),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect(snipcart.refunds.filter((r) => r.token === order.token)).toHaveLength(1);
      expect(await stored(order.token)).toMatchObject({ status: 'refunded' });
    });
  });

  describe('price check', () => {
    const check = (slug, photoId, sig = signPhotoSale(photoId)) => request(app)
      .get(`/api/gallery/${slug}/price-check`)
      .query(sig ? { photoId, sig } : { photoId });

    it('answers the database price of a signed sellable photo', async () => {
      const res = await check('on-sale', ids.photo2);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: `on-sale-photo-${ids.photo2}`, price: 2.5, customFields: [] });
      expect(res.body).not.toHaveProperty('valid');
    });

    it('refuses an unsigned or wrongly signed photo', async () => {
      expect((await check('on-sale', ids.photo, null)).status).toBe(403);
      expect((await check('on-sale', ids.photo, signPhotoSale(ids.photo2))).status).toBe(403);
    });

    it('does not validate photos that are not for sale', async () => {
      for (const key of ['hidden', 'pending', 'video', 'inactivePhoto']) {
        expect((await check('on-sale', ids[key])).status).toBe(404);
      }
    });

    it('refuses galleries that are not on sale', async () => {
      expect((await check('closed', ids.inactivePhoto)).status).toBe(403);
      expect((await check('expired', ids.expiredPhoto)).status).toBe(403);
    });
  });
});
