/**
 * Client booking requests — integration tests (#2440, migration 354).
 *
 * Public booking API + admin booking API against SQLite with the full core
 * migration run (helpers/crmDb). Pins:
 *   - the flag gates the public API;
 *   - the catalogue shows bookable services and only client-visible factors;
 *   - slots follow the business hours in the business timezone, the slot
 *     step, and the duration factor; gallery events (full-day and timed),
 *     manual blocks and held requests take slots away;
 *   - a request holds its slot (a second one for it gets 409); an expired
 *     hold frees it; the honeypot stores nothing;
 *   - accepting creates the customer, a project and a draft quote
 *     with the estimate lines; a second accept is refused; declining frees
 *     the slot.
 */

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let tmpDir;
let adminId;
let token;
let quoteApp;
let catalogApp;
let publicApp;
let adminApp;
let invalidateFeatureFlagCache;

const prevCwd = process.cwd();
const auth = { get Authorization() { return `Bearer ${token}`; } };
const ZONE = 'Europe/Zurich';

async function setFlag(key, value) {
  const updated = await db('feature_flags').where({ key }).update({ value });
  if (!updated) await db('feature_flags').insert({ key, value });
  invalidateFeatureFlagCache();
}

/** A Monday at least 10 days out, as YYYY-MM-DD, plus day offsets from it. */
function mondayAhead() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 10);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}
const day = (base, offset) => {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
/** Zurich wall clock → ISO instant (CET/CEST resolved by Intl). */
function zurich(date, hhmm) {
  const { _internal: tz } = require('../../src/utils/businessHours');
  const [y, mo, d] = date.split('-').map(Number);
  const [hh, mi] = hhmm.split(':').map(Number);
  return tz.zonedWallClockToUtc(y, mo, d, hh, mi, ZONE).toISOString();
}
const hhmm = (isoString) => new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONE, hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(isoString));

let monday;
let shoot;
let sessionLength;
let editing;

async function slotsOn(date, duration = 2) {
  const res = await request(publicApp).get('/api/public/booking/slots')
    .query({ serviceId: shoot.id, from: date, to: date, ...(duration == null ? {} : { duration }) });
  expect(res.status).toBe(200);
  return res.body.slots.map((s) => hhmm(s.start));
}

