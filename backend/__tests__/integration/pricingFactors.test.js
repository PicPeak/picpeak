/**
 * Pricing factors on catalogue items — integration tests (#2440, migration 353).
 *
 * Drives the real admin routes against SQLite with the full core-migration
 * run (helpers/crmDb), and pins:
 *   - the factor library CRUD (options keep their ids across an edit);
 *   - attaching factors to a catalogue item, with the currency and the
 *     configurable-product rules;
 *   - every effect: per unit above an included amount, per started step,
 *     toggle fixed / percent, choice option, travel zone by postcode
 *     (exact, prefix, numeric range) and an unmatched postcode;
 *   - an hourly item prices its base from the rate chain;
 *   - the snapshot travels on the parent line of a quote and onto the
 *     invoice it converts to; totals come from the sub-lines.
 */

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

const n = (v) => (v == null ? v : Number(v));

let db;
let cleanup;
let tmpDir;
let adminId;
let customerId;
let token;
let quoteApp;
let catalogApp;

const prevCwd = process.cwd();
const auth = { get Authorization() { return `Bearer ${token}`; } };

async function enableFlag(key) {
  const updated = await db('feature_flags').where({ key }).update({ value: true });
  if (!updated) await db('feature_flags').insert({ key, value: true });
}

async function createFactor(body) {
  const res = await request(catalogApp).post('/api/admin/quote-catalog/factors').set(auth).send(body);
  if (res.status !== 201) throw new Error(`factor create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.factor;
}

async function createPreset(body) {
  const res = await request(quoteApp).post('/api/admin/quotes/presets/line-items').set(auth).send(body);
  if (res.status !== 201) throw new Error(`preset create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.preset;
}

const price = (presetId, values, extra = {}) => request(catalogApp)
  .post('/api/admin/quote-catalog/factors/price').set(auth)
  .send({ presetId, values, ...extra });

let session;
let editing;
let kind;
let travel;
let drone;
let rush;
let shoot;

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
  catalogApp = buildRouteApp('/api/admin/quote-catalog', require('../../src/routes/adminQuoteCatalog'));

  session = await createFactor({
    name: 'Session length', inputType: 'number', effect: 'per_unit', unitLabel: 'h',
    amountMinor: 15000, includedUnits: 2, minValue: 1, maxValue: 12, defaultValue: '2',
  });
  editing = await createFactor({
    name: 'Editing', inputType: 'number', effect: 'step', unitLabel: 'h', amountMinor: 20000, stepSize: 2,
    clientVisible: false,
  });
  kind = await createFactor({
    name: 'Kind of work', inputType: 'choice',
    options: [
      { label: 'Photo', effect: 'fixed', amountMinor: 0 },
      { label: 'Video', effect: 'percent', percent: 50 },
      { label: 'Photo and video', effect: 'fixed', amountMinor: 80000 },
    ],
  });
  travel = await createFactor({
    name: 'Travel', inputType: 'zone',
    options: [
      { label: 'City', effect: 'fixed', amountMinor: 0, postcodes: '8001\n8002' },
      { label: 'Region', effect: 'fixed', amountMinor: 9000, postcodes: '80*, 84*' },
      { label: 'Canton', effect: 'fixed', amountMinor: 18000, postcodes: '8100-8999' },
    ],
  });
  drone = await createFactor({ name: 'Drone', inputType: 'toggle', effect: 'fixed', amountMinor: 25000 });
  rush = await createFactor({ name: 'Rush delivery', inputType: 'toggle', effect: 'percent', percent: 20 });

  shoot = await createPreset({
    name: 'Music video shoot', unitPriceMinor: 100000, currency: 'CHF',
    factorIds: [session.id, editing.id, kind.id, travel.id, drone.id, rush.id],
  });
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

describe('factor library', () => {
  test('lists factors with their options, and options keep ids on edit', async () => {
    const list = await request(catalogApp).get('/api/admin/quote-catalog/factors').set(auth);
    expect(list.status).toBe(200);
    const listed = list.body.factors.find((f) => f.id === kind.id);
    expect(listed.options.map((o) => o.label)).toEqual(['Photo', 'Video', 'Photo and video']);

    const [photo, video] = listed.options;
    const res = await request(catalogApp).put(`/api/admin/quote-catalog/factors/${kind.id}`).set(auth).send({
      defaultValue: String(photo.id),
      options: [
        { id: photo.id, label: 'Photo only', effect: 'fixed', amountMinor: 0 },
        { id: video.id, label: 'Video', effect: 'percent', percent: 50 },
        { id: listed.options[2].id, label: 'Photo and video', effect: 'fixed', amountMinor: 80000 },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.factor.options.map((o) => o.id)).toEqual(listed.options.map((o) => o.id));
    expect(res.body.factor.options[0].label).toBe('Photo only');
    kind = res.body.factor;
  });

  test('a stepped number factor needs a step size', async () => {
    const res = await request(catalogApp).post('/api/admin/quote-catalog/factors').set(auth)
      .send({ name: 'Bad', inputType: 'number', effect: 'step', amountMinor: 100 });
    expect(res.status).toBe(400);
  });

  test('the catalogue item lists its factor ids in order', async () => {
    const res = await request(quoteApp).get('/api/admin/quotes/presets/line-items').set(auth);
    const item = res.body.presets.find((p) => p.id === shoot.id);
    expect(item.factorIds).toEqual([session.id, editing.id, kind.id, travel.id, drone.id, rush.id]);
  });

  test('a factor in another currency cannot be attached', async () => {
    const euro = await createFactor({ name: 'Euro fee', inputType: 'toggle', amountMinor: 100, currency: 'EUR' });
    const res = await request(quoteApp).post('/api/admin/quotes/presets/line-items').set(auth)
      .send({ name: 'CHF item', unitPriceMinor: 100, currency: 'CHF', factorIds: [euro.id] });
    expect(res.status).toBe(400);
    expect(res.body.code || res.body.error?.code).toBeDefined();
    expect(await db('quote_line_item_presets').where({ name: 'CHF item' }).first()).toBeUndefined();
  });

  test('an archived factor cannot be newly attached, but stays on items that have it', async () => {
    const old = await createFactor({ name: 'Old fee', inputType: 'toggle', amountMinor: 100 });
    const item = await createPreset({ name: 'Keeps old', unitPriceMinor: 100, factorIds: [old.id] });
    await request(catalogApp).delete(`/api/admin/quote-catalog/factors/${old.id}`).set(auth).expect(200);

    const keep = await request(quoteApp).put(`/api/admin/quotes/presets/line-items/${item.id}`).set(auth)
      .send({ name: 'Keeps old (renamed)' });
    expect(keep.status).toBe(200);
    expect(keep.body.preset.factorIds).toEqual([old.id]);

    const res = await request(quoteApp).post('/api/admin/quotes/presets/line-items').set(auth)
      .send({ name: 'New with old', unitPriceMinor: 100, factorIds: [old.id] });
    expect(res.status).toBe(400);
  });
});

describe('pricing', () => {
  test('defaults only: base price, nothing else changes it', async () => {
    const res = await price(shoot.id, {});
    expect(res.status).toBe(200);
    expect(res.body.lines.map((l) => l.kind)).toEqual(['base']);
    expect(res.body.totalMinor).toBe(100000);
  });

  test('every effect adds its own line', async () => {
    const [, video] = kind.options;
    const res = await price(shoot.id, {
      [session.id]: 5, // 3 h above the 2 included × 150
      [editing.id]: 5, // 3 started steps of 2 h × 200
      [kind.id]: video.id, // +50 % of the base
      [travel.id]: { postcode: '8 400' }, // "84*" → Region 90
      [drone.id]: true,
      [rush.id]: true, // +20 % of the base
    }, { language: 'de' });
    expect(res.status).toBe(200);
    const totals = res.body.lines.map((l) => [l.kind, l.totalMinor]);
    expect(totals).toEqual([
      ['base', 100000],
      ['factor', 45000],
      ['factor', 60000],
      ['factor', 50000],
      ['factor', 9000],
      ['factor', 25000],
      ['factor', 20000],
    ]);
    expect(res.body.totalMinor).toBe(309000);
    expect(res.body.lines[0].description).toBe('Grundpreis');
    expect(res.body.lines[1].description).toBe('Session length: 5 h (2 h inklusive)');
    expect(res.body.snapshot.values[travel.id]).toEqual({ postcode: '8 400', optionId: travel.options[1].id });
  });

  test('zones match exact, prefix and range, in order; an unknown postcode is flagged', async () => {
    const zone = async (postcode) => {
      const res = await price(shoot.id, { [travel.id]: { postcode } });
      return { total: res.body.totalMinor, unmatched: res.body.unmatched };
    };
    expect(await zone('8001')).toEqual({ total: 100000, unmatched: [] }); // City wins over 80*
    expect(await zone('8050')).toEqual({ total: 109000, unmatched: [] });
    expect(await zone('8500')).toEqual({ total: 118000, unmatched: [] });
    expect(await zone('3000')).toEqual({ total: 100000, unmatched: [travel.id] });
  });

  test('values outside the bounds are refused', async () => {
    const res = await price(shoot.id, { [session.id]: 20 });
    expect(res.status).toBe(400);
  });

  test('an hourly item prices its base from the rate chain', async () => {
    await db('business_profile').where({ id: 1 }).update({ default_hourly_rate_minor: 12000 });
    const hourly = await createPreset({ name: 'Studio hour', priceMode: 'hour', factorIds: [drone.id] });
    const res = await price(hourly.id, { [drone.id]: true }, { quantity: 3, customerId });
    expect(res.status).toBe(200);
    expect(res.body.lines[0]).toEqual(expect.objectContaining({
      quantity: 3, unitPriceMinor: 12000, totalMinor: 36000, priceMode: 'hour', rateSource: 'default',
    }));
    expect(res.body.totalMinor).toBe(61000);
  });
});

describe('quote lines', () => {
  test('the snapshot rides on the parent line; the sub-lines make the total', async () => {
    const priced = await price(shoot.id, { [drone.id]: true });
    const lines = priced.body.lines;
    const res = await request(quoteApp).post('/api/admin/quotes').set(auth).send({
      customerAccountId: customerId, currency: 'CHF', vatRate: 0,
      lineItems: [
        {
          position: 1, quantity: 1, unitPriceMinor: 0, description: 'Music video shoot',
          cataloguePresetId: shoot.id, pricingFactors: priced.body.snapshot,
        },
        ...lines.map((l, i) => ({
          position: i + 2, parentPosition: 1, description: l.description,
          quantity: l.quantity, unitPriceMinor: l.unitPriceMinor,
        })),
      ],
    });
    expect(res.status).toBe(201);
    expect(n(res.body.quote.netAmountMinor)).toBe(125000);
    const parent = res.body.lineItems.find((li) => li.description === 'Music video shoot');
    expect(parent.pricingFactors).toEqual(expect.objectContaining({ presetId: shoot.id, version: 1 }));

    const row = await db('quote_line_items').where({ quote_id: res.body.quote.id, description: 'Music video shoot' }).first();
    expect(JSON.parse(row.pricing_factors).values[drone.id]).toBe(true);
  });
});

describe('review round 1', () => {
  test('removing the default option clears the default; a default naming no option is refused', async () => {
    const f = await createFactor({
      name: 'Format', inputType: 'choice',
      options: [{ label: 'Square', effect: 'fixed', amountMinor: 0 }, { label: 'Wide', effect: 'fixed', amountMinor: 5000 }],
    });
    const [square, wide] = f.options;
    let res = await request(catalogApp).put(`/api/admin/quote-catalog/factors/${f.id}`).set(auth)
      .send({ defaultValue: String(wide.id), options: f.options });
    expect(res.body.factor.defaultValue).toBe(String(wide.id));

    res = await request(catalogApp).put(`/api/admin/quote-catalog/factors/${f.id}`).set(auth)
      .send({ options: [{ id: square.id, label: 'Square', effect: 'fixed', amountMinor: 0 }] });
    expect(res.status).toBe(200);
    expect(res.body.factor.defaultValue).toBeNull();

    res = await request(catalogApp).put(`/api/admin/quote-catalog/factors/${f.id}`).set(auth)
      .send({ defaultValue: String(wide.id) });
    expect(res.status).toBe(400);
  });

  test('a number default outside the bounds is refused', async () => {
    const res = await request(catalogApp).post('/api/admin/quote-catalog/factors').set(auth)
      .send({ name: 'Hours', inputType: 'number', amountMinor: 100, maxValue: 8, defaultValue: '9' });
    expect(res.status).toBe(400);
  });

  test('the type of a factor in use cannot change', async () => {
    const res = await request(catalogApp).put(`/api/admin/quote-catalog/factors/${kind.id}`).set(auth)
      .send({ inputType: 'number' });
    expect(res.status).toBe(409);
  });

  test('numeric fields are bounded, and so is a submitted value', async () => {
    for (const bad of [{ stepSize: 0.004, effect: 'step' }, { includedUnits: 1e9 }, { maxValue: 1e12 }]) {
      const res = await request(catalogApp).post('/api/admin/quote-catalog/factors').set(auth)
        .send({ name: 'Bad', inputType: 'number', amountMinor: 100, ...bad });
      expect(res.status).toBe(400);
    }
    const editingNoMax = await createFactor({ name: 'Unbounded', inputType: 'number', amountMinor: 100 });
    const item = await createPreset({ name: 'Unbounded item', unitPriceMinor: 100, factorIds: [editingNoMax.id] });
    const res = await price(item.id, { [editingNoMax.id]: 1e300 });
    expect(res.status).toBe(400);
  });

  test('a range whose ends differ in length is refused', async () => {
    const res = await request(catalogApp).post('/api/admin/quote-catalog/factors').set(auth)
      .send({ name: 'Bad zones', inputType: 'zone', options: [{ label: 'Z', effect: 'fixed', amountMinor: 0, postcodes: '800-1200' }] });
    expect(res.status).toBe(400);
  });

  test('the snapshot keeps only the chosen option and the lines it made', async () => {
    const res = await price(shoot.id, { [travel.id]: { postcode: '8050' }, [drone.id]: true });
    const travelSnap = res.body.snapshot.factors.find((f) => f.id === travel.id);
    expect(travelSnap.options.map((o) => o.label)).toEqual(['Region']);
    expect(res.body.snapshot.lines.map((l) => l.description)).toEqual(res.body.lines.map((l) => l.description));
  });

  test('an oversized snapshot is refused, not dropped', async () => {
    const res = await request(quoteApp).post('/api/admin/quotes').set(auth).send({
      customerAccountId: customerId, currency: 'CHF', vatRate: 0,
      lineItems: [{ position: 1, quantity: 1, unitPriceMinor: 100, description: 'Big', pricingFactors: { version: 1, padding: 'x'.repeat(25000) } }],
    });
    expect(res.status).toBe(400);
  });
});
