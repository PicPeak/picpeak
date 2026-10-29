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

jest.mock('../../src/services/emailProcessor', () => ({
  queueEmail: jest.fn(async () => true), getSupportEmail: jest.fn(async () => 'support@example.test'),
  initializeTransporter: jest.fn(), resolveFromIdentity: jest.fn(async () => ({ fromName: 'PicPeak', fromEmail: 'studio@example.test' })),
  wrapEmailHtml: jest.fn(async (html) => html), buildSignatureTextFor: jest.fn(async () => '\nStudio'),
}));
jest.mock('../../src/services/emailWebhookTransport', () => ({ isEnabled: jest.fn(() => false), send: jest.fn(async () => {}) }));
jest.mock('../../src/utils/frontendUrl', () => ({ getFrontendBaseUrl: async () => 'https://photos.example.test', getApiBaseUrl: async () => 'https://photos.example.test/api' }));
jest.mock('../../src/modules/photoSales/stripeClient', () => ({
  ...jest.requireActual('../../src/modules/photoSales/stripeClient'),
  stripeClient: () => mockStripe,
}));

const { queueEmail } = require('../../src/services/emailProcessor');
const { reconcileWebhook } = require('../../src/modules/photoSales/stripeCheckout');
const promoIdentity = require('../../src/modules/photoSales/promoIdentity');
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
    const req = request(app).post('/api/gallery/stripe-gallery/checkout').set('X-Forwarded-For', `198.51.${Math.floor(++requestSeq / 250)}.${requestSeq % 250 + 1}`);
    return (bearer ? req.set('Authorization', `Bearer ${bearer}`) : req).send({ browserKey, ...body });
  };
  // Payment-state tests use a signed proof. The verification route tests
  // below exercise the actual email-code exchange that issues this proof.
  const grant = (email = 'buyer@example.test', gallery = galleryId, browser = browserKey) => promoIdentity.issueGrant({
    gallery_id: gallery, browser_hash: promoIdentity.browserHash(browser), email_hash: promoIdentity.emailHash(email),
  });
  const create = (extra = {}) => post({ photoIds: [ids[0]], checkoutKey: crypto.randomUUID(),
    ...(extra.promoCode ? { promoGrant: grant() } : {}), ...extra });
  const verification = (action, body, slug = 'stripe-gallery', bearer) => {
    const req = request(app).post(`/api/gallery/${slug}/checkout/promo-verification${action === 'confirm' ? '/confirm' : ''}`)
      .set('X-Forwarded-For', `203.0.${Math.floor(++requestSeq / 250)}.${requestSeq % 250 + 1}`);
    return (bearer ? req.set('Authorization', `Bearer ${bearer}`) : req).send({ browserKey, promoCode: 'FOTO-ONCE', ...body });
  };
  const offerPromo = () => db('events').where({ id: galleryId }).update({ free_photo_count: 1, promo_code: 'FOTO-ONCE' });
  const anotherGallery = async () => {
    const slug = `other-${crypto.randomUUID()}`;
    const [event] = await db('events').insert({ slug, event_name: 'Other gallery', event_type: 'wedding', event_date: '2026-10-01',
      host_email: 'host@example.test', admin_email: 'admin@example.test', password_hash: 'x', share_link: `/gallery/${slug}/share`,
      share_token: crypto.randomUUID(), expires_at: new Date(Date.now() + 10 * 864e5).toISOString(), is_active: 1, is_archived: 0,
      is_draft: 0, require_password: 0, allow_downloads: 1, is_priced: 1, photo_price: 5, free_photo_count: 1,
      promo_code: 'FOTO-ONCE', snipcart_discount_id: crypto.randomUUID() }).returning('id');
    const [photo] = await db('photos').insert({ event_id: event.id, filename: 'other.jpg', path: 'private/other.jpg',
      type: 'individual', media_type: 'image', mime_type: 'image/jpeg', processing_status: 'complete' }).returning('id');
    return { id: event.id, slug, photoId: photo.id };
  };
  const checkoutOther = (gallery, email = 'buyer@example.test', extra = {}) => request(app).post(`/api/gallery/${gallery.slug}/checkout`)
    .set('X-Forwarded-For', `192.0.${Math.floor(++requestSeq / 250)}.${requestSeq % 250 + 1}`)
    .send({ photoIds: [gallery.photoId], checkoutKey: crypto.randomUUID(), browserKey, promoCode: 'FOTO-ONCE',
      promoGrant: grant(email, gallery.id), ...extra });
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
    app.use('/api/gallery', require('../../src/routes/gallery/snipcartWebhook'));
    app.use(express.json());
    app.use('/api/gallery', require('../../src/routes/gallery/snipcart'));
    app.use('/api/public/settings', require('../../src/routes/publicSettings'));
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery/stripeCheckout'));
    app.use('/api/photo-checkout', require('../../src/routes/photoCheckout'));
    app.use('/api/gallery', require('../../src/routes/gallery/purchasedDownloads'));
  });
  afterAll(async () => { if (cleanup) await cleanup(); });
  afterEach(() => jest.restoreAllMocks());
  beforeEach(async () => {
    // Fixture writes bypass the Payments save paths that invalidate this cache.
    require('../../src/modules/photoSales/providers').invalidateConfiguration();
    delete process.env.SNIPCART_API_KEY; delete process.env.SNIPCART_SECRET_API_KEY;
    browserKey = crypto.randomBytes(32).toString('hex');
    await db('photo_purchases').del();
    await db('photo_purchase_orders').del();
    await db('photo_checkout_verifications').del();
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

  test('verifies a promo by email without creating a feedback guest, and retains no plaintext identity or code', async () => {
    await offerPromo();
    const send = jest.spyOn(promoIdentity, 'sendCodeEmail').mockResolvedValue();
    const sent = await verification('send', { email: ' Buyer@Example.test ', language: 'de-DE' });
    expect(sent.status).toBe(202);
    expect(sent.headers['cache-control']).toContain('no-store');
    const message = send.mock.calls[0][0];
    expect(message).toMatchObject({ to: 'buyer@example.test', language: 'de' });
    const row = await db('photo_checkout_verifications').first();
    expect(row).toMatchObject({ email_hash: promoIdentity.emailHash(message.to), browser_hash: promoIdentity.browserHash(browserKey), attempts: 0 });
    expect(JSON.stringify(row)).not.toContain(message.to);
    expect(JSON.stringify(row)).not.toContain(message.code);
    expect(JSON.stringify(sent.body)).not.toContain(message.code);
    expect(Number((await db('gallery_guests').count('* as n').first()).n)).toBe(0);
    expect(await db('photo_purchase_orders').first()).toBeUndefined();
    const confirmed = await verification('confirm', { challenge: sent.body.challenge, code: message.code });
    expect(confirmed.status).toBe(200);
    const response = await create({ promoCode: 'FOTO-ONCE', promoGrant: confirmed.body.grant });
    expect(response.status).toBe(200);
    expect((await orderFor(response)).promo_identity_hash).toBe(promoIdentity.emailHash(message.to));
    expect(JSON.stringify(mockStripe.checkout.sessions.create.mock.calls)).not.toContain(confirmed.body.grant);
    expect(JSON.stringify(mockStripe.checkout.sessions.create.mock.calls)).not.toContain(row.email_hash);
    expect((await verification('confirm', { challenge: sent.body.challenge, code: message.code })).status).toBe(400);
  });

  test.each(['missing', 'forged', 'expired', 'wrong_gallery', 'wrong_browser'])('refuses %s promo identity before creating an order or provider checkout', async (kind) => {
    await offerPromo();
    let proof = grant();
    if (kind === 'missing') proof = undefined;
    if (kind === 'forged') proof += 'x';
    if (kind === 'expired') proof = jwt.sign({ type: 'photo_checkout_promo', galleryId, browser: promoIdentity.browserHash(browserKey), identity: promoIdentity.emailHash('buyer@example.test') }, process.env.JWT_SECRET,
      { issuer: 'picpeak-auth', audience: 'photo_checkout_promo', expiresIn: -1 });
    if (kind === 'wrong_gallery') proof = grant('buyer@example.test', galleryId + 1);
    if (kind === 'wrong_browser') proof = grant('buyer@example.test', galleryId, crypto.randomBytes(32).toString('hex'));
    const response = await create({ promoCode: 'FOTO-ONCE', promoGrant: proof });
    expect(response.status).toBe(401); expect(response.body.code).toBe('CHECKOUT_PROMO_IDENTITY_REQUIRED');
    expect(await db('photo_purchase_orders').first()).toBeUndefined();
    expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  test('binds codes to the requesting gallery and browser and checks expiry at redemption', async () => {
    await offerPromo(); const other = await anotherGallery();
    const send = jest.spyOn(promoIdentity, 'sendCodeEmail').mockResolvedValue();
    const sent = await verification('send', { email: 'buyer@example.test' });
    const body = { challenge: sent.body.challenge, code: send.mock.calls[0][0].code };
    expect((await verification('confirm', { ...body, browserKey: crypto.randomBytes(32).toString('hex') })).status).toBe(400);
    expect((await verification('confirm', body, other.slug)).status).toBe(400);
    expect((await db('photo_checkout_verifications').first()).attempts).toBe(0);
    await db('photo_checkout_verifications').update({ expires_at: new Date(Date.now() - 1000).toISOString() });
    expect((await verification('confirm', body)).status).toBe(400);
  });

  test('claims only five comparisons under concurrent guesses and only one grant under concurrent correct codes', async () => {
    await offerPromo(); const send = jest.spyOn(promoIdentity, 'sendCodeEmail').mockResolvedValue();
    const sent = await verification('send', { email: 'buyer@example.test' });
    const correct = send.mock.calls[0][0].code; const wrong = correct === '000000' ? '111111' : '000000';
    const rejected = await Promise.all(Array.from({ length: 8 }, () => verification('confirm', { challenge: sent.body.challenge, code: wrong })));
    expect(rejected.every((response) => response.status === 400)).toBe(true);
    expect((await db('photo_checkout_verifications').first()).attempts).toBe(5);
    expect((await verification('confirm', { challenge: sent.body.challenge, code: correct })).status).toBe(400);
    const next = await verification('send', { email: 'another@example.test' });
    const body = { challenge: next.body.challenge, code: send.mock.calls[1][0].code };
    const results = await Promise.all([verification('confirm', body), verification('confirm', body)]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 400]);
  });

  test('serializes per-address sends across galleries and browsers, with five sends per hour and a resend delay', async () => {
    await offerPromo(); const other = await anotherGallery();
    const send = jest.spyOn(promoIdentity, 'sendCodeEmail').mockResolvedValue();
    const responses = await Promise.all([verification('send', { email: ' Buyer@Example.test ' }),
      verification('send', { email: 'buyer@example.test', browserKey: crypto.randomBytes(32).toString('hex') }, other.slug)]);
    expect(responses.map((response) => response.status).sort()).toEqual([202, 429]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(responses.find((response) => response.status === 429).headers['retry-after']).toBeDefined();
    for (let i = 0; i < 4; i++) {
      await db('photo_checkout_verifications').update({ created_at: new Date(Date.now() - 65000).toISOString() });
      expect((await verification('send', { email: 'buyer@example.test' })).status).toBe(202);
    }
    await db('photo_checkout_verifications').update({ created_at: new Date(Date.now() - 65000).toISOString() });
    expect((await verification('send', { email: 'buyer@example.test' })).status).toBe(429);
    expect(send).toHaveBeenCalledTimes(5);
  });

  test('a failed email creates no usable challenge and does not consume the address send budget', async () => {
    await offerPromo(); const send = jest.spyOn(promoIdentity, 'sendCodeEmail').mockRejectedValueOnce(new Error('Transport unavailable')).mockResolvedValue();
    expect((await verification('send', { email: 'buyer@example.test' })).status).toBe(503);
    expect(await db('photo_checkout_verifications').first()).toBeUndefined();
    expect((await verification('send', { email: 'buyer@example.test' })).status).toBe(202);
    expect(send).toHaveBeenCalledTimes(2);
  });

  test('does not send codes with invalid promo input or while payment providers are disabled', async () => {
    await offerPromo(); const send = jest.spyOn(promoIdentity, 'sendCodeEmail').mockResolvedValue();
    expect((await verification('send', { email: 'buyer@example.test', promoCode: { toString: null } })).status).toBe(409);
    const providers = require('../../src/modules/photoSales/providers');
    await providers.savePreferences({ revision: (await providers.preferences()).revision, stripe: false, snipcart: false });
    try {
      expect((await verification('send', { email: 'buyer@example.test' })).status).toBe(503);
      expect(send).not.toHaveBeenCalled();
    } finally {
      await providers.savePreferences({ revision: (await providers.preferences()).revision, stripe: true, snipcart: true });
    }
  });

  test.each(['paused', 'unpriced', 'no_promo', 'slideshow'])('does not email verification codes for a %s gallery/session', async (kind) => {
    await offerPromo(); const send = jest.spyOn(promoIdentity, 'sendCodeEmail').mockResolvedValue();
    if (kind === 'paused') await db('events').where({ id: galleryId }).update({ is_active: false });
    if (kind === 'unpriced') await db('events').where({ id: galleryId }).update({ is_priced: false });
    if (kind === 'no_promo') await db('events').where({ id: galleryId }).update({ free_photo_count: 0 });
    const response = await verification('send', { email: 'buyer@example.test' }, 'stripe-gallery', kind === 'slideshow' ? token({ type: 'slideshow' }) : undefined);
    expect(response.status).toBeGreaterThanOrEqual(400); expect(send).not.toHaveBeenCalled();
  });

  test.each(['stripe', 'snipcart'])('one verified address cannot hold another gallery promo after a new browser or provider (%s first)', async (provider) => {
    await offerPromo(); enableSnipcart();
    await db('events').where({ id: galleryId }).update({ snipcart_discount_id: crypto.randomUUID() });
    const other = await anotherGallery(); const key = crypto.randomUUID();
    const first = await create({ provider, promoCode: 'FOTO-ONCE', checkoutKey: key }); expect(first.status).toBe(200);
    expect((await create({ provider, promoCode: 'FOTO-ONCE', checkoutKey: key })).body).toEqual(first.body);
    browserKey = crypto.randomBytes(32).toString('hex');
    const blocked = await checkoutOther(other, 'BUYER@example.test', { provider: provider === 'stripe' ? 'snipcart' : 'stripe' });
    expect(blocked.status).toBe(409); expect(blocked.body.code).toBe('CHECKOUT_PROMO_BUSY');
    expect((await checkoutOther(other, 'different@example.test')).status).toBe(200);
  });

  test('concurrent reservations for one verified address serialize across galleries and release after confirmed cancellation', async () => {
    await offerPromo(); const other = await anotherGallery();
    const responses = await Promise.all([create({ promoCode: 'FOTO-ONCE' }), checkoutOther(other)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(responses.find((response) => response.status === 409).body.code).toBe('CHECKOUT_PROMO_BUSY');
    const order = await orderFor(responses.find((response) => response.status === 200));
    expect((await request(app).post(`/api/photo-checkout/${order.checkout_token}/cancel`).set('X-Photo-Checkout-Key', browserKey)).status).toBe(200);
    const next = Number(order.gallery_id) === Number(galleryId) ? await checkoutOther(other) : await create({ promoCode: 'FOTO-ONCE' });
    expect(next.status).toBe(200);
  });

  test.each(['creation_unknown', 'processing', 'refund_pending', 'refund_failed'])('keeps the verified identity cap while a %s payment remains ambiguous', async (status) => {
    await offerPromo(); const other = await anotherGallery(); const order = await orderFor(await create({ promoCode: 'FOTO-ONCE' }));
    await db('photo_purchase_orders').where({ id: order.id }).update({ status });
    expect((await checkoutOther(other)).body.code).toBe('CHECKOUT_PROMO_BUSY');
  });

  test('prunes expired challenges without resetting the current hourly send budget', async () => {
    await offerPromo(); jest.spyOn(promoIdentity, 'sendCodeEmail').mockResolvedValue();
    await verification('send', { email: 'buyer@example.test' });
    const fresh = await db('photo_checkout_verifications').first();
    await db('photo_checkout_verifications').insert({ ...fresh, id: undefined, challenge: crypto.randomBytes(24).toString('hex'),
      created_at: new Date(Date.now() - 2 * 3600e3).toISOString(), expires_at: new Date(Date.now() - 90 * 60e3).toISOString() });
    await promoIdentity.prune(); expect(await db('photo_checkout_verifications')).toHaveLength(1);
    expect((await verification('send', { email: 'buyer@example.test' })).status).toBe(429);
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

  test.each(['paid', 'no_payment_required'])('one-time promo releases only after expiry and supports a zero-total %s purchase', async (paymentStatus) => {
    await db('events').where({ id: galleryId }).update({ free_photo_count: 1, promo_code: 'FOTO-ONCE' });
    const first = await create({ promoCode: 'FOTO-ONCE' });
    const order = await orderFor(first);
    expect(order.total_cents).toBe(0);
    expect((await create({ promoCode: 'FOTO-ONCE' })).status).toBe(409);
    expect((await request(app).get(`/api/photo-checkout/${order.checkout_token}?cancelled=1`).set('X-Photo-Checkout-Key', browserKey)).body.status).toBe('pending');
    expect((await create({ promoCode: 'FOTO-ONCE' })).status).toBe(409);
    expect((await request(app).post(`/api/photo-checkout/${order.checkout_token}/cancel`).set('X-Photo-Checkout-Key', browserKey)).status).toBe(200);
    const second = await orderFor(await create({ promoCode: 'FOTO-ONCE' }));
    const session = await pay(second, { payment_status: paymentStatus, payment_intent: null });
    expect((await webhook('checkout.session.completed', session)).status).toBe(200);
    expect((await webhook('checkout.session.completed', session)).status).toBe(200);
    expect(Number((await db('photo_purchases').where({ order_id: second.order_id }).count('* as n').first()).n)).toBe(1);
    expect(queueEmail).toHaveBeenCalledTimes(1);
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
    quote.sessionExpiresAt = Math.floor(Date.now() / 1000) - 301;
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

  test.each(['paid', 'no_payment_required'])('%s without a PaymentIntent never unlocks a quote that requires payment', async (paymentStatus) => {
    const order = await orderFor(await create());
    const session = await pay(order, { payment_status: paymentStatus, payment_intent: null });
    session.amount_total = 0;
    await webhook('checkout.session.completed', session);
    expect((await readOrder(order)).status).toBe('cancelled');
    expect(Number((await db('photo_purchases').count('* as n').first()).n)).toBe(0);
  });

  const enableSnipcart = () => {
    process.env.SNIPCART_API_KEY = crypto.randomBytes(20).toString('hex');
    process.env.SNIPCART_SECRET_API_KEY = crypto.randomBytes(20).toString('hex');
  };
  const deliverSnipcart = async (handoff, overrides = {}) => {
    const remote = { token: crypto.randomUUID(), paymentStatus: 'Paid', currency: 'eur', email: 'buyer@example.test',
      items: handoff.items, discounts: handoff.promo_code ? [{ code: handoff.promo_code }] : [],
      total: handoff.items.reduce((sum, line) => sum + line.price, 0), ...overrides };
    const fetcher = jest.spyOn(global, 'fetch').mockImplementation(async (url) => ({ ok: true, status: 200,
      json: async () => String(url).includes('/requestvalidation/') ? {} : remote }));
    const result = await request(app).post('/api/gallery/snipcart-webhook')
      .set('X-Snipcart-RequestToken', crypto.randomUUID()).send({ eventName: 'order.completed', content: { token: remote.token } });
    fetcher.mockRestore();
    return { result, remote };
  };
  test('configuration supports Stripe-only, Snipcart-only and both, preferring Stripe', async () => {
    const config = async () => (await request(app).get('/api/public/settings')).body;
    expect((await config()).photo_sales_providers).toEqual(['stripe']);
    enableSnipcart();
    expect(await config()).toMatchObject({ photo_sales_providers: ['stripe', 'snipcart'], photo_sales_preferred_provider: 'stripe', snipcart_api_key: process.env.SNIPCART_API_KEY });
    expect(JSON.stringify(await config())).not.toContain(process.env.SNIPCART_SECRET_API_KEY);
    const stripeKey = process.env.STRIPE_SECRET_KEY; const webhookKey = process.env.STRIPE_WEBHOOK_SECRET;
    try {
      delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_WEBHOOK_SECRET;
      expect((await config()).photo_sales_providers).toEqual(['snipcart']);
      const response = await create();
      expect(response.status).toBe(200); expect(response.body.snipcart.items).toHaveLength(1);
      expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
    } finally { process.env.STRIPE_SECRET_KEY = stripeKey; process.env.STRIPE_WEBHOOK_SECRET = webhookKey; }
  });
  test('rejects a positive Stripe total below EUR 0.50 before reserving a promo', async () => {
    await db('events').where({ id: galleryId }).update({ photo_price: 1, free_photo_count: 1, promo_code: 'FOTO-ONCE' });
    await db('photos').where({ id: ids[0] }).update({ photo_price: 1.25 });
    const response = await create({ promoCode: 'FOTO-ONCE' });
    expect(response.status).toBe(400); expect(response.body.code).toBe('CHECKOUT_MINIMUM');
    expect(await db('photo_purchase_orders').first()).toBeUndefined();
  });
  test('promo sessions use a shorter valid Stripe expiry while ordinary sessions keep one hour', async () => {
    await create();
    expect(mockStripe.checkout.sessions.create.mock.calls[0][0].expires_at * 1000 - Date.now()).toBeGreaterThan(59 * 60e3);
    await db('events').where({ id: galleryId }).update({ free_photo_count: 1, promo_code: 'FOTO-ONCE' });
    await create({ promoCode: 'FOTO-ONCE' });
    const remaining = mockStripe.checkout.sessions.create.mock.calls[1][0].expires_at * 1000 - Date.now();
    expect(remaining).toBeGreaterThan(30 * 60e3); expect(remaining).toBeLessThanOrEqual(31 * 60e3);
  });
  test.each(['stripe', 'snipcart'])('the shared promo permits one concurrent reservation with %s attempted first', async (first) => {
    enableSnipcart();
    await db('events').where({ id: galleryId }).update({ free_photo_count: 1, promo_code: 'FOTO-ONCE', snipcart_discount_id: crypto.randomUUID() });
    const replies = await Promise.all([first, first === 'stripe' ? 'snipcart' : 'stripe'].map((provider) => create({ provider, promoCode: 'FOTO-ONCE' })));
    expect(replies.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(replies.find((r) => r.status === 409).body.code).toBe('PROMO_UNAVAILABLE');
    expect(await db('photo_purchase_orders').where({ promo_gallery_id: galleryId })).toHaveLength(1);
  });
  test('Snipcart honours a signed reserved price snapshot, grants once and keeps the provider reference', async () => {
    enableSnipcart();
    const reply = await create({ provider: 'snipcart' });
    expect(reply.status).toBe(200);
    const local = await db('photo_purchase_orders').where({ checkout_token: reply.body.snipcart.checkout_token }).first();
    expect(reply.body.snipcart.items[0]).toMatchObject({ quantity: 1, minQuantity: 1, maxQuantity: 1 });
    const stripped = new URL(reply.body.snipcart.items[0].url); stripped.searchParams.delete('checkout');
    const denied = await request(app).get(stripped.pathname + stripped.search);
    expect(denied.status).toBe(409); expect(denied.body.code).toBe('CHECKOUT_REQUIRED');
    await db('photos').where({ id: ids[0] }).update({ photo_price: 99 });
    const price = await request(app).get(new URL(reply.body.snipcart.items[0].url).pathname + new URL(reply.body.snipcart.items[0].url).search);
    expect(price.status).toBe(200); expect(price.body.price).toBe(5);
    const { result, remote } = await deliverSnipcart(reply.body.snipcart);
    expect(result.status).toBe(200);
    expect(await readOrder(local)).toMatchObject({ status: 'completed', order_id: local.order_id, provider_order_id: remote.token });
    expect(await db('photo_purchases').where({ order_id: local.order_id })).toHaveLength(1);
    await deliverSnipcart(reply.body.snipcart, { token: remote.token });
    expect(await db('photo_purchases').where({ order_id: local.order_id })).toHaveLength(1);
    const status = await request(app).get(`/api/photo-checkout/${local.checkout_token}`).set('X-Photo-Checkout-Key', browserKey);
    expect(status.body.status).toBe('completed'); expect(status.body.download_url).toBeTruthy();
  });
  test('a second paid Snipcart order reusing a reservation is refunded rather than lost', async () => {
    enableSnipcart(); const reply = await create({ provider: 'snipcart' });
    await deliverSnipcart(reply.body.snipcart);
    const { result, remote } = await deliverSnipcart(reply.body.snipcart);
    expect(result.status).toBe(200);
    expect(await db('photo_purchase_orders').where({ provider_order_id: remote.token }).first()).toMatchObject({ status: 'refunded' });
    expect(await db('photo_purchases')).toHaveLength(1);
  });
  test.each(['removed_photo', 'removed_discount', 'added_discount'])('server quote checks still refuse a paid Snipcart cart with %s', async (change) => {
    enableSnipcart(); await offerPromo();
    await db('events').where({ id: galleryId }).update({ snipcart_discount_id: crypto.randomUUID() });
    const reply = await create({ provider: 'snipcart', photoIds: ids.slice(0, 2), promoCode: 'FOTO-ONCE' });
    const overrides = { total: 5 };
    if (change === 'removed_photo') overrides.items = reply.body.snipcart.items.slice(0, 1);
    if (change === 'removed_discount') overrides.discounts = [];
    if (change === 'added_discount') overrides.discounts = [{ code: 'FOTO-ONCE' }, { code: 'UNEXPECTED' }];
    const { result, remote } = await deliverSnipcart(reply.body.snipcart, overrides);
    expect(result.status).toBe(200);
    expect(await db('photo_purchase_orders').where({ provider_order_id: remote.token }).first()).toMatchObject({ status: 'refunded' });
    expect(await db('photo_purchases')).toHaveLength(0);
    expect(queueEmail).not.toHaveBeenCalled();
  });
  test('a late Snipcart payment after promo expiry and a Stripe claim is refunded, preserving the Stripe claim', async () => {
    enableSnipcart(); await db('events').where({ id: galleryId }).update({ free_photo_count: 1, promo_code: 'FOTO-ONCE', snipcart_discount_id: crypto.randomUUID() });
    const reply = await create({ provider: 'snipcart', promoCode: 'FOTO-ONCE' });
    const local = await db('photo_purchase_orders').where({ checkout_token: reply.body.snipcart.checkout_token }).first();
    const quote = JSON.parse(local.checkout_quote); quote.sessionExpiresAt = Math.floor(Date.now() / 1000) - 301;
    await db('photo_purchase_orders').where({ id: local.id }).update({ checkout_quote: JSON.stringify(quote), purchased_at: new Date(Date.now() - 65 * 60e3).toISOString() });
    await require('../../src/services/photoCheckoutReconciler').reconcilePhotoCheckouts();
    expect((await readOrder(local)).status).toBe('expired');
    const stripe = await orderFor(await create({ promoCode: 'FOTO-ONCE' }));
    const { result } = await deliverSnipcart(reply.body.snipcart, { total: 0 });
    expect(result.status).toBe(200); expect((await readOrder(local)).status).toBe('refunded');
    expect((await readOrder(stripe)).promo_gallery_id).toBe(galleryId);
    expect(await db('photo_purchases')).toHaveLength(0);
  });
  test('recovery isolates malformed quotes and backs off unconfirmed refunds', async () => {
    const bad = await orderFor(await create()); const good = await orderFor(await create()); const session = await pay(good);
    await db('photo_purchase_orders').whereIn('id', [bad.id, good.id]).update({ purchased_at: new Date(Date.now() - 180e3).toISOString() });
    await db('photo_purchase_orders').where({ id: bad.id }).update({ checkout_quote: '{' });
    await require('../../src/services/photoCheckoutReconciler').reconcilePhotoCheckouts();
    expect((await readOrder(bad))).toMatchObject({ recovery_needs_attention: db.client.config.client === 'pg' ? true : 1, recovery_error: 'QUOTE_UNREADABLE' });
    expect((await readOrder(good)).status).toBe('completed');
    expect(session.status).toBe('complete');
  });
  test('ambiguous creation persists pagination beyond 1,000 sessions without releasing the claim', async () => {
    const order = await orderFor(await create());
    const quote = JSON.parse(order.checkout_quote); quote.sessionExpiresAt = Math.floor(Date.now() / 1000) - 301;
    const stale = { ...order, checkout_session_id: null, status: 'creation_unknown', checkout_quote: JSON.stringify(quote), purchased_at: new Date(Date.now() - 65 * 60e3).toISOString() };
    await db('photo_purchase_orders').where({ id: order.id }).update({ checkout_session_id: null, status: stale.status, checkout_quote: stale.checkout_quote, purchased_at: stale.purchased_at });
    mockStripe.checkout.sessions.list.mockImplementationOnce(async () => ({ data: [{ id: 'page-1' }], has_more: true }));
    for (let page = 2; page <= 10; page++) mockStripe.checkout.sessions.list.mockImplementationOnce(async () => ({ data: [{ id: `page-${page}` }], has_more: true }));
    const { checkoutSession } = require('../../src/modules/photoSales/stripeCheckout');
    await expect(checkoutSession(stale, mockStripe)).rejects.toMatchObject({ code: 'CHECKOUT_RETRY' });
    const progress = await readOrder(order); expect(progress.checkout_scan_cursor).toBe('page-10'); expect(progress.status).toBe('creation_unknown');
    mockStripe.checkout.sessions.list.mockImplementationOnce(async (params) => {
      expect(params.starting_after).toBe('page-10');
      return { data: [sessions.get(order.checkout_session_id)], has_more: false };
    });
    expect((await checkoutSession(progress, mockStripe)).id).toBe(order.checkout_session_id);
  });
  test('the existing database lease prevents a second recovery runner from contacting the provider', async () => {
    const order = await orderFor(await create());
    await db('photo_purchase_orders').where({ id: order.id }).update({ purchased_at: new Date(Date.now() - 180e3).toISOString() });
    const lease = require('../../src/services/maintenanceJobState'); await lease.ensure('photo_checkout_recovery');
    const token = await lease.claim('photo_checkout_recovery'); expect(token).toBeTruthy();
    try { await require('../../src/services/photoCheckoutReconciler').reconcilePhotoCheckouts(); expect(mockStripe.checkout.sessions.retrieve).not.toHaveBeenCalled(); }
    finally { await lease.release('photo_checkout_recovery', token); }
  });

  test('turning off a provider stops new checkout but keeps signed payment settlement working', async () => {
    const order = await orderFor(await create()); const session = await pay(order);
    const providers = require('../../src/modules/photoSales/providers');
    await providers.savePreferences({ revision: (await providers.preferences()).revision, stripe: false, snipcart: true });
    try {
      expect((await create()).status).toBe(503);
      expect((await webhook('checkout.session.completed', session)).status).toBe(200);
      expect((await readOrder(order)).status).toBe('completed');
    } finally { await db('app_settings').where({ setting_key: 'payments_provider_availability' }).del(); }
  });
  test('an authoritative pending Snipcart payment keeps its promo after the cart reservation window', async () => {
    enableSnipcart(); await db('events').where({ id: galleryId }).update({ free_photo_count: 1, promo_code: 'FOTO-ONCE', snipcart_discount_id: crypto.randomUUID() });
    const reply = await create({ provider: 'snipcart', promoCode: 'FOTO-ONCE' });
    const local = await db('photo_purchase_orders').where({ checkout_token: reply.body.snipcart.checkout_token }).first();
    const { result, remote } = await deliverSnipcart(reply.body.snipcart, { total: 0, paymentStatus: 'Deferred' });
    expect(result.status).toBe(200); expect((await readOrder(local))).toMatchObject({ status: 'processing', provider_order_id: remote.token });
    const quote = JSON.parse(local.checkout_quote); quote.sessionExpiresAt = Math.floor(Date.now() / 1000) - 301;
    await db('photo_purchase_orders').where({ id: local.id }).update({ checkout_quote: JSON.stringify(quote), purchased_at: new Date(Date.now() - 65 * 60e3).toISOString() });
    const fetcher = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => remote });
    try { await require('../../src/services/photoCheckoutReconciler').reconcilePhotoCheckouts(); } finally { fetcher.mockRestore(); }
    expect((await readOrder(local))).toMatchObject({ status: 'processing', promo_gallery_id: galleryId });
    await deliverSnipcart(reply.body.snipcart, { total: 0, token: remote.token });
    expect((await readOrder(local)).status).toBe('completed');
  });

  test('expires an unpaid Snipcart reservation without a promo while retaining its history', async () => {
    enableSnipcart();
    const response = await create({ provider: 'snipcart' });
    expect(response.status).toBe(200);
    const local = await db('photo_purchase_orders').where({ checkout_token: response.body.snipcart.checkout_token }).first();
    const quote = JSON.parse(local.checkout_quote);
    await db('photo_purchase_orders').where({ id: local.id }).update({
      purchased_at: new Date(Date.now() - 7200e3).toISOString(),
      checkout_quote: JSON.stringify({ ...quote, sessionExpiresAt: Math.floor(Date.now() / 1000) - 301 }),
    });
    await require('../../src/services/photoCheckoutReconciler').reconcilePhotoCheckouts();
    expect(await readOrder(local)).toMatchObject({ status: 'expired', promo_gallery_id: null });
    expect(await db('photo_purchases').where({ order_id: local.order_id })).toHaveLength(0);
  });

  test.each(['stripe', 'snipcart'])('honours a %s payment during a pause and keeps compensation and confirmation deadlines in sync', async (provider) => {
    if (provider === 'snipcart') enableSnipcart();
    await db('events').where({ id: galleryId }).update({ purchase_access_days: 1 });
    const response = await create({ provider });
    expect(response.status).toBe(200);
    const local = provider === 'stripe' ? await orderFor(response)
      : await db('photo_purchase_orders').where({ checkout_token: response.body.snipcart.checkout_token }).first();
    const pauseAt = Date.now();
    await db('events').where({ id: galleryId }).update({
      temporarily_disabled: true, temporarily_disabled_at: new Date(pauseAt).toISOString(),
    });
    const grantedAt = pauseAt + 60000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(grantedAt);
    if (provider === 'stripe') {
      expect((await webhook('checkout.session.completed', await pay(local))).status).toBe(200);
    } else await deliverSnipcart(response.body.snipcart);
    const granted = await readOrder(local);
    expect(granted.status).toBe('completed');
    const pausedMail = queueEmail.mock.calls.find((call) => call[2] === 'photo_purchase_paused');
    expect(pausedMail).toBeDefined();
    expect(pausedMail[3].support_email).toBe('support@example.test');
    expect(new Date(pausedMail[3].expires_at).toISOString()).toBe(new Date(granted.expires_at).toISOString());

    clock.mockReturnValue(grantedAt + 3600e3);
    await require('../../src/services/galleryPauseService').updateGalleryAvailability(galleryId, { temporarily_disabled: false },
      (trx, updates) => trx('events').where({ id: galleryId }).update(updates));
    const resumed = await readOrder(local);
    const earned = new Date(Date.parse(granted.expires_at) + 3600e3).toISOString();
    expect(new Date(resumed.expires_at).toISOString()).toBe(earned);
    const photo = await db('photo_purchases').where({ order_id: local.order_id }).first();
    expect(new Date(photo.expires_at).toISOString()).toBe(earned);

    // A retry may hold the old snapshot; its mail must use the locked fresh row.
    await db('photo_purchase_orders').where({ id: local.id }).update({ email_sent: false });
    queueEmail.mockClear();
    await require('../../src/modules/photoSales/fulfilment').sendPurchaseEmail({ ...granted, email_sent: false }, 'Photo sales', 1);
    expect(queueEmail).toHaveBeenCalledTimes(1);
    expect(queueEmail.mock.calls[0][2]).toBe('photo_purchase_access');
    expect(new Date(queueEmail.mock.calls[0][3].expires_at).toISOString()).toBe(earned);
  });
  test('an unconfirmed refund is flagged and backed off rather than polled every minute', async () => {
    const order = await orderFor(await create()); await pay(order);
    await db('photo_purchase_orders').where({ id: order.id }).update({ status: 'refund_failed', purchased_at: new Date(Date.now() - 180e3).toISOString() });
    mockStripe.refunds.create.mockResolvedValueOnce({ id: crypto.randomUUID(), status: 'failed' });
    await require('../../src/services/photoCheckoutReconciler').reconcilePhotoCheckouts();
    const fresh = await readOrder(order);
    expect(!!fresh.recovery_needs_attention).toBe(true); expect(Date.parse(fresh.recovery_next_at)).toBeGreaterThan(Date.now() + 60000);
    const calls = mockStripe.checkout.sessions.retrieve.mock.calls.length;
    await require('../../src/services/photoCheckoutReconciler').reconcilePhotoCheckouts();
    expect(mockStripe.checkout.sessions.retrieve).toHaveBeenCalledTimes(calls);
  });

  test.each(['gallery_archived', 'quote_expired'])('a stale second worker cannot refund a fulfilled order when %s before it acquires the event lock', async (change) => {
    const order = await orderFor(await create()); const session = await pay(order);
    const { reconcileSession } = require('../../src/modules/photoSales/stripeCheckout');
    const transaction = db.client.transaction.bind(db.client);
    // Worker B has read the open order. Let worker A really fulfill it just
    // before B enters its event/order transaction, then close the gallery/window.
    jest.spyOn(db.client, 'transaction').mockImplementationOnce(async (callback, ...options) => {
      await reconcileSession(order, session, { client: mockStripe });
      if (change === 'gallery_archived') await db('events').where({ id: galleryId }).update({ is_archived: true });
      else jest.spyOn(Date, 'now').mockReturnValue(Date.parse(JSON.parse(order.checkout_quote).expiresAt) + 1);
      return transaction(callback, ...options);
    });
    await reconcileSession(order, session, { client: mockStripe });
    expect((await readOrder(order)).status).toBe('completed');
    expect(await db('photo_purchases').where({ order_id: order.order_id })).toHaveLength(1);
    expect(mockStripe.refunds.create).not.toHaveBeenCalled();
    expect(queueEmail).toHaveBeenCalledTimes(1);
  });

  test('simultaneous Stripe settlement and a pre-upgrade Snipcart promo payment grant only one redemption', async () => {
    enableSnipcart(); await db('events').where({ id: galleryId }).update({ free_photo_count: 1, promo_code: 'FOTO-ONCE', snipcart_discount_id: crypto.randomUUID() });
    const order = await orderFor(await create({ photoIds: ids.slice(0, 2), promoCode: 'FOTO-ONCE' })); const session = await pay(order);
    const { signPhotoSale } = require('../../src/modules/photoSales/sellable');
    const remote = { token: crypto.randomUUID(), paymentStatus: 'Paid', currency: 'eur', email: 'other@example.test', total: 5, discounts: [{ code: 'FOTO-ONCE' }],
      items: ids.slice(0, 2).map((photoId) => ({ quantity: 1, url: `https://photos.example.test/api/gallery/stripe-gallery/price-check?photoId=${photoId}&sig=${signPhotoSale(photoId)}` })) };
    const fetcher = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true });
    try { await Promise.all([
      require('../../src/modules/photoSales/stripeCheckout').reconcileSession(order, session, { client: mockStripe }),
      require('../../src/modules/photoSales/snipcartOrders').reconcileOrder(remote),
    ]); } finally { fetcher.mockRestore(); }
    expect((await readOrder(order))).toMatchObject({ status: 'completed', promo_gallery_id: galleryId });
    expect(await db('photo_purchase_orders').where({ provider_order_id: remote.token }).first()).toMatchObject({ status: 'refunded' });
    expect(await db('photo_purchases')).toHaveLength(2);
    expect(mockStripe.refunds.create).not.toHaveBeenCalled();
  });

  test('normal ambiguity waiting checks at the release boundary rather than extending the hold through backoff', async () => {
    const order = await orderFor(await create()); const quote = JSON.parse(order.checkout_quote);
    quote.sessionExpiresAt = Math.floor(Date.now() / 1000) + 60;
    await db('photo_purchase_orders').where({ id: order.id }).update({ checkout_session_id: null, status: 'creation_unknown',
      checkout_quote: JSON.stringify(quote), purchased_at: new Date(Date.now() - 65 * 60e3).toISOString() });
    sessions.clear(); await require('../../src/services/photoCheckoutReconciler').reconcilePhotoCheckouts();
    expect((await readOrder(order))).toMatchObject({ status: 'creation_unknown', recovery_next_at: new Date((quote.sessionExpiresAt + 300) * 1000).toISOString() });
  });

});
