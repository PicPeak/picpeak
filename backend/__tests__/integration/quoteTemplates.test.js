/**
 * Quote catalogue + templates — integration tests (#1451, migration 215).
 *
 * Real admin routes → services → SQLite with the full core-migration run
 * (helpers/crmDb). Pins:
 *   - a published template creates a quote with packages priced the agreed
 *     way (one item: price on the package line; several: sum of priced items),
 *     hour rates from the chain, bound hours, pinned rates, an unticked
 *     optional add-on, a pre-ticked promotion and placeholders that resolve
 *     on display while the stored text keeps them;
 *   - published versions are immutable: catalogue edits only reach a new
 *     version;
 *   - publishing refuses unknown placeholders and archived catalogue items;
 *   - save-as-template, archived-promotion skipping and the feature-flag gate.
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
let catalogApp;
const ids = {};

const prevCwd = process.cwd();
const auth = { get Authorization() { return `Bearer ${token}`; } };

async function setFlag(key, value) {
  const updated = await db('feature_flags').where({ key }).update({ value });
  if (!updated) await db('feature_flags').insert({ key, value });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
}

async function ok(req, status = [200, 201]) {
  const res = await req;
  if (!status.includes(res.status)) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

async function preset(body) {
  const { preset: row } = await ok(request(quoteApp).post('/api/admin/quotes/presets/line-items').set(auth).send(body));
  return row.id;
}

async function quoteFromTemplate(templateId, extra = {}) {
  const body = await ok(request(catalogApp).post(`/api/admin/quote-catalog/templates/${templateId}/quotes`).set(auth)
    .send({ customerAccountId: customerId, eventName: 'Hochzeit Muster', eventDate: '2027-06-12', ...extra }));
  const quote = await ok(request(quoteApp).get(`/api/admin/quotes/${body.quoteId}`).set(auth));
  return { ...body, ...quote };
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  db.client.pool.acquireTimeoutMillis = 2000;

  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  await setFlag('quotes', true);
  await db('business_profile').where({ id: 1 }).update({ default_hourly_rate_minor: 15000, company_name: 'Studio Test' });
  await db('customer_accounts').where({ id: customerId }).update({ first_name: 'Anna', last_name: 'Muster' });

  quoteApp = buildRouteApp('/api/admin/quotes', require('../../src/routes/adminQuotes'));
  catalogApp = buildRouteApp('/api/admin/quote-catalog', require('../../src/routes/adminQuoteCatalog'));

  ids.photography = await preset({ name: 'Photography on location', priceMode: 'hour', unit: 'hour' });
  ids.makeup = await preset({ name: 'Make-up', unitPriceMinor: 30000 });
  ids.editing = await preset({ name: 'Editing', unitPriceMinor: 50000 });
  ids.secondShooter = await preset({ name: 'Second shooter', priceMode: 'hour', pinnedRateMinor: 9000, unit: 'hour' });

  ids.gold = (await ok(request(catalogApp).post('/api/admin/quote-catalog/packages').set(auth).send({
    name: 'Wedding Gold',
    items: [
      { presetId: ids.photography, boundTo: 'hours' },
      { presetId: ids.makeup },
      { presetId: ids.editing },
    ],
  }))).package.id;
  ids.portrait = (await ok(request(catalogApp).post('/api/admin/quote-catalog/packages').set(auth).send({
    name: 'Portrait add-on', items: [{ presetId: ids.editing }],
  }))).package.id;
  ids.verein = (await ok(request(catalogApp).post('/api/admin/quote-catalog/promotions').set(auth).send({
    name: 'Vereinsrabatt', type: 'fixed', valueMinor: 30000, currency: 'CHF',
  }))).promotion.id;
  ids.intro = (await ok(request(catalogApp).post('/api/admin/quote-catalog/text-blocks').set(auth).send({
    kind: 'intro', name: 'Wedding intro',
    body: 'Hallo {{customer_name}}, danke für {{event_name}} am {{event_date}} ({{hours}} h à {{hourly_rate}}).',
  }))).textBlock.id;

  const { template } = await ok(request(catalogApp).post('/api/admin/quote-catalog/templates').set(auth).send({
    name: 'Wedding', currency: 'CHF',
    draft: {
      sections: [
        { type: 'package', packageId: ids.gold },
        { type: 'package', packageId: ids.portrait, isOptional: true },
        { type: 'item', presetId: ids.secondShooter, quantity: 2 },
      ],
      introTextBlockId: ids.intro,
      promotionIds: [ids.verein],
      hours: 8,
    },
  }));
  ids.template = template.id;
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

test('a quote from an unpublished template is refused', async () => {
  const res = await request(catalogApp).post(`/api/admin/quote-catalog/templates/${ids.template}/quotes`).set(auth)
    .send({ customerAccountId: customerId });
  expect(res.status).toBe(409);
});

test('publishing creates version 1 and the quote is built from it', async () => {
  const published = await ok(request(catalogApp).post(`/api/admin/quote-catalog/templates/${ids.template}/publish`).set(auth));
  expect(published.version).toBe(1);
  expect(published.template.status).toBe('published');

  const { quote, lineItems, skippedPromotions } = await quoteFromTemplate(ids.template);
  expect(skippedPromotions).toEqual([]);
  expect(quote.sourceTemplateId).toBe(ids.template);
  expect(quote.sourceTemplateVersion).toBe(1);
  expect(quote.hours).toBe(8);

  const byDescription = (d) => lineItems.filter((li) => li.description === d);
  // Several items: each priced, the package line is their sum.
  const [gold] = byDescription('Wedding Gold');
  const [photo] = byDescription('Photography on location');
  expect(photo).toEqual(expect.objectContaining({ quantity: 8, unitPriceMinor: 15000, rateSource: 'default', parentPosition: gold.position }));
  expect(gold.lineTotalMinor).toBe(8 * 15000 + 30000 + 50000);
  // One item: the package line carries the price, the item is listed unpriced.
  const [portrait] = byDescription('Portrait add-on');
  expect(portrait).toEqual(expect.objectContaining({ unitPriceMinor: 50000, isOptional: true, selected: false }));
  const portraitChild = lineItems.find((li) => li.parentPosition === portrait.position);
  expect(portraitChild).toEqual(expect.objectContaining({ description: 'Editing', unitPriceMinor: 0 }));
  // Pinned rate.
  expect(byDescription('Second shooter')[0]).toEqual(expect.objectContaining({ quantity: 2, unitPriceMinor: 9000, rateSource: 'item' }));
  // Pre-ticked promotion.
  expect(byDescription('Vereinsrabatt')[0]).toEqual(expect.objectContaining({ lineKind: 'discount', lineTotalMinor: -30000 }));
  // The unticked optional add-on isn't in the net.
  expect(quote.netAmountMinor).toBe(200000 + 18000 - 30000);
  // The quote keeps the raw text; placeholders resolve where it is shown.
  expect(quote.introText).toContain('{{');
  const row = await db('quotes').where({ id: quote.id }).first();
  const { introText } = await require('../../src/services/quoteTemplateService').resolveQuoteTexts(row);
  expect(introText).toContain('Hallo Anna Muster');
  expect(introText).toContain('Hochzeit Muster am 12.06.2027');
  expect(introText).toMatch(/8 h à CHF\s?150\.00/);
});

test('catalogue edits never change a published version, only the next one', async () => {
  await ok(request(quoteApp).put(`/api/admin/quotes/presets/line-items/${ids.makeup}`).set(auth).send({ unitPriceMinor: 99900 }));

  const v1 = await quoteFromTemplate(ids.template);
  expect(v1.lineItems.find((li) => li.description === 'Make-up').unitPriceMinor).toBe(30000);

  const published = await ok(request(catalogApp).post(`/api/admin/quote-catalog/templates/${ids.template}/publish`).set(auth));
  expect(published.version).toBe(2);
  const v2 = await quoteFromTemplate(ids.template);
  expect(v2.lineItems.find((li) => li.description === 'Make-up').unitPriceMinor).toBe(99900);

  const pinned = await quoteFromTemplate(ids.template, { version: 1 });
  expect(pinned.lineItems.find((li) => li.description === 'Make-up').unitPriceMinor).toBe(30000);
});

test('publishing refuses unknown placeholders and archived items', async () => {
  const { template } = await ok(request(catalogApp).post('/api/admin/quote-catalog/templates').set(auth).send({
    name: 'Broken', draft: { sections: [{ type: 'item', presetId: ids.editing }], introText: 'Hi {{custmer_name}}' },
  }));
  let res = await request(catalogApp).post(`/api/admin/quote-catalog/templates/${template.id}/publish`).set(auth);
  expect(res.status).toBe(400);
  expect(JSON.stringify(res.body)).toContain('custmer_name');

  const archivedId = await preset({ name: 'Old item', unitPriceMinor: 100 });
  await ok(request(quoteApp).put(`/api/admin/quotes/presets/line-items/${archivedId}`).set(auth).send({ isActive: false }));
  await ok(request(catalogApp).put(`/api/admin/quote-catalog/templates/${template.id}`).set(auth).send({
    draft: { sections: [{ type: 'item', presetId: archivedId }] },
  }));
  res = await request(catalogApp).post(`/api/admin/quote-catalog/templates/${template.id}/publish`).set(auth);
  expect(res.status).toBe(400);
});

test('a text block with an unknown placeholder is refused', async () => {
  const res = await request(catalogApp).post('/api/admin/quote-catalog/text-blocks').set(auth)
    .send({ kind: 'intro', name: 'Typo', body: 'Hello {{custmer}}' });
  expect(res.status).toBe(400);
});

test('a pre-ticked promotion that is no longer valid is skipped, not fatal', async () => {
  await ok(request(catalogApp).delete(`/api/admin/quote-catalog/promotions/${ids.verein}`).set(auth));
  const { skippedPromotions, lineItems } = await quoteFromTemplate(ids.template);
  expect(skippedPromotions).toEqual(['Vereinsrabatt']);
  expect(lineItems.some((li) => li.lineKind === 'discount')).toBe(false);
});

test('save as template keeps the lines and stays customer-neutral', async () => {
  const { quote } = await quoteFromTemplate(ids.template);
  const { template } = await ok(request(catalogApp)
    .post(`/api/admin/quote-catalog/templates/from-quote/${quote.id}`).set(auth).send({ name: 'Copied wedding' }));
  expect(template.status).toBe('draft');
  const sections = template.draft.sections;
  expect(sections.map((s) => s.line.description)).toEqual(['Wedding Gold', 'Portrait add-on', 'Second shooter']);
  // A rate taken from the business default goes back to "use the rate".
  const photo = sections[0].children.find((c) => c.description === 'Photography on location');
  expect(photo).toEqual(expect.objectContaining({ rateSource: 'auto', unitPriceMinor: 0 }));
  expect(sections[1].isOptional).toBe(true);
  // The intro comes over with its placeholders, not this customer's details.
  expect(template.draft.introText).toContain('{{customer_name}}');
  expect(template.draft.introText).not.toContain('Anna');
});

test('the catalogue is behind the quotes feature flag', async () => {
  await setFlag('quotes', false);
  const res = await request(catalogApp).get('/api/admin/quote-catalog/packages').set(auth);
  expect(res.status).toBe(403);
  expect(res.body.code).toBe('QUOTES_DISABLED');
  await setFlag('quotes', true);
});
