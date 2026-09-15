/**
 * Quote lines with promotions, hour/day rates and optional add-ons —
 * integration tests (#1451, migration 215).
 *
 * Drives the real admin routes → quoteService / invoiceService → SQLite with
 * the full core-migration run (helpers/crmDb), and pins:
 *   - a promotion ticked in the editor becomes a discount line whose amount
 *     is resolved server-side (percentage first, then fixed, capped);
 *   - `rateSource: 'auto'` copies the customer's or the default rate into the
 *     line, and bound lines follow the quote-wide hours;
 *   - an unselected optional add-on stays on the quote but out of the totals;
 *   - duplicating a quote keeps sub-items, notes and the new fields;
 *   - appending a quote with sub-items to a monthly draft keeps each
 *     sub-item attached to its own parent.
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
let customerId;
let token;
let quoteApp;
let invoiceApp;

const prevCwd = process.cwd();
const auth = { get Authorization() { return `Bearer ${token}`; } };

async function enableFlag(key) {
  const updated = await db('feature_flags').where({ key }).update({ value: true });
  if (!updated) await db('feature_flags').insert({ key, value: true });
}

async function insertPromotion(row) {
  const inserted = await db('quote_promotions').insert({
    is_active: true, display_order: 0, created_at: new Date(), updated_at: new Date(), ...row,
  }).returning('id');
  return typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
}

async function createQuote(body) {
  const res = await request(quoteApp).post('/api/admin/quotes').set(auth).send({
    customerAccountId: customerId, currency: 'CHF', vatRate: 0, ...body,
  });
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  db.client.pool.acquireTimeoutMillis = 2000;

  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  await enableFlag('quotes');
  await enableFlag('bills');

  quoteApp = buildRouteApp('/api/admin/quotes', require('../../src/routes/adminQuotes'));
  invoiceApp = buildRouteApp('/api/admin/invoices', require('../../src/routes/adminInvoices'));
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

describe('discount promotions', () => {
  test('percentage first, then fixed, resolved on the server', async () => {
    const tenPercent = await insertPromotion({ name: 'Early booking', type: 'percent', percent: 10 });
    const verein = await insertPromotion({ name: 'Vereinsrabatt', type: 'fixed', value_minor: 30000, currency: 'CHF' });

    const { quote, lineItems } = await createQuote({
      lineItems: [
        { position: 1, quantity: 1, description: 'Wedding coverage', unitPriceMinor: 200000 },
        // The client sends an amount; the server ignores it and resolves.
        { position: 2, lineKind: 'discount', promotionId: verein, unitPriceMinor: -1 },
        { position: 3, lineKind: 'discount', promotionId: tenPercent },
      ],
    });

    const discount = lineItems.filter((li) => li.lineKind === 'discount');
    expect(discount.map((li) => li.lineTotalMinor)).toEqual([-30000, -20000]);
    expect(discount[0].description).toBe('Vereinsrabatt');
    expect(discount[0].promotionSnapshot).toEqual(expect.objectContaining({ type: 'fixed', valueMinor: 30000 }));
    expect(quote.netAmountMinor).toBe(150000);
  });

  test('the discount is capped at the subtotal', async () => {
    const big = await insertPromotion({ name: 'Too big', type: 'fixed', value_minor: 500000, currency: 'CHF' });
    const { quote, lineItems } = await createQuote({
      lineItems: [
        { position: 1, quantity: 1, description: 'Portrait session', unitPriceMinor: 40000 },
        { position: 2, lineKind: 'discount', promotionId: big },
      ],
    });
    expect(lineItems[1].lineTotalMinor).toBe(-40000);
    expect(quote.totalAmountMinor).toBe(0);
  });

  test('an inactive or foreign-currency promotion is refused', async () => {
    const inactive = await insertPromotion({ name: 'Old', type: 'percent', percent: 5, is_active: false });
    const euro = await insertPromotion({ name: 'Euro', type: 'fixed', value_minor: 1000, currency: 'EUR' });
    for (const promotionId of [inactive, euro]) {
      const res = await request(quoteApp).post('/api/admin/quotes').set(auth).send({
        customerAccountId: customerId, currency: 'CHF', vatRate: 0,
        lineItems: [
          { position: 1, quantity: 1, description: 'Item', unitPriceMinor: 10000 },
          { position: 2, lineKind: 'discount', promotionId },
        ],
      });
      expect(res.status).toBe(400);
    }
  });
});

describe('hour and day rates', () => {
  test('auto rate comes from the business default, bound lines follow the hours', async () => {
    await db('business_profile').where({ id: 1 }).update({ default_hourly_rate_minor: 15000, default_day_rate_minor: 120000 });

    const { quote, lineItems } = await createQuote({
      hours: 8,
      lineItems: [
        { position: 1, quantity: 1, description: 'Coverage', priceMode: 'hour', rateSource: 'auto', boundTo: 'hours', unit: 'hour' },
        { position: 2, quantity: 2, description: 'Editing days', priceMode: 'day', rateSource: 'auto', unit: 'day' },
      ],
    });

    expect(quote.hours).toBe(8);
    expect(lineItems[0]).toEqual(expect.objectContaining({ quantity: 8, unitPriceMinor: 15000, rateSource: 'default', unit: 'hour' }));
    expect(lineItems[1]).toEqual(expect.objectContaining({ quantity: 2, unitPriceMinor: 120000, rateSource: 'default' }));
    expect(quote.netAmountMinor).toBe(8 * 15000 + 2 * 120000);
  });

  test('the customer rate wins over the default, and a later change does not touch the quote', async () => {
    await db('customer_accounts').where({ id: customerId }).update({ hourly_rate_minor: 18000 });
    const { quote } = await createQuote({
      lineItems: [{ position: 1, quantity: 2, description: 'Studio', priceMode: 'hour', rateSource: 'auto' }],
    });
    await db('customer_accounts').where({ id: customerId }).update({ hourly_rate_minor: 99000 });

    const reloaded = await request(quoteApp).get(`/api/admin/quotes/${quote.id}`).set(auth);
    expect(reloaded.body.lineItems[0]).toEqual(expect.objectContaining({ unitPriceMinor: 18000, rateSource: 'customer' }));
    await db('customer_accounts').where({ id: customerId }).update({ hourly_rate_minor: null });
  });

  test('a missing rate is a 400 the editor can explain', async () => {
    await db('business_profile').where({ id: 1 }).update({ default_day_rate_minor: null });
    const res = await request(quoteApp).post('/api/admin/quotes').set(auth).send({
      customerAccountId: customerId, currency: 'CHF', vatRate: 0,
      lineItems: [{ position: 1, quantity: 1, description: 'Day', priceMode: 'day', rateSource: 'auto' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.code || res.body.error?.code).toBe('RATE_REQUIRED');
    await db('business_profile').where({ id: 1 }).update({ default_day_rate_minor: 120000 });
  });
});

describe('optional add-ons', () => {
  test('an unselected add-on stays on the quote but out of the totals', async () => {
    const { quote, lineItems } = await createQuote({
      lineItems: [
        { position: 1, quantity: 1, description: 'Coverage', unitPriceMinor: 100000 },
        { position: 2, quantity: 1, description: 'Album 30×30', unitPriceMinor: 50000, isOptional: true, selected: false },
        { position: 3, quantity: 1, description: 'Drone', unitPriceMinor: 20000, isOptional: true, selected: true },
      ],
    });
    expect(lineItems).toHaveLength(3);
    expect(lineItems[1]).toEqual(expect.objectContaining({ isOptional: true, selected: false }));
    expect(quote.netAmountMinor).toBe(120000);
  });
});

describe('duplicate', () => {
  test('keeps sub-items, notes and the new line fields', async () => {
    const { quote } = await createQuote({
      hours: 6,
      lineItems: [
        { position: 1, quantity: 1, description: 'Package', unitPriceMinor: 0 },
        { position: 2, quantity: 6, description: 'Coverage', unitPriceMinor: 15000, parentPosition: 1, detailsText: 'On location', unit: 'hour', boundTo: 'hours' },
        { position: 3, quantity: 1, description: 'Makeup', unitPriceMinor: 30000, parentPosition: 1 },
      ],
    });
    const res = await request(quoteApp).post(`/api/admin/quotes/${quote.id}/duplicate`).set(auth).send();
    expect([200, 201]).toContain(res.status);
    const copyId = res.body.quote?.id ?? res.body.id;
    const copy = await request(quoteApp).get(`/api/admin/quotes/${copyId}`).set(auth);
    expect(copy.body.quote.hours).toBe(6);
    expect(copy.body.lineItems.map((li) => li.parentPosition)).toEqual([null, 1, 1]);
    expect(copy.body.lineItems[1]).toEqual(expect.objectContaining({ detailsText: 'On location', unit: 'hour', boundTo: 'hours' }));
    expect(copy.body.quote.netAmountMinor).toBe(quote.netAmountMinor);
  });
});

describe('monthly draft append', () => {
  test('a sub-item stays attached to its own parent after the draft offset', async () => {
    await db('customer_accounts').where({ id: customerId }).update({ billing_cadence: 'monthly' });
    const post = async (lineItems) => {
      const res = await request(invoiceApp).post('/api/admin/invoices').set(auth).send({
        customerAccountId: customerId, currency: 'CHF', vatRate: 0, lineItems,
      });
      if (res.status >= 400) throw new Error(`invoice create failed: ${res.status} ${JSON.stringify(res.body)}`);
      return res;
    };

    const first = await post([
      { position: 1, quantity: 1, description: 'Earlier A', unitPriceMinor: 1000 },
      { position: 2, quantity: 1, description: 'Earlier B', unitPriceMinor: 2000 },
    ]);
    expect([200, 201]).toContain(first.status);

    const second = await post([
      { position: 1, quantity: 1, description: 'Package', unitPriceMinor: 0 },
      { position: 2, quantity: 1, description: 'Camera', unitPriceMinor: 3000, parentPosition: 1 },
    ]);
    expect([200, 201]).toContain(second.status);

    const draft = await db('invoices').where({ customer_account_id: customerId, is_monthly_draft: true }).first();
    const rows = await db('invoice_line_items').where({ invoice_id: draft.id }).orderBy('position', 'asc');
    const byDescription = Object.fromEntries(rows.map((r) => [r.description, r]));
    expect(byDescription.Camera.parent_line_item_id).toBe(byDescription.Package.id);
    expect(rows.map((r) => r.position)).toEqual([1, 2, 3, 4]);
    await db('customer_accounts').where({ id: customerId }).update({ billing_cadence: 'per_event' });
  });
});
