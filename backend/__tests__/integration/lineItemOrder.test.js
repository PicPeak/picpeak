/**
 * Line-item order persistence — integration tests (#1452).
 *
 * `LineItemsTable` keeps `position` as a stable row id ("once assigned at row
 * creation we never renumber it") and `move()` only reorders the array, so the
 * editors post the row's original position back on save. The service stored it
 * verbatim and the detail endpoints read the items back `ORDER BY position`,
 * which is why a reorder looked right in the editor and came back in the
 * original order after a reload.
 *
 * These tests drive the real HTTP route → service → SQLite pipeline and pin
 * that the order the editor sent is the order that is stored, for quotes and
 * for invoices, with a moved parent keeping its sub-items.
 *
 * Real SQLite with the full core-migration run (helpers/crmDb). No PDF
 * rendering: the PDF and the customer page both read the stored order, so the
 * round-trip through getQuoteById / getInvoiceById is the contract under test.
 */

const request = require('supertest');
const { formatBoolean } = require('../../src/utils/dbCompat');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

// Full migration run + cold-requiring the CRM services is slow under CI load;
// matches the other CRM integration suites.
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

const descriptionsOf = (body) => body.lineItems.map((li) => li.description);
const positionsOf = (body) => body.lineItems.map((li) => li.position);

async function enableFlag(key) {
  const value = formatBoolean(true);
  const updated = await db('feature_flags').where({ key }).update({ value });
  if (!updated) await db('feature_flags').insert({ key, value });
}

/**
 * Create a draft quote through the admin route so the payload goes through the
 * same mapping the editor uses. Returns the new quote id.
 */
async function createQuote(lineItems) {
  const res = await request(quoteApp).post('/api/admin/quotes').set(auth).send({
    customerAccountId: customerId,
    currency: 'CHF',
    vatRate: 0,
    lineItems,
  });
  expect(res.status).toBe(201);
  return res.body.quote.id;
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  // Business-doc storage paths are anchored under process.cwd() — chdir into
  // the temp dir so nothing escapes the suite.
  process.chdir(tmpDir);
  // Same swallowed logActivity-inside-transaction stall the other CRM
  // integration suites shrink: 2s instead of the 60s acquire timeout.
  db.client.pool.acquireTimeoutMillis = 2000;

  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);

  // CRM surfaces are feature-flagged; migration 107 seeds them off.
  await enableFlag('quotes');
  await enableFlag('bills');

  quoteApp = buildRouteApp('/api/admin/quotes', require('../../src/routes/adminQuotes'));
  invoiceApp = buildRouteApp('/api/admin/invoices', require('../../src/routes/adminInvoices'));
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

