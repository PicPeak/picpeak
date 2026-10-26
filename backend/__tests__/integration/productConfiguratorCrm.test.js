'use strict';
// Native core migrations, auth grants, quote arithmetic and document snapshots.
const crypto = require('crypto');
const request = require('supertest');
const sharp = require('sharp');
const {
  bootCrmDb,
  seedMinimal,
  assignAdminRole,
  createPublicToken,
  buildRouteApp,
} = require('./helpers/crmDb');
const V = require('../../src/services/albumProducts/validation');
const G = require('../../src/services/albumProducts/library');
const uuid = () => crypto.randomUUID();
const parsed = (value) =>
  typeof value === 'string' ? JSON.parse(value) : value;
let db,
  cleanup,
  adminId,
  customerId,
  products,
  quotes,
  app,
  catalog,
  product,
  type,
  size,
  frame,
  mat,
  image;
const previousCwd = process.cwd();
beforeAll(async () => {
  let tmpDir;
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId);
  for (const key of ['albumProducts', 'quotes', 'contracts'])
    await db('feature_flags')
      .insert({ key, value: true })
      .onConflict('key')
      .merge({ value: true });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
  products = require('../../src/services/albumProducts/service').application();
  quotes = require('../../src/services/quoteService');
  image = await products.uploadImage(
    await sharp({
      create: { width: 24, height: 24, channels: 3, background: '#336699' },
    })
      .png()
      .toBuffer(),
    adminId,
  );
  const option = (name, extra = {}) => ({
    id: uuid(),
    name,
    active: true,
    imageId: image.id,
    ...extra,
  });
  const library = [
    {
      id: uuid(),
      name: 'Size',
      kind: 'size',
      options: [
        option('90 × 60 cm', { width: 90, height: 60, unit: 'cm' }),
        option('60 × 40 cm', { width: 60, height: 40, unit: 'cm' }),
      ],
    },
    {
      id: uuid(),
      name: 'Frame',
      kind: 'choice',
      options: [option('Oak'), option('Walnut')],
    },
    { id: uuid(), name: 'Mat', kind: 'choice', options: [option('White mat')] },
  ];
  const attribute = (group, extra = {}) => ({
    id: uuid(),
    name: group.name,
    groupId: group.id,
    optionIds: group.options.map((o) => o.id),
    required: true,
    multiple: false,
    addOn: false,
    dependsOn: [],
    ...extra,
  });
  size = attribute(library[0]);
  frame = attribute(library[1], { required: false, addOn: true });
  mat = attribute(library[2], {
    required: false,
    addOn: true,
    dependsOn: [{ attributeId: frame.id, optionIds: frame.optionIds }],
  });
  type = {
    id: uuid(),
    name: 'Framed print',
    active: true,
    attributes: [size, frame, mat],
  };
  product = {
    id: uuid(),
    name: 'Wall print',
    active: true,
    description: 'Synthetic review fixture',
    typeId: type.id,
  };
  catalog = await products.saveCatalogue({
    revision: 0,
    products: [product],
    library,
    types: [type],
  });
  app = buildRouteApp(
    '/api/public/quotes',
    require('../../src/routes/publicQuotes'),
  );
}, 180000);
beforeEach(async () => {
  await db('feature_flags').where({ key: 'bills' }).update({ value: false });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
});
afterAll(async () => {
  process.chdir(previousCwd);
  if (cleanup) await cleanup();
});
async function fixture({ optional = true, parent = false } = {}) {
  const preset = await quotes.createLineItemPreset({
    name: 'Print',
    currency: 'EUR',
    unit_price_minor: 10000,
    price_mode: 'fixed',
    product_id: product.id,
    product_surcharges: [
      {
        attributeId: frame.id,
        optionId: frame.optionIds[0],
        amountMinor: 2000,
      },
      { attributeId: mat.id, optionId: mat.optionIds[0], amountMinor: 500 },
    ],
  });
  const lines = [
    {
      position: 1,
      quantity: 1,
      description: 'Photography',
      unit_price_minor: 50000,
    },
    ...(parent
      ? [
        {
          position: 2,
          quantity: 1,
          description: 'Print package',
          unit_price_minor: 0,
          is_optional: optional,
          selected: !optional,
        },
      ]
      : []),
    {
      position: parent ? 3 : 2,
      parent_position: parent ? 2 : null,
      quantity: 2,
      description: 'Print',
      unit_price_minor: 1,
      catalogue_preset_id: preset.id,
      is_optional: optional,
      selected: !optional,
    },
  ];
  const quoteId = await quotes.createQuote(
    {
      customerAccountId: customerId,
      currency: 'EUR',
      vatRate: 0,
      lineItems: lines,
    },
    adminId,
  );
  await db('quotes')
    .where({ id: quoteId })
    .update({ status: 'sent', sent_at: new Date().toISOString() });
  const token = await createPublicToken(db, 'quote_action_tokens', {
    quote_id: quoteId,
  });
  const tokenRow = await db('quote_action_tokens').where({ token }).first();
  const grant =
    await require('../../src/services/publicDocumentVerificationService').issueGrant(
      'quote',
      tokenRow,
      token,
    );
  const stored = await quotes.getQuoteById(quoteId),
    line = stored.lineItems.find((li) => li.configuration_definition);
  const definition = parsed(line.configuration_definition);
  const configurations = [
    {
      position: Number(line.position),
      definitionVersion: definition.version,
      values: {
        [size.id]: [size.optionIds[0]],
        [frame.id]: [frame.optionIds[0]],
        [mat.id]: [mat.optionIds[0]],
      },
    },
  ];
  return { quoteId, token, grant, configurations, preset, line, definition };
}
const totals = (f, selected = [2], configurations = f.configurations) =>
  request(app)
    .post(`/api/public/quotes/${f.token}/totals`)
    .set('X-Document-Access', f.grant)
    .send({ selectedOptional: selected, configurations });
const accept = (f, total, selected = [2], configurations = f.configurations) =>
  request(app)
    .post(`/api/public/quotes/${f.token}/respond`)
    .set('X-Document-Access', f.grant)
    .send({
      action: 'accept',
      selectedOptional: selected,
      expectedTotalMinor: total,
      configurations,
    });

test('archived ordinary catalogue items remain usable on existing quotes with configuration disabled', async () => {
  const preset = await quotes.createLineItemPreset({ name: 'Ordinary photography', currency: 'EUR', unit_price_minor: 12000 });
  const templates = require('../../src/services/quoteTemplateService');
  const templateId = await templates.createTemplate({ name: 'Ordinary item', currency: 'EUR',
    draft: { sections: [{ type: 'item', presetId: preset.id }] } }, adminId);
  await templates.publishTemplate(templateId, adminId);
  await quotes.deleteLineItemPreset(preset.id);
  await db('feature_flags').where({ key: 'albumProducts' }).update({ value: false });
  try {
    const quoteId = await quotes.createQuote({ customerAccountId: customerId, currency: 'EUR', vatRate: 0,
      lineItems: [{ position: 1, quantity: 1, description: 'Saved ordinary item', unit_price_minor: 12000, catalogue_preset_id: preset.id }] }, adminId);
    const saved = await quotes.getQuoteById(quoteId);
    expect(Number(saved.quote.total_amount_minor)).toBe(12000);
    expect(saved.lineItems[0].configuration_definition).toBeNull();
    await quotes.updateQuote(quoteId, { lineItems: saved.lineItems }, adminId);
    const created = await templates.createQuoteFromTemplate(templateId, { customerAccountId: customerId }, adminId);
    const fromTemplate = await quotes.getQuoteById(created.quoteId);
    expect(fromTemplate.lineItems[0].configuration_definition).toBeNull();
    expect(Number(fromTemplate.lineItems[0].unit_price_minor)).toBe(12000);
  } finally {
    await db('feature_flags').where({ key: 'albumProducts' }).update({ value: true });
  }
});

