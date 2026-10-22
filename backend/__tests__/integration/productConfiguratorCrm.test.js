'use strict';
// Native core migrations, auth grants, quote arithmetic and document snapshots.
const crypto = require('crypto');
const request = require('supertest');
const sharp = require('sharp');
const { bootCrmDb, seedMinimal, assignAdminRole, createPublicToken, buildRouteApp } = require('./helpers/crmDb');
const V = require('../../src/services/albumProducts/validation');
const G = require('../../src/services/albumProducts/library');
const uuid = () => crypto.randomUUID();
const parsed = value => typeof value === 'string' ? JSON.parse(value) : value;
let db, cleanup, adminId, customerId, products, quotes, app, catalog, product, type, size, frame, mat, image;
const previousCwd = process.cwd();
beforeAll(async () => {
  let tmpDir;
  ({ db, cleanup, tmpDir } = await bootCrmDb()); process.chdir(tmpDir);
  ({ adminId, customerId } = await seedMinimal(db)); await assignAdminRole(db, adminId);
  for (const key of ['albumProducts','quotes','contracts']) await db('feature_flags').insert({ key, value: true }).onConflict('key').merge({ value: true });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
  products = require('../../src/services/albumProducts/service').application(); quotes = require('../../src/services/quoteService');
  image = await products.uploadImage(await sharp({ create: { width: 24, height: 24, channels: 3, background: '#336699' } }).png().toBuffer(), adminId);
  const option = (name, extra = {}) => ({ id: uuid(), name, active: true, imageId: image.id, ...extra });
  const library = [
    { id: uuid(), name: 'Size', kind: 'size', options: [option('90 × 60 cm', { width: 90, height: 60, unit: 'cm' }), option('60 × 40 cm', { width: 60, height: 40, unit: 'cm' })] },
    { id: uuid(), name: 'Frame', kind: 'choice', options: [option('Oak'), option('Walnut')] },
    { id: uuid(), name: 'Mat', kind: 'choice', options: [option('White mat')] },
  ];
  const attribute = (group, extra = {}) => ({ id: uuid(), name: group.name, groupId: group.id, optionIds: group.options.map(o => o.id), required: true, multiple: false, addOn: false, dependsOn: [], ...extra });
  size = attribute(library[0]); frame = attribute(library[1], { required: false, addOn: true }); mat = attribute(library[2], { required: false, addOn: true, dependsOn: [{ attributeId: frame.id, optionIds: frame.optionIds }] });
  type = { id: uuid(), name: 'Framed print', active: true, attributes: [size,frame,mat] };
  product = { id: uuid(), name: 'Wall print', active: true, description: 'Synthetic review fixture', typeId: type.id };
  catalog = await products.saveCatalogue({ revision: 0, products: [product], library, types: [type] });
  app = buildRouteApp('/api/public/quotes', require('../../src/routes/publicQuotes'));
}, 180000);
afterAll(async () => { process.chdir(previousCwd); if (cleanup) await cleanup(); });
async function fixture({ optional = true, parent = false } = {}) {
  const preset = await quotes.createLineItemPreset({ name: 'Print', currency: 'EUR', unit_price_minor: 10000, price_mode: 'fixed', product_id: product.id, product_surcharges: [
    { attributeId: frame.id, optionId: frame.optionIds[0], amountMinor: 2000 },
    { attributeId: mat.id, optionId: mat.optionIds[0], amountMinor: 500 },
  ] });
  const lines = [{ position: 1, quantity: 1, description: 'Photography', unit_price_minor: 50000 },
    ...(parent ? [{ position: 2, quantity: 1, description: 'Print package', unit_price_minor: 0, is_optional: optional, selected: !optional }] : []),
    { position: parent ? 3 : 2, parent_position: parent ? 2 : null, quantity: 2, description: 'Print', unit_price_minor: 1, catalogue_preset_id: preset.id, is_optional: optional, selected: !optional },
  ];
  const quoteId = await quotes.createQuote({ customerAccountId: customerId, currency: 'EUR', vatRate: 0, lineItems: lines }, adminId);
  await db('quotes').where({ id: quoteId }).update({ status: 'sent', sent_at: new Date().toISOString() });
  const token = await createPublicToken(db, 'quote_action_tokens', { quote_id: quoteId });
  const tokenRow = await db('quote_action_tokens').where({ token }).first();
  const grant = await require('../../src/services/publicDocumentVerificationService').issueGrant('quote', tokenRow, token);
  const stored = await quotes.getQuoteById(quoteId), line = stored.lineItems.find(li => li.configuration_definition);
  const definition = parsed(line.configuration_definition);
  const configurations = [{ position: Number(line.position), definitionVersion: definition.version, values: { [size.id]: [size.optionIds[0]], [frame.id]: [frame.optionIds[0]], [mat.id]: [mat.optionIds[0]] } }];
  return { quoteId, token, grant, configurations, preset, line, definition };
}
const totals = (f, selected = [2], configurations = f.configurations) => request(app).post(`/api/public/quotes/${f.token}/totals`).set('X-Document-Access', f.grant).send({ selectedOptional: selected, configurations });
const accept = (f, total, selected = [2], configurations = f.configurations) => request(app).post(`/api/public/quotes/${f.token}/respond`).set('X-Document-Access', f.grant).send({ action: 'accept', selectedOptional: selected, expectedTotalMinor: total, configurations });
test('generic sizes, required and multi-select attributes and dependencies are validated', () => {
  const resolved = G.resolve(product, catalog);
  const values = { [size.id]: [size.optionIds[0]], [mat.id]: [mat.optionIds[0]] };
  expect(() => V.selection(resolved, { productVersion: resolved.version, values })).toThrow(/depends/);
  expect(() => V.selection(resolved, { productVersion: resolved.version, values: {} })).toThrow(/Choose Size/);
  expect(() => V.selection(resolved, { productVersion: resolved.version, values: { [size.id]: size.optionIds } })).toThrow();
  const multi = { ...resolved, attributes: resolved.attributes.map(a => a.id === size.id ? { ...a, multiple: true } : a) };
  const snapshot = V.selection(multi, { productVersion: multi.version, values: { [size.id]: size.optionIds } });
  expect(snapshot.attributes[0].options).toHaveLength(2); expect(snapshot.attributes[0].options[0]).toMatchObject({ width: 90, height: 60, unit: 'cm' });
  const bad = structuredClone(catalog.types); bad[0].attributes[1].dependsOn = [{ attributeId: mat.id, optionIds: mat.optionIds }];
  expect(() => G.cleanTypes(bad, catalog.library)).toThrow(/cycles/);
  expect(() => G.cleanLibrary([{ ...catalog.library[0], options: [{ ...catalog.library[0].options[0], width: -1 }] }])).toThrow();
});
test('quote totals are authoritative, include quantity and optional surcharges, and reject missing/forged choices', async () => {
  const f = await fixture();
  expect((await request(app).post(`/api/public/quotes/${f.token}/totals`).send({ selectedOptional: [2] })).status).toBe(401);
  const preview = await totals(f); expect(preview.status).toBe(200); expect(Number(preview.body.totalAmountMinor ?? preview.body.data?.totalAmountMinor)).toBe(75000);
  expect((await accept(f, 1)).status).toBe(409);
  expect((await totals(f, [2], [])).status).toBe(400);
  const forged = structuredClone(f.configurations); forged[0].values[size.id] = [uuid()];
  expect((await totals(f, [2], forged)).status).toBe(400);
  const stale = structuredClone(f.configurations); stale[0].definitionVersion = '0'.repeat(64);
  expect((await totals(f, [2], stale)).status).toBe(409);
  expect((await db('quotes').where({ id: f.quoteId }).first()).status).toBe('sent');
  expect((await accept(f, 75000)).status).toBe(200);
  const [line] = (await quotes.getQuoteById(f.quoteId)).lineItems.filter(li => li.configuration_definition);
  expect(parsed(line.configuration_snapshot)).toMatchObject({ schemaVersion: 2, pricing: { baseUnitPriceMinor: 10000, surchargeMinor: 2500, unitPriceMinor: 12500 } });
  expect(line.details_text).toContain('Frame: Oak');
});
test('a product can be booked inside a package and unbooked products need no choice', async () => {
  const f = await fixture({ parent: true });
  expect((await totals(f)).status).toBe(200);
  expect((await accept(f, 75000)).status).toBe(200);
  const empty = await fixture(); expect((await accept(empty, 50000, [], [])).status).toBe(200);
  expect((await quotes.getQuoteById(empty.quoteId)).lineItems.find(li => li.configuration_definition).configuration_snapshot).toBeNull();
});
test('included products also require configuration and cannot be accepted incomplete by an admin', async () => {
  const f = await fixture({ optional: false });
  await expect(quotes.adminAcceptQuote(f.quoteId, adminId)).rejects.toThrow(/Choose/);
  expect((await db('quotes').where({ id: f.quoteId }).first()).status).toBe('sent');
  expect((await accept(f, 75000, [])).status).toBe(200);
});
test('offered and accepted definitions survive live library/pricing changes; contracts and invoices keep the exact specification', async () => {
  const f = await fixture();
  const original = await products.catalogue(), changed = structuredClone(original);
  changed.library[0].options[0].name = 'Renamed after offer';
  await products.saveCatalogue(changed);
  await quotes.updateLineItemPreset(f.preset.id, { unit_price_minor: 99000 });
  expect((await accept(f, 75000)).status).toBe(200);
  const line = (await quotes.getQuoteById(f.quoteId)).lineItems.find(li => li.configuration_definition), snapshot = parsed(line.configuration_snapshot);
  expect(snapshot.attributes[0].options[0].name).toBe('90 × 60 cm');
  const contractService = require('../../src/services/contractService');
  const { contractId } = await contractService.createFromQuote(f.quoteId, adminId);
  await contractService.sendContract(contractId, adminId);
  const contract = await db('contracts').where({ id: contractId }).first();
  const frozen = parsed(contract.rendered_content).quote.lineItems.find(li => li.configuration_snapshot);
  expect(parsed(frozen.configuration_snapshot)).toEqual(snapshot);
  const { invoiceIds: [invoiceId] } = await require('../../src/services/invoiceService').createInvoice({ customerAccountId: customerId, currency: 'EUR', vatRate: 0, lineItems: [line] }, adminId);
  expect(parsed((await db('invoice_line_items').where({ invoice_id: invoiceId }).first()).configuration_snapshot)).toEqual(snapshot);
  expect((await accept(f, 75000)).status).toBe(409);
  await products.saveCatalogue({ ...original, revision: (await products.catalogue()).revision });
}, 120000);
test('quote images require verification and belong to this quote, including historical offered images', async () => {
  const f = await fixture();
  expect((await request(app).get(`/api/public/quotes/${f.token}/product-images/${image.id}`)).status).toBe(401);
  expect((await request(app).get(`/api/public/quotes/${f.token}/product-images/${image.id}`).set('X-Document-Access', f.grant)).status).toBe(200);
  expect((await request(app).get(`/api/public/quotes/${f.token}/product-images/${uuid()}`).set('X-Document-Access', f.grant)).status).toBe(404);
  const other = await quotes.createQuote({ customerAccountId: customerId, currency: 'EUR', lineItems: [{ position: 1, description: 'No product', quantity: 1, unit_price_minor: 100 }] }, adminId);
  await expect(require('../../src/services/albumProducts/crm').quoteImage(db, other, image.id)).rejects.toMatchObject({ statusCode: 404 });
});
test('templates and CRM packages reuse the same configurable preset, without copying the library', async () => {
  const f = await fixture();
  const packages = require('../../src/services/quoteCatalogService');
  const pkg = await packages.savePackage(null, { name: 'Print package', currency: 'EUR', items: [{ preset_id: f.preset.id, quantity: 1 }] });
  const templates = require('../../src/services/quoteTemplateService');
  const template = await templates.createTemplate({ name: 'Product template', currency: 'EUR', draft: { sections: [{ type: 'package', packageId: pkg.id, isOptional: true }] } }, adminId);
  const templateId = template;
  await templates.publishTemplate(templateId, adminId);
  const created = await templates.createQuoteFromTemplate(templateId, { customerAccountId: customerId }, adminId);
  const quote = await quotes.getQuoteById(created.quoteId);
  expect(quote.lineItems.filter(li => li.configuration_definition)).toHaveLength(1);
  expect(parsed(quote.lineItems.find(li => li.configuration_definition).configuration_definition).product.id).toBe(product.id);
});

