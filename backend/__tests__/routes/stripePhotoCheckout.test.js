'use strict';

const crypto = require('crypto');
const Stripe = require('stripe');
const express = require('express');
const request = require('supertest');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

process.env.TEST_DATABASE_PATH = require('path').join(require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'picpeak-stripe-route-')), 'test.sqlite');
process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.STRIPE_SECRET_KEY = ['rk', 'test', crypto.randomBytes(18).toString('hex')].join('_');
process.env.STRIPE_WEBHOOK_SECRET = crypto.randomBytes(32).toString('hex');

jest.mock('../../src/services/emailProcessor', () => ({ queueEmail: jest.fn(async () => true) }));
jest.mock('../../src/utils/frontendUrl', () => ({ getFrontendBaseUrl: async () => 'https://photos.example.test' }));
jest.mock('../../src/modules/photoSales/stripeClient', () => ({
  ...jest.requireActual('../../src/modules/photoSales/stripeClient'),
  stripeClient: () => mockStripe,
}));

const { queueEmail } = require('../../src/services/emailProcessor');
const { reconcileWebhook } = require('../../src/modules/photoSales/stripeCheckout');
const sdk = new Stripe(process.env.STRIPE_SECRET_KEY);
const sessions = new Map();
const payments = new Map();
const idempotency = new Map();
const mockStripe = {
  webhooks: sdk.webhooks,
  checkout: { sessions: {
    create: jest.fn(async (body, options) => {
      if (idempotency.has(options.idempotencyKey)) return sessions.get(idempotency.get(options.idempotencyKey));
      const id = `cs_${crypto.randomUUID()}`;
      const session = {
        id, status: 'open', payment_status: 'unpaid', payment_intent: null, livemode: false, mode: 'payment',
        currency: 'eur', metadata: body.metadata, customer_details: { email: 'buyer@example.test' },
        amount_total: body.line_items.reduce((sum, item) => sum + item.price_data.unit_amount, 0),
        url: `https://checkout.stripe.com/c/pay/${id}`,
      };
      sessions.set(id, session);
      idempotency.set(options.idempotencyKey, id);
      return session;
    }),
    retrieve: jest.fn(async (id) => {
      const session = sessions.get(id);
      if (!session) throw new Error('Unknown session');
      return { ...session, payment_intent: typeof session.payment_intent === 'string' ? payments.get(session.payment_intent) : session.payment_intent };
    }),
    expire: jest.fn(async (id) => {
      const session = sessions.get(id);
      if (session.status !== 'open') throw new Error('Already completed');
      session.status = 'expired';
      return session;
    }),
    list: jest.fn(async ({ payment_intent }) => ({ data: [...sessions.values()].filter((s) => !payment_intent || s.payment_intent === payment_intent), has_more: false })),
  } },
  paymentIntents: { retrieve: jest.fn(async (id) => payments.get(id)) },
  charges: { retrieve: jest.fn(async (id) => [...payments.values()].find((p) => p.latest_charge.id === id).latest_charge) },
  refunds: { create: jest.fn(async () => ({ id: crypto.randomUUID(), status: 'succeeded' })), retrieve: jest.fn(async (id) => ({ id, status: 'succeeded' })) },
};

