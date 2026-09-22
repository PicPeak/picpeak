/**
 * System-template lineage and the contract template on quote conversion
 * (#1445, plan slice 10).
 *
 *   - a new built-in revision publishes a new system version — once, even
 *     with two processes at it — and never changes the old one;
 *   - a copy remembers its source and the version it took in, shows when the
 *     source moved on, and only moves on when the admin says so;
 *   - converting a quote starts the contract from the template asked for,
 *     else the quote template's contract template, else the default.
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
let templatesApp;
let quotesApp;
let catalogApp;
let systemId;

const prevCwd = process.cwd();
const auth = { get Authorization() { return `Bearer ${token}`; } };
const url = (p = '') => `/api/admin/contract-templates${p}`;

async function ok(req, status = [200, 201]) {
  const res = await req;
  if (!status.includes(res.status)) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

async function publishedTemplate(name) {
  const created = await ok(request(templatesApp).post(url()).set(auth).send({ name }));
  const saved = await ok(request(templatesApp).put(url(`/${created.template.id}/draft`)).set(auth).send({
    lockVersion: created.template.lockVersion,
    items: [{ kind: 'text', section: 'closing', heading: name, body: { de: `${name} Text`, en: `${name} text` } }],
  }));
  await ok(request(templatesApp).post(url(`/${created.template.id}/publish`)).set(auth).send({ lockVersion: saved.template.lockVersion }));
  return created.template.id;
}

async function acceptedQuote(extra = {}) {
  const quoteService = require('../../src/services/quoteService');
  const id = await quoteService.createQuote({
    customerAccountId: customerId, currency: 'CHF', vatRate: 0,
    lineItems: [{ position: 1, quantity: 1, description: 'Shoot', unit_price_minor: 1000, discount_percent: 0, parent_position: null }],
  }, adminId);
  if (Object.keys(extra).length) await db('quotes').where({ id }).update(extra);
  await quoteService.sendQuote(id, adminId);
  await quoteService.adminAcceptQuote(id, adminId);
  return id;
}

const templateOfContract = async (contractId) => (await db('contracts').where({ id: contractId }).first()).template_id;

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  db.client.pool.acquireTimeoutMillis = 2000;
  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  for (const key of ['contracts', 'quotes']) {
    const updated = await db('feature_flags').where({ key }).update({ value: true });
    if (!updated) await db('feature_flags').insert({ key, value: true });
  }
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
  templatesApp = buildRouteApp('/api/admin/contract-templates', require('../../src/routes/adminContractTemplates'));
  quotesApp = buildRouteApp('/api/admin/quotes', require('../../src/routes/adminQuotes'));
  catalogApp = buildRouteApp('/api/admin/quote-catalog', require('../../src/routes/adminQuoteCatalog'));
  const { templates } = await ok(request(templatesApp).get(url()).set(auth));
  systemId = templates.find((t) => t.isSystem).id;
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

test('a copy records its source; a new system revision is a new version, offered to the copy, not applied', async () => {
  const copy = await ok(request(templatesApp).post(url(`/${systemId}/duplicate`)).set(auth).send({ name: 'Meine Kopie' }));
  expect(copy.template).toEqual(expect.objectContaining({ sourceTemplateId: systemId, sourceVersion: 1 }));
  expect(copy.lineage).toEqual(expect.objectContaining({ sourceIsSystem: true, sourceVersion: 1, latestSourceVersion: 1, updateAvailable: false }));

  const v1 = await db('contract_template_versions').where({ template_id: systemId, version_number: 1 }).first();
  const v1Items = await db('contract_template_version_items').where({ version_id: v1.id }).orderBy('position');
  // A new built-in block, then the revision that includes it.
  await db('contract_blocks').insert({
    slug: 'new_system_clause', section: 'closing', name: 'Neue Klausel', body_text: 'New clause.', body_text_de: 'Neue Klausel.',
    is_system: true, is_active: true, display_order: 99, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  const { publishSystemRevision } = require('../../src/services/contract/defaultTemplate');
  const system = await db('contract_templates').where({ id: systemId }).first();
  // Two processes at once: one version comes out, neither fails.
  const results = await Promise.all([publishSystemRevision(system, 2), publishSystemRevision(system, 2)]);
  expect(results.filter(Boolean)).toEqual([2]);
  expect(await publishSystemRevision(system, 2)).toBeNull();

  const versions = await db('contract_template_versions').where({ template_id: systemId }).orderBy('version_number');
  expect(versions.map((v) => [Number(v.version_number), v.status, v.system_revision == null ? null : Number(v.system_revision)]))
    .toEqual([[1, 'superseded', 1], [2, 'published', 2]]);
  // Version 1 is exactly what it was.
  expect(versions[0].content_sha256).toBe(v1.content_sha256);
  expect((await db('contract_template_version_items').where({ version_id: v1.id }).orderBy('position')).map((i) => i.block_id))
    .toEqual(v1Items.map((i) => i.block_id));
  const v2Items = await db('contract_template_version_items').where({ version_id: versions[1].id });
  expect(v2Items.length).toBe(v1Items.length + 1);

  // The copy is untouched and says the source moved on.
  let detail = await ok(request(templatesApp).get(url(`/${copy.template.id}`)).set(auth));
  expect(detail.draft.items.length).toBe(v1Items.length);
  expect(detail.lineage).toEqual(expect.objectContaining({ sourceVersion: 1, latestSourceVersion: 2, updateAvailable: true }));

  // Reviewed: the admin moves the copy on (with or without taking clauses in).
  detail = await ok(request(templatesApp).put(url(`/${copy.template.id}/draft`)).set(auth)
    .send({ lockVersion: detail.template.lockVersion, sourceVersionNumber: 2 }));
  expect(detail.lineage).toEqual(expect.objectContaining({ sourceVersion: 2, updateAvailable: false }));
  const beyond = await request(templatesApp).put(url(`/${copy.template.id}/draft`)).set(auth)
    .send({ lockVersion: detail.template.lockVersion, sourceVersionNumber: 3 });
  expect(beyond.status).toBe(400);
});

test('converting a quote: the template asked for, else the quote template\'s, else the default', async () => {
  const chosen = await publishedTemplate('Gewählt');
  const fromQuoteTemplate = await publishedTemplate('Aus Offertvorlage');

  // Asked for.
  let quoteId = await acceptedQuote();
  let res = await ok(request(quotesApp).post(`/api/admin/quotes/${quoteId}/convert-to-contract`).set(auth).send({ contractTemplateId: chosen }));
  expect(await templateOfContract(res.contractId)).toBe(chosen);
  const first = { quoteId, contractId: res.contractId };

  // The quote template names one.
  const qt = await ok(request(catalogApp).post('/api/admin/quote-catalog/templates').set(auth)
    .send({ name: 'Hochzeit', defaultContractTemplateId: fromQuoteTemplate }));
  expect(qt.template.defaultContractTemplateId).toBe(fromQuoteTemplate);
  quoteId = await acceptedQuote({ source_template_id: qt.template.id });
  res = await ok(request(quotesApp).post(`/api/admin/quotes/${quoteId}/convert-to-contract`).set(auth).send({}));
  expect(await templateOfContract(res.contractId)).toBe(fromQuoteTemplate);

  // It was archived since: the default.
  await db('contract_templates').where({ id: fromQuoteTemplate }).update({ status: 'archived' });
  quoteId = await acceptedQuote({ source_template_id: qt.template.id });
  res = await ok(request(quotesApp).post(`/api/admin/quotes/${quoteId}/convert-to-contract`).set(auth).send({}));
  expect(await templateOfContract(res.contractId)).toBe(systemId);

  // An unusable one asked for is refused, and no contract is made.
  quoteId = await acceptedQuote();
  const refused = await request(quotesApp).post(`/api/admin/quotes/${quoteId}/convert-to-contract`).set(auth)
    .send({ contractTemplateId: fromQuoteTemplate });
  expect(refused.status).toBe(400);
  expect((await db('quotes').where({ id: quoteId }).first()).converted_contract_id || null).toBeNull();

  // A quote template can't be pointed at an archived contract template…
  const other = await ok(request(catalogApp).post('/api/admin/quote-catalog/templates').set(auth).send({ name: 'Portrait' }));
  const bad = await request(catalogApp).put(`/api/admin/quote-catalog/templates/${other.template.id}`).set(auth)
    .send({ defaultContractTemplateId: fromQuoteTemplate });
  expect(bad.status).toBe(400);
  // …but one that already points at it can still be saved.
  const kept = await request(catalogApp).put(`/api/admin/quote-catalog/templates/${qt.template.id}`).set(auth)
    .send({ description: 'Neu', defaultContractTemplateId: fromQuoteTemplate });
  expect(kept.status).toBe(200);

  // A retry of a finished conversion returns its contract, even with the
  // template it asked for archived since.
  await db('contract_templates').where({ id: chosen }).update({ status: 'archived' });
  const retry = await ok(request(quotesApp).post(`/api/admin/quotes/${first.quoteId}/convert-to-contract`).set(auth)
    .send({ contractTemplateId: chosen }));
  expect(retry.contractId).toBe(first.contractId);
});

test('a new system revision on an archived standard template adds the version and leaves it archived', async () => {
  const { publishSystemRevision } = require('../../src/services/contract/defaultTemplate');
  await db('contract_templates').where({ id: systemId }).update({ status: 'archived' });
  try {
    const system = await db('contract_templates').where({ id: systemId }).first();
    const version = await publishSystemRevision(system, 3);
    expect(version).toBe(3);
    const after = await db('contract_templates').where({ id: systemId }).first();
    expect(after.status).toBe('archived');
    expect(Number(after.current_version)).toBe(3);
  } finally {
    await db('contract_templates').where({ id: systemId }).update({ status: 'published' });
  }
});