test('the gallery stores the same generic choice and only chosen-option changes require review', async () => {
  const event = { slug: `shared-${uuid()}`, event_name: 'Shared gallery', event_type: 'wedding', event_date: '2026-10-22', host_email: 'client@example.com', admin_email: 'studio@example.com', password_hash: 'x', share_link: '/gallery/shared', share_token: uuid() };
  const inserted = await db('events').insert(event).returning('id'); event.id = inserted[0].id ?? inserted[0];
  const offer = await products.assign(event.id, product.id), resolved = (await products.clientOffers(event.id))[0].product;
  const values = { [size.id]: [size.optionIds[0]], [frame.id]: [frame.optionIds[0]] };
  const saved = await products.mutate(event, { id: offer.id, revision: 1, mutationId: uuid(), productVersion: resolved.version, values, submit: true }, { type: 'client', id: 'f'.repeat(64), name: 'Synthetic Client' });
  expect(saved.selection).toEqual(V.selection(resolved, { productVersion: resolved.version, values }));
  const catalog = await products.catalogue();
  await products.saveCatalogue({ ...catalog, products: catalog.products.map(p => ({ ...p, description: 'Edited description' })) });
  expect((await products.clientOffers(event.id))[0].needsReview).toBe(false);
  expect((await products.mutate(event, { id: offer.id, revision: 2, mutationId: uuid(), action: 'lock' }, { type: 'admin', id: adminId }, { admin: true })).status).toBe('locked');
});