describe('PUT /api/admin/quotes/:id — line-item order', () => {
  test('a reordered quote keeps the new order after a reload', async () => {
    const quoteId = await createQuote([
      { position: 1, quantity: 1, description: 'Studio shooting', unitPriceMinor: 100000, discountPercent: 0 },
      { position: 2, quantity: 1, description: 'Album', unitPriceMinor: 50000, discountPercent: 0 },
    ]);

    // The editor's arrows only reorder the array — the row ids travel back
    // unchanged, which is exactly what used to lose the reorder.
    const saved = await request(quoteApp)
      .put(`/api/admin/quotes/${quoteId}`)
      .set(auth)
      .send({
        lineItems: [
          { position: 2, quantity: 1, description: 'Album', unitPriceMinor: 50000, discountPercent: 0 },
          { position: 1, quantity: 1, description: 'Studio shooting', unitPriceMinor: 100000, discountPercent: 0 },
        ],
      });
    expect(saved.status).toBe(200);

    const reloaded = await request(quoteApp).get(`/api/admin/quotes/${quoteId}`).set(auth);
    expect(reloaded.status).toBe(200);
    expect(descriptionsOf(reloaded.body)).toEqual(['Album', 'Studio shooting']);
    expect(positionsOf(reloaded.body)).toEqual([1, 2]);
  });

  test('a moved parent carries its sub-items and the parent links survive', async () => {
    const quoteId = await createQuote([
      { position: 1, quantity: 1, description: 'Package', unitPriceMinor: 120000, discountPercent: 0 },
      { position: 2, quantity: 1, description: 'Camera', unitPriceMinor: 30000, discountPercent: 0, parentPosition: 1 },
      { position: 3, quantity: 1, description: 'Travel', unitPriceMinor: 20000, discountPercent: 0 },
    ]);

    // 'Package' moves below 'Travel'; its sub-item follows it in the array
    // and still names row id 1 as its parent.
    const saved = await request(quoteApp)
      .put(`/api/admin/quotes/${quoteId}`)
      .set(auth)
      .send({
        lineItems: [
          { position: 3, quantity: 1, description: 'Travel', unitPriceMinor: 20000, discountPercent: 0 },
          { position: 1, quantity: 1, description: 'Package', unitPriceMinor: 120000, discountPercent: 0 },
          { position: 2, quantity: 1, description: 'Camera', unitPriceMinor: 30000, discountPercent: 0, parentPosition: 1 },
        ],
      });
    expect(saved.status).toBe(200);

    const reloaded = await request(quoteApp).get(`/api/admin/quotes/${quoteId}`).set(auth);
    expect(reloaded.status).toBe(200);
    expect(descriptionsOf(reloaded.body)).toEqual(['Travel', 'Package', 'Camera']);
    expect(positionsOf(reloaded.body)).toEqual([1, 2, 3]);
    // 'Camera' is still the child of 'Package', at its new position.
    expect(reloaded.body.lineItems[2].parentPosition).toBe(2);
    expect(reloaded.body.lineItems[2].parentLineItemId).toBe(reloaded.body.lineItems[1].id);
  });

  test('reordering sub-items inside one parent persists', async () => {
    const quoteId = await createQuote([
      { position: 1, quantity: 1, description: 'Package', unitPriceMinor: 120000, discountPercent: 0 },
      { position: 2, quantity: 1, description: 'Camera', unitPriceMinor: 30000, discountPercent: 0, parentPosition: 1 },
      { position: 3, quantity: 1, description: 'Lens', unitPriceMinor: 40000, discountPercent: 0, parentPosition: 1 },
    ]);

    const saved = await request(quoteApp)
      .put(`/api/admin/quotes/${quoteId}`)
      .set(auth)
      .send({
        lineItems: [
          { position: 1, quantity: 1, description: 'Package', unitPriceMinor: 120000, discountPercent: 0 },
          { position: 3, quantity: 1, description: 'Lens', unitPriceMinor: 40000, discountPercent: 0, parentPosition: 1 },
          { position: 2, quantity: 1, description: 'Camera', unitPriceMinor: 30000, discountPercent: 0, parentPosition: 1 },
        ],
      });
    expect(saved.status).toBe(200);

    const reloaded = await request(quoteApp).get(`/api/admin/quotes/${quoteId}`).set(auth);
    expect(descriptionsOf(reloaded.body)).toEqual(['Package', 'Lens', 'Camera']);
    expect(reloaded.body.lineItems[1].parentPosition).toBe(1);
    expect(reloaded.body.lineItems[2].parentPosition).toBe(1);
  });

  test('a new quote keeps the order chosen before its first save', async () => {
    const quoteId = await createQuote([
      { position: 3, quantity: 1, description: 'Third', unitPriceMinor: 30000, discountPercent: 0 },
      { position: 1, quantity: 1, description: 'First', unitPriceMinor: 10000, discountPercent: 0 },
      { position: 2, quantity: 1, description: 'Second', unitPriceMinor: 20000, discountPercent: 0 },
    ]);
    const reloaded = await request(quoteApp).get(`/api/admin/quotes/${quoteId}`).set(auth);
    expect(reloaded.status).toBe(200);
    expect(descriptionsOf(reloaded.body)).toEqual(['Third', 'First', 'Second']);
  });
});

