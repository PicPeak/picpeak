/**
 * Customer gifts and gift stock (migration 343), through the real admin router
 * so the flag, permission and validation layers are part of what is pinned.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'crm-route-test-secret';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let app;
let superToken;
let viewerToken;
let adminToken;
let invalidateFeatureFlagCache;
let seq = 0;

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const idOf = (inserted) => (typeof inserted[0] === 'object' ? inserted[0].id : inserted[0]);
const bodyOf = (res) => res.body.data || res.body;
const api = (path) => `/api/admin/gifts${path}`;
const post = (path, body = {}, token = superToken) => request(app).post(api(path)).set(auth(token)).send(body);
const get = (path, token = superToken) => request(app).get(api(path)).set(auth(token));

const setFlag = async (key, value) => {
  await db('feature_flags').where({ key }).del();
  await db('feature_flags').insert({ key, value });
  invalidateFeatureFlagCache();
};

async function createCustomer(fields = {}) {
  seq += 1;
  return idOf(await db('customer_accounts').insert({
    email: `gifts-${seq}@example.com`,
    display_name: `Customer ${seq}`,
    is_active: true,
    created_at: new Date().toISOString(),
    ...fields,
  }).returning('id'));
}

const yearsAgo = (years, days = 0) => {
  const date = new Date();
  date.setFullYear(date.getFullYear() - years);
  date.setDate(date.getDate() - days);
  return date.toISOString();
};

/** Midday in the middle of a calendar year, `years` before this one. */
const inYear = (years) => `${new Date().getFullYear() - years}-06-15T12:00:00.000Z`;

let invoiceSeq = 0;
async function paidInvoice(customerId, paidAt, fields = {}) {
  invoiceSeq += 1;
  return idOf(await db('invoices').insert({
    invoice_number: `GIFT-${invoiceSeq}`,
    customer_account_id: customerId,
    status: 'paid',
    kind: 'invoice',
    currency: 'CHF',
    issue_date: paidAt.slice(0, 10),
    due_date: paidAt.slice(0, 10),
    total_amount_minor: 10000,
    paid_at: paidAt,
    ...fields,
  }).returning('id'));
}

async function createItem(name = 'Wine', quantity = 0) {
  const item = bodyOf(await post('/items', { name })).item;
  if (quantity) await post(`/items/${item.id}/stock`, { quantity, unitCostMinor: 1500 });
  return item;
}

const stockOf = async (id) => {
  const { items } = bodyOf(await get('/items?includeArchived=true'));
  return items.find((item) => item.id === id).stock;
};

/** Three bookings in three calendar years, the last today. */
async function dueCustomer() {
  const id = await createCustomer();
  await paidInvoice(id, inYear(2));
  await paidInvoice(id, inYear(1));
  await paidInvoice(id, yearsAgo(0));
  return id;
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ invalidateFeatureFlagCache } = require('../../src/middleware/requireFeatureFlag'));
  const { adminId } = await seedMinimal(db);
  await assignAdminRole(db, adminId, 'super_admin');
  superToken = mintAdminToken(adminId);
  const [viewer] = await db('admin_users').insert({
    username: 'gift-viewer', email: 'gift-viewer@example.com', password_hash: 'x',
  }).returning('id');
  const viewerId = viewer?.id ?? viewer;
  await assignAdminRole(db, viewerId, 'viewer').catch(() => {});
  viewerToken = mintAdminToken(viewerId);
  const [plain] = await db('admin_users').insert({
    username: 'gift-admin', email: 'gift-admin@example.com', password_hash: 'x',
  }).returning('id');
  const plainId = plain?.id ?? plain;
  await assignAdminRole(db, plainId, 'admin');
  adminToken = mintAdminToken(plainId);
  app = buildRouteApp('/api/admin/gifts', require('../../src/routes/adminGifts'));
  await setFlag('customerGifts', true);
});
afterAll(async () => { if (cleanup) await cleanup(); });

