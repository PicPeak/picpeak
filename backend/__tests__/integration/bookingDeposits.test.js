/**
 * Booking deposits and gallery unlock on payment — integration tests
 * (#2440, migration 355).
 *
 * Real routes on a migrated SQLite database; Stripe is an in-memory fake
 * behind the real SDK's webhook signature check (as in the photo-sales
 * suite). Pins:
 *   - a service with a deposit answers the request with a checkout link and
 *     holds the slot only for the checkout; no mail before the payment;
 *   - the paid webhook makes it an ordinary pending request (mails go out);
 *     an expired checkout frees the slot; photo-sales events are untouched;
 *   - the status page follows the request by its token;
 *   - accepting a paid request notes the deposit on the quote; the deposit
 *     is booked on the deal's invoice as a Stripe payment, once;
 *   - a gallery from the booking's quote is locked for clients until every
 *     invoice of the deal is paid, then opens; admins can open it by hand;
 *   - the deposit waits for an issued invoice (an unissued one takes no
 *     payment);
 *   - declining a paid request refunds the deposit.
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Stripe = require('stripe');
const express = require('express');
const request = require('supertest');

process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-booking-deposit-')), 'test.sqlite');
process.env.STRIPE_SECRET_KEY = ['rk', 'test', crypto.randomBytes(18).toString('hex')].join('_');
process.env.STRIPE_WEBHOOK_SECRET = crypto.randomBytes(32).toString('hex');

jest.mock('../../src/utils/frontendUrl', () => ({
  getFrontendBaseUrl: jest.fn(async () => 'https://photos.example.test'),
  getApiBaseUrl: async () => 'https://photos.example.test/api',
}));
jest.mock('../../src/modules/photoSales/stripeClient', () => ({
  ...jest.requireActual('../../src/modules/photoSales/stripeClient'),
  stripeClient: async () => mockStripe,
}));

const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

const sdk = new Stripe(process.env.STRIPE_SECRET_KEY);
const sessions = new Map();
const mockStripe = {
  webhooks: sdk.webhooks,
  checkout: { sessions: {
    create: jest.fn(async (body) => {
      const id = `cs_${crypto.randomUUID()}`;
      const session = {
        id, status: 'open', payment_status: 'unpaid', payment_intent: null, livemode: false, mode: 'payment',
        currency: body.line_items[0].price_data.currency, metadata: body.metadata,
        amount_total: body.line_items[0].price_data.unit_amount, url: `https://checkout.stripe.com/c/pay/${id}`,
      };
      sessions.set(id, session);
      return session;
    }),
    retrieve: jest.fn(async (id) => ({ ...sessions.get(id) })),
    expire: jest.fn(async (id) => {
      const session = sessions.get(id);
      if (session.status !== 'open') throw new Error('Not open');
      session.status = 'expired';
      return session;
    }),
  } },
  refunds: { create: jest.fn(async () => ({ id: `re_${crypto.randomUUID()}`, status: 'succeeded' })) },
};

let db;
let cleanup;
let adminId;
let token;
let publicApp;
let adminApp;
let quoteApp;
let webhookApp;
let shoot;
let ip = 0;
const auth = { get Authorization() { return `Bearer ${token}`; } };
const ZONE = 'Europe/Zurich';

function mondayAhead() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 10);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}
const day = (offset) => {
  const d = mondayAhead();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const zurich = (date, hhmm) => {
  const { _internal: tz } = require('../../src/utils/businessHours');
  const [y, mo, d] = date.split('-').map(Number);
  const [hh, mi] = hhmm.split(':').map(Number);
  return tz.zonedWallClockToUtc(y, mo, d, hh, mi, ZONE).toISOString();
};

/** A form token as GET / signs it, issued a minute ago. */
function formToken() {
  const issued = Date.now() - 60000;
  return `${issued}.${crypto.createHmac('sha256', `booking-form:${process.env.JWT_SECRET}`).update(String(issued)).digest('hex')}`;
}