// The request limiter allows 5 per IP and hour; each request here comes
// from its own address (the test app trusts X-Forwarded-For).
let clientIp = 0;
const sendRequest = (start, extra = {}) => request(publicApp).post('/api/public/booking/requests')
  .set('X-Forwarded-For', `198.51.100.${(clientIp += 1)}`).send({
  serviceId: shoot.id,
  values: { [sessionLength.id]: 2 },
  start,
  name: 'Mia Keller',
  email: 'mia@band.example',
  company: 'The Echoes',
  message: 'Music video for our single',
  language: 'en',
  startedAt: Date.now() - 60000,
  ...extra,
});

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  db.client.pool.acquireTimeoutMillis = 2000;
  ({ invalidateFeatureFlagCache } = require('../../src/middleware/requireFeatureFlag'));

  ({ adminId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  await setFlag('quotes', true);
  await setFlag('calendar', true);
  await setFlag('calendarBooking', true);

  await db('business_profile').where({ id: 1 }).update({
    timezone: ZONE,
    business_hours: JSON.stringify({
      1: [{ start: '09:00', end: '12:00' }, { start: '13:00', end: '17:00' }],
      2: [{ start: '09:00', end: '17:00' }],
      3: [{ start: '09:00', end: '17:00' }],
      4: [{ start: '09:00', end: '17:00' }],
      5: [{ start: '09:00', end: '17:00' }],
      6: [], 7: [],
    }),
  });

  quoteApp = buildRouteApp('/api/admin/quotes', require('../../src/routes/adminQuotes'));
  catalogApp = buildRouteApp('/api/admin/quote-catalog', require('../../src/routes/adminQuoteCatalog'));
  publicApp = buildRouteApp('/api/public/booking', require('../../src/routes/publicBooking'));
  publicApp.set('trust proxy', true);
  adminApp = buildRouteApp('/api/admin/booking', require('../../src/routes/adminBooking'));

  await request(adminApp).put('/api/admin/booking/settings').set(auth)
    .send({ slotStepMinutes: 60, leadTimeHours: 24, holdHours: 48 }).expect(200);

  const factor = (body) => request(catalogApp).post('/api/admin/quote-catalog/factors').set(auth).send(body)
    .then((r) => { expect(r.status).toBe(201); return r.body.factor; });
  sessionLength = await factor({
    name: 'Session length', inputType: 'number', effect: 'per_unit', unitLabel: 'h', amountMinor: 15000, includedUnits: 2, minValue: 1, maxValue: 8, defaultValue: '2',
  });
  editing = await factor({
    name: 'Editing difficulty', inputType: 'toggle', effect: 'percent', percent: 30, clientVisible: false,
  });

  const res = await request(quoteApp).post('/api/admin/quotes/presets/line-items').set(auth).send({
    name: 'Music video shoot', unitPriceMinor: 100000, currency: 'CHF',
    factorIds: [sessionLength.id, editing.id], bookable: true, bookingDurationFactorId: sessionLength.id,
  });
  expect(res.status).toBe(201);
  shoot = res.body.preset;
  monday = mondayAhead();
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

describe('public catalogue', () => {
  test('is off while the flag is off', async () => {
    await setFlag('calendarBooking', false);
    const res = await request(publicApp).get('/api/public/booking');
    expect(res.status).toBe(403);
    await setFlag('calendarBooking', true);
  });

  test('lists bookable services with their client-visible factors only', async () => {
    const res = await request(publicApp).get('/api/public/booking');
    expect(res.status).toBe(200);
    const [service] = res.body.services;
    expect(service).toEqual(expect.objectContaining({ id: shoot.id, name: 'Music video shoot', durationFactorId: sessionLength.id }));
    expect(service.factors.map((f) => f.name)).toEqual(['Session length']);
    expect(res.body.timezone).toBe(ZONE);
  });

  test('a duration factor must be one of the service\'s number factors', async () => {
    const res = await request(quoteApp).put(`/api/admin/quotes/presets/line-items/${shoot.id}`).set(auth)
      .send({ bookingDurationFactorId: editing.id });
    expect(res.status).toBe(400);
  });

  test('the estimate uses the defaults of admin-only factors', async () => {
    const res = await request(publicApp).post('/api/public/booking/estimate')
      .send({ serviceId: shoot.id, values: { [sessionLength.id]: 4, [editing.id]: true } });
    expect(res.status).toBe(200);
    expect(res.body.totalMinor).toBe(130000); // 1000 + 2 h × 150; editing stays off
    expect(res.body.durationMinutes).toBe(240);
  });
});

describe('availability', () => {
  test('slots follow the hours, the step and the duration', async () => {
    expect(await slotsOn(day(monday, 0), 2)).toEqual(['09:00', '10:00', '13:00', '14:00', '15:00']);
    expect(await slotsOn(day(monday, 0), 4)).toEqual(['13:00']);
    // No value given: the factor's default (2 h) sets the length, as it sets the price.
    expect(await slotsOn(day(monday, 0), null)).toEqual(['09:00', '10:00', '13:00', '14:00', '15:00']);
    expect(await slotsOn(day(monday, 5), 2)).toEqual([]); // Saturday
  });

  test('gallery events, full-day and timed, take their time', async () => {
    await db('events').insert([
      { slug: 'booking-full-day', event_name: 'Wedding', event_type: 'wedding', event_date: day(monday, 1), is_full_day: true, share_link: 'x1', password_hash: 'x', expires_at: new Date(Date.now() + 86400000 * 365), is_archived: false, is_active: true, created_at: new Date() },
      { slug: 'booking-timed', event_name: 'Portrait', event_type: 'portrait', event_date: day(monday, 2), is_full_day: false, event_time_start: '11:00', event_time_end: '13:00', share_link: 'x2', password_hash: 'x', expires_at: new Date(Date.now() + 86400000 * 365), is_archived: false, is_active: true, created_at: new Date() },
    ]);
    expect(await slotsOn(day(monday, 1))).toEqual([]);
    expect(await slotsOn(day(monday, 2))).toEqual(['09:00', '13:00', '14:00', '15:00']);
  });

  test('a manual block takes its time', async () => {
    const res = await request(adminApp).post('/api/admin/booking/blocks').set(auth)
      .send({ startsAt: zurich(day(monday, 3), '12:00'), endsAt: zurich(day(monday, 3), '17:00'), note: 'Dentist' });
    expect(res.status).toBe(201);
    expect(await slotsOn(day(monday, 3))).toEqual(['09:00', '10:00']);
  });
});

describe('requests', () => {
  test('the honeypot stores nothing', async () => {
    const res = await sendRequest(zurich(day(monday, 0), '09:00'), { website: 'http://spam.example' });
    expect(res.status).toBe(201);
    expect(res.body.reference).toBeNull();
    const { n } = await db('booking_requests').count('* as n').first();
    expect(Number(n)).toBe(0); // PostgreSQL counts as a string
  });

  test('a request holds its slot; a second one for it is refused', async () => {
    const res = await sendRequest(zurich(day(monday, 0), '09:00'));
    expect(res.status).toBe(201);
    expect(res.body.reference).toMatch(/^[A-Z2-9]{10}$/);
    expect(res.body.estimateMinor).toBe(100000);
    expect(await slotsOn(day(monday, 0))).toEqual(['13:00', '14:00', '15:00']);

    const again = await sendRequest(zurich(day(monday, 0), '10:00'));
    expect(again.status).toBe(409);
  });

  test('a time that is not a slot is refused', async () => {
    const res = await sendRequest(zurich(day(monday, 0), '12:30'));
    expect(res.status).toBe(409);
  });

  test('an expired hold frees the slot', async () => {
    const row = await db('booking_requests').first();
    await db('booking_requests').where({ id: row.id }).update({ hold_expires_at: new Date(Date.now() - 1000).toISOString() });
    expect(await slotsOn(day(monday, 0))).toContain('09:00');
    const list = await request(adminApp).get('/api/admin/booking/requests').set(auth);
    expect(list.body.requests[0].status).toBe('expired');
  });
});

describe('admin decisions', () => {
  test('accept creates customer, project and a draft quote with the estimate', async () => {
    const sent = await sendRequest(zurich(day(monday, 4), '13:00'), { values: { [sessionLength.id]: 3 } });
    expect(sent.status).toBe(201);
    const row = await db('booking_requests').where({ reference: sent.body.reference }).first();

    const res = await request(adminApp).post(`/api/admin/booking/requests/${row.id}/accept`).set(auth);
    expect(res.status).toBe(200);
    const accepted = res.body.request;
    expect(accepted.status).toBe('accepted');

    const customer = await db('customer_accounts').where({ id: accepted.customerAccountId }).first();
    expect(customer).toEqual(expect.objectContaining({ email: 'mia@band.example', first_name: 'Mia', last_name: 'Keller', company_name: 'The Echoes' }));
    const project = await db('projects').where({ id: accepted.projectId }).first();
    // Created as an inquiry; attaching the quote makes it active, as it does
    // for any inquiry that gets a document.
    expect(project.status).toBe('active');
    expect(project.source).toBe('website');

    const quote = await request(quoteApp).get(`/api/admin/quotes/${accepted.quoteId}`).set(auth);
    expect(quote.status).toBe(200);
    expect(quote.body.quote.status).toBe('draft');
    expect(quote.body.quote.eventTimeStart).toBe('13:00');
    expect(Number(quote.body.quote.netAmountMinor)).toBe(115000);
    const parent = quote.body.lineItems.find((li) => li.description === 'Music video shoot');
    expect(parent.pricingFactors.values[sessionLength.id]).toBe(3);

    // Still busy, and a second accept is refused.
    expect(await slotsOn(day(monday, 4), 3)).not.toContain('13:00');
    const again = await request(adminApp).post(`/api/admin/booking/requests/${row.id}/accept`).set(auth);
    expect(again.status).toBe(409);
  });

  test('a second request from the same email reuses the customer', async () => {
    const sent = await sendRequest(zurich(day(monday, 7), '09:00'));
    const row = await db('booking_requests').where({ reference: sent.body.reference }).first();
    const res = await request(adminApp).post(`/api/admin/booking/requests/${row.id}/accept`).set(auth);
    expect(res.status).toBe(200);
    const customers = await db('customer_accounts').where({ email: 'mia@band.example' });
    expect(customers).toHaveLength(1);
    expect(res.body.request.customerAccountId).toBe(customers[0].id);
  });

  test('a failed accept leaves the request pending and no project behind', async () => {
    // A customer with quotes switched off: the quote step refuses.
    await db('customer_accounts').insert({
      email: 'noquotes@band.example', display_name: 'No Quotes', preferred_language: 'en',
      is_active: true, feature_quotes: false, created_at: new Date().toISOString(),
    });
    const sent = await sendRequest(zurich(day(monday, 7), '13:00'), { email: 'noquotes@band.example' });
    const row = await db('booking_requests').where({ reference: sent.body.reference }).first();
    const projectsBefore = Number((await db('projects').count('* as n').first()).n);

    const res = await request(adminApp).post(`/api/admin/booking/requests/${row.id}/accept`).set(auth);
    expect(res.status).toBe(409);
    expect((await db('booking_requests').where({ id: row.id }).first()).status).toBe('pending');
    expect(Number((await db('projects').count('* as n').first()).n)).toBe(projectsBefore);
  });

  test('decline frees the slot', async () => {
    const sent = await sendRequest(zurich(day(monday, 8), '09:00'));
    const row = await db('booking_requests').where({ reference: sent.body.reference }).first();
    expect(await slotsOn(day(monday, 8))).not.toContain('09:00');
    const res = await request(adminApp).post(`/api/admin/booking/requests/${row.id}/decline`).set(auth)
      .send({ reason: 'Fully booked that week.' });
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('declined');
    expect(await slotsOn(day(monday, 8))).toContain('09:00');
  });

  test('accepting needs the permissions the manual path needs', async () => {
    const sent = await sendRequest(zurich(day(monday, 9), '09:00'));
    const row = await db('booking_requests').where({ reference: sent.body.reference }).first();
    await assignAdminRole(db, adminId, 'viewer');
    const res = await request(adminApp).post(`/api/admin/booking/requests/${row.id}/accept`).set(auth);
    await assignAdminRole(db, adminId, 'super_admin');
    expect(res.status).toBe(403);
  });
});