describe('access', () => {
  it('answers 403 on every route while the flag is off', async () => {
    await setFlag('customerGifts', false);
    const res = await get('/suggestions');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CUSTOMER_GIFTS_DISABLED');
    expect((await post('/items', { name: 'x' })).status).toBe(403);
    await setFlag('customerGifts', true);
  });

  it('refuses without a token and without the permission', async () => {
    expect((await request(app).get(api('/suggestions'))).status).toBe(401);
    expect((await get('/suggestions', viewerToken)).status).toBe(403);
    expect((await post('/items', { name: 'x' }, viewerToken)).status).toBe(403);
  });
});

describe('access to customer data', () => {
  async function tokenWith(name, permissions) {
    const [role] = await db('roles').insert({ name, display_name: name }).returning('id');
    const roleId = role?.id ?? role;
    const rows = await db('permissions').whereIn('name', permissions).select('id');
    await db('role_permissions').insert(rows.map(({ id }) => ({ role_id: roleId, permission_id: id })));
    require('../../src/middleware/permissions').clearPermissionCache();
    const [admin] = await db('admin_users').insert({
      username: name, email: `${name}@example.com`, password_hash: 'x', role_id: roleId,
    }).returning('id');
    return mintAdminToken(admin?.id ?? admin);
  }

  it('gives a manage-only role no gift history through a change', async () => {
    const token = await tokenWith('gift-manage-only', ['customers.gifts.manage']);
    const customer = await dueCustomer();
    const item = await createItem('Manage only', 2);
    const { gifts } = bodyOf(await post(`/customers/${customer}/gifts`, { giftItemId: item.id, note: 'Secret note' }));
    expect((await post('/items', { name: 'Allowed' }, token)).status).toBe(201);
    const patched = await request(app).patch(api(`/customers/${customer}`)).set(auth(token)).send({});
    expect(patched.status).toBe(403);
    expect((await post(`/customers/${customer}/gifts`, { giftItemId: item.id }, token)).status).toBe(403);
    expect((await post(`/customers/${customer}/declines`, { milestoneYears: 3 }, token)).status).toBe(403);
    expect((await post(`/${gifts[0].id}/undo`, {}, token)).status).toBe(403);
  });

  it('keeps invoice figures from a role without bills.view', async () => {
    const token = await tokenWith('gift-no-bills', ['customers.view', 'customers.gifts.view']);
    const customer = await dueCustomer();
    const row = bodyOf(await get('/suggestions', token)).due.find((r) => r.customerId === customer);
    expect(row).toMatchObject({ milestoneYears: 3, bookingCount: null, lastPaidOn: null, reason: null });
    const full = bodyOf(await get('/suggestions')).due.find((r) => r.customerId === customer);
    expect(full.bookingCount).toBe(3);
    expect(full.lastPaidOn).not.toBeNull();
  });

  it('keeps supplier costs from a role without accounting.view', async () => {
    const token = await tokenWith('gift-no-accounting', ['customers.gifts.view']);
    const item = await createItem('Costs', 2);
    const [movement] = bodyOf(await get(`/items/${item.id}/movements`, token)).movements;
    expect(movement).toMatchObject({ kind: 'purchase', unitCostMinor: null, currency: null });
    const [full] = bodyOf(await get(`/items/${item.id}/movements`)).movements;
    expect(full.unitCostMinor).toBe(1500);

    const customer = await createCustomer();
    const given = bodyOf(await post(`/customers/${customer}/gifts`, { giftItemId: item.id }));
    expect(given.gifts[0]).not.toHaveProperty('unitCostMinor');
    expect(given.gifts[0]).not.toHaveProperty('currency');
    const reader = await tokenWith('gift-customer-reader', ['customers.view', 'customers.gifts.view']);
    const [gift] = bodyOf(await get(`/customers/${customer}`, reader)).gifts;
    expect(gift).not.toHaveProperty('unitCostMinor');
    expect(gift).not.toHaveProperty('currency');
  });

  it('leaves gifts out of the timeline without the gift right or the flag', async () => {
    const adminCustomers = buildRouteApp('/api/admin/customers', require('../../src/routes/adminCustomers'));
    const read = (path, token) => request(adminCustomers).get(`/api/admin/customers${path}`).set(auth(token));
    const token = await tokenWith('gift-customers-only', ['customers.view']);
    const customer = await createCustomer();
    const item = await createItem('Timeline', 1);
    await post(`/customers/${customer}/gifts`, { giftItemId: item.id });

    const types = (res) => bodyOf(res).entries.map((entry) => entry.type);
    expect(types(await read(`/${customer}/activity`, superToken))).toContain('customer_gift_given');
    expect(types(await read(`/${customer}/activity`, token))).not.toContain('customer_gift_given');

    await setFlag('customerGifts', false);
    expect(types(await read(`/${customer}/activity`, superToken))).not.toContain('customer_gift_given');
    await setFlag('customerGifts', true);
  });
});

