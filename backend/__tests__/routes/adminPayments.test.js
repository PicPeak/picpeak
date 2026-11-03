'use strict';

const crypto = require('crypto');
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = require('path').join(require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'picpeak-payments-')), 'test.sqlite');
process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.FRONTEND_URL = 'https://photos.example.test';
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');
const mockAccount = jest.fn(async () => ({ id: 'acct_picpeak_test' }));
const mockList = jest.fn(async () => ({ data: [], has_more: false }));
const mockRetrieve = jest.fn(async (id) => ({ id }));
const mockCreate = jest.fn(async () => { throw new Error('No payment should be created by settings'); });
jest.mock('stripe', () => {
  const Actual = jest.requireActual('stripe');
  return class extends Actual {
    constructor(...args) {
      super(...args);
      this.accounts.retrieve = mockAccount;
      this.checkout.sessions.list = mockList;
      this.checkout.sessions.retrieve = mockRetrieve;
      this.checkout.sessions.create = mockCreate;
    }
  };
});
const Stripe = require('stripe');
const { getAppSetting } = require('../../src/utils/appSettings');
const { clearPermissionCache } = require('../../src/middleware/permissions');
const payments = require('../../src/modules/photoSales/paymentSettings');
const KEY = ['rk', 'test', crypto.randomBytes(24).toString('hex')].join('_');
const WEBHOOK = 'whsec_' + crypto.randomBytes(24).toString('hex');