const sendRequest = (start, extra = {}) => request(publicApp).post('/api/public/booking/requests')
  .set('X-Forwarded-For', `203.0.113.${(ip += 1)}`)
  .send({
    serviceId: shoot.id, values: {}, start, name: 'Mia Keller', email: 'mia@band.example',
    language: 'en', formToken: formToken(), ...extra,
  });

const webhook = (type, object) => {
  const payload = JSON.stringify({ id: `evt_${crypto.randomUUID()}`, type, livemode: false, data: { object } });
  const header = sdk.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
  return request(webhookApp).post('/api/photo-sales/stripe/webhook')
    .set('Content-Type', 'application/json').set('stripe-signature', header).send(payload);
};

const pay = (sessionId) => Object.assign(sessions.get(sessionId), {
  status: 'complete', payment_status: 'paid', payment_intent: `pi_${crypto.randomUUID()}`,
});

const bookingMails = async () => db('email_queue').whereIn('email_type', ['booking_request_received', 'booking_request_admin']).count('* as n').first()
  .then((r) => Number(r.n));

const withTrusted = (fn) => require('../../src/database/crmAccess').withTrustedCrmAccess('booking deposit test', fn);

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  db.client.pool.acquireTimeoutMillis = 2000;
  ({ adminId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  for (const key of ['quotes', 'bills', 'calendar', 'calendarBooking']) {
    const updated = await db('feature_flags').where({ key }).update({ value: true });
    if (!updated) await db('feature_flags').insert({ key, value: true });
  }
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
  await db('business_profile').where({ id: 1 }).update({
    timezone: ZONE,
    email: 'studio@example.test',
    business_hours: JSON.stringify({ 1: [{ start: '09:00', end: '17:00' }], 2: [{ start: '09:00', end: '17:00' }], 3: [], 4: [], 5: [], 6: [], 7: [] }),
  });

  publicApp = buildRouteApp('/api/public/booking', require('../../src/routes/publicBooking'));
  publicApp.set('trust proxy', true);
  adminApp = buildRouteApp('/api/admin/booking', require('../../src/routes/adminBooking'));
  quoteApp = buildRouteApp('/api/admin/quotes', require('../../src/routes/adminQuotes'));
  webhookApp = express();
  webhookApp.use('/api/photo-sales/stripe/webhook', require('../../src/routes/stripeWebhook'));

  await request(adminApp).put('/api/admin/booking/settings').set(auth).send({ slotStepMinutes: 60, leadTimeHours: 24 }).expect(200);
  const res = await request(quoteApp).post('/api/admin/quotes/presets/line-items').set(auth).send({
    name: 'Portrait session', unitPriceMinor: 80000, currency: 'CHF', bookable: true, bookingDurationMinutes: 60,
    bookingDepositType: 'percent', bookingDepositPercent: 25, galleryUnlock: 'full_payment',
  });
  expect(res.status).toBe(201);
  shoot = res.body.preset;
}, 120000);

afterAll(async () => {
  if (cleanup) await cleanup();
});