describe('stock', () => {
  it('adds stock, gives, undoes and corrects, and the count follows', async () => {
    const item = await createItem('Merlot', 5);
    const customer = await createCustomer();
    expect(await stockOf(item.id)).toBe(5);

    const given = bodyOf(await post(`/customers/${customer}/gifts`, { giftItemId: item.id, note: 'thank you' }));
    expect(await stockOf(item.id)).toBe(4);
    expect(given.gifts[0]).toMatchObject({ status: 'given', note: 'thank you' });
    const stored = await db('customer_gifts').where({ id: given.gifts[0].id }).first();
    expect(Number(stored.unit_cost_minor)).toBe(1500);
    expect(stored.currency).toBe('CHF');

    await post(`/${given.gifts[0].id}/undo`);
    expect(await stockOf(item.id)).toBe(5);

    await post(`/items/${item.id}/corrections`, { quantityDelta: -2, reason: '2 bottles broken' });
    expect(await stockOf(item.id)).toBe(3);

    const { movements } = bodyOf(await get(`/items/${item.id}/movements`));
    expect(movements.map((m) => m.kind).sort()).toEqual(['correction', 'gift', 'gift_undone', 'purchase']);
  });

  it('refuses a gift at zero stock and a correction below zero', async () => {
    const item = await createItem('Empty');
    const customer = await createCustomer();
    const res = await post(`/customers/${customer}/gifts`, { giftItemId: item.id });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('GIFT_OUT_OF_STOCK');
    expect((await post(`/items/${item.id}/corrections`, { quantityDelta: -1, reason: 'x' })).body.code)
      .toBe('GIFT_STOCK_NEGATIVE');
  });

  it('lets two gifts race for the last unit and only one wins', async () => {
    const item = await createItem('Last', 1);
    const [a, b] = [await createCustomer(), await createCustomer()];
    const results = await Promise.all([
      post(`/customers/${a}/gifts`, { giftItemId: item.id }),
      post(`/customers/${b}/gifts`, { giftItemId: item.id }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await stockOf(item.id)).toBe(0);
  });

  it('records a past gift without touching stock', async () => {
    const item = await createItem('Old', 1);
    const customer = await createCustomer();
    expect((await post(`/customers/${customer}/gifts`, {
      giftItemId: item.id, reduceStock: false, giftDate: '2020-05-01',
    })).status).toBe(201);
    expect(await stockOf(item.id)).toBe(1);
    const { gifts } = bodyOf(await get(`/customers/${customer}`));
    expect(gifts[0].giftDate).toBe('2020-05-01');
  });

  it('links a supplier invoice only with incoming invoices on and accounting access', async () => {
    const item = await createItem('Invoiced');
    const [doc] = await db('inbound_documents').insert({ supplier_name: 'Wine shop', currency: 'EUR' }).returning('id');
    const documentId = doc?.id ?? doc;
    const body = { quantity: 6, unitCostMinor: 1200, inboundDocumentId: documentId };

    await setFlag('incomingInvoices', false);
    const refused = await post(`/items/${item.id}/stock`, body);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('GIFT_INVOICE_FORBIDDEN');
    expect(await stockOf(item.id)).toBe(0);

    await setFlag('incomingInvoices', true);
    const res = await post(`/items/${item.id}/stock`, body);
    expect(res.status).toBe(201);
    expect(bodyOf(res).movement).toMatchObject({ inboundDocumentId: documentId, currency: 'EUR' });
    expect((await post(`/items/${item.id}/stock`, { ...body, inboundDocumentId: 999999 })).status).toBe(404);
  });

  it('refuses an archived item for a new gift', async () => {
    const item = await createItem('Retired', 1);
    await request(app).patch(api(`/items/${item.id}`)).set(auth(superToken)).send({ isArchived: true });
    const customer = await createCustomer();
    expect((await post(`/customers/${customer}/gifts`, { giftItemId: item.id })).body.code).toBe('GIFT_ITEM_ARCHIVED');
  });
});

describe('suggestions', () => {
  const find = (list, id) => list.find((row) => row.customerId === id);

  it('lists a qualifying customer as due and closes the milestone on a gift', async () => {
    const customer = await dueCustomer();
    const item = await createItem('Due item', 2);
    const { due } = bodyOf(await get('/suggestions'));
    expect(find(due, customer)).toMatchObject({ milestoneYears: 3, bookingCount: 3 });

    await post(`/customers/${customer}/gifts`, { giftItemId: item.id, milestoneYears: 3 });
    expect(find(bodyOf(await get('/suggestions')).due, customer)).toBeUndefined();

    const twice = await post(`/customers/${customer}/gifts`, { giftItemId: item.id, milestoneYears: 3 });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('GIFT_MILESTONE_CLOSED');
    expect(await stockOf(item.id)).toBe(1);
  });

  it('ignores Storno rows and cancelled originals', async () => {
    const customer = await createCustomer();
    await paidInvoice(customer, inYear(6));
    await paidInvoice(customer, inYear(5));
    await paidInvoice(customer, inYear(2), { status: 'cancelled' });
    await paidInvoice(customer, inYear(2), { kind: 'storno' });
    const { notQualified } = bodyOf(await get('/suggestions'));
    expect(find(notQualified, customer)).toMatchObject({ bookingCount: 2, reason: 'too_few_bookings' });
  });

  it('declines one milestone, and undo reopens it', async () => {
    const customer = await dueCustomer();
    const declined = bodyOf(await post(`/customers/${customer}/declines`, { milestoneYears: 3, note: 'asked for none' }));
    expect(declined.gifts[0]).toMatchObject({ status: 'declined', giftItemId: null });
    expect(find(bodyOf(await get('/suggestions')).due, customer)).toBeUndefined();
    await post(`/${declined.gifts[0].id}/undo`);
    expect(find(bodyOf(await get('/suggestions')).due, customer)).toBeDefined();
    expect((await post(`/${declined.gifts[0].id}/undo`)).body.code).toBe('GIFT_ALREADY_UNDONE');
  });

  it('marks a gift anyway, and hides a no-gifts customer', async () => {
    const customer = await createCustomer();
    await paidInvoice(customer, inYear(6));
    const item = await createItem('Override', 1);
    expect(find(bodyOf(await get('/suggestions')).notQualified, customer)).toBeDefined();
    const { gifts } = bodyOf(await post(`/customers/${customer}/gifts`, { giftItemId: item.id, milestoneYears: 5, isOverride: true }));
    expect(gifts[0].isOverride).toBe(true);

    const other = await dueCustomer();
    await request(app).patch(api(`/customers/${other}`)).set(auth(superToken)).send({ noGifts: true });
    expect(find(bodyOf(await get('/suggestions')).due, other)).toBeUndefined();
  });

  it('keeps changed rules', async () => {
    const res = await request(app).put(api('/rules')).set(auth(superToken))
      .send({ activityPeriodYears: 3, milestoneYears: [10, 3, 3] });
    expect(bodyOf(res).rules).toMatchObject({ activityPeriodYears: 3, milestoneYears: [3, 10], minBookings: 3 });
    const { rules } = bodyOf(await get('/rules'));
    expect(rules).toMatchObject({ activityPeriodYears: 3, milestoneYears: [3, 10] });
    const single = await request(app).put(api('/rules')).set(auth(superToken)).send({ milestoneYears: [3] });
    expect(bodyOf(single).rules.milestoneYears).toEqual([3]);
    expect((await get('/suggestions')).status).toBe(200);
    expect(await db('app_settings').where({ setting_key: 'gift_grace_days' }).first()).toBeUndefined();
    await request(app).put(api('/rules')).set(auth(superToken)).send({ activityPeriodYears: 1, milestoneYears: [3, 5, 10] });
  });
});

describe('more than one admin', () => {
  it('shows every admin the same list, with figures only from invoices they can open', async () => {
    const customer = await dueCustomer();
    const row = (list) => list.find((r) => r.customerId === customer);
    const asSuper = row(bodyOf(await get('/suggestions')).due);
    const asAdmin = row(bodyOf(await get('/suggestions', adminToken)).due);
    expect(asSuper.bookingCount).toBe(3);
    expect(asAdmin).toEqual({ ...asSuper, bookingCount: null, lastPaidOn: null, reason: null });

    const own = await dueCustomer();
    await db('invoices').where({ customer_account_id: own }).update({ created_by_admin_id: jwt.decode(adminToken).id });
    const mine = bodyOf(await get('/suggestions', adminToken)).due.find((r) => r.customerId === own);
    expect(mine.bookingCount).toBe(3);
  });

  it('refuses another admin\'s supplier invoice', async () => {
    const item = await createItem('Foreign invoice');
    const owner = await db('admin_users').first('id');
    const [doc] = await db('inbound_documents').insert({
      supplier_name: 'Foreign shop', currency: 'EUR', created_by_admin_id: owner.id,
    }).returning('id');
    await setFlag('incomingInvoices', true);
    const res = await post(`/items/${item.id}/stock`, { quantity: 1, inboundDocumentId: doc?.id ?? doc }, adminToken);
    expect(res.status).toBe(404);
    expect(await stockOf(item.id)).toBe(0);
  });
});

describe('edges', () => {
  it('closes only the current milestone', async () => {
    const customer = await dueCustomer();
    const item = await createItem('Current', 2);
    for (const milestoneYears of [100, 5]) {
      const declined = await post(`/customers/${customer}/declines`, { milestoneYears });
      expect(declined.status).toBe(409);
      expect(declined.body.code).toBe('GIFT_MILESTONE_NOT_CURRENT');
      const given = await post(`/customers/${customer}/gifts`, { giftItemId: item.id, milestoneYears });
      expect(given.body.code).toBe('GIFT_MILESTONE_NOT_CURRENT');
    }
    expect(await stockOf(item.id)).toBe(2);
    const { due } = bodyOf(await get('/suggestions'));
    expect(due.find((row) => row.customerId === customer).milestoneYears).toBe(3);
  });

  it('refuses a milestone for a customer who has not reached one', async () => {
    const customer = await createCustomer();
    await paidInvoice(customer, yearsAgo(1));
    const res = await post(`/customers/${customer}/declines`, { milestoneYears: 3 });
    expect(res.body.code).toBe('GIFT_MILESTONE_NOT_CURRENT');
  });

  it('reads a payment entered without a time as that day', async () => {
    const customer = await createCustomer();
    const paidOn = `${new Date().getFullYear() - 6}-06-15`;
    await paidInvoice(customer, `${paidOn}T00:00:00.000Z`);
    const row = bodyOf(await get('/suggestions')).notQualified.find((r) => r.customerId === customer);
    expect(row.lastPaidOn).toBe(paidOn);
  });

  it('stamps undo as a real timestamp', async () => {
    const customer = await createCustomer();
    const item = await createItem('Stamp', 1);
    const { gifts } = bodyOf(await post(`/customers/${customer}/gifts`, { giftItemId: item.id }));
    await post(`/${gifts[0].id}/undo`);
    const row = await db('customer_gifts').where({ id: gifts[0].id }).first();
    expect(Number.isNaN(new Date(row.undone_at).getTime())).toBe(false);
  });

  it('does not bring back an earlier milestone once a later one is closed', async () => {
    const customer = await createCustomer();
    await paidInvoice(customer, inYear(4));
    await paidInvoice(customer, inYear(3));
    await paidInvoice(customer, yearsAgo(0));
    const find = async () => bodyOf(await get('/suggestions')).due.find((r) => r.customerId === customer);
    expect((await find()).milestoneYears).toBe(5);
    await post(`/customers/${customer}/declines`, { milestoneYears: 5 });
    await request(app).put(api('/rules')).set(auth(superToken)).send({ milestoneYears: [3, 10] });
    expect(await find()).toBeUndefined();
    await request(app).put(api('/rules')).set(auth(superToken)).send({ milestoneYears: [3, 5, 10] });
  });

  it('refuses a week date, which the rules could not read', async () => {
    const customer = await createCustomer();
    const res = await request(app).patch(api(`/customers/${customer}`)).set(auth(superToken))
      .send({ startDateOverride: '2026-W01-1' });
    expect(res.status).toBe(400);
  });

  it('stamps no cost on a gift that predates stock', async () => {
    const item = await createItem('Priced', 1);
    const customer = await createCustomer();
    const { gifts } = bodyOf(await post(`/customers/${customer}/gifts`, { giftItemId: item.id, reduceStock: false }));
    const stored = await db('customer_gifts').where({ id: gifts[0].id }).first();
    expect(stored.unit_cost_minor).toBeNull();
  });

  it('refuses a duplicate invoice in the inbox', async () => {
    const item = await createItem('Dupe');
    await setFlag('incomingInvoices', true);
    const [doc] = await db('inbound_documents').insert({ supplier_name: 'x', status: 'duplicate' }).returning('id');
    expect((await post(`/items/${item.id}/stock`, { quantity: 1, inboundDocumentId: doc?.id ?? doc })).status).toBe(404);
  });
});

describe('customer erasure', () => {
  it('clears gift notes and keeps the stock count', async () => {
    const item = await createItem('Erased', 3);
    const customer = await createCustomer({ no_gifts: true });
    await post(`/customers/${customer}/gifts`, { giftItemId: item.id, note: 'Loves Barolo' });
    await request(app).patch(api(`/customers/${customer}`)).set(auth(superToken)).send({ startDateOverride: '2020-01-01' });
    await require('../../src/services/customerAccountsService').eraseCustomer(customer, null);
    const [row] = await db('customer_gifts').where({ customer_account_id: customer });
    expect(row.note).toBeNull();
    expect(await stockOf(item.id)).toBe(2);
    const account = await db('customer_accounts').where({ id: customer }).first();
    expect(account.gift_start_date_override).toBeNull();
    expect(Boolean(account.no_gifts)).toBe(false);
    const logged = await db('activity_logs').where({ activity_type: 'customer_gift_preferences_updated' });
    expect(JSON.stringify(logged)).not.toContain('2020-01-01');
    expect((bodyOf(await get('/suggestions')).notQualified).find((r) => r.customerId === customer)).toBeUndefined();
    const refused = await post(`/customers/${customer}/gifts`, { giftItemId: item.id, note: 'after erasure' });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('GIFT_CUSTOMER_ERASED');
  });
});