describe('Stripe photo checkout (real routes, migrated database and SDK signature verification)', () => {
  let db; let cleanup; let app; let galleryId; let ids; let gallerySeq = 0; let requestSeq = 0; let browserKey;
  const token = (extra = {}) => jwt.sign({
    type: 'gallery', eventId: galleryId, eventSlug: 'stripe-gallery',
    iat: Math.floor(Date.now() / 1000) - 1, jti: crypto.randomUUID(), ...extra,
  }, process.env.JWT_SECRET, { issuer: 'picpeak-auth', expiresIn: '1h' });
  const post = (body, bearer) => {
    const req = request(app).post('/api/gallery/stripe-gallery/checkout').set('X-Forwarded-For', `198.51.100.${++requestSeq}`);
    return (bearer ? req.set('Authorization', `Bearer ${bearer}`) : req).send({ browserKey, ...body });
  };
  const create = (extra = {}) => post({ photoIds: [ids[0]], checkoutKey: crypto.randomUUID(), ...extra });
  const orderFor = async (response) => {
    const id = response.body.checkout_url.split('/').pop();
    return db('photo_purchase_orders').where({ checkout_session_id: id }).first();
  };
  const pay = async (order, extra = {}) => {
    const session = sessions.get(order.checkout_session_id);
    const payment = {
      id: `pi_${crypto.randomUUID()}`, status: 'succeeded', metadata: session.metadata,
      currency: 'eur', amount_received: session.amount_total,
      latest_charge: { id: `ch_${crypto.randomUUID()}`, amount_refunded: 0, disputed: false },
    };
    payments.set(payment.id, payment);
    Object.assign(session, { status: 'complete', payment_status: 'paid', payment_intent: payment.id }, extra);
    return session;
  };
  const webhook = (type, object, { stale = false, mode = false, invalid = false } = {}) => {
    const payload = JSON.stringify({ id: `evt_${crypto.randomUUID()}`, type, livemode: mode, data: { object } });
    const header = sdk.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET,
      timestamp: Math.floor(Date.now() / 1000) - (stale ? 600 : 0) });
    return request(app).post('/api/photo-sales/stripe/webhook').set('Content-Type', 'application/json')
      .set('stripe-signature', invalid ? `${header}x` : header).send(payload);
  };
  const readOrder = (order) => db('photo_purchase_orders').where({ id: order.id }).first();

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    app = express();
    app.set('trust proxy', 1);
    app.use('/api/photo-sales/stripe/webhook', require('../../src/routes/stripeWebhook'));
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery/stripeCheckout'));
    app.use('/api/photo-checkout', require('../../src/routes/photoCheckout'));
    app.use('/api/gallery', require('../../src/routes/gallery/purchasedDownloads'));
  });
  afterAll(async () => { if (cleanup) await cleanup(); });
  beforeEach(async () => {
    browserKey = crypto.randomBytes(32).toString('hex');
    await db('photo_purchases').del();
    await db('photo_purchase_orders').del();
    await db('events').where('slug', 'stripe-gallery').update({ slug: `old-${++gallerySeq}` });
    const rows = await db('events').insert({
      slug: 'stripe-gallery', event_type: 'wedding', event_name: 'Photo sales', event_date: '2026-10-01',
      host_email: 'host@example.test', admin_email: 'admin@example.test', password_hash: 'x',
      share_link: `/gallery/stripe-gallery/share-${gallerySeq}`, share_token: crypto.randomUUID(),
      expires_at: new Date(Date.now() + 10 * 864e5).toISOString(), is_active: 1, is_archived: 0, is_draft: 0,
      require_password: 0, allow_downloads: 1, is_priced: 1, photo_price: 5, free_photo_count: 0,
    }).returning('id');
    galleryId = rows[0].id;
    ids = [];
    for (let i = 0; i < 3; i++) {
      const inserted = await db('photos').insert({ event_id: galleryId, filename: `photo-${i}.jpg`, original_filename: `Original ${i}.jpg`,
        path: `private/photo-${i}.jpg`, type: 'individual', media_type: 'image', mime_type: 'image/jpeg', processing_status: 'complete' }).returning('id');
      ids.push(inserted[0].id);
    }
    jest.clearAllMocks();
    sessions.clear(); payments.clear(); idempotency.clear();
  });

  test('creates server-priced checkout without exposing credentials or private photo URLs to Stripe', async () => {
    const response = await create({ amount: 1, currency: 'jpy' });
    expect(response.status).toBe(200);
    const order = await orderFor(response);
    expect(order).toMatchObject({ total_cents: 500, currency: 'EUR', status: 'pending', payment_provider: 'stripe' });
    const [body] = mockStripe.checkout.sessions.create.mock.calls[0];
    expect(body.line_items[0].price_data.unit_amount).toBe(500);
    expect(body.payment_method_types).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/private\/|sale_token|Bearer|gallery_token/);
    expect(JSON.stringify(body)).not.toContain(browserKey);
    expect(response.body).not.toHaveProperty('access_token');
  });

  test('requires actual access to a password-protected gallery and rejects slideshow tokens', async () => {
    await db('events').where({ id: galleryId }).update({ require_password: 1 });
    expect((await create()).status).toBe(401);
    expect((await post({ photoIds: [ids[0]], checkoutKey: crypto.randomUUID() }, token())).status).toBe(200);
    expect((await post({ photoIds: [ids[0]], checkoutKey: crypto.randomUUID() }, token({ accessLevel: 'slideshow' }))).status).toBe(403);
  });

  test.each([
    ['hidden', { visibility: 'hidden' }], ['moderated', { moderation_status: 'pending' }],
    ['video', { media_type: 'video' }], ['unprocessed', { processing_status: 'pending' }], ['trashed', { deleted_at: new Date().toISOString() }],
  ])('rejects %s photos before contacting Stripe', async (_, change) => {
    await db('photos').where({ id: ids[0] }).update(change);
    expect((await create()).status).toBe(409);
    expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  test('reuses a checkout key across retries and rejects another cart using it', async () => {
    const key = crypto.randomUUID();
    const first = await create({ checkoutKey: key });
    expect((await create({ checkoutKey: key })).body).toEqual(first.body);
    expect(Number((await db('photo_purchase_orders').count('* as n').first()).n)).toBe(1);
    expect((await create({ checkoutKey: key, photoIds: [ids[1]] })).status).toBe(409);
  });

  test.each([{ stale: true }, { invalid: true }, { mode: true }])('rejects invalid timestamp, signature and mode: %j', async (options) => {
    const order = await orderFor(await create());
    const session = await pay(order);
    expect((await webhook('checkout.session.completed', session, options)).status).toBe(400);
    expect((await readOrder(order)).status).toBe('pending');
  });

  test('a return-page request grants nothing; signed duplicate/concurrent callbacks grant and email once', async () => {
    const order = await orderFor(await create());
    const session = await pay(order);
    expect((await request(app).get(`/api/photo-checkout/${order.checkout_token}`)).status).toBe(404);
    const pending = await request(app).get(`/api/photo-checkout/${order.checkout_token}`).set('X-Photo-Checkout-Key', browserKey);
    expect(pending.body).toMatchObject({ status: 'pending', download_url: null, purchased_photo_ids: [] });
    const responses = await Promise.all([webhook('checkout.session.completed', session), webhook('checkout.session.completed', session)]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(Number((await db('photo_purchases').count('* as n').first()).n)).toBe(1);
    expect(queueEmail).toHaveBeenCalledTimes(1);
    const ready = await request(app).get(`/api/photo-checkout/${order.checkout_token}`).set('X-Photo-Checkout-Key', browserKey);
    expect(ready.body.download_url).toMatch(/^\/purchased-downloads\//);
    expect(ready.body).not.toHaveProperty('buyer_email');
    expect(ready.headers['cache-control']).toContain('no-store');
    expect(responses[0].body).toEqual({ ok: true });
  });

  test('delayed payments wait and are fulfilled only when the authoritative payment succeeds', async () => {
    const order = await orderFor(await create());
    const session = await pay(order, { payment_status: 'unpaid' });
    payments.get(session.payment_intent).status = 'processing';
    expect((await webhook('checkout.session.completed', session)).status).toBe(200);
    expect((await readOrder(order)).status).toBe('processing');
    session.payment_status = 'paid'; payments.get(session.payment_intent).status = 'succeeded';
    expect((await webhook('checkout.session.async_payment_succeeded', session)).status).toBe(200);
    expect((await readOrder(order)).status).toBe('completed');
  });

  test('price edits after checkout preserve the agreed price snapshot and access is capped at gallery expiry', async () => {
    const order = await orderFor(await create());
    await db('events').where({ id: galleryId }).update({ photo_price: 20 });
    const session = await pay(order);
    expect((await webhook('checkout.session.completed', session)).status).toBe(200);
    expect((await readOrder(order)).total_cents).toBe(500);
    const gallery = await db('events').where({ id: galleryId }).first();
    expect(new Date((await readOrder(order)).expires_at).getTime()).toBeLessThanOrEqual(new Date(gallery.expires_at).getTime());
  });

  test.each(['currency', 'amount', 'hidden', 'deleted gallery'])('refuses and records a refund for %s', async (change) => {
    const order = await orderFor(await create());
    const session = await pay(order);
    if (change === 'currency') session.currency = 'jpy';
    if (change === 'amount') session.amount_total = 1;
    if (change === 'hidden') await db('photos').where({ id: ids[0] }).update({ visibility: 'hidden' });
    if (change === 'deleted gallery') await db('events').where({ id: galleryId }).del();
    expect((await webhook('checkout.session.completed', session)).status).toBe(200);
    expect((await readOrder(order)).status).toBe('refunded');
    expect(Number((await db('photo_purchases').count('* as n').first()).n)).toBe(0);
    expect(mockStripe.refunds.create).toHaveBeenCalledWith({ payment_intent: session.payment_intent }, { idempotencyKey: `picpeak-refund:${order.order_id}` });
  });

  test('an API failure records refund_failed, and a redelivery retries without unlocking photos', async () => {
    const order = await orderFor(await create());
    const session = await pay(order);
    await db('photos').where({ id: ids[0] }).update({ visibility: 'hidden' });
    mockStripe.refunds.create.mockRejectedValueOnce(new Error('Temporary provider outage'));
    expect((await webhook('checkout.session.completed', session)).status).toBe(500);
    expect((await readOrder(order)).status).toBe('refund_failed');
    expect((await webhook('checkout.session.completed', session)).status).toBe(200);
    expect((await readOrder(order)).status).toBe('refunded');
  });

  test.each(['refund', 'dispute'])('%s arriving before success prevents any later grant', async (kind) => {
    const order = await orderFor(await create());
    const session = await pay(order);
    const payment = payments.get(session.payment_intent);
    if (kind === 'refund') payment.latest_charge.amount_refunded = 1;
    else payment.latest_charge.disputed = true;
    const event = { type: kind === 'refund' ? 'charge.refunded' : 'charge.dispute.created', data: { object: { payment_intent: payment.id } } };
    await reconcileWebhook(event, mockStripe);
    expect((await webhook('checkout.session.completed', session)).status).toBe(200);
    expect((await readOrder(order)).status).toBe(kind === 'refund' ? 'refunded' : 'charged_back');
    expect(Number((await db('photo_purchases').count('* as n').first()).n)).toBe(0);
  });

  test('partial refund revokes an existing purchase and a late success cannot restore it', async () => {
    const order = await orderFor(await create());
    const session = await pay(order);
    await webhook('checkout.session.completed', session);
    payments.get(session.payment_intent).latest_charge.amount_refunded = 1;
    await webhook('charge.refunded', { payment_intent: session.payment_intent });
    await webhook('checkout.session.completed', session);
    expect((await readOrder(order)).status).toBe('refunded');
    const row = await db('photo_purchases').where({ order_id: order.order_id }).first();
    expect(Date.parse(row.expires_at)).toBeLessThanOrEqual(Date.now());
  });

  test('failed email queue is retried after an already committed purchase', async () => {
    const order = await orderFor(await create()); const session = await pay(order);
    queueEmail.mockRejectedValueOnce(new Error('Queue unavailable'));
    expect((await webhook('checkout.session.completed', session)).status).toBe(500);
    expect((await readOrder(order)).status).toBe('completed');
    expect((await readOrder(order)).email_sent).toBeFalsy();
    expect((await webhook('checkout.session.completed', session)).status).toBe(200);
    expect((await readOrder(order)).email_sent).toBeTruthy();
    expect(Number((await db('photo_purchases').count('* as n').first()).n)).toBe(1);
  });

  test('one-time promo is reserved once, releases only after confirmed expiry, and supports a zero-total purchase', async () => {
    await db('events').where({ id: galleryId }).update({ free_photo_count: 1, promo_code: 'FOTO-ONCE' });
    const first = await create({ promoCode: 'FOTO-ONCE' });
    const order = await orderFor(first);
    expect(order.total_cents).toBe(0);
    expect((await create({ promoCode: 'FOTO-ONCE' })).status).toBe(409);
    expect((await request(app).get(`/api/photo-checkout/${order.checkout_token}?cancelled=1`).set('X-Photo-Checkout-Key', browserKey)).body.status).toBe('pending');
    expect((await create({ promoCode: 'FOTO-ONCE' })).status).toBe(409);
    expect((await request(app).post(`/api/photo-checkout/${order.checkout_token}/cancel`).set('X-Photo-Checkout-Key', browserKey)).status).toBe(200);
    const second = await orderFor(await create({ promoCode: 'FOTO-ONCE' }));
    const session = await pay(second, { payment_status: 'no_payment_required', payment_intent: null });
    expect((await webhook('checkout.session.completed', session)).status).toBe(200);
    expect((await readOrder(second)).status).toBe('completed');
    expect((await readOrder(second)).promo_used).toBeTruthy();
    expect((await create({ promoCode: 'FOTO-ONCE' })).status).toBe(409);
  });

  test('two concurrent promo checkouts cannot both reserve the discount', async () => {
    await db('events').where({ id: galleryId }).update({ free_photo_count: 1, promo_code: 'FOTO-ONCE' });
    const results = await Promise.all([create({ promoCode: 'FOTO-ONCE' }), create({ promoCode: 'FOTO-ONCE' })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  test('a completion racing cancellation is reconciled as paid and keeps the promo spent', async () => {
    await db('events').where({ id: galleryId }).update({ free_photo_count: 1, promo_code: 'FOTO-ONCE' });
    const order = await orderFor(await create({ photoIds: [ids[0], ids[1]], promoCode: 'FOTO-ONCE' }));
    await pay(order);
    expect((await request(app).post(`/api/photo-checkout/${order.checkout_token}/cancel`).set('X-Photo-Checkout-Key', browserKey)).status).toBe(200);
    expect((await readOrder(order)).status).toBe('completed');
    expect((await create({ promoCode: 'FOTO-ONCE' })).status).toBe(409);
  });
  test('recovers an API creation timeout with the same quote and idempotency key', async () => {
    mockStripe.checkout.sessions.create.mockRejectedValueOnce(new Error('Response lost'));
    const key = crypto.randomUUID();
    expect((await create({ checkoutKey: key })).status).toBe(503);
    const uncertain = await db('photo_purchase_orders').where({ checkout_key: key }).first();
    expect(uncertain.status).toBe('creation_unknown');
    expect((await create({ checkoutKey: key })).status).toBe(200);
    expect(mockStripe.checkout.sessions.create.mock.calls[0]).toEqual(mockStripe.checkout.sessions.create.mock.calls[1]);
  });

  test('failed delayed payment releases an unused promo, but does not unlock any photos', async () => {
    await db('events').where({ id: galleryId }).update({ free_photo_count: 1, promo_code: 'FOTO-ONCE' });
    const order = await orderFor(await create({ photoIds: ids, promoCode: 'FOTO-ONCE' }));
    const session = await pay(order, { payment_status: 'unpaid' });
    payments.get(session.payment_intent).status = 'requires_payment_method';
    expect((await webhook('checkout.session.async_payment_failed', session)).status).toBe(200);
    expect((await readOrder(order))).toMatchObject({ status: 'failed', promo_gallery_id: null });
    expect((await create({ promoCode: 'FOTO-ONCE' })).status).toBe(200);
    expect(Number((await db('photo_purchases').count('* as n').first()).n)).toBe(0);
  });

  test('automatic refund remains pending until the provider confirms it succeeded', async () => {
    const order = await orderFor(await create()); const session = await pay(order);
    await db('photos').where({ id: ids[0] }).update({ visibility: 'hidden' });
    const refundId = crypto.randomUUID();
    mockStripe.refunds.create.mockResolvedValueOnce({ id: refundId, status: 'pending' });
    await webhook('checkout.session.completed', session);
    expect((await readOrder(order))).toMatchObject({ status: 'refund_pending', payment_refund_id: refundId });
    await webhook('refund.updated', { payment_intent: session.payment_intent });
    expect(mockStripe.refunds.retrieve).toHaveBeenCalledWith(refundId);
    expect((await readOrder(order)).status).toBe('refunded');
  });

  test('a stale incomplete creation is searched before its reservation is released', async () => {
    await db('events').where({ id: galleryId }).update({ free_photo_count: 1, promo_code: 'FOTO-ONCE' });
    const order = await orderFor(await create({ promoCode: 'FOTO-ONCE' }));
    const quote = JSON.parse(order.checkout_quote);
    quote.sessionExpiresAt = Math.floor(Date.now() / 1000) - 60;
    await db('photo_purchase_orders').where({ id: order.id }).update({
      checkout_session_id: null, status: 'creation_unknown', checkout_quote: JSON.stringify(quote),
      purchased_at: new Date(Date.now() - 65 * 60e3).toISOString(),
    });
    sessions.clear();
    await require('../../src/services/photoCheckoutReconciler').reconcilePhotoCheckouts();
    expect(mockStripe.checkout.sessions.list).toHaveBeenCalled();
    expect((await readOrder(order))).toMatchObject({ status: 'expired', promo_gallery_id: null });
  });

  test('a session created before a crash is recovered rather than replaced', async () => {
    const order = await orderFor(await create()); const session = await pay(order);
    const quote = JSON.parse(order.checkout_quote);
    quote.sessionExpiresAt = Math.floor(Date.now() / 1000) - 60;
    await db('photo_purchase_orders').where({ id: order.id }).update({ checkout_session_id: null,
      status: 'creation_unknown', checkout_quote: JSON.stringify(quote), purchased_at: new Date(Date.now() - 65 * 60e3).toISOString() });
    await require('../../src/services/photoCheckoutReconciler').reconcilePhotoCheckouts();
    expect((await readOrder(order))).toMatchObject({ status: 'completed', checkout_session_id: session.id });
  });

  test('even an expected-free order refunds an unexpected actual charge', async () => {
    await db('events').where({ id: galleryId }).update({ free_photo_count: 1, promo_code: 'FOTO-ONCE' });
    const order = await orderFor(await create({ promoCode: 'FOTO-ONCE' }));
    const session = await pay(order); session.amount_total = 500;
    payments.get(session.payment_intent).amount_received = 500;
    await webhook('checkout.session.completed', session);
    expect(mockStripe.refunds.create).toHaveBeenCalledWith({ payment_intent: session.payment_intent }, expect.any(Object));
    expect((await readOrder(order)).status).toBe('refunded');
    expect((await readOrder(order)).total_cents).toBe(500);
  });

  test('missing local state for this installation fails for provider retry, while unrelated checkouts are ignored', async () => {
    const missing = { id: 'cs_missing', metadata: { picpeak_order_id: 'stripe:missing', picpeak_origin: 'https://photos.example.test' } };
    expect((await webhook('checkout.session.completed', missing)).status).toBe(500);
    expect((await webhook('checkout.session.completed', { id: 'cs_other', metadata: {} })).status).toBe(200);
  });

  test('uses the gallery interface language for hosted checkout and explains its deadline', async () => {
    await create({ language: 'de' });
    const [body] = mockStripe.checkout.sessions.create.mock.calls[0];
    expect(body.locale).toBe('de');
    expect(body.line_items[0].price_data.product_data.description).toMatch(/Download bis .* UTC/);
  });

});