test.each(['active', 'archived', 'disabled'])('an existing plain line keeps its manual price after its preset becomes configurable (%s)', async (state) => {
  const preset = await quotes.createLineItemPreset({ name: 'Ordinary album', currency: 'EUR', unit_price_minor: 12000 });
  const quoteId = await quotes.createQuote({ customerAccountId: customerId, currency: 'EUR', vatRate: 0,
    lineItems: [{ position: 1, quantity: 1, description: 'Agreed album', unit_price_minor: 8700, catalogue_preset_id: preset.id }] }, adminId);
  const before = await quotes.getQuoteById(quoteId);
  await quotes.updateLineItemPreset(preset.id, { product_id: product.id, unit_price_minor: 45000 });
  if (state === 'archived') await quotes.deleteLineItemPreset(preset.id);
  if (state === 'disabled') await db('feature_flags').where({ key: 'albumProducts' }).update({ value: false });
  try {
    await quotes.updateQuote(quoteId, { lineItems: before.lineItems.map((line) => ({
      ...line, quantity: 2, configuration_definition: undefined, configuration_snapshot: undefined,
      configuration_source_line_id: line.id,
    })) }, adminId);
    const after = await quotes.getQuoteById(quoteId);
    expect(after.lineItems[0].configuration_definition).toBeNull();
    expect(Number(after.lineItems[0].catalogue_preset_id)).toBe(Number(preset.id));
    expect(Number(after.lineItems[0].unit_price_minor)).toBe(8700);
    expect(Number(after.quote.total_amount_minor)).toBe(17400);
  } finally {
    await db('feature_flags').where({ key: 'albumProducts' }).update({ value: true });
  }
});

test.each(['direct', 'package'].flatMap((kind) => ['active', 'archived', 'disabled'].map((state) => [kind, state])))('a published plain %s template preserves its definition and price after linking its preset (%s)', async (kind, state) => {
  const preset = await quotes.createLineItemPreset({ name: 'Published ordinary album', currency: 'EUR', unit_price_minor: 12000 });
  const templates = require('../../src/services/quoteTemplateService');
  let section = { type: 'item', presetId: preset.id };
  if (kind === 'package') {
    const packages = require('../../src/services/quoteCatalogService');
    const pkg = await packages.savePackage(null, { name: 'Ordinary package', currency: 'EUR',
      items: [{ preset_id: preset.id, quantity: 1 }] });
    section = { type: 'package', packageId: pkg.id };
  }
  const templateId = await templates.createTemplate({ name: 'Frozen plain offer', currency: 'EUR',
    draft: { vatRate: 0, sections: [section] } }, adminId);
  await templates.publishTemplate(templateId, adminId);
  await quotes.updateLineItemPreset(preset.id, { product_id: product.id, unit_price_minor: 45000 });
  if (state === 'archived') await quotes.deleteLineItemPreset(preset.id);
  if (state === 'disabled') await db('feature_flags').where({ key: 'albumProducts' }).update({ value: false });
  try {
    const created = await templates.createQuoteFromTemplate(templateId, { customerAccountId: customerId }, adminId);
    const saved = await quotes.getQuoteById(created.quoteId);
    const item = saved.lineItems.find((line) => Number(line.catalogue_preset_id) === Number(preset.id));
    expect(item.configuration_definition).toBeNull();
    expect(Number(item.unit_price_minor)).toBe(12000);
    expect(Number(saved.quote.total_amount_minor)).toBe(12000);
  } finally {
    await db('feature_flags').where({ key: 'albumProducts' }).update({ value: true });
  }
});

test('new catalogue lines and republished plain templates adopt the current product definition and price', async () => {
  const preset = await quotes.createLineItemPreset({ name: 'Newly configurable album', currency: 'EUR', unit_price_minor: 12000 });
  const templates = require('../../src/services/quoteTemplateService');
  const templateId = await templates.createTemplate({ name: 'Republished offer', currency: 'EUR',
    draft: { sections: [{ type: 'item', presetId: preset.id }] } }, adminId);
  await templates.publishTemplate(templateId, adminId);
  await quotes.updateLineItemPreset(preset.id, { product_id: product.id, unit_price_minor: 45000 });
  const freshId = await quotes.createQuote({ customerAccountId: customerId, currency: 'EUR', vatRate: 0,
    lineItems: [{ position: 1, quantity: 1, description: 'Fresh catalogue item', unit_price_minor: 1, catalogue_preset_id: preset.id }] }, adminId);
  await templates.publishTemplate(templateId, adminId);
  const fromTemplate = await templates.createQuoteFromTemplate(templateId, { customerAccountId: customerId }, adminId);
  for (const id of [freshId, fromTemplate.quoteId]) {
    const saved = await quotes.getQuoteById(id);
    const definition = parsed(saved.lineItems[0].configuration_definition);
    expect(definition.product.id).toBe(product.id);
    expect(definition.baseUnitPriceMinor).toBe(45000);
    expect(Number(saved.lineItems[0].unit_price_minor)).toBe(45000);
  }
});

