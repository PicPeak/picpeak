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
const crypto = require('crypto');
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
/** A form token as GET / signs it, issued `ageMs` ago. */
function formToken(ageMs = 60000) {
  const issued = Date.now() - ageMs;
  const mac = require('crypto').createHmac('sha256', `booking-form:${process.env.JWT_SECRET}`).update(String(issued)).digest('hex');
  return `${issued}.${mac}`;
}

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
  formToken: formToken(),
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
      { slug: 'booking-full-day', event_name: 'Wedding', event_type: 'wedding', event_date: day(monday, 1), is_full_day: true, share_link: 'x1', password_hash: 'x', expires_at: new Date(Date.now() + 86400000 * 365).toISOString(), is_archived: false, is_active: true, created_at: new Date().toISOString() },
      { slug: 'booking-timed', event_name: 'Portrait', event_type: 'portrait', event_date: day(monday, 2), is_full_day: false, event_time_start: '11:00', event_time_end: '13:00', share_link: 'x2', password_hash: 'x', expires_at: new Date(Date.now() + 86400000 * 365).toISOString(), is_archived: false, is_active: true, created_at: new Date().toISOString() },
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

  test('an email two customers share is not guessed', async () => {
    const ids = [];
    for (const name of ['Band A', 'Band B']) {
      const inserted = await db('customer_accounts').insert({
        email: `${name.replace(' ', '').toLowerCase()}@example.test`, display_name: name, preferred_language: 'en',
        is_active: true, created_at: new Date().toISOString(),
      }).returning('id');
      ids.push(typeof inserted[0] === 'object' ? inserted[0].id : inserted[0]);
    }
    await db('customer_contacts').insert(ids.map((id) => ({
      customer_account_id: id, email: 'Manager@Shared.example', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    })));
    const sent = await sendRequest(zurich(day(monday, 7), '15:00'), { email: 'manager@shared.example' });
    const row = await db('booking_requests').where({ reference: sent.body.reference }).first();
    const res = await request(adminApp).post(`/api/admin/booking/requests/${row.id}/accept`).set(auth);
    expect(res.status).toBe(409);
    expect((await db('booking_requests').where({ id: row.id }).first()).status).toBe('pending');
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

describe('review round 1', () => {
  const ip = '198.51.100.250';
  const fresh = (start, extra = {}) => request(publicApp).post('/api/public/booking/requests')
    .set('X-Forwarded-For', extra.ip || `198.51.100.${(clientIp += 1)}`)
    .send({ serviceId: shoot.id, values: {}, start, name: 'Robo', email: `r${clientIp}@bots.example`, language: 'en', formToken: formToken(), ...extra, ip: undefined });

  test('the form token is required, signed and not too fresh', async () => {
    const start = zurich(day(monday, 14), '09:00');
    let res = await fresh(start, { formToken: undefined });
    expect(res.status).toBe(400);
    res = await fresh(start, { formToken: `${Date.now() - 60000}.${'0'.repeat(64)}` });
    expect(res.status).toBe(400);
    res = await fresh(start, { formToken: formToken(500) });
    expect([res.status, res.body.reference]).toEqual([201, null]);
    const info = await request(publicApp).get('/api/public/booking');
    expect(info.body.formToken).toMatch(/^\d+\.[0-9a-f]{64}$/);
  });

  test('one client holds at most two open requests', async () => {
    expect((await fresh(zurich(day(monday, 14), '09:00'), { ip })).status).toBe(201);
    expect((await fresh(zurich(day(monday, 14), '13:00'), { ip })).status).toBe(201);
    const third = await fresh(zurich(day(monday, 14), '15:00'), { ip });
    expect([third.status, third.body.code || third.body.error?.code]).toEqual([429, 'BOOKING_TOO_MANY_OPEN']);
    const row = await db('booking_requests').whereNotNull('client_ip_hash').first();
    expect(row.client_ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.client_ip_hash).not.toContain('198.51');
  });

  test('a second open request from one address mails the client once', async () => {
    const mails = async () => Number((await db('email_queue').where({ email_type: 'booking_request_received', recipient_email: 'twice@band.example' }).count('* as n').first()).n);
    await fresh(zurich(day(monday, 15), '09:00'), { email: 'twice@band.example' });
    await fresh(zurich(day(monday, 15), '11:00'), { email: 'Twice@Band.example' });
    expect(await mails()).toBe(1);
    const third = await fresh(zurich(day(monday, 15), '13:00'), { email: 'twice@band.example' });
    expect(third.status).toBe(429);
  });

  test('the total number of open requests is capped', async () => {
    await request(adminApp).put('/api/admin/booking/settings').set(auth).send({ maxOpenRequests: 1 }).expect(200);
    const res = await fresh(zurich(day(monday, 16), '09:00'));
    expect([res.status, res.body.code || res.body.error?.code]).toEqual([429, 'BOOKING_REQUESTS_FULL']);
    await request(adminApp).put('/api/admin/booking/settings').set(auth).send({ maxOpenRequests: 200 }).expect(200);
  });

  test('a language outside the supported ones is refused', async () => {
    const res = await fresh(zurich(day(monday, 16), '09:00'), { language: 'xx' });
    expect(res.status).toBe(400);
  });

  test('a hidden duration factor ignores the posted value', async () => {
    await db('pricing_factors').where({ id: sessionLength.id }).update({ client_visible: false });
    const res = await fresh(zurich(day(monday, 16), '09:00'), { values: { [sessionLength.id]: 8 } });
    await db('pricing_factors').where({ id: sessionLength.id }).update({ client_visible: true });
    expect(res.status).toBe(201);
    const row = await db('booking_requests').where({ reference: res.body.reference }).first();
    const minutes = (new Date(row.ends_at) - new Date(row.starts_at)) / 60000;
    expect(minutes).toBe(120); // the factor's default (2 h), not 8 h
  });

  test('the hold never outlasts the slot', async () => {
    await request(adminApp).put('/api/admin/booking/settings').set(auth).send({ holdHours: 24 * 30 }).expect(200);
    const res = await fresh(zurich(day(monday, 17), '09:00'));
    await request(adminApp).put('/api/admin/booking/settings').set(auth).send({ holdHours: 48 }).expect(200);
    const row = await db('booking_requests').where({ reference: res.body.reference }).first();
    expect(new Date(row.hold_expires_at).getTime()).toBeLessThanOrEqual(new Date(row.starts_at).getTime());
  });

  test('an expired request is accepted while its time is free; a block added since refuses it', async () => {
    const a = await fresh(zurich(day(monday, 17), '13:00'));
    const rowA = await db('booking_requests').where({ reference: a.body.reference }).first();
    await db('booking_requests').where({ id: rowA.id }).update({ status: 'expired' });
    const ok = await request(adminApp).post(`/api/admin/booking/requests/${rowA.id}/accept`).set(auth);
    expect([ok.status, ok.body.request?.status]).toEqual([200, 'accepted']);

    const b = await fresh(zurich(day(monday, 18), '09:00'));
    const rowB = await db('booking_requests').where({ reference: b.body.reference }).first();
    await request(adminApp).post('/api/admin/booking/blocks').set(auth)
      .send({ startsAt: zurich(day(monday, 18), '08:00'), endsAt: zurich(day(monday, 18), '12:00') }).expect(201);
    const taken = await request(adminApp).post(`/api/admin/booking/requests/${rowB.id}/accept`).set(auth);
    expect(taken.status).toBe(409);
    expect((await db('booking_requests').where({ id: rowB.id }).first()).status).toBe('pending');
  });

  test('the public estimate does not name hidden factors', async () => {
    const editing = await request(catalogApp).post('/api/admin/quote-catalog/factors').set(auth)
      .send({ name: 'Secret editing', inputType: 'toggle', effect: 'fixed', amountMinor: 5000, clientVisible: false, defaultValue: 'true' });
    await request(quoteApp).put(`/api/admin/quotes/presets/line-items/${shoot.id}`).set(auth)
      .send({ factorIds: [...shoot.factorIds, editing.body.factor.id] }).expect(200);
    const res = await request(publicApp).post('/api/public/booking/estimate').send({ serviceId: shoot.id });
    const names = res.body.lines.map((l) => l.description);
    expect(names).not.toContain('Secret editing');
    expect(names).toContain('Further work');
    await request(quoteApp).put(`/api/admin/quotes/presets/line-items/${shoot.id}`).set(auth)
      .send({ factorIds: shoot.factorIds }).expect(200);
  });

  test('erasing a customer redacts their booking requests; old declined ones are purged', async () => {
    const accepted = await db('booking_requests').where({ status: 'accepted' }).whereNotNull('customer_account_id').first();
    await require('../../src/database/crmAccess').withTrustedCrmAccess('test',
      () => require('../../src/services/customerAccountsService').eraseCustomer(accepted.customer_account_id, adminId));
    const after = await db('booking_requests').where({ id: accepted.id }).first();
    expect(after).toMatchObject({ name: 'Erased', email: 'erased@deleted.invalid', phone: null, message: null });

    const old = await db('booking_requests').where({ status: 'declined' }).first();
    await db('booking_requests').where({ id: old.id }).update({ updated_at: new Date(Date.now() - 200 * 86400000).toISOString() });
    await request(adminApp).get('/api/admin/booking/requests').set(auth).expect(200);
    expect(await db('booking_requests').where({ id: old.id }).first()).toBeUndefined();
  });
});