describe('installation payment settings', () => {
  let db; let cleanup; let app; let superToken; let adminToken; let gallery; let requestSeq = 0;
  const auth = (req, token = superToken) => req.set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', `198.51.100.${++requestSeq}`);
  const read = () => auth(request(app).get('/api/admin/settings/payments'));
  const save = async (patch = {}) => auth(request(app).put('/api/admin/settings/payments'))
    .send({ revision: (await read()).body.revision, secret_key: KEY, webhook_secret: WEBHOOK, ...patch });
  const order = (testMode, status = 'completed') => db('photo_purchase_orders').insert({
    order_id: 'stripe:' + crypto.randomUUID(), payment_provider: 'stripe', gallery_id: gallery.id,
    buyer_email: 'buyer@example.test', status, total_cents: 500, currency: 'EUR',
    checkout_quote: JSON.stringify({ testMode }), checkout_session_id: 'cs_test_' + crypto.randomUUID(),
    access_token: crypto.randomUUID(), purchased_at: new Date().toISOString(), expires_at: new Date(Date.now() + 864e5).toISOString(),
  });
  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId, 'super_admin'); superToken = mintAdminToken(adminId);
    const [ordinary] = await db('admin_users').insert({ username: 'payment-admin', email: 'admin@example.test', password_hash: 'x' }).returning('id');
    await assignAdminRole(db, ordinary.id, 'admin'); adminToken = mintAdminToken(ordinary.id);
    [gallery] = await db('events').insert({ slug: 'payments', event_name: 'Payments', event_type: 'wedding', event_date: '2026-10-26', password_hash: 'x', share_link: '/gallery/payments', host_email: 'host@example.test', admin_email: 'host@example.test', is_active: true, is_priced: true, photo_price: 5 }).returning('*');
    clearPermissionCache();
    app = express();
    app.set('trust proxy', 1);
    app.use('/api/photo-sales/stripe/webhook', require('../../src/routes/stripeWebhook'));
    app.use(express.json()); app.use(cookieParser());
    app.use('/api/admin/settings', require('../../src/routes/adminSettings'));
    app.use('/api/public/settings', require('../../src/routes/publicSettings'));
  });
  afterAll(async () => { if (cleanup) await cleanup(); });
  beforeEach(async () => {
    // Fixture writes bypass the Payments save paths that invalidate this cache.
    require('../../src/modules/photoSales/providers').invalidateConfiguration();
    delete process.env.SNIPCART_API_KEY; delete process.env.SNIPCART_SECRET_API_KEY;
    delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_WEBHOOK_SECRET; delete process.env.PAYMENTS_ENCRYPTION_KEY;
    await db('photo_purchase_orders').del();
    await db('app_settings').where('setting_key', 'like', 'payments_%').del();
    mockAccount.mockReset().mockResolvedValue({ id: 'acct_picpeak_test' });
    mockList.mockReset().mockResolvedValue({ data: [], has_more: false });
    mockRetrieve.mockReset().mockImplementation(async (id) => ({ id }));
    mockCreate.mockClear();
  });

  test('only super admins can read, save or probe the installation account', async () => {
    for (const method of ['get', 'put', 'post']) {
      const path = '/api/admin/settings/payments' + (method === 'post' ? '/test' : '');
      expect((await auth(request(app)[method](path), adminToken)).status).toBe(403);
      expect((await request(app)[method](path)).status).toBe(401);
    }
    expect(mockAccount).not.toHaveBeenCalled();
  });
  test('encrypts both secrets, returns only a projection and uses saved credentials immediately', async () => {
    const response = await save();
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ source: 'settings', test_mode: true, account_id: 'acct_picpeak_test', checkout_configured: true, webhook_configured: true });
    const stored = await getAppSetting('payments_stripe_credentials');
    expect(JSON.stringify(stored)).not.toContain(KEY); expect(JSON.stringify(stored)).not.toContain(WEBHOOK);
    expect(JSON.stringify(response.body)).not.toContain(stored.secret_key);
    expect(await payments.credentials()).toMatchObject({ secretKey: KEY, webhookSecret: WEBHOOK });
    expect((await read()).headers['cache-control']).toContain('no-store');
    expect(mockCreate).not.toHaveBeenCalled();
  });
  test('blank inputs retain secrets and stale revisions cannot overwrite a newer save', async () => {
    const initial = await save();
    const revision = initial.body.revision;
    const updated = await auth(request(app).put('/api/admin/settings/payments')).send({ revision, secret_key: '', webhook_secret: '' });
    expect(updated.status).toBe(200);
    expect(await payments.credentials()).toMatchObject({ secretKey: KEY, webhookSecret: WEBHOOK });
    expect((await auth(request(app).put('/api/admin/settings/payments')).send({ revision, secret_key: KEY })).status).toBe(409);
  });
  test('generic settings APIs cannot read or write payment secrets or status', async () => {
    await save();
    for (const path of ['', '/payments_stripe_credentials', '/payments_stripe_webhook_status']) {
      const response = await auth(request(app).get('/api/admin/settings' + path), adminToken);
      if (response.status === 200) expect(Object.keys(response.body).some((key) => key.startsWith('payments_'))).toBe(false);
      expect(JSON.stringify(response.body)).not.toContain(KEY);
    }
    for (const path of ['general', 'security', 'analytics', 'seo', 'branding', 'theme']) {
      await auth(request(app).put('/api/admin/settings/' + path)).send({ payments_stripe_credentials: 'plaintext', payments_stripe_webhook_status: 'fake' });
      expect(await getAppSetting('payments_stripe_credentials')).toEqual(expect.objectContaining({ account_id: 'acct_picpeak_test' }));
      expect(await getAppSetting('payments_stripe_webhook_status')).toBeNull();
    }
    const publicResponse = await request(app).get('/api/public/settings');
    expect(publicResponse.body.photo_sales_checkout_configured).toBe(true);
    expect(JSON.stringify(publicResponse.body)).not.toContain(KEY);
    expect(JSON.stringify(publicResponse.body)).not.toContain(WEBHOOK);
  });
  test('environment configuration is a locked pair, without mixing stored or environment secrets', async () => {
    await save();
    process.env.STRIPE_SECRET_KEY = KEY;
    const response = await read();
    expect(response.body).toMatchObject({ source: 'environment', checkout_configured: true, webhook_configured: false });
    expect((await save()).status).toBe(409);
    expect((await payments.credentials()).webhookSecret).toBe('');
  });
  test('invalid input and provider errors never echo supplied keys', async () => {
    expect((await save({ secret_key: 'pk_test_invalid' })).status).toBe(400);
    mockAccount.mockRejectedValueOnce(new Error(KEY));
    const response = await save();
    expect(response.status).toBe(422); expect(response.text).not.toContain(KEY);
    expect(await getAppSetting('payments_stripe_credentials')).toBeNull();
  });
  test('read-only probe checks saved API access and never claims webhook verification', async () => {
    await save();
    const response = await auth(request(app).post('/api/admin/settings/payments/test'));
    expect(response.status).toBe(200); expect(response.body.account_id).toBe('acct_picpeak_test');
    expect(mockList).toHaveBeenCalledWith({ limit: 1 }); expect(mockCreate).not.toHaveBeenCalled();
    expect((await read()).body.webhook_verified_at).toBeNull();
  });
  test('projects the public HTTPS address and uses the configured public API for Stripe notifications', async () => {
    const originalApi = process.env.API_URL;
    process.env.API_URL = 'https://api.photos.example.test/api/';
    try {
      const response = await read();
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ site_url: 'https://photos.example.test', site_url_ready: true,
        webhook_url: 'https://api.photos.example.test/api/photo-sales/stripe/webhook', webhook_verified_at: null });
      expect(mockAccount).not.toHaveBeenCalled();
      expect(mockCreate).not.toHaveBeenCalled();
    } finally {
      if (originalApi === undefined) delete process.env.API_URL; else process.env.API_URL = originalApi;
    }
  });
  test.each(['', 'http://photos.example.test', 'https://localhost', 'https://photos.localhost',
    `https://u:${crypto.randomBytes(16).toString('hex')}@photos.example.test`, 'https://photos.example.test?query=1', 'https://photos.example.test#fragment'])('does not offer an invalid public destination to the setup wizard: %s', async (base) => {
    const originalBase = process.env.FRONTEND_URL;
    const originalApi = process.env.API_URL;
    delete process.env.API_URL;
    process.env.FRONTEND_URL = base;
    try {
      const response = await read();
      expect(response.status).toBe(200);
      expect(response.body.site_url_ready).toBe(false);
      expect(response.body.webhook_url).toBe('');
    } finally {
      process.env.FRONTEND_URL = originalBase;
      if (originalApi === undefined) delete process.env.API_URL; else process.env.API_URL = originalApi;
    }
  });
  test('only a valid current-mode signature records webhook verification; rotation resets it', async () => {
    await save();
    const sdk = new Stripe(KEY);
    const deliver = (secret, livemode = false) => {
      const payload = JSON.stringify({ id: 'evt_test', type: 'payment_intent.succeeded', livemode, data: { object: {} } });
      return request(app).post('/api/photo-sales/stripe/webhook').set('Content-Type', 'application/json')
        .set('stripe-signature', sdk.webhooks.generateTestHeaderString({ payload, secret })).send(payload);
    };
    expect((await deliver('wrong')).status).toBe(400);
    expect((await deliver(WEBHOOK, true)).status).toBe(400);
    expect((await read()).body.webhook_verified_at).toBeNull();
    expect((await deliver(WEBHOOK)).status).toBe(200);
    expect((await read()).body.webhook_verified_at).toBeTruthy();
    await save({ webhook_secret: 'whsec_' + crypto.randomBytes(24).toString('hex') });
    expect((await read()).body.webhook_verified_at).toBeNull();
  });
  test('unreadable encryption fails closed without leaking the stored ciphertext', async () => {
    await save(); process.env.PAYMENTS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    expect((await read()).body).toMatchObject({ unreadable: true, checkout_configured: false, webhook_configured: false });
    expect((await payments.credentials()).secretKey).toBe('');
  });
  test('rotates keys for the same account but prevents moving existing orders to another merchant', async () => {
    await save(); await order(true);
    expect((await save({ secret_key: ['rk', 'test', crypto.randomBytes(24).toString('hex')].join('_') })).status).toBe(200);
    mockAccount.mockResolvedValue({ id: 'acct_other' });
    expect((await save()).status).toBe(409);
  });
  test('requires matching mode secrets and settled test orders before going live; retains live history access', async () => {
    await save(); await order(true, 'processing');
    const liveKey = ['rk', 'live', crypto.randomBytes(24).toString('hex')].join('_');
    const revision = (await read()).body.revision;
    expect((await auth(request(app).put('/api/admin/settings/payments')).send({ revision, secret_key: liveKey })).status).toBe(400);
    expect((await save({ secret_key: liveKey })).status).toBe(409);
    await db('photo_purchase_orders').update({ status: 'completed' });
    expect((await save({ secret_key: liveKey })).status).toBe(200);
    await order(false);
    expect((await save()).status).toBe(409);
  });
  test('two admins saving the same revision cannot overwrite each other', async () => {
    const initial = await save();
    const update = () => auth(request(app).put('/api/admin/settings/payments')).send({ revision: initial.body.revision, secret_key: KEY });
    const responses = await Promise.all([update(), update()]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  });
  test('concurrent first-time setup returns a conflict instead of overwriting credentials', async () => {
    const revision = (await read()).body.revision;
    const update = () => auth(request(app).put('/api/admin/settings/payments')).send({ revision, secret_key: KEY, webhook_secret: WEBHOOK });
    const responses = await Promise.all([update(), update()]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  });
  test('moving environment-era orders into Settings must verify access to their actual session', async () => {
    await order(true);
    mockRetrieve.mockRejectedValueOnce(new Error('Unknown session for this account'));
    expect((await save()).status).toBe(409);
    expect(await getAppSetting('payments_stripe_credentials')).toBeNull();
    expect((await save()).status).toBe(200);
  });
  test('a checkout started during the provider probe prevents switching to live mode', async () => {
    await save();
    const revision = (await read()).body.revision;
    let release; let entered;
    const checking = new Promise((resolve) => { entered = resolve; });
    const waiting = new Promise((resolve) => { release = resolve; });
    mockAccount.mockImplementationOnce(() => { entered(); return waiting; });
    const update = auth(request(app).put('/api/admin/settings/payments')).send({ revision, secret_key: ['rk', 'live', crypto.randomBytes(24).toString('hex')].join('_'), webhook_secret: WEBHOOK }).then((r) => r);
    await checking;
    try {
      const [photo] = await db('photos').insert({ event_id: gallery.id, filename: 'race.jpg', path: 'events/race.jpg', type: 'individual', visibility: 'visible', media_type: 'image', processing_status: 'complete' }).returning('id');
      await require('../../src/modules/photoSales/stripeCheckout').reserveCheckout(gallery, { photoIds: [photo.id], checkoutKey: crypto.randomUUID(), browserKey: crypto.randomBytes(32).toString('hex') });
    } finally { release({ id: 'acct_picpeak_test' }); }
    expect((await update).status).toBe(409);
    expect((await payments.settings()).test_mode).toBe(true);
  });
  test('saved credentials power real checkout and signed fulfilment routes without environment keys', async () => {
    await save();
    const [photo] = await db('photos').insert({ event_id: gallery.id, filename: 'purchase.jpg', path: 'events/purchase.jpg', type: 'individual', visibility: 'visible', media_type: 'image', processing_status: 'complete' }).returning('id');
    const { reserveCheckout, checkoutSession } = require('../../src/modules/photoSales/stripeCheckout');
    const pending = await reserveCheckout(gallery, { photoIds: [photo.id], checkoutKey: crypto.randomUUID(), browserKey: crypto.randomBytes(32).toString('hex') });
    mockCreate.mockImplementationOnce(async (body) => ({ id: 'cs_test_saved', url: 'https://checkout.stripe.com/c/pay/cs_test_saved', mode: 'payment', metadata: body.metadata, livemode: false }));
    const session = await checkoutSession(pending);
    Object.assign(session, { status: 'complete', payment_status: 'paid', amount_total: 500, currency: 'eur', customer_details: { email: 'buyer@example.test' },
      payment_intent: { id: 'pi_saved', status: 'succeeded', metadata: session.metadata, currency: 'eur', amount_received: 500, latest_charge: { id: 'ch_saved', amount_refunded: 0, disputed: false } } });
    mockRetrieve.mockResolvedValue(session);
    const payload = JSON.stringify({ id: 'evt_saved', type: 'checkout.session.completed', livemode: false, data: { object: session } });
    const sdk = new Stripe(KEY);
    const response = await request(app).post('/api/photo-sales/stripe/webhook').set('Content-Type', 'application/json')
      .set('stripe-signature', sdk.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK })).send(payload);
    expect(response.status).toBe(200);
    expect(await db('photo_purchase_orders').where({ id: pending.id }).first()).toMatchObject({ status: 'completed' });
    expect(Number((await db('photo_purchases').where({ order_id: pending.order_id }).count('* as n').first()).n)).toBe(1);
  });
  test('stores Snipcart credentials encrypted, projects only the public key, and preserves environment precedence', async () => {
    const publicKey = crypto.randomBytes(20).toString('hex'); const secretKey = crypto.randomBytes(20).toString('hex');
    const fetcher = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true });
    try {
      const initial = (await read()).body;
      const response = await auth(request(app).put('/api/admin/settings/payments')).send({ provider: 'snipcart', revision: initial.snipcart.revision, public_key: publicKey, secret_key: secretKey });
      expect(response.status).toBe(200); expect(response.body.providers.available).toEqual(['snipcart']);
      expect(response.body.snipcart).toMatchObject({ source: 'settings', public_key: publicKey, checkout_configured: true });
      expect(JSON.stringify(response.body)).not.toContain(secretKey);
      const stored = await getAppSetting('payments_snipcart_credentials'); expect(stored.secret_key).not.toContain(secretKey);
      expect(() => payments.decrypt(stored.secret_key)).toThrow(); // separate encryption purpose
      process.env.SNIPCART_API_KEY = crypto.randomBytes(20).toString('hex');
      const masked = await read(); expect(masked.body.snipcart).toMatchObject({ source: 'environment', checkout_configured: false });
      expect((await auth(request(app).put('/api/admin/settings/payments')).send({ provider: 'snipcart', revision: masked.body.snipcart.revision, secret_key: secretKey })).status).toBe(409);
    } finally { fetcher.mockRestore(); }
  });
  test('surfaces orphaned and attention orders only to super admins without download or checkout credentials', async () => {
    await order(true, 'refund_failed');
    const orphanId = (await db('photo_purchase_orders').first()).id;
    await db('photo_purchase_orders').where({ id: orphanId }).update({ gallery_id: null, recovery_needs_attention: true, checkout_browser_hash: crypto.randomBytes(32).toString('hex') });
    const response = await auth(request(app).get('/api/admin/settings/payments/orders'));
    expect(response.status).toBe(200); expect(response.body.orders).toHaveLength(1);
    expect(response.body.orders[0]).toMatchObject({ orphaned: true, needs_attention: true, status: 'refund_failed' });
    expect(JSON.stringify(response.body)).not.toMatch(/access_token|checkout_token|checkout_browser_hash|checkout_quote/);
    expect((await auth(request(app).get('/api/admin/settings/payments/orders'), adminToken)).status).toBe(403);
    expect((await auth(request(app).get('/api/admin/settings/payments/orders?page=-1'))).status).toBe(400);
  });
  test('serves a gallery CSP that permits Snipcart only when configured and remains one policy', async () => {
    const policy = () => request(app).get('/api/public/settings/photo-sales-policy');
    let response = await policy(); expect(response.status).toBe(204);
    expect(response.headers['x-picpeak-gallery-csp']).not.toContain('snipcart');
    expect(response.headers['x-picpeak-gallery-csp']).not.toContain('unsafe-eval');
    process.env.SNIPCART_API_KEY = crypto.randomBytes(20).toString('hex'); process.env.SNIPCART_SECRET_API_KEY = crypto.randomBytes(20).toString('hex');
    response = await policy(); expect(response.headers['x-picpeak-gallery-csp']).toContain('https://cdn.snipcart.com');
    expect(response.headers['x-picpeak-gallery-csp']).toContain('unsafe-eval');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  test('checkout availability uses revision checks independently of environment-managed credentials', async () => {
    process.env.STRIPE_SECRET_KEY = KEY; process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK;
    const initial = (await read()).body;
    const change = { provider: 'availability', revision: initial.checkout_enabled.revision, stripe: false, snipcart: true };
    const result = await auth(request(app).put('/api/admin/settings/payments')).send(change);
    expect(result.status).toBe(200); expect(result.body.providers.available).toEqual([]);
    expect(result.body.checkout_configured).toBe(true);
    expect((await auth(request(app).put('/api/admin/settings/payments')).send(change)).status).toBe(409);
    expect((await auth(request(app).put('/api/admin/settings/payments'), adminToken).send(change)).status).toBe(403);
  });

  test.each(['stripe', 'snipcart'])('reports unreadable saved %s credentials after an encryption-key change without logging secrets', async (provider) => {
    const publicKey = crypto.randomBytes(20).toString('hex');
    const secretKey = crypto.randomBytes(20).toString('hex');
    const fetcher = provider === 'snipcart' ? jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true }) : null;
    if (provider === 'stripe') await save();
    else {
      const initial = (await read()).body;
      await auth(request(app).put('/api/admin/settings/payments')).send({
        provider, revision: initial.snipcart.revision, public_key: publicKey, secret_key: secretKey,
      }).expect(200);
    }
    const logger = require('../../src/utils/logger');
    const log = jest.spyOn(logger, 'error').mockImplementation(() => {});
    process.env.PAYMENTS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    try {
      const response = await read();
      expect(response.status).toBe(200);
      expect(provider === 'stripe' ? response.body : response.body.snipcart)
        .toMatchObject({ unreadable: true, checkout_configured: false });
      expect(response.body.providers.available).not.toContain(provider);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('PAYMENTS_ENCRYPTION_KEY'), { provider });
      const output = JSON.stringify(log.mock.calls);
      expect(output).not.toContain(KEY);
      expect(output).not.toContain(WEBHOOK);
      expect(output).not.toContain(secretKey);
      expect(output).not.toContain(process.env.PAYMENTS_ENCRYPTION_KEY);
    } finally {
      delete process.env.PAYMENTS_ENCRYPTION_KEY;
      log.mockRestore();
      fetcher?.mockRestore();
    }
  });

});