test('unchanged product links remain editable when configuration is disabled, but new links do not', async () => {
  const f = await fixture();
  await db('feature_flags').where({ key: 'albumProducts' }).update({ value: false });
  try {
    const row = await db('quote_line_item_presets').where({ id: f.preset.id }).first();
    await quotes.updateLineItemPreset(row.id, { name: 'Updated ordinary details', product_id: row.product_id,
      product_surcharges: parsed(row.product_surcharges) });
    expect((await db('quote_line_item_presets').where({ id: row.id }).first()).name).toBe('Updated ordinary details');
    await expect(quotes.updateLineItemPreset(row.id, { price_mode: 'hour' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(quotes.createLineItemPreset({ name: 'New product', currency: 'EUR', unit_price_minor: 100,
      product_id: product.id })).rejects.toMatchObject({ statusCode: 403 });
  } finally {
    await db('feature_flags').where({ key: 'albumProducts' }).update({ value: true });
  }
});

test('saving an existing configurable draft preserves its definition after the feature and product are disabled', async () => {
  const f = await fixture();
  await db('quotes').where({ id: f.quoteId }).update({ status: 'draft', sent_at: null });
  const before = await quotes.getQuoteById(f.quoteId);
  const original = await products.catalogue();
  const changed = structuredClone(original);
  changed.products.find((p) => p.id === product.id).active = false;
  await products.saveCatalogue(changed);
  await db('feature_flags').where({ key: 'albumProducts' }).update({ value: false });
  try {
    await quotes.updateQuote(f.quoteId, { lineItems: before.lineItems.map((line) => ({
      ...line, configuration_definition: undefined, configuration_snapshot: undefined,
      configuration_source_line_id: line.id,
    })) }, adminId);
    const after = await quotes.getQuoteById(f.quoteId);
    expect(parsed(after.lineItems.find((line) => line.configuration_definition).configuration_definition)).toEqual(f.definition);
  } finally {
    await db('feature_flags').where({ key: 'albumProducts' }).update({ value: true });
    await products.saveCatalogue({ ...original, revision: (await products.catalogue()).revision });
  }
});

test.each(['product', 'option'])('unchanged product pricing remains editable after its %s is deactivated', async (kind) => {
  const f = await fixture();
  const original = await products.catalogue();
  const changed = structuredClone(original);
  if (kind === 'product') changed.products.find((p) => p.id === product.id).active = false;
  else changed.library.find((g) => g.id === size.groupId).options[0].active = false;
  await products.saveCatalogue(changed);
  try {
    const row = await db('quote_line_item_presets').where({ id: f.preset.id }).first();
    await quotes.updateLineItemPreset(row.id, { description: 'Keep editing existing records', product_id: row.product_id,
      product_surcharges: parsed(row.product_surcharges) });
    expect((await db('quote_line_item_presets').where({ id: row.id }).first()).description).toBe('Keep editing existing records');
  } finally {
    await products.saveCatalogue({ ...original, revision: (await products.catalogue()).revision });
  }
});

test('repeated acceptance of identical product choices creates no extra PDF, mail or selection change', async () => {
  const f = await fixture();
  const pdf = jest.spyOn(require('../../src/services/pdfService'), 'renderQuoteToBuffer');
  const input = { token: f.token, action: 'accept', expectedTotalMinor: 75000, selectedOptional: [2], configurations: f.configurations };
  try {
    await quotes.recordResponse(input);
    const before = await db('quotes').where({ id: f.quoteId }).first();
    const [{ count }] = await db('email_queue').count({ count: '*' });
    const renders = pdf.mock.calls.length;
    await quotes.recordResponse(input);
    const after = await db('quotes').where({ id: f.quoteId }).first();
    expect(after.pdf_path).toBe(before.pdf_path);
    expect(after.selection_changes).toBe(before.selection_changes);
    expect((await db('email_queue').count({ count: '*' }))[0].count).toBe(count);
    expect(pdf).toHaveBeenCalledTimes(renders);
  } finally { pdf.mockRestore(); }
});

test.each([false, true])('an admin can configure a new accepted-quote add-on (package: %s) with the normal history, PDF and customer email', async (parent) => {
  const f = await fixture({ parent });
  await quotes.recordResponse({ token: f.token, action: 'accept', expectedTotalMinor: 50000, selectedOptional: [], configurations: [] });
  const before = (await quotes.getQuoteById(f.quoteId)).quote;
  const pdf = jest.spyOn(require('../../src/services/pdfService'), 'renderQuoteToBuffer');
  const email = jest.spyOn(require('../../src/services/emailProcessor'), 'queueEmail');
  const admin = buildRouteApp('/api/admin/quotes', require('../../src/routes/adminQuotes'));
  const token = require('./helpers/crmDb').mintAdminToken(adminId);
  const change = (configurations) => request(admin).post(`/api/admin/quotes/${f.quoteId}/add-ons`)
    .set('Authorization', `Bearer ${token}`).send({ selectedOptional: [2], configurations });
  try {
    expect((await change([null])).status).toBe(400);
    expect((await change([{ ...f.configurations[0], values: {} }])).status).toBe(400);
    expect((await change([{ ...f.configurations[0], definitionVersion: 'stale' }])).status).toBe(409);
    expect(Number((await quotes.getQuoteById(f.quoteId)).quote.total_amount_minor)).toBe(50000);
    const saved = await change(f.configurations);
    expect(saved.status).toBe(200);
    const data = await quotes.getQuoteById(f.quoteId);
    expect(Number(data.quote.total_amount_minor)).toBe(75000);
    expect(data.quote.selection_accepted_at).toEqual(before.selection_accepted_at);
    expect(parsed(data.quote.selection_changes)).toEqual([expect.objectContaining({
      by: 'admin', adminId, booked: [parent ? 'Print package' : 'Print'], removed: [], totalAfterMinor: 75000,
    })]);
    expect(parsed(data.lineItems.find((line) => line.configuration_definition).configuration_snapshot).pricing.unitPriceMinor).toBe(12500);
    expect(pdf).toHaveBeenCalledTimes(1);
    expect(email.mock.calls.filter((args) => args[2] === 'quote_addons_updated')).toHaveLength(1);
    // An identical retry keeps the accepted version/history/mail unchanged.
    expect((await change(f.configurations)).status).toBe(200);
    expect(pdf).toHaveBeenCalledTimes(1);
    expect(email.mock.calls.filter((args) => args[2] === 'quote_addons_updated')).toHaveLength(1);
    const different = structuredClone(f.configurations);
    different[0].values[size.id] = [size.optionIds[1]];
    const frozen = await change(different);
    expect(frozen.status).toBe(409);
    expect(frozen.body.code).toBe('CONFIGURATION_FROZEN');
  } finally { pdf.mockRestore(); email.mockRestore(); }
});

test('an unbooked studio-locked add-on retains its agreed specification for a later admin booking', async () => {
  const f = await fixture();
  await db('quotes').where({ id: f.quoteId }).update({ status: 'draft', sent_at: null });
  const data = await quotes.getQuoteById(f.quoteId);
  await quotes.updateQuote(f.quoteId, { lineItems: data.lineItems.map((line) => ({ ...line,
    ...(line.configuration_definition ? { configuration_values: f.configurations[0].values, configuration_locked: true } : {}),
  })) }, adminId);
  await quotes.adminAcceptQuote(f.quoteId, adminId);
  const accepted = await quotes.getQuoteById(f.quoteId);
  expect(parsed(accepted.lineItems.find((line) => line.configuration_definition).configuration_snapshot).pricing.unitPriceMinor).toBe(12500);
  const result = await quotes.adminChangeAddOns(f.quoteId, { selectedOptional: [2] }, adminId);
  expect(result).toMatchObject({ changed: true, totalAmountMinor: 75000 });
});

test.each(['customer', 'admin'])('concurrent identical %s amendments create one history entry, PDF and email', async (actor) => {
  const f = await fixture();
  await db('business_profile').where({ id: 1 }).update({ email: 'studio@example.test' });
  const base = { token: f.token, action: 'accept', expectedTotalMinor: 75000, selectedOptional: [2], configurations: f.configurations };
  await quotes.recordResponse(actor === 'customer' ? base : { ...base, expectedTotalMinor: 50000, selectedOptional: [], configurations: [] });
  const configurations = structuredClone(f.configurations);
  configurations[0].values[size.id] = [size.optionIds[1]];
  const pdf = jest.spyOn(require('../../src/services/pdfService'), 'renderQuoteToBuffer');
  const email = jest.spyOn(require('../../src/services/emailProcessor'), 'queueEmail');
  // Both requests finish their reads before either starts its write. This
  // deterministically exercises the race rather than relying on scheduling.
  const transaction = db.client.transaction.bind(db.client);
  let arrivals = 0, release;
  const ready = new Promise((resolve) => { release = resolve; });
  const gate = jest.spyOn(db.client, 'transaction').mockImplementation(async (...args) => {
    if (arrivals < 2) { if (++arrivals === 2) release(); await ready; }
    return transaction(...args);
  });
  const change = () => actor === 'customer' ? quotes.recordResponse({ ...base, configurations })
    : quotes.adminChangeAddOns(f.quoteId, { selectedOptional: [2], configurations }, adminId);
  try {
    await Promise.all([change(), change()]);
    const result = await quotes.getQuoteById(f.quoteId);
    expect(parsed(result.quote.selection_changes)).toHaveLength(1);
    expect(pdf).toHaveBeenCalledTimes(1);
    const template = actor === 'customer' ? 'quote_accepted_admin' : 'quote_addons_updated';
    expect(email.mock.calls.filter((args) => args[2] === template)).toHaveLength(1);
  } finally { gate.mockRestore(); pdf.mockRestore(); email.mockRestore(); }
});

test('configured package amounts persist to quote rows, the accepted PDF and the contract snapshot', async () => {
  const f = await fixture({ parent: true });
  const pdf = jest.spyOn(require('../../src/services/pdfService'), 'renderQuoteToBuffer');
  try {
    await quotes.recordResponse({ token: f.token, action: 'accept', expectedTotalMinor: 75000,
      selectedOptional: [2], configurations: f.configurations });
    const saved = await quotes.getQuoteById(f.quoteId);
    expect(Number(saved.lineItems.find((li) => Number(li.position) === 2).line_total_minor)).toBe(25000);
    const context = pdf.mock.calls.at(-1)[0];
    expect(Number(context.lineItems.find((li) => li.description === 'Print package').lineTotalMinor)).toBe(25000);
    const contracts = require('../../src/services/contractService');
    const { contractId } = await contracts.createFromQuote(f.quoteId, adminId);
    await contracts.sendContract(contractId, adminId);
    const snapshot = parsed((await db('contracts').where({ id: contractId }).first()).rendered_content);
    expect(Number(snapshot.quote.lineItems.find((li) => Number(li.position) === 2).line_total_minor)).toBe(25000);
  } finally { pdf.mockRestore(); }
});

test('public and portal quote projections expose the studio lock as a boolean', async () => {
  const f = await fixture();
  await db('quote_line_items').where({ id: f.line.id }).update({ configuration_locked: true });
  const view = await require('../../src/services/publicDocumentViews').buildQuoteView(f.quoteId);
  expect(view.lineItems.find((li) => Number(li.position) === 2).configurationLocked).toBe(true);
  const response = await request(app).get(`/api/public/quotes/${f.token}`).set('X-Document-Access', f.grant);
  expect(response.status).toBe(200);
  expect(response.body.quote.lineItems.find((li) => Number(li.position) === 2).configurationLocked).toBe(true);
  await require('../../src/utils/appSettings').upsertAppSetting('customer_feature_quotes_enabled', 'true', 'customer');
  const portal = buildRouteApp('/api/customer', require('../../src/routes/customer'));
  const token = require('jsonwebtoken').sign({ type: 'customer', customerId, jti: uuid() }, process.env.JWT_SECRET,
    { issuer: 'picpeak-auth', expiresIn: '1h' });
  const customerView = await request(portal).get(`/api/customer/quotes/${f.quoteId}`).set('Cookie', `customer_token=${token}`);
  expect(customerView.status).toBe(200);
  expect(customerView.body.quote.lineItems.find((li) => Number(li.position) === 2).configurationLocked).toBe(true);
});

test('malformed configuration elements are refused with 400 by the domain and HTTP paths', async () => {
  const f = await fixture();
  for (const entry of [null, [], 'invalid', 7]) {
    expect(() => require('../../src/services/albumProducts/crm').configureLines([f.line], [entry])).toThrow('Invalid configuration');
  }
  const response = await totals(f, [2], [null]);
  expect(response.status).toBe(400);
  expect((await request(app).post(`/api/public/quotes/${f.token}/respond`).set('X-Document-Access', f.grant)
    .send({ action: 'accept', selectedOptional: [2], configurations: [null], expectedTotalMinor: 75000 })).status).toBe(400);
  const portal = buildRouteApp('/api/customer', require('../../src/routes/customer'));
  const token = require('jsonwebtoken').sign({ type: 'customer', customerId, jti: uuid() }, process.env.JWT_SECRET,
    { issuer: 'picpeak-auth', expiresIn: '1h' });
  for (const action of ['totals', 'respond'])
    expect((await request(portal).post(`/api/customer/quotes/${f.quoteId}/${action}`).set('Cookie', `customer_token=${token}`)
      .send({ action: 'accept', selectedOptional: [2], configurations: [null], expectedTotalMinor: 75000 })).status).toBe(400);
});

test('existing quote images remain verified and scoped with the configurator switched off', async () => {
  const f = await fixture();
  await db('feature_flags').where({ key: 'albumProducts' }).update({ value: false });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
  try {
    const endpoint = `/api/public/quotes/${f.token}/product-images/${image.id}`;
    expect((await request(app).get(endpoint)).status).not.toBe(200);
    expect((await request(app).get(endpoint).set('X-Document-Access', f.grant)).status).toBe(200);
    const portal = buildRouteApp('/api/customer', require('../../src/routes/customer'));
    const token = require('jsonwebtoken').sign({ type: 'customer', customerId, jti: uuid() }, process.env.JWT_SECRET,
      { issuer: 'picpeak-auth', expiresIn: '1h' });
    expect((await request(portal).get(`/api/customer/quotes/${f.quoteId}/product-images/${image.id}`)
      .set('Cookie', `customer_token=${token}`)).status).toBe(200);
  } finally {
    await db('feature_flags').where({ key: 'albumProducts' }).update({ value: true });
    require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
  }
});
test('gallery client reads and writes never expose internal billing associations', async () => {
  const f = await billableFixture();
  const adminOffer = (await products.offers(f.event.id))[0];
  expect(adminOffer.cataloguePresetId).toBe(f.preset.id);
  const gallery = buildRouteApp('/api/gallery', require('../../src/routes/gallery/albumProducts'));
  const token = require('jsonwebtoken').sign({ type: 'gallery', eventId: f.event.id, accessLevel: 'client', jti: uuid() },
    process.env.JWT_SECRET, { issuer: 'picpeak-auth', expiresIn: '1h' });
  const endpoint = `/api/gallery/${f.event.slug}/album-products`;
  const response = await request(gallery).get(endpoint).set('Authorization', `Bearer ${token}`);
  expect(response.status).toBe(200);
  expect(response.body.offers[0]).not.toHaveProperty('cataloguePresetId');
  expect(response.body.offers[0]).not.toHaveProperty('customerId');
  const saved = await request(gallery).put(`${endpoint}/${f.offer.id}`).set('Authorization', `Bearer ${token}`)
    .send({ revision: f.offer.revision, mutationId: uuid(), name: 'Synthetic client', submit: true,
      productVersion: response.body.offers[0].product.version, values: f.configurations[0].values });
  expect(saved.status).toBe(200);
  expect(saved.body).not.toHaveProperty('cataloguePresetId');
  expect(saved.body).not.toHaveProperty('customerId');
});

test('an assigned product administrator cannot unlock open financial items with billing switched off', async () => {
  const f = await billableFixture();
  await f.change('lock');
  const [{ id: roleId }] = await db('roles').insert({ name: `assigned-${uuid()}`, display_name: 'Assigned product editor' }).returning('id');
  for (const permission of await db('permissions').whereIn('name', ['products.view', 'products.configure']))
    await db('role_permissions').insert({ role_id: roleId, permission_id: permission.id });
  const [{ id: assignedId }] = await db('admin_users').insert({ username: `assigned-${uuid()}`, email: `${uuid()}@example.test`,
    password_hash: 'x', role_id: roleId, must_change_password: false }).returning('id');
  await db('event_admin_assignments').insert({ event_id: f.event.id, admin_user_id: assignedId });
  require('../../src/middleware/permissions').clearPermissionCache();
  const admin = buildRouteApp('/api/admin/album-products', require('../../src/routes/adminAlbumProducts'));
  const { mintAdminToken } = require('./helpers/crmDb');
  const endpoint = `/api/admin/album-products/events/${f.event.id}`;
  const token = mintAdminToken(assignedId);
  expect((await request(admin).get(endpoint).set('Authorization', `Bearer ${token}`)).status).toBe(200);
  await db('feature_flags').where({ key: 'bills' }).update({ value: false });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
  try {
    const response = await request(admin).put(`${endpoint}/offers/${f.offer.id}`).set('Authorization', `Bearer ${token}`)
      .send({ revision: f.offer.revision, mutationId: uuid(), action: 'unlock' });
    expect(response.status).toBe(403);
    expect(await db('product_billable_items').where({ offer_id: f.offer.id })).toHaveLength(1);
    const owner = await request(admin).put(`${endpoint}/offers/${f.offer.id}`).set('Authorization', `Bearer ${mintAdminToken(adminId)}`)
      .send({ revision: f.offer.revision, mutationId: uuid(), action: 'unlock' });
    expect(owner.status).toBe(200);
    expect(await db('product_billable_items').where({ offer_id: f.offer.id })).toHaveLength(0);
  } finally {
    await db('feature_flags').where({ key: 'bills' }).update({ value: true });
    require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
  }
});

test('appending products recalculates percentage discounts, sub-cent rounding, VAT and shipping', async () => {
  const f = await billableFixture({ project: true });
  const settings = require('../../src/utils/appSettings');
  await settings.upsertAppSetting('crm_invoice_round_total', 'true', 'crm');
  try {
    const { invoiceIds: [invoiceId] } = await require('../../src/services/invoiceService').createInvoice({
      customerAccountId: customerId, projectId: f.event.project_id, eventId: f.event.id, currency: 'EUR',
      vatCode: f.vat.code, vatRate: Number(f.vat.rate), shippingAmountMinor: 99,
      lineItems: [1, 2].map((position) => ({ position, quantity: 1.4, description: 'Fractional item', unit_price_minor: 1 }))
        .concat([{ position: 3, quantity: 1, description: 'Ten percent discount', unit_price_minor: 0, line_kind: 'discount',
          promotion_snapshot: { id: uuid(), name: 'Promotion', type: 'percent', percent: 10 } }]),
    }, adminId);
    await f.change('lock');
    const invoice = await db('invoices').where({ id: invoiceId }).first();
    const discount = await db('invoice_line_items').where({ invoice_id: invoiceId, line_kind: 'discount' }).first();
    expect(Number(discount.line_total_minor)).toBe(-1250);
    expect(Number(invoice.net_amount_minor)).toBe(11253);
    expect(Number(invoice.total_amount_minor)).toBe(11253 + Math.round(11253 * Number(f.vat.rate) / 100) + 99);
  } finally { await settings.upsertAppSetting('crm_invoice_round_total', 'false', 'crm'); }
});

test.each(['append', 'new invoice'])('a refused billable-item stamp rolls back %s, lines and audit writes', async (mode) => {
  const f = await billableFixture({ project: mode === 'append' });
  const invoices = require('../../src/services/invoiceService');
  let invoiceId;
  if (mode === 'append') ({ invoiceIds: [invoiceId] } = await invoices.createInvoice({ customerAccountId: customerId,
    projectId: f.event.project_id, eventId: f.event.id, currency: 'EUR', vatCode: f.vat.code, vatRate: Number(f.vat.rate),
    lineItems: [{ position: 1, quantity: 1, description: 'Existing line', unit_price_minor: 100 }] }, adminId));
  else await f.change('lock');
  const before = (await db('invoices').count({ n: '*' }))[0].n;
  const pg = db.client.config.client === 'pg';
  if (pg) {
    await db.raw('CREATE FUNCTION review_refuse_product_stamp() RETURNS trigger AS $$ BEGIN RETURN NULL; END; $$ LANGUAGE plpgsql');
    await db.raw('CREATE TRIGGER review_refuse_product_stamp BEFORE UPDATE OF invoice_id ON product_billable_items FOR EACH ROW EXECUTE FUNCTION review_refuse_product_stamp()');
  } else await db.raw('CREATE TRIGGER review_refuse_product_stamp BEFORE UPDATE OF invoice_id ON product_billable_items BEGIN SELECT RAISE(IGNORE); END');
  try {
    const action = mode === 'append' ? f.change('lock') : require('../../src/services/albumProducts/billing').billEvent(db, f.event.id, adminId);
    await expect(action).rejects.toMatchObject({ statusCode: 409, code: 'PRODUCT_ITEM_CHANGED' });
    expect((await db('invoices').count({ n: '*' }))[0].n).toBe(before);
    if (invoiceId) expect(await db('invoice_line_items').where({ invoice_id: invoiceId })).toHaveLength(1);
    else expect((await db('product_billable_items').where({ offer_id: f.offer.id }).first()).invoice_id).toBeNull();
  } finally {
    await db.raw(`DROP TRIGGER review_refuse_product_stamp${pg ? ' ON product_billable_items' : ''}`);
    if (pg) await db.raw('DROP FUNCTION review_refuse_product_stamp()');
  }
});

test('generic sizes, required and multi-select attributes and dependencies are validated', () => {
  const resolved = G.resolve(product, catalog);
  const values = {
    [size.id]: [size.optionIds[0]],
    [mat.id]: [mat.optionIds[0]],
  };
  expect(() =>
    V.selection(resolved, { productVersion: resolved.version, values }),
  ).toThrow(/depends/);
  expect(() =>
    V.selection(resolved, { productVersion: resolved.version, values: {} }),
  ).toThrow(/Choose Size/);
  expect(() =>
    V.selection(resolved, {
      productVersion: resolved.version,
      values: { [size.id]: size.optionIds },
    }),
  ).toThrow();
  const multi = {
    ...resolved,
    attributes: resolved.attributes.map((a) =>
      a.id === size.id ? { ...a, multiple: true } : a,
    ),
  };
  const snapshot = V.selection(multi, {
    productVersion: multi.version,
    values: { [size.id]: size.optionIds },
  });
  expect(snapshot.attributes[0].options).toHaveLength(2);
  expect(snapshot.attributes[0].options[0]).toMatchObject({
    width: 90,
    height: 60,
    unit: 'cm',
  });
  const bad = structuredClone(catalog.types);
  bad[0].attributes[1].dependsOn = [
    { attributeId: mat.id, optionIds: mat.optionIds },
  ];
  expect(() => G.cleanTypes(bad, catalog.library)).toThrow(/cycles/);
  expect(() =>
    G.cleanLibrary([
      {
        ...catalog.library[0],
        options: [{ ...catalog.library[0].options[0], width: -1 }],
      },
    ]),
  ).toThrow();
});
test('quote totals are authoritative, include quantity and optional surcharges, and reject missing/forged choices', async () => {
  const f = await fixture();
  expect(
    (
      await request(app)
        .post(`/api/public/quotes/${f.token}/totals`)
        .send({ selectedOptional: [2] })
    ).status,
  ).toBe(401);
  const preview = await totals(f);
  expect(preview.status).toBe(200);
  expect(
    Number(
      preview.body.totalAmountMinor ?? preview.body.data?.totalAmountMinor,
    ),
  ).toBe(75000);
  expect((await accept(f, 1)).status).toBe(409);
  expect((await totals(f, [2], [])).status).toBe(400);
  const forged = structuredClone(f.configurations);
  forged[0].values[size.id] = [uuid()];
  expect((await totals(f, [2], forged)).status).toBe(400);
  const stale = structuredClone(f.configurations);
  stale[0].definitionVersion = '0'.repeat(64);
  expect((await totals(f, [2], stale)).status).toBe(409);
  expect((await db('quotes').where({ id: f.quoteId }).first()).status).toBe(
    'sent',
  );
  expect((await accept(f, 75000)).status).toBe(200);
  const [line] = (await quotes.getQuoteById(f.quoteId)).lineItems.filter(
    (li) => li.configuration_definition,
  );
  expect(parsed(line.configuration_snapshot)).toMatchObject({
    schemaVersion: 2,
    pricing: {
      baseUnitPriceMinor: 10000,
      surchargeMinor: 2500,
      unitPriceMinor: 12500,
    },
  });
  expect(line.details_text).toContain('Frame: Oak');
});
test('a product can be booked inside a package and unbooked products need no choice', async () => {
  const f = await fixture({ parent: true });
  expect((await totals(f)).status).toBe(200);
  expect((await accept(f, 75000)).status).toBe(200);
  const empty = await fixture();
  expect((await accept(empty, 50000, [], [])).status).toBe(200);
  expect(
    (await quotes.getQuoteById(empty.quoteId)).lineItems.find(
      (li) => li.configuration_definition,
    ).configuration_snapshot,
  ).toBeNull();
});
test('included products also require configuration and cannot be accepted incomplete by an admin', async () => {
  const f = await fixture({ optional: false });
  await expect(quotes.adminAcceptQuote(f.quoteId, adminId)).rejects.toThrow(
    /Choose/,
  );
  expect((await db('quotes').where({ id: f.quoteId }).first()).status).toBe(
    'sent',
  );
  expect((await accept(f, 75000, [])).status).toBe(200);
});
test('offered and accepted definitions survive live library/pricing changes; contracts and invoices keep the exact specification', async () => {
  const f = await fixture();
  const original = await products.catalogue(),
    changed = structuredClone(original);
  changed.library[0].options[0].name = 'Renamed after offer';
  await products.saveCatalogue(changed);
  await quotes.updateLineItemPreset(f.preset.id, { unit_price_minor: 99000 });
  expect((await accept(f, 75000)).status).toBe(200);
  const line = (await quotes.getQuoteById(f.quoteId)).lineItems.find(
      (li) => li.configuration_definition,
    ),
    snapshot = parsed(line.configuration_snapshot);
  expect(snapshot.attributes[0].options[0].name).toBe('90 × 60 cm');
  const contractService = require('../../src/services/contractService');
  const { contractId } = await contractService.createFromQuote(
    f.quoteId,
    adminId,
  );
  await contractService.sendContract(contractId, adminId);
  const contract = await db('contracts').where({ id: contractId }).first();
  const frozen = parsed(contract.rendered_content).quote.lineItems.find(
    (li) => li.configuration_snapshot,
  );
  expect(parsed(frozen.configuration_snapshot)).toEqual(snapshot);
  const {
    invoiceIds: [invoiceId],
  } = await require('../../src/services/invoiceService').createInvoice(
    {
      customerAccountId: customerId,
      currency: 'EUR',
      vatRate: 0,
      lineItems: [line],
    },
    adminId,
  );
  expect(
    parsed(
      (await db('invoice_line_items').where({ invoice_id: invoiceId }).first())
        .configuration_snapshot,
    ),
  ).toEqual(snapshot);
  expect((await accept(f, 75000)).status).toBe(409);
  await products.saveCatalogue({
    ...original,
    revision: (await products.catalogue()).revision,
  });
}, 120000);
test('quote images require verification and belong to this quote, including historical offered images', async () => {
  const f = await fixture();
  expect(
    (
      await request(app).get(
        `/api/public/quotes/${f.token}/product-images/${image.id}`,
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await request(app)
        .get(`/api/public/quotes/${f.token}/product-images/${image.id}`)
        .set('X-Document-Access', f.grant)
    ).status,
  ).toBe(200);
  expect(
    (
      await request(app)
        .get(`/api/public/quotes/${f.token}/product-images/${uuid()}`)
        .set('X-Document-Access', f.grant)
    ).status,
  ).toBe(404);
  const other = await quotes.createQuote(
    {
      customerAccountId: customerId,
      currency: 'EUR',
      lineItems: [
        {
          position: 1,
          description: 'No product',
          quantity: 1,
          unit_price_minor: 100,
        },
      ],
    },
    adminId,
  );
  await expect(
    require('../../src/services/albumProducts/crm').quoteImage(
      db,
      other,
      image.id,
    ),
  ).rejects.toMatchObject({ statusCode: 404 });
});
test('templates and CRM packages reuse the same configurable preset, without copying the library', async () => {
  const f = await fixture();
  const packages = require('../../src/services/quoteCatalogService');
  const pkg = await packages.savePackage(null, {
    name: 'Print package',
    currency: 'EUR',
    items: [{ preset_id: f.preset.id, quantity: 1 }],
  });
  const templates = require('../../src/services/quoteTemplateService');
  const template = await templates.createTemplate(
    {
      name: 'Product template',
      currency: 'EUR',
      draft: {
        sections: [{ type: 'package', packageId: pkg.id, isOptional: true }],
      },
    },
    adminId,
  );
  const templateId = template;
  await templates.publishTemplate(templateId, adminId);
  await quotes.updateLineItemPreset(f.preset.id, { unit_price_minor: 17000,
    product_surcharges: [{ attributeId: frame.id, optionId: frame.optionIds[0], amountMinor: 5000 }] });
  const created = await templates.createQuoteFromTemplate(
    templateId,
    { customerAccountId: customerId },
    adminId,
  );
  const quote = await quotes.getQuoteById(created.quoteId);
  expect(
    quote.lineItems.filter((li) => li.configuration_definition),
  ).toHaveLength(1);
  expect(
    parsed(
      quote.lineItems.find((li) => li.configuration_definition)
        .configuration_definition,
    ).product.id,
  ).toBe(product.id);
  const definition = parsed(quote.lineItems.find((li) => li.configuration_definition).configuration_definition);
  expect(definition.baseUnitPriceMinor).toBe(10000);
  expect(definition.surcharges.find((row) => row.attributeId === frame.id).amountMinor).toBe(2000);
  await templates.publishTemplate(templateId, adminId);
  const updated = await templates.createQuoteFromTemplate(templateId, { customerAccountId: customerId }, adminId);
  const next = await quotes.getQuoteById(updated.quoteId);
  const refreshed = parsed(next.lineItems.find((li) => li.configuration_definition).configuration_definition);
  expect(refreshed.baseUnitPriceMinor).toBe(17000);
  expect(refreshed.surcharges[0].amountMinor).toBe(5000);
});

test('the gallery stores the same generic choice and only chosen-option changes require review', async () => {
  const event = {
    slug: `shared-${uuid()}`,
    event_name: 'Shared gallery',
    event_type: 'wedding',
    event_date: '2026-10-22',
    host_email: 'client@example.com',
    admin_email: 'studio@example.com',
    password_hash: 'x',
    share_link: '/gallery/shared',
    share_token: uuid(),
  };
  const inserted = await db('events').insert(event).returning('id');
  event.id = inserted[0].id ?? inserted[0];
  const offer = await products.assign(event.id, product.id),
    resolved = (await products.clientOffers(event.id))[0].product;
  const values = {
    [size.id]: [size.optionIds[0]],
    [frame.id]: [frame.optionIds[0]],
  };
  const saved = await products.mutate(
    event,
    {
      id: offer.id,
      revision: 1,
      mutationId: uuid(),
      productVersion: resolved.version,
      values,
      submit: true,
    },
    { type: 'client', id: 'f'.repeat(64), name: 'Synthetic Client' },
  );
  expect(saved.selection).toEqual(
    V.selection(resolved, { productVersion: resolved.version, values }),
  );
  const catalog = await products.catalogue();
  await products.saveCatalogue({
    ...catalog,
    products: catalog.products.map((p) => ({
      ...p,
      description: 'Edited description',
    })),
  });
  expect((await products.clientOffers(event.id))[0].needsReview).toBe(false);
  expect(
    (
      await products.mutate(
        event,
        { id: offer.id, revision: 2, mutationId: uuid(), action: 'lock' },
        { type: 'admin', id: adminId },
        { admin: true },
      )
    ).status,
  ).toBe('locked');
});

test('admin prefill can be partial; locked specifications are complete and cannot be changed by a client', async () => {
  const f = await fixture({ optional: false });
  const CRM = require('../../src/services/albumProducts/crm');
  const partial = await CRM.prepareLine(
    db,
    {
      position: 1,
      quantity: 1,
      description: 'Prefill',
      catalogue_preset_id: f.preset.id,
      configuration_values: { [frame.id]: [frame.optionIds[0]] },
    },
    { currency: 'EUR' },
  );
  expect(parsed(partial.configuration_snapshot).attributes).toHaveLength(1);
  await expect(
    CRM.prepareLine(db, { ...partial, configuration_locked: true }),
  ).rejects.toThrow(/Choose Size/);
  const values = f.configurations[0].values;
  const id = await quotes.createQuote(
    {
      customerAccountId: customerId,
      currency: 'EUR',
      vatRate: 8.1,
      lineItems: [
        {
          position: 1,
          quantity: 1,
          description: 'Agreed print',
          catalogue_preset_id: f.preset.id,
          configuration_values: values,
          configuration_locked: true,
        },
      ],
    },
    adminId,
  );
  const quote = await quotes.getQuoteById(id),
    line = quote.lineItems[0];
  expect(
    line.configuration_locked === true || line.configuration_locked === 1,
  ).toBe(true);
  expect(Number(quote.quote.total_amount_minor)).toBe(13513);
  const definition = parsed(line.configuration_definition);
  const forged = { ...values, [size.id]: [size.optionIds[1]] };
  expect(() =>
    CRM.configureLines(
      [line],
      [{ position: 1, definitionVersion: definition.version, values: forged }],
    ),
  ).toThrow(/locked/);
  expect(CRM.configureLines([line], [])[0].unit_price_minor).toBe(12500);
  const editedNotes = await CRM.prepareLine(
    db,
    {
      position: 1,
      configuration_source_line_id: line.id,
      details_text: 'Keep this photographer note',
    },
    { quoteId: id, currency: 'EUR' },
  );
  expect(editedNotes.configuration_base_details).toBe(
    'Keep this photographer note',
  );
  expect(editedNotes.details_text.match(/Size:/g)).toHaveLength(1);
  expect(editedNotes.configuration_locked).toBe(true);
  await db('quotes')
    .where({ id })
    .update({ status: 'sent', sent_at: new Date() });
  const token = await createPublicToken(db, 'quote_action_tokens', {
    quote_id: id,
  });
  const tokenRow = await db('quote_action_tokens').where({ token }).first();
  const grant =
    await require('../../src/services/publicDocumentVerificationService').issueGrant(
      'quote',
      tokenRow,
      token,
    );
  const configured = {
    token,
    grant,
    configurations: [
      { position: 1, definitionVersion: definition.version, values },
    ],
  };
  expect(
    (
      await totals(
        configured,
        [],
        [{ ...configured.configurations[0], values: forged }],
      )
    ).status,
  ).toBe(409);
  expect((await accept(configured, 13513, [])).status).toBe(200);
  const wire = require('../../src/utils/lineItemTotals').lineItemFieldsFromApi({
    id: line.id,
    configurationLocked: true,
    configurationValues: values,
    configurationDefinition: { forged: true },
    configurationSnapshot: { forged: true },
  });
  expect(wire.configuration_definition).toBeUndefined();
  expect(wire.configuration_snapshot).toBeUndefined();
  expect(wire.configuration_locked).toBe(true);
});

test('accepted specification images are retained even with SQLite foreign keys disabled', async () => {
  const f = await fixture();
  expect((await accept(f, 75000)).status).toBe(200);
  expect(
    await db('product_configuration_image_references').where({
      image_id: image.id,
      source_kind: 'quote',
      source_id: String(f.quoteId),
    }),
  ).not.toHaveLength(0);
  if (db.client.config.client !== 'pg')
    await db.raw('PRAGMA foreign_keys = OFF');
  await expect(
    db('album_product_images').where({ id: image.id }).del(),
  ).rejects.toThrow(/frozen product specification/);
  expect(
    await db('album_product_images').where({ id: image.id }).first(),
  ).toBeTruthy();
});

async function billableFixture({ project = false } = {}) {
  const f = await fixture({ optional: false });
  const vat = await db('vat_codes')
    .where({ direction: 'output', active: true })
    .where('rate', '>', 0)
    .first();
  await quotes.updateLineItemPreset(f.preset.id, { vat_code: vat.code });
  await db('feature_flags')
    .insert({ key: 'bills', value: true })
    .onConflict('key')
    .merge({ value: true });
  const event = {
    slug: `bill-${uuid()}`,
    event_name: 'Synthetic billable gallery',
    event_type: 'wedding',
    event_date: '2026-10-22',
    host_email: 'client@example.com',
    admin_email: 'studio@example.com',
    password_hash: 'x',
    share_link: `/gallery/bill-${uuid()}`,
    share_token: uuid(),
    created_by: adminId,
  };
  if (project) {
    const ids = await db('projects')
      .insert({
        name: 'Synthetic project',
        customer_account_id: customerId,
        created_by: adminId,
      })
      .returning('id');
    event.project_id = ids[0]?.id ?? ids[0];
  }
  const ids = await db('events').insert(event).returning('id');
  event.id = ids[0]?.id ?? ids[0];
  await db('event_customer_assignments').insert({
    event_id: event.id,
    customer_account_id: customerId,
  });
  let offer = await products.assign(event.id, product.id);
  offer = await products.mutate(
    event,
    {
      id: offer.id,
      revision: offer.revision,
      mutationId: uuid(),
      cataloguePresetId: f.preset.id,
      showPrices: false,
    },
    { type: 'admin', id: adminId },
    { admin: true },
  );
  const resolved = (await products.clientOffers(event.id))[0].product;
  offer = await products.mutate(
    event,
    {
      id: offer.id,
      revision: offer.revision,
      mutationId: uuid(),
      productVersion: resolved.version,
      values: f.configurations[0].values,
      submit: true,
    },
    { type: 'client', id: 'a'.repeat(64), name: 'Synthetic Client' },
  );
  const change = (action) =>
    products
      .mutate(
        event,
        { id: offer.id, revision: offer.revision, mutationId: uuid(), action },
        { type: 'admin', id: adminId },
        { admin: true },
      )
      .then((next) => (offer = next));
  return {
    ...f,
    event,
    vat,
    get offer() {
      return offer;
    },
    change,
  };
}
test('gallery lock freezes current CRM pricing once, price display defaults off, and unlock removes only unbilled items', async () => {
  const f = await billableFixture();
  expect((await products.clientOffers(f.event.id))[0].pricing).toBeNull();
  let offer = await products.mutate(
    f.event,
    {
      id: f.offer.id,
      revision: f.offer.revision,
      mutationId: uuid(),
      showPrices: true,
    },
    { type: 'admin', id: adminId },
    { admin: true },
  );
  expect(
    (await products.clientOffers(f.event.id))[0].pricing.baseUnitPriceMinor,
  ).toBe(10000);
  await quotes.updateLineItemPreset(f.preset.id, { unit_price_minor: 20000 });
  const mutationId = uuid(),
    input = {
      id: offer.id,
      revision: offer.revision,
      mutationId,
      action: 'lock',
    };
  offer = await products.mutate(
    f.event,
    input,
    { type: 'admin', id: adminId },
    { admin: true },
  );
  await products.mutate(
    f.event,
    input,
    { type: 'admin', id: adminId },
    { admin: true },
  );
  const items = await db('product_billable_items').where({
    offer_id: offer.id,
  });
  expect(items).toHaveLength(1);
  expect(parsed(items[0].line_item).unit_price_minor).toBe(22500);
  await products.mutate(
    f.event,
    {
      id: offer.id,
      revision: offer.revision,
      mutationId: uuid(),
      action: 'unlock',
    },
    { type: 'admin', id: adminId },
    { admin: true },
  );
  expect(
    await db('product_billable_items').where({ offer_id: offer.id }),
  ).toHaveLength(0);
});
test('open gallery products create a product-only invoice; issued invoices stay unchanged and Storno is required for a change', async () => {
  const f = await billableFixture({ project: true });
  const invoices = require('../../src/services/invoiceService');
  const {
    invoiceIds: [original],
  } = await invoices.createInvoice(
    {
      customerAccountId: customerId,
      projectId: f.event.project_id,
      eventId: f.event.id,
      currency: 'EUR',
      vatCode: f.vat.code,
      vatRate: Number(f.vat.rate),
      lineItems: [
        {
          position: 1,
          description: 'Photography already billed',
          quantity: 1,
          unit_price_minor: 50000,
        },
      ],
    },
    adminId,
  );
  await db('invoices')
    .where({ id: original })
    .update({ status: 'sent', sent_at: new Date() });
  const before = await db('invoices').where({ id: original }).first();
  await f.change('lock');
  const result =
    await require('../../src/services/albumProducts/billing').billEvent(
      db,
      f.event.id,
      adminId,
    );
  expect(result.invoiceId).not.toBe(original);
  expect(result.itemsBilled).toBe(1);
  const lines = await db('invoice_line_items').where({
    invoice_id: result.invoiceId,
  });
  expect(lines).toHaveLength(1);
  expect(parsed(lines[0].configuration_snapshot).pricing.unitPriceMinor).toBe(
    12500,
  );
  expect(await db('invoices').where({ id: original }).first()).toEqual(before);
  await expect(f.change('unlock')).rejects.toMatchObject({
    code: 'PRODUCT_ALREADY_BILLED',
  });
  await expect(
    require('../../src/services/albumProducts/billing').billEvent(
      db,
      f.event.id,
      adminId,
    ),
  ).rejects.toMatchObject({ code: 'NO_OPEN_ITEMS' });
  await invoices.cancelInvoice(result.invoiceId, adminId);
  expect((await f.change('unlock')).status).toBe('submitted');
  await f.change('lock');
  expect(
    await db('product_billable_items')
      .where({ offer_id: f.offer.id })
      .whereNull('invoice_id'),
  ).toHaveLength(1);
});
test('locking appends a distinct frozen line to one unissued project invoice using the same VAT code', async () => {
  const f = await billableFixture({ project: true });
  const {
    invoiceIds: [invoiceId],
  } = await require('../../src/services/invoiceService').createInvoice(
    {
      customerAccountId: customerId,
      projectId: f.event.project_id,
      eventId: f.event.id,
      currency: 'EUR',
      vatCode: f.vat.code,
      vatRate: Number(f.vat.rate),
      lineItems: [
        {
          position: 1,
          description: 'Photography',
          quantity: 1,
          unit_price_minor: 50000,
        },
      ],
    },
    adminId,
  );
  await f.change('lock');
  const lines = await db('invoice_line_items')
    .where({ invoice_id: invoiceId })
    .orderBy('position');
  expect(lines).toHaveLength(2);
  expect(lines[1].configuration_snapshot).toBeTruthy();
  const invoice = await db('invoices').where({ id: invoiceId }).first();
  expect(Number(invoice.net_amount_minor)).toBe(62500);
  expect(Number(invoice.vat_amount_minor)).toBe(
    Math.round((62500 * Number(f.vat.rate)) / 100),
  );
  expect(
    (await db('product_billable_items').where({ offer_id: f.offer.id }).first())
      .invoice_line_item_id,
  ).toBe(lines[1].id);
  await expect(f.change('unlock')).rejects.toMatchObject({
    code: 'PRODUCT_ALREADY_BILLED',
  });
});

test('customer billing retains open items after gallery deletion and enforces creator scope and selected-item atomicity', async () => {
  const f = await billableFixture();
  await f.change('lock');
  const item = await db('product_billable_items')
    .where({ offer_id: f.offer.id })
    .first();
  await require('../../src/routes/adminEvents/helpers').deleteEventCascade(
    f.event.id,
    { id: adminId, username: 'Synthetic photographer' },
  );
  expect(
    (await db('product_billable_items').where({ id: item.id }).first())
      .event_id,
  ).toBeNull();
  const billing = require('../../src/services/albumProducts/billing');
  const { withCrmActor } = require('../../src/database/crmAccess');
  await withCrmActor(
    {
      id: adminId + 1000,
      roleName: 'admin',
      permissions: new Set(['bills.manage', 'bills.view']),
    },
    async () => {
      expect(
        await billing
          .scoped(db('product_billable_items'))
          .where({ id: item.id }),
      ).toHaveLength(0);
      await expect(
        billing.billEvent(db, null, adminId + 1000, null, customerId, [
          item.id,
        ]),
      ).rejects.toThrow(/unavailable/);
    },
  );
  await expect(
    billing.billEvent(db, null, adminId, null, customerId, [
      item.id,
      item.id + 999,
    ]),
  ).rejects.toThrow(/unavailable/);
  expect(
    (await db('product_billable_items').where({ id: item.id }).first())
      .invoice_id,
  ).toBeNull();
  const result = await billing.billEvent(db, null, adminId, null, customerId, [
    item.id,
  ]);
  expect(result.itemsBilled).toBe(1);
  expect(
    await db('accounting_change_history')
      .where({
        entity_type: 'product_item',
        entity_id: item.id,
        source: 'product.bill',
      })
      .first(),
  ).toBeTruthy();
});

test('CRM billing HTTP routes require billing authority, gallery ownership and feature flags', async () => {
  const f = await billableFixture();
  const { mintAdminToken } = require('./helpers/crmDb');
  const adminApp = buildRouteApp(
    '/api/admin/album-products',
    require('../../src/routes/adminAlbumProducts'),
  );
  const endpoint = `/api/admin/album-products/events/${f.event.id}/billing`;
  const token = mintAdminToken(adminId);
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
  expect((await request(adminApp).get(endpoint)).status).toBe(401);
  expect(
    (
      await request(adminApp)
        .get(endpoint)
        .set('Authorization', `Bearer ${token}`)
    ).status,
  ).toBe(200);
  await db('feature_flags').where({ key: 'bills' }).update({ value: false });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
  expect(
    (
      await request(adminApp)
        .post(endpoint)
        .set('Authorization', `Bearer ${token}`)
        .send({})
    ).status,
  ).toBe(403);
  await db('feature_flags').where({ key: 'bills' }).update({ value: true });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
  const role = await db('roles')
    .insert({ name: `products-only-${uuid()}`, display_name: 'Products only' })
    .returning('id');
  const roleId = role[0]?.id ?? role[0];
  for (const p of await db('permissions').whereIn('name', [
    'products.view',
    'products.configure',
  ]))
    await db('role_permissions').insert({
      role_id: roleId,
      permission_id: p.id,
    });
  const other = await db('admin_users')
    .insert({
      username: `other-${uuid()}`,
      email: `${uuid()}@example.com`,
      password_hash: 'x',
      role_id: roleId,
      must_change_password: false,
    })
    .returning('id');
  const otherId = other[0]?.id ?? other[0];
  require('../../src/middleware/permissions').clearPermissionCache();
  const otherToken = mintAdminToken(otherId);
  expect(
    (
      await request(adminApp)
        .get(endpoint)
        .set('Authorization', `Bearer ${otherToken}`)
    ).status,
  ).toBe(403);
  const chosen = f.offer;
  expect(
    (
      await request(adminApp)
        .put(
          `/api/admin/album-products/events/${f.event.id}/offers/${chosen.id}`,
        )
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ revision: chosen.revision, mutationId: uuid(), action: 'lock' })
    ).status,
  ).toBe(403);
});

test('portal totals and product images retain customer ownership and quote feature gates', async () => {
  const f = await fixture();
  await db('app_settings')
    .where({ setting_key: 'customer_feature_quotes_enabled' })
    .update({ setting_value: JSON.stringify(true) });
  const portal = buildRouteApp(
    '/api/customer',
    require('../../src/routes/customer'),
  );
  const token = require('jsonwebtoken').sign(
    { type: 'customer', customerId, jti: uuid() },
    process.env.JWT_SECRET,
    { issuer: 'picpeak-auth', expiresIn: '1h' },
  );
  const endpoint = `/api/customer/quotes/${f.quoteId}`;
  expect(
    (
      await request(portal)
        .post(`${endpoint}/totals`)
        .send({ selectedOptional: [2], configurations: f.configurations })
    ).status,
  ).toBe(401);
  const ok = await request(portal)
    .post(`${endpoint}/totals`)
    .set('Cookie', `customer_token=${token}`)
    .send({ selectedOptional: [2], configurations: f.configurations });
  expect(ok.status).toBe(200);
  expect(Number(ok.body.totalAmountMinor)).toBe(75000);
  expect(
    (
      await request(portal)
        .get(`${endpoint}/product-images/${image.id}`)
        .set('Cookie', `customer_token=${token}`)
    ).status,
  ).toBe(200);
  const foreign = await db('customer_accounts')
    .insert({
      email: `${uuid()}@example.com`,
      display_name: 'Another synthetic customer',
      password_hash: 'x',
      is_active: true,
      feature_quotes: true,
    })
    .returning('id');
  const otherId = foreign[0]?.id ?? foreign[0];
  const wrong = require('jsonwebtoken').sign(
    { type: 'customer', customerId: otherId, jti: uuid() },
    process.env.JWT_SECRET,
    { issuer: 'picpeak-auth', expiresIn: '1h' },
  );
  expect(
    (
      await request(portal)
        .get(`${endpoint}/product-images/${image.id}`)
        .set('Cookie', `customer_token=${wrong}`)
    ).status,
  ).toBe(404);
  expect(
    (
      await request(portal)
        .post(`${endpoint}/totals`)
        .set('Cookie', `customer_token=${wrong}`)
        .send({ selectedOptional: [2], configurations: f.configurations })
    ).status,
  ).toBe(404);
});

test('invoice correction and reissue retain the exact product specification and prevent editing a billed line in place', async () => {
  const f = await billableFixture();
  await f.change('lock');
  const invoices = require('../../src/services/invoiceService');
  const billed =
    await require('../../src/services/albumProducts/billing').billEvent(
      db,
      f.event.id,
      adminId,
    );
  const before = await db('invoice_line_items')
    .where({ invoice_id: billed.invoiceId })
    .first();
  const invoiceApp = buildRouteApp(
    '/api/admin/invoices',
    require('../../src/routes/adminInvoices'),
  );
  const token = require('./helpers/crmDb').mintAdminToken(adminId);
  const refusal = await request(invoiceApp)
    .put(`/api/admin/invoices/${billed.invoiceId}`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      customerAccountId: customerId,
      lineItems: [
        {
          position: 1,
          description: 'Changed product',
          quantity: 1,
          unitPriceMinor: 1,
        },
      ],
    });
  expect(refusal.status).toBe(409);
  expect(refusal.body.code).toBe('PRODUCT_SPECIFICATION_FROZEN');
  await db('invoices')
    .where({ id: billed.invoiceId })
    .update({ status: 'sent', sent_at: new Date() });
  const reissued = await invoices.reissueInvoice(billed.invoiceId, adminId);
  const original = await db('invoices').where({ id: billed.invoiceId }).first();
  const credit = await db('invoice_line_items')
    .where({ invoice_id: original.cancellation_storno_id })
    .first();
  expect(credit.configuration_snapshot).toBe(before.configuration_snapshot);
  const replacementId =
    reissued.invoiceIds?.[0] ?? reissued.invoiceId ?? reissued.id;
  expect(replacementId).toBeTruthy();
  const replacement = await db('invoice_line_items')
    .where({ invoice_id: replacementId })
    .first();
  expect(replacement.configuration_snapshot).toBe(
    before.configuration_snapshot,
  );
  await expect(f.change('unlock')).rejects.toMatchObject({
    code: 'PRODUCT_ALREADY_BILLED',
  });
});

test('a product appended during PDF rendering prevents a stale invoice from being issued', async () => {
  const f = await billableFixture({ project: true });
  const invoices = require('../../src/services/invoiceService');
  const {
    invoiceIds: [invoiceId],
  } = await invoices.createInvoice(
    {
      customerAccountId: customerId,
      eventId: f.event.id,
      projectId: f.event.project_id,
      currency: 'EUR',
      vatCode: f.vat.code,
      vatRate: Number(f.vat.rate),
      lineItems: [
        {
          position: 1,
          description: 'Photography',
          quantity: 1,
          unit_price_minor: 50000,
        },
      ],
    },
    adminId,
  );
  const renderer = require('../../src/services/pdfService');
  const render = renderer.renderInvoiceToBuffer;
  const spy = jest
    .spyOn(renderer, 'renderInvoiceToBuffer')
    .mockImplementationOnce(async (context) => {
      await f.change('lock');
      return render(context);
    });
  try {
    await expect(
      invoices.sendInvoice(invoiceId, adminId),
    ).rejects.toMatchObject({ code: 'INVOICE_CHANGED_DURING_SEND' });
  } finally {
    spy.mockRestore();
  }
  expect((await db('invoices').where({ id: invoiceId }).first()).status).toBe(
    'scheduled',
  );
  expect(
    await db('invoice_line_items').where({ invoice_id: invoiceId }),
  ).toHaveLength(2);
  expect((await invoices.sendInvoice(invoiceId, adminId)).sent).toBe(true);
});

test('the native gallery HTTP endpoint accepts partial generic drafts and requires complete submitted choices', async () => {
  const f = await billableFixture();
  const event = {
    ...f.event,
    slug: `http-${uuid()}`,
    share_link: `/gallery/http-${uuid()}`,
    share_token: uuid(),
  };
  delete event.id;
  const ids = await db('events').insert(event).returning('id');
  event.id = ids[0]?.id ?? ids[0];
  const offer = await products.assign(event.id, product.id);
  const galleryApp = buildRouteApp(
    '/api/gallery',
    require('../../src/routes/gallery/albumProducts'),
  );
  const token = require('jsonwebtoken').sign(
    { type: 'gallery', eventId: event.id, accessLevel: 'client', jti: uuid() },
    process.env.JWT_SECRET,
    { issuer: 'picpeak-auth', expiresIn: '1h' },
  );
  const endpoint = `/api/gallery/${event.slug}/album-products`;
  const read = await request(galleryApp)
    .get(endpoint)
    .set('Authorization', `Bearer ${token}`);
  expect(read.status).toBe(200);
  const payload = {
    revision: offer.revision,
    mutationId: uuid(),
    productVersion: read.body.offers[0].product.version,
    values: {},
    name: 'Synthetic HTTP Client',
    submit: false,
  };
  const draft = await request(galleryApp)
    .put(`${endpoint}/${offer.id}`)
    .set('Authorization', `Bearer ${token}`)
    .send(payload);
  expect(draft.status).toBe(200);
  expect(draft.body.status).toBe('draft');
  const incomplete = await request(galleryApp)
    .put(`${endpoint}/${offer.id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      ...payload,
      revision: draft.body.revision,
      mutationId: uuid(),
      submit: true,
    });
  expect(incomplete.status).toBe(400);
  const submitted = await request(galleryApp)
    .put(`${endpoint}/${offer.id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      ...payload,
      revision: draft.body.revision,
      mutationId: uuid(),
      values: f.configurations[0].values,
      submit: true,
    });
  expect(submitted.status).toBe(200);
  expect(submitted.body.status).toBe('submitted');
});
