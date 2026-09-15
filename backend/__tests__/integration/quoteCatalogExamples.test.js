/**
 * Quote catalogue examples (#1451): seeded once, archived (so the quote
 * editor doesn't offer them) but listed and editable in the catalogue, the
 * template an editable draft, and "Vereinsrabatt" without an end date.
 */

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let token;
let catalogApp;
let quotesApp;

const auth = { get Authorization() { return `Bearer ${token}`; } };
const off = (v) => v === false || v === 0 || v === '0';

async function setFlag(key, value) {
  const updated = await db('feature_flags').where({ key }).update({ value });
  if (!updated) await db('feature_flags').insert({ key, value });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  const { adminId } = await seedMinimal(db);
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  await setFlag('quotes', true);
  catalogApp = buildRouteApp('/api/admin/quote-catalog', require('../../src/routes/adminQuoteCatalog'));
  quotesApp = buildRouteApp('/api/admin/quotes', require('../../src/routes/adminQuotes'));
}, 120000);

afterAll(async () => {
  if (cleanup) await cleanup();
});

test('opening the catalogue seeds the examples once, archived', async () => {
  const res = await request(catalogApp).get('/api/admin/quote-catalog/promotions').set(auth);
  expect(res.status).toBe(200);
  const names = res.body.promotions.map((p) => p.name);
  expect(names).toEqual(expect.arrayContaining(['Beispiel: Vereinsrabatt', 'Beispiel: Frühbucherrabatt']));

  const examples = require('../../src/services/quoteCatalogExamples');
  examples._resetForTests();
  await examples.ensureCatalogExamples();
  expect(await db('quote_promotions').where('name', 'like', 'Beispiel:%')).toHaveLength(2);
  expect(await db('quote_line_item_presets').where('name', 'like', 'Beispiel:%')).toHaveLength(5);

  for (const table of ['quote_line_item_presets', 'quote_packages', 'quote_promotions', 'quote_text_blocks']) {
    const rows = await db(table).where('name', 'like', 'Beispiel:%');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => off(r.is_active))).toBe(true);
  }
  // Archived rows stay out of what the quote editor offers.
  const active = await request(catalogApp).get('/api/admin/quote-catalog/promotions?activeOnly=true').set(auth);
  expect(active.body.promotions.map((p) => p.name)).not.toContain('Beispiel: Vereinsrabatt');

  const club = res.body.promotions.find((p) => p.name === 'Beispiel: Vereinsrabatt');
  expect(club).toEqual(expect.objectContaining({ type: 'fixed', valueMinor: 30000, validUntil: null }));
});

test('the examples are editable, and restoring one puts it to use', async () => {
  const club = await db('quote_promotions').where({ name: 'Beispiel: Vereinsrabatt' }).first();
  const edited = await request(catalogApp).put(`/api/admin/quote-catalog/promotions/${club.id}`).set(auth)
    .send({ name: 'Vereinsrabatt', type: 'fixed', valueMinor: 25000, currency: 'CHF' });
  expect(edited.status).toBe(200);
  expect(edited.body.promotion).toEqual(expect.objectContaining({ name: 'Vereinsrabatt', valueMinor: 25000, isActive: false }));
  const restored = await request(catalogApp).put(`/api/admin/quote-catalog/promotions/${club.id}`).set(auth).send({ isActive: true });
  expect(restored.body.promotion.isActive).toBe(true);

  const service = await db('quote_line_item_presets').where('name', 'like', 'Beispiel: Anfahrt').first();
  const updated = await request(quotesApp).put(`/api/admin/quotes/presets/line-items/${service.id}`).set(auth)
    .send({ unit_price_minor: 80 });
  expect([200, 404]).toContain(updated.status);

  const template = await db('quote_templates').where({ name: 'Beispiel: Hochzeitsreportage' }).first();
  expect(template.status).toBe('draft');
  const saved = await request(catalogApp).put(`/api/admin/quote-catalog/templates/${template.id}`).set(auth)
    .send({ name: 'Hochzeitsreportage' });
  expect(saved.status).toBe(200);
});

test('the example template can be published and used as it is', async () => {
  const template = await db('quote_templates').where({ name: 'Hochzeitsreportage' }).first();
  const published = await request(catalogApp).post(`/api/admin/quote-catalog/templates/${template.id}/publish`).set(auth).send({});
  expect(published.status).toBe(200);

  const customer = await db('customer_accounts').first();
  const created = await request(catalogApp).post(`/api/admin/quote-catalog/templates/${template.id}/quotes`).set(auth)
    .send({ customerAccountId: customer.id });
  expect([200, 201]).toContain(created.status);
  const quoteId = created.body.quoteId || created.body.quote?.id || created.body.id;
  const lines = await db('quote_line_items').where({ quote_id: quoteId }).orderBy('position');
  expect(lines).toHaveLength(5);
  // The hourly line follows the template's 8 hours at the example price.
  expect(lines[0]).toEqual(expect.objectContaining({ quantity: 8, unit_price_minor: 18000 }));
  expect(lines.filter((l) => l.is_optional === true || l.is_optional === 1)).toHaveLength(2);
});

test('an edited or deleted example stays as it is when the seeding runs again', async () => {
  await db('quote_promotions').where({ name: 'Beispiel: Frühbucherrabatt' }).del();
  const examples = require('../../src/services/quoteCatalogExamples');
  examples._resetForTests();
  await examples.ensureCatalogExamples();
  expect(await db('quote_promotions').where({ name: 'Beispiel: Frühbucherrabatt' })).toHaveLength(0);
  // The promotion edited above keeps its edit, and no second set appears.
  expect(await db('quote_promotions').where({ name: 'Vereinsrabatt', value_minor: 25000 })).toHaveLength(1);
  expect(await db('quote_promotions').where({ name: 'Beispiel: Vereinsrabatt' })).toHaveLength(0);
  expect(await db('quote_templates').where('name', 'like', '%Hochzeitsreportage%')).toHaveLength(1);
});