describe('deposit at booking', () => {
  test('the page shows the deposit; the estimate says how much', async () => {
    const info = await request(publicApp).get('/api/public/booking');
    expect(info.body.services[0].deposit).toEqual({ type: 'percent', percent: 25, amountMinor: null });
    const estimate = await request(publicApp).post('/api/public/booking/estimate').send({ serviceId: shoot.id });
    expect(estimate.body.depositMinor).toBe(20000);
  });

  test('a request waits for the payment; paid, it becomes pending and the mails go out', async () => {
    const res = await sendRequest(zurich(day(0), '09:00'));
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('awaiting_payment');
    expect(res.body.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(res.body.depositMinor).toBe(20000);
    expect(await bookingMails()).toBe(0);

    const row = await db('booking_requests').where({ reference: res.body.reference }).first();
    expect(row.deposit_status).toBe('open');
    const status = await request(publicApp).get(`/api/public/booking/requests/status/${res.body.statusToken}`);
    expect(status.body.status).toBe('awaiting_payment');

    const session = pay(row.checkout_session_id);
    const hook = await webhook('checkout.session.completed', { id: session.id, metadata: session.metadata });
    expect(hook.status).toBe(200);

    const paid = await db('booking_requests').where({ id: row.id }).first();
    expect([paid.status, paid.deposit_status]).toEqual(['pending', 'paid']);
    expect(paid.payment_intent_id).toBe(session.payment_intent);
    expect(await bookingMails()).toBe(2);
    const again = await webhook('checkout.session.completed', { id: session.id, metadata: session.metadata });
    expect(again.status).toBe(200);
    expect(await bookingMails()).toBe(2);
  });

  test('an expired checkout frees the slot', async () => {
    const res = await sendRequest(zurich(day(0), '11:00'));
    const row = await db('booking_requests').where({ reference: res.body.reference }).first();
    const before = await request(publicApp).get('/api/public/booking/slots').query({ serviceId: shoot.id, from: day(0), to: day(0) });
    expect(before.body.slots.map((s) => s.start)).not.toContain(zurich(day(0), '11:00'));

    Object.assign(sessions.get(row.checkout_session_id), { status: 'expired' });
    await webhook('checkout.session.expired', { id: row.checkout_session_id, metadata: { picpeak_booking_ref: row.reference } }).expect(200);
    expect((await db('booking_requests').where({ id: row.id }).first()).status).toBe('expired');
    const after = await request(publicApp).get('/api/public/booking/slots').query({ serviceId: shoot.id, from: day(0), to: day(0) });
    expect(after.body.slots.map((s) => s.start)).toContain(zurich(day(0), '11:00'));
  });

  test('a checkout event without booking metadata is left to photo sales', async () => {
    const res = await webhook('checkout.session.completed', { id: 'cs_unknown', metadata: {} });
    expect(res.status).toBe(200);
  });

  test('declining a paid request refunds the deposit', async () => {
    const res = await sendRequest(zurich(day(1), '09:00'));
    const row = await db('booking_requests').where({ reference: res.body.reference }).first();
    const session = pay(row.checkout_session_id);
    await webhook('checkout.session.completed', { id: session.id, metadata: session.metadata }).expect(200);

    const declined = await request(adminApp).post(`/api/admin/booking/requests/${row.id}/decline`).set(auth).send({});
    expect(declined.status).toBe(200);
    expect(declined.body.request.depositStatus).toBe('refunded');
    expect(mockStripe.refunds.create).toHaveBeenCalledWith(
      { payment_intent: session.payment_intent },
      { idempotencyKey: `picpeak-booking-refund:${row.reference}` },
    );
  });
});

describe('gallery unlock on full payment', () => {
  let requestRow;
  let eventId;

  test('accept notes the deposit; the gallery from the quote is locked', async () => {
    requestRow = await db('booking_requests').where({ status: 'pending', deposit_status: 'paid' }).first();
    const accepted = await request(adminApp).post(`/api/admin/booking/requests/${requestRow.id}/accept`).set(auth);
    expect(accepted.status).toBe(200);
    const quoteId = accepted.body.request.quoteId;
    const quote = await withTrusted(() => db('quotes').where({ id: quoteId }).first());
    expect(quote.internal_notes).toMatch(/deposit CHF\s200\.00/u);

    await withTrusted(() => db('quotes').where({ id: quoteId }).update({ status: 'accepted' }));
    const converted = await withTrusted(() => require('../../src/services/quoteService').convertToEvent(quoteId, adminId));
    eventId = converted.eventId;
    const event = await db('events').where({ id: eventId }).first();
    expect(event.payment_lock).toBe('full_payment');
    expect(event.payment_unlocked_at).toBeNull();
  });

  test('clients are refused while the deal is unpaid', async () => {
    await db('events').where({ id: eventId }).update({ is_active: true, is_draft: false, expires_at: new Date(Date.now() + 86400000 * 365).toISOString() });
    const access = require('../../src/services/galleryAccessService');
    const event = await db('events').where({ id: eventId }).first();
    const grant = { kind: 'public', eventId, issuedAt: Math.floor(Date.now() / 1000) };
    await expect(access.authorize({ ...event, password_hash: null, require_password: false }, grant))
      .rejects.toMatchObject({ code: 'GALLERY_AWAITING_PAYMENT' });
  });

  test('the deposit is booked on the deal\'s invoice once; paying the rest opens the gallery', async () => {
    const list = await request(adminApp).get(`/api/admin/booking/requests/${requestRow.id}`).set(auth);
    const [invoice] = list.body.request.invoices;
    expect(invoice).toBeDefined();
    expect(list.body.request.galleries).toEqual([expect.objectContaining({ id: eventId, locked: true })]);

    // The default plan bills after delivery: an unissued invoice takes no
    // payment, so the deposit waits for it like any payment would.
    expect(invoice.status).toBe('pending_delivery');
    const early = await request(adminApp).post(`/api/admin/booking/requests/${requestRow.id}/apply-deposit`).set(auth)
      .send({ invoiceId: invoice.id });
    expect(early.status).toBe(409);
    expect((await db('booking_requests').where({ id: requestRow.id }).first()).deposit_invoice_id).toBeNull();

    // Delivered and sent (the send itself is covered by the invoice suites).
    await withTrusted(() => db('invoices').where({ id: invoice.id }).update({ status: 'sent' }));
    const applied = await request(adminApp).post(`/api/admin/booking/requests/${requestRow.id}/apply-deposit`).set(auth)
      .send({ invoiceId: invoice.id });
    expect(applied.status).toBe(200);
    expect(applied.body.request.depositInvoiceId).toBe(invoice.id);
    const log = await withTrusted(() => db('invoice_payment_log').where({ invoice_id: invoice.id }).first());
    expect([Number(log.amount_minor), log.payment_method]).toEqual([20000, 'stripe']);
    const twice = await request(adminApp).post(`/api/admin/booking/requests/${requestRow.id}/apply-deposit`).set(auth)
      .send({ invoiceId: invoice.id });
    expect(twice.status).toBe(409);

    // Still locked: only the deposit is in.
    expect((await db('events').where({ id: eventId }).first()).payment_unlocked_at).toBeNull();

    const fresh = await withTrusted(() => db('invoices').where({ id: invoice.id }).first());
    await withTrusted(() => require('../../src/services/invoice/payments').markPaid(invoice.id, {
      amountMinor: Number(fresh.total_amount_minor) - Number(fresh.paid_amount_minor),
      paidAt: new Date().toISOString().slice(0, 10), paymentMethod: 'bank_transfer',
    }, adminId));
    const opened = await db('events').where({ id: eventId }).first();
    expect(opened.payment_unlocked_at).not.toBeNull();
    const access = require('../../src/services/galleryAccessService');
    const grant = { kind: 'public', eventId, issuedAt: Math.floor(Date.now() / 1000) };
    await expect(access.authorize({ ...opened, password_hash: null, require_password: false }, grant)).resolves.toBe(grant);
  });

  test('an admin can open a locked gallery by hand', async () => {
    await db('events').where({ id: eventId }).update({ payment_unlocked_at: null });
    // The deal is paid: the check opens it on the next client visit anyway.
    // By hand, it opens at once.
    const res = await request(adminApp).post(`/api/admin/booking/galleries/${eventId}/unlock`).set(auth);
    expect(res.status).toBe(200);
    const again = await request(adminApp).post(`/api/admin/booking/galleries/${eventId}/unlock`).set(auth);
    expect(again.status).toBe(409);
  });
});

describe('payments at the edges', () => {
  const slotTaken = async (date, hhmm) => {
    const res = await request(publicApp).get('/api/public/booking/slots').query({ serviceId: shoot.id, from: date, to: date });
    return !res.body.slots.map((x) => x.start).includes(zurich(date, hhmm));
  };
  const open = async (date, hhmm, email) => {
    const res = await sendRequest(zurich(date, hhmm), { email });
    expect(res.status).toBe(201);
    return { res, row: await db('booking_requests').where({ reference: res.body.reference }).first() };
  };

  test('a paid request outlives its hold: the slot stays taken until the admin decides', async () => {
    const { row } = await open(day(7), '09:00', 'paid-hold@example.test');
    const session = pay(row.checkout_session_id);
    await webhook('checkout.session.completed', { id: session.id, metadata: session.metadata }).expect(200);
    await db('booking_requests').where({ id: row.id }).update({ hold_expires_at: new Date(Date.now() - 1000).toISOString() });
    await request(adminApp).get('/api/admin/booking/requests').set(auth).expect(200);
    expect((await db('booking_requests').where({ id: row.id }).first()).status).toBe('pending');
    expect(await slotTaken(day(7), '09:00')).toBe(true);
  });

  test('a payment after the hold ran out: restored while the slot is free, refunded once it is taken', async () => {
    const { row: free } = await open(day(7), '11:00', 'late-free@example.test');
    await db('booking_requests').where({ id: free.id }).update({ hold_expires_at: new Date(Date.now() - 1000).toISOString() });
    await request(adminApp).get('/api/admin/booking/requests').set(auth);
    expect((await db('booking_requests').where({ id: free.id }).first()).status).toBe('expired');
    const s1 = pay(free.checkout_session_id);
    await webhook('checkout.session.completed', { id: s1.id, metadata: s1.metadata }).expect(200);
    expect(await db('booking_requests').where({ id: free.id }).first()).toMatchObject({ status: 'pending', deposit_status: 'paid' });

    const { row: late } = await open(day(7), '13:00', 'late-taken@example.test');
    await db('booking_requests').where({ id: late.id }).update({ status: 'expired', deposit_status: 'expired' });
    await open(day(7), '13:00', 'someone-else@example.test');
    const s2 = pay(late.checkout_session_id);
    await webhook('checkout.session.completed', { id: s2.id, metadata: s2.metadata }).expect(200);
    expect(await db('booking_requests').where({ id: late.id }).first()).toMatchObject({ status: 'expired', deposit_status: 'refunded' });
  });

  test('cancelling the checkout frees the slot at once', async () => {
    const { res, row } = await open(day(8), '09:00', 'cancel@example.test');
    expect(await slotTaken(day(8), '09:00')).toBe(true);
    const status = await request(publicApp).get(`/api/public/booking/requests/status/${res.body.statusToken}`).query({ cancelled: '1' });
    expect(status.body.status).toBe('expired');
    expect((await db('booking_requests').where({ id: row.id }).first()).deposit_status).toBe('expired');
    expect(await slotTaken(day(8), '09:00')).toBe(false);
  });

  test('a payment of another amount is held for review and the studio is told', async () => {
    const before = await bookingMails();
    const { row } = await open(day(8), '11:00', 'review@example.test');
    const session = pay(row.checkout_session_id);
    session.amount_total = 1;
    await webhook('checkout.session.completed', { id: session.id, metadata: session.metadata }).expect(200);
    expect(await db('booking_requests').where({ id: row.id }).first()).toMatchObject({ status: 'pending', deposit_status: 'review' });
    expect(await bookingMails()).toBe(before + 2);
  });

  test('one address holds at most two open requests, deposits awaiting payment included', async () => {
    for (const hhmm of ['13:00', '14:00']) await open(day(8), hhmm, 'busy@example.test');
    const third = await sendRequest(zurich(day(8), '15:00'), { email: 'Busy@Example.test' });
    expect(third.status).toBe(429);
  });
});

describe('review round 1', () => {
  const open = async (date, hhmm, email) => {
    const res = await sendRequest(zurich(date, hhmm), { email });
    expect(res.status).toBe(201);
    return { res, row: await db('booking_requests').where({ reference: res.body.reference }).first() };
  };
  const payAndHook = async (row) => {
    const session = pay(row.checkout_session_id);
    await webhook('checkout.session.completed', { id: session.id, metadata: session.metadata }).expect(200);
    return session;
  };
  const acceptAndConvert = async (row) => {
    const accepted = await request(adminApp).post(`/api/admin/booking/requests/${row.id}/accept`).set(auth);
    expect(accepted.status).toBe(200);
    return accepted.body.request.quoteId;
  };

  test('a gallery from a reissued quote is locked like the original', async () => {
    const { row } = await open(day(14), '09:00', 'reissue@example.test');
    await payAndHook(row);
    const quoteId = await acceptAndConvert(row);
    const quoteService = require('../../src/services/quoteService');
    await withTrusted(() => db('quotes').where({ id: quoteId }).update({ status: 'accepted' }));
    const reissued = await withTrusted(() => quoteService.reissueQuote(quoteId, adminId, 'Changed the scope'));
    const newId = reissued.id ?? reissued.quoteId ?? reissued;
    await withTrusted(() => db('quotes').where({ id: newId }).update({ status: 'accepted' }));
    const converted = await withTrusted(() => quoteService.convertToEvent(newId, adminId));
    expect((await db('events').where({ id: converted.eventId }).first()).payment_lock).toBe('full_payment');
  });

  test('the deposit goes only on an issued, open invoice, and never above what is open', async () => {
    const { row } = await open(day(21), '09:00', 'invoice@example.test');
    await payAndHook(row);
    const quoteId = await acceptAndConvert(row);
    await withTrusted(() => db('quotes').where({ id: quoteId }).update({ status: 'accepted' }));
    await withTrusted(() => require('../../src/services/quoteService').convertToEvent(quoteId, adminId));
    const quote = await withTrusted(() => db('quotes').where({ id: quoteId }).first());
    const invoice = await withTrusted(() => db('invoices').where({ deal_uuid: quote.deal_uuid }).first());
    const apply = () => request(adminApp).post(`/api/admin/booking/requests/${row.id}/apply-deposit`).set(auth).send({ invoiceId: invoice.id });

    await withTrusted(() => db('invoices').where({ id: invoice.id }).update({ status: 'scheduled' }));
    expect((await apply()).status).toBe(409);
    await withTrusted(() => db('invoices').where({ id: invoice.id }).update({ status: 'paid', paid_amount_minor: invoice.total_amount_minor }));
    expect((await apply()).status).toBe(409);
    // Issued, with only 50.00 still open: 50.00 booked, not the 200.00 deposit.
    await withTrusted(() => db('invoices').where({ id: invoice.id })
      .update({ status: 'sent', paid_amount_minor: Number(invoice.total_amount_minor) - 5000 }));
    const res = await apply();
    expect(res.status).toBe(200);
    const log = await withTrusted(() => db('invoice_payment_log').where({ invoice_id: invoice.id }).orderBy('id', 'desc').first());
    expect(Number(log.amount_minor)).toBe(5000);
  });

  test('a payment of another amount after the hold ran out is held for review but not put back on the calendar', async () => {
    const { row } = await open(day(15), '09:00', 'late-review@example.test');
    await db('booking_requests').where({ id: row.id }).update({ status: 'expired', deposit_status: 'expired' });
    const session = pay(row.checkout_session_id);
    session.amount_total = 1;
    await webhook('checkout.session.completed', { id: session.id, metadata: session.metadata }).expect(200);
    expect(await db('booking_requests').where({ id: row.id }).first()).toMatchObject({ status: 'expired', deposit_status: 'review' });
  });

  test('a late payment for a taken time is refunded and the client is told why', async () => {
    const { row } = await open(day(15), '13:00', 'late-mail@example.test');
    await db('booking_requests').where({ id: row.id }).update({ status: 'expired', deposit_status: 'expired' });
    await open(day(15), '13:00', 'other-late@example.test');
    await payAndHook(row);
    expect((await db('booking_requests').where({ id: row.id }).first()).deposit_status).toBe('refunded');
    const mail = await db('email_queue').where({ email_type: 'booking_request_declined', recipient_email: 'late-mail@example.test' }).first();
    expect(mail).toBeDefined();
    // A JSON column: text on SQLite, an object on PostgreSQL.
    const data = typeof mail.email_data === 'string' ? JSON.parse(mail.email_data) : mail.email_data;
    expect(data.deposit_refunded).toBeTruthy();
  });

  test('a refund that fails at Stripe, and a dispute, show on the request', async () => {
    const { row } = await open(day(22), '09:00', 'dispute@example.test');
    const session = await payAndHook(row);
    const intent = session.payment_intent;
    await webhook('refund.failed', { id: 're_x', status: 'failed', payment_intent: intent }).expect(200);
    expect((await db('booking_requests').where({ id: row.id }).first()).deposit_status).toBe('refund_failed');
    await webhook('charge.dispute.created', { id: 'dp_x', payment_intent: intent }).expect(200);
    expect((await db('booking_requests').where({ id: row.id }).first()).deposit_status).toBe('disputed');
  });

  test('a won dispute is paid again, a partial refund changes nothing, a refund is not overwritten', async () => {
    const { row } = await open(day(36), '13:00', 'dispute-won@example.test');
    const session = await payAndHook(row);
    const intent = session.payment_intent;
    const status = async () => (await db('booking_requests').where({ id: row.id }).first()).deposit_status;
    await webhook('charge.refunded', { id: 'ch_p', payment_intent: intent, refunded: false }).expect(200);
    expect(await status()).toBe('paid');
    await webhook('refund.updated', { id: 're_p', payment_intent: intent, status: 'succeeded', amount: 100 }).expect(200);
    expect(await status()).toBe('paid');
    await webhook('charge.dispute.created', { id: 'dp_w', payment_intent: intent }).expect(200);
    expect(await status()).toBe('disputed');
    // A disputed deposit holds the request like a paid one: it does not expire.
    await db('booking_requests').where({ id: row.id }).update({ hold_expires_at: new Date(Date.now() - 60000).toISOString() });
    await request(adminApp).get('/api/admin/booking/requests').set(auth).expect(200);
    expect((await db('booking_requests').where({ id: row.id }).first()).status).toBe('pending');
    await webhook('charge.dispute.closed', { id: 'dp_w', payment_intent: intent, status: 'won' }).expect(200);
    expect(await status()).toBe('paid');
    await webhook('charge.refunded', { id: 'ch_f', payment_intent: intent, refunded: true }).expect(200);
    expect(await status()).toBe('refunded');
    await webhook('charge.dispute.created', { id: 'dp_l', payment_intent: intent }).expect(200);
    expect(await status()).toBe('refunded');
  });
});

describe('blind review', () => {
  const open = async (date, hhmm, email) => {
    const res = await sendRequest(zurich(date, hhmm), { email });
    expect(res.status).toBe(201);
    return { res, row: await db('booking_requests').where({ reference: res.body.reference }).first() };
  };
  const hook = async (session) => webhook('checkout.session.completed', { id: session.id, metadata: session.metadata }).expect(200);

  test('a payment after the admin declined the expired request is recorded and refunded', async () => {
    const { row } = await open(day(28), '09:00', 'late-declined@example.test');
    await db('booking_requests').where({ id: row.id }).update({ status: 'expired', deposit_status: 'expired' });
    await request(adminApp).post(`/api/admin/booking/requests/${row.id}/decline`).set(auth).send({}).expect(200);
    await hook(pay(row.checkout_session_id));
    const after = await db('booking_requests').where({ id: row.id }).first();
    expect(after).toMatchObject({ status: 'declined', deposit_status: 'refunded' });
    expect(after.payment_intent_id).toBeTruthy();
  });

  test('a payment after the admin accepted the expired request is recorded as paid', async () => {
    const { row } = await open(day(28), '13:00', 'late-accepted@example.test');
    await db('booking_requests').where({ id: row.id }).update({ status: 'expired', deposit_status: 'expired' });
    await request(adminApp).post(`/api/admin/booking/requests/${row.id}/accept`).set(auth).expect(200);
    await hook(pay(row.checkout_session_id));
    expect(await db('booking_requests').where({ id: row.id }).first()).toMatchObject({ status: 'accepted', deposit_status: 'paid' });
  });

  test('a deposit larger than what is open is booked over several invoices', async () => {
    const { row } = await open(day(29), '09:00', 'split@example.test');
    await hook(pay(row.checkout_session_id));
    const quoteId = (await request(adminApp).post(`/api/admin/booking/requests/${row.id}/accept`).set(auth)).body.request.quoteId;
    await withTrusted(() => db('quotes').where({ id: quoteId }).update({ status: 'accepted' }));
    await withTrusted(() => require('../../src/services/quoteService').convertToEvent(quoteId, adminId));
    const quote = await withTrusted(() => db('quotes').where({ id: quoteId }).first());
    const [first] = await withTrusted(() => db('invoices').where({ deal_uuid: quote.deal_uuid }));
    // Two invoices in the deal, 50.00 open on each; the deposit is 200.00.
    await withTrusted(() => db('invoices').where({ id: first.id }).update({ status: 'sent', paid_amount_minor: Number(first.total_amount_minor) - 5000 }));
    const { id: _id, invoice_number: _n, ...copy } = await withTrusted(() => db('invoices').where({ id: first.id }).first());
    const inserted = await withTrusted(() => db('invoices').insert({ ...copy, invoice_number: `X-${Date.now()}` }).returning('id'));
    const second = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
    const apply = (invoiceId) => request(adminApp).post(`/api/admin/booking/requests/${row.id}/apply-deposit`).set(auth).send({ invoiceId });
    expect((await apply(first.id)).body.request.depositAppliedMinor).toBe(5000);
    expect((await apply(second)).body.request.depositAppliedMinor).toBe(10000);
  });

  test('a refund made in Stripe closes a review, and declining a review refunds it', async () => {
    const { row } = await open(day(36), '13:00', 'review-refund@example.test');
    const session = pay(row.checkout_session_id);
    session.amount_total = 1;
    await hook(session);
    expect((await db('booking_requests').where({ id: row.id }).first()).deposit_status).toBe('review');
    await webhook('charge.refunded', { id: 'ch_x', refunded: true, payment_intent: session.payment_intent }).expect(200);
    expect((await db('booking_requests').where({ id: row.id }).first()).deposit_status).toBe('refunded');

    const { row: other } = await open(day(35), '09:00', 'review-decline@example.test');
    const s2 = pay(other.checkout_session_id);
    s2.amount_total = 1;
    await hook(s2);
    const declined = await request(adminApp).post(`/api/admin/booking/requests/${other.id}/decline`).set(auth).send({});
    expect(declined.body.request.depositStatus).toBe('refunded');
  });

  test('our own session is still reconciled after the frontend URL changed', async () => {
    const { row } = await open(day(35), '13:00', 'moved@example.test');
    const session = pay(row.checkout_session_id);
    session.metadata = { ...session.metadata, picpeak_origin: 'https://old-address.example.test' };
    await hook(session);
    expect((await db('booking_requests').where({ id: row.id }).first()).deposit_status).toBe('paid');
  });
});