describe('PUT /api/admin/invoices/:id — line-item order', () => {
  test('a reordered scheduled invoice keeps the new order after a reload', async () => {
    const created = await request(invoiceApp).post('/api/admin/invoices').set(auth).send({
      customerAccountId: customerId,
      currency: 'CHF',
      vatRate: 0,
      lineItems: [
        { position: 1, quantity: 1, description: 'Wedding coverage', unitPriceMinor: 200000, discountPercent: 0 },
        { position: 2, quantity: 1, description: 'Album', unitPriceMinor: 60000, discountPercent: 0 },
      ],
    });
    expect(created.status).toBe(201);
    const invoiceId = created.body.invoice.id;

    const saved = await request(invoiceApp)
      .put(`/api/admin/invoices/${invoiceId}`)
      .set(auth)
      .send({
        lineItems: [
          { position: 2, quantity: 1, description: 'Album', unitPriceMinor: 60000, discountPercent: 0 },
          { position: 1, quantity: 1, description: 'Wedding coverage', unitPriceMinor: 200000, discountPercent: 0 },
        ],
      });
    expect(saved.status).toBe(200);

    const reloaded = await request(invoiceApp).get(`/api/admin/invoices/${invoiceId}`).set(auth);
    expect(reloaded.status).toBe(200);
    expect(descriptionsOf(reloaded.body)).toEqual(['Album', 'Wedding coverage']);
    expect(positionsOf(reloaded.body)).toEqual([1, 2]);
  });
});

describe.each(['quotes', 'invoices'])('%s — hierarchy validation before renumbering', (resource) => {
  const line = (position, description, extra = {}) => ({
    position, description, quantity: 1, unitPriceMinor: 10000, discountPercent: 0, ...extra,
  });
  const invalidCases = [
    ['missing parent colliding with a new position', [
      line(10, 'Unrelated'),
      line(20, 'Orphan', { parentPosition: 1 }),
    ], 'LINE_ITEM_PARENT_NOT_FOUND'],
    ['duplicate original positions', [
      line(10, 'First'),
      line(10, 'Second'),
      line(20, 'Child', { parentPosition: 10 }),
    ], 'LINE_ITEM_POSITION_DUPLICATE'],
  ];

  test.each(invalidCases)('POST rejects %s without creating a document', async (_name, lineItems, code) => {
    const app = resource === 'quotes' ? quoteApp : invoiceApp;
    const before = await db(resource).select('id');
    const res = await request(app).post(`/api/admin/${resource}`).set(auth).send({
      customerAccountId: customerId, currency: 'CHF', vatRate: 0, lineItems,
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(code);
    expect(await db(resource).select('id')).toEqual(before);
  });

  test.each(invalidCases)('PUT rejects %s without changing saved lines or totals', async (_name, lineItems, code) => {
    const app = resource === 'quotes' ? quoteApp : invoiceApp;
    const created = await request(app).post(`/api/admin/${resource}`).set(auth).send({
      customerAccountId: customerId, currency: 'CHF', vatRate: 0,
      lineItems: [line(1, 'Original')],
    });
    expect(created.status).toBe(201);
    const id = (created.body.quote || created.body.invoice).id;
    const url = `/api/admin/${resource}/${id}`;
    const before = await request(app).get(url).set(auth).expect(200);
    const rejected = await request(app).put(url).set(auth).send({ lineItems });
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe(code);
    const after = await request(app).get(url).set(auth).expect(200);
    expect(after.body.lineItems).toEqual(before.body.lineItems);
    const key = resource === 'quotes' ? 'quote' : 'invoice';
    expect(after.body[key].totalAmountMinor).toBe(before.body[key].totalAmountMinor);
  });

  test('POST preserves a moved parent and reordered children on first save', async () => {
    const app = resource === 'quotes' ? quoteApp : invoiceApp;
    const created = await request(app).post(`/api/admin/${resource}`).set(auth).send({
      customerAccountId: customerId, currency: 'CHF', vatRate: 0,
      lineItems: [line(4, 'Travel'), line(1, 'Package'),
        line(3, 'Lens', { parentPosition: 1 }), line(2, 'Camera', { parentPosition: 1 })],
    });
    expect(created.status).toBe(201);
    const id = (created.body.quote || created.body.invoice).id;
    const reloaded = await request(app).get(`/api/admin/${resource}/${id}`).set(auth).expect(200);
    expect(descriptionsOf(reloaded.body)).toEqual(['Travel', 'Package', 'Lens', 'Camera']);
    expect(positionsOf(reloaded.body)).toEqual([1, 2, 3, 4]);
    expect(reloaded.body.lineItems.slice(2).map((li) => li.parentLineItemId))
      .toEqual([reloaded.body.lineItems[1].id, reloaded.body.lineItems[1].id]);
  });
});
