/**
 * The per-quote installment plan (migration 142) round-trips through the
 * admin API. The quote page edits a draft in place and reloads it after a
 * save, so the plan it just saved has to come back on GET — otherwise the
 * panel shows it wiped while the override is still stored — and an emptied
 * plan has to clear the override.
 */

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let tmpDir;
let customerId;
let token;
let quoteApp;

const prevCwd = process.cwd();
const auth = { get Authorization() { return `Bearer ${token}`; } };

const PLAN = [
  { label: 'Anzahlung', percent: 30, trigger: 'quote_accepted', offset_days: 0 },
  { label: 'Rest', percent: 70, trigger: 'after_delivery', offset_days: 10 },
];

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  let adminId;
  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  const updated = await db('feature_flags').where({ key: 'quotes' }).update({ value: true });
  if (!updated) await db('feature_flags').insert({ key: 'quotes', value: true });
  quoteApp = buildRouteApp('/api/admin/quotes', require('../../src/routes/adminQuotes'));
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

test('a saved plan comes back on GET, and an empty plan clears it', async () => {
  const created = await request(quoteApp).post('/api/admin/quotes').set(auth).send({
    customerAccountId: customerId, currency: 'CHF', vatRate: 0, installments: PLAN,
    lineItems: [{ description: 'Shooting', quantity: 1, unitPriceMinor: 100000 }],
  });
  expect(created.status).toBe(201);
  const id = created.body.quote?.id ?? created.body.id;

  const loaded = await request(quoteApp).get(`/api/admin/quotes/${id}`).set(auth);
  expect(loaded.status).toBe(200);
  expect(loaded.body.quote.installmentsOverride).toEqual(PLAN);

  const cleared = await request(quoteApp).put(`/api/admin/quotes/${id}`).set(auth).send({ installments: [] });
  expect(cleared.status).toBe(200);
  const after = await request(quoteApp).get(`/api/admin/quotes/${id}`).set(auth);
  expect(after.body.quote.installmentsOverride).toBeNull();
});
