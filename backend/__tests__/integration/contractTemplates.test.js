/**
 * Contract templates (#1445).
 *
 * Real admin + public routes → services → SQLite with the full
 * core-migration run (helpers/crmDb). Pins:
 *   - the standard template holds the system blocks in the order contracts
 *     always had them, and a new contract without a block list starts from
 *     the default template;
 *   - drafts publish into immutable versions: a later library edit changes
 *     neither the version nor a contract made from it;
 *   - a contract from a version carries its overrides and free text;
 *   - a stale lockVersion is refused, for templates and contract edits;
 *   - publishing lists every problem; the standard template is copied, not
 *     edited; the default can't be archived;
 *   - sending freezes the resolved content with its sha256, and the signing
 *     page shows that content with placeholders filled in;
 *   - everything sits behind the contracts flag.
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
let contractsApp;
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

const templatesUrl = (path = '') => `/api/admin/contract-templates${path}`;

async function systemBlocksInLegacyOrder() {
  const { SECTIONS_ORDER } = require('../../src/services/contract/helpers');
  const rank = (s) => (SECTIONS_ORDER.indexOf(s) === -1 ? 99 : SECTIONS_ORDER.indexOf(s));
  const rows = await db('contract_blocks').where({ is_system: true, is_active: true });
  return rows.sort((a, b) => rank(a.section) - rank(b.section) || a.display_order - b.display_order || a.id - b.id);
}

async function createContract(body = {}) {
  const res = await ok(request(contractsApp).post('/api/admin/contracts').set(auth)
    .send({ customerAccountId: customerId, ...body }));
  return res.contract;
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  db.client.pool.acquireTimeoutMillis = 2000;
  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  await setFlag('contracts', true);
  await db('customer_accounts').where({ id: customerId }).update({ first_name: 'Anna', last_name: 'Muster' });

  templatesApp = buildRouteApp('/api/admin/contract-templates', require('../../src/routes/adminContractTemplates'));
  contractsApp = buildRouteApp('/api/admin/contracts', require('../../src/routes/adminContracts'));
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

test('the standard template holds the system blocks in their usual order', async () => {
  const { templates } = await ok(request(templatesApp).get(templatesUrl()).set(auth));
  const system = templates.find((t) => t.isSystem);
  expect(system).toEqual(expect.objectContaining({ status: 'published', currentVersion: 1, isDefault: true }));
  ids.system = system.id;

  const detail = await ok(request(templatesApp).get(templatesUrl(`/${system.id}`)).set(auth));
  const expected = await systemBlocksInLegacyOrder();
  expect(detail.published.items.map((i) => i.blockId)).toEqual(expected.map((b) => b.id));
  expect(detail.published.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  ids.systemVersionId = detail.published.id;
  // What a new contract from it is made from.
  expect(system.currentVersionId).toBe(detail.published.id);
});

test('a new contract without a block list starts from the default template', async () => {
  const contract = await createContract();
  expect(contract.templateId).toBe(ids.system);
  expect(contract.templateVersionId).toBe(ids.systemVersionId);
  const expected = await systemBlocksInLegacyOrder();
  expect(contract.inclusions).toHaveLength(expected.length);
  // The version's text is frozen into the contract from the start.
  expect(Object.keys(contract.inclusions[0].snapshot).length).toBeGreaterThan(0);
});

test('drafts publish into versions that later library edits never change', async () => {
  const [block] = await systemBlocksInLegacyOrder();
  ids.block = block;
  const created = await ok(request(templatesApp).post(templatesUrl()).set(auth).send({ name: 'Hochzeit' }));
  ids.wedding = created.template.id;

  const saved = await ok(request(templatesApp).put(templatesUrl(`/${ids.wedding}/draft`)).set(auth).send({
    lockVersion: created.template.lockVersion,
    title: 'Hochzeitsvertrag',
    introText: { de: 'Hallo {{customer_name}}', en: 'Hello {{customer_name}}' },
    items: [
      { kind: 'block', blockId: block.id, body: { de: 'Eigener Text für {{event_name}}' } },
      { kind: 'text', section: 'closing', heading: 'Zusatz', body: { de: 'Freitext', en: 'Free text' } },
    ],
  }));
  expect(saved.template.lockVersion).toBe(created.template.lockVersion + 1);
  expect(saved.draft.items.map((i) => i.kind)).toEqual(['block', 'text']);

  const published = await ok(request(templatesApp).post(templatesUrl(`/${ids.wedding}/publish`)).set(auth)
    .send({ lockVersion: saved.template.lockVersion }));
  expect(published.version).toBe(1);
  expect(published.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  ids.weddingVersionId = published.published.id;
  const frozenBody = published.published.items[0].snapshot.en;
  expect(frozenBody).toBe(block.body_text);

  await db('contract_blocks').where({ id: block.id }).update({ body_text: 'Changed in the library' });
  const after = await ok(request(templatesApp).get(templatesUrl(`/${ids.wedding}`)).set(auth));
  expect(after.published.items[0].snapshot.en).toBe(frozenBody);
});

test('a contract from a version carries its overrides and free text', async () => {
  const contract = await createContract({ templateVersionId: ids.weddingVersionId, eventName: 'Hochzeit Muster', language: 'de' });
  ids.weddingContract = contract;
  expect(contract.templateVersionId).toBe(ids.weddingVersionId);
  expect(contract.templateName).toBe('Hochzeit');
  expect(contract.templateVersion).toBe(1);
  expect(contract.title).toBe('Hochzeitsvertrag');
  expect(contract.introText).toBe('Hallo {{customer_name}}');
  expect(contract.inclusions).toHaveLength(1);
  expect(contract.inclusions[0].bodyOverride.de).toBe('Eigener Text für {{event_name}}');
  expect(contract.inclusions[0].snapshot.en).toBe(ids.block.body_text);
  expect(contract.textSections).toEqual([expect.objectContaining({ section: 'closing', heading: 'Zusatz' })]);

  const { getContractById } = require('../../src/services/contractService');
  const { buildRenderContext } = require('../../src/services/contract/renderContext');
  const data = await getContractById(contract.id);
  const ctx = await buildRenderContext(data.contract, data.inclusions, data.textSections);
  const bodies = ctx.sections.flatMap((s) => s.blocks.map((b) => b.body));
  expect(bodies).toEqual(['Eigener Text für Hochzeit Muster', 'Freitext']);
  expect(ctx.doc.introText).toBe('Hallo Anna Muster');
});

test('a stale lockVersion is refused', async () => {
  const res = await request(templatesApp).put(templatesUrl(`/${ids.wedding}/draft`)).set(auth)
    .send({ lockVersion: 1, title: 'Too late' });
  expect(res.status).toBe(409);
  expect(res.body.code).toBe('TEMPLATE_CONFLICT');
});

test('publishing lists every problem at once', async () => {
  const created = await ok(request(templatesApp).post(templatesUrl()).set(auth).send({ name: 'Broken' }));
  const saved = await ok(request(templatesApp).put(templatesUrl(`/${created.template.id}/draft`)).set(auth).send({
    lockVersion: created.template.lockVersion,
    introText: { de: 'Hallo {{custmer_name}}' },
    items: [{ kind: 'text', section: 'basics', heading: 'Leer', body: {} }],
  }));
  const res = await request(templatesApp).post(templatesUrl(`/${created.template.id}/publish`)).set(auth)
    .send({ lockVersion: saved.template.lockVersion });
  expect(res.status).toBe(400);
  expect(res.body.code).toBe('TEMPLATE_INVALID');
  expect(res.body.error).toMatch(/has no text/);
  expect(res.body.error).toMatch(/\{\{custmer_name\}\}/);
});

test('the standard template is copied, not edited', async () => {
  const detail = await ok(request(templatesApp).get(templatesUrl(`/${ids.system}`)).set(auth));
  const edit = await request(templatesApp).put(templatesUrl(`/${ids.system}/draft`)).set(auth)
    .send({ lockVersion: detail.template.lockVersion, title: 'Mine' });
  expect(edit.status).toBe(409);
  expect(edit.body.code).toBe('TEMPLATE_SYSTEM');

  const copy = await ok(request(templatesApp).post(templatesUrl(`/${ids.system}/duplicate`)).set(auth)
    .send({ name: 'Mein Standard' }));
  expect(copy.template.isSystem).toBe(false);
  expect(copy.draft.items.map((i) => i.blockId)).toEqual(detail.published.items.map((i) => i.blockId));
});

test('the default template can be changed but not archived', async () => {
  let res = await request(templatesApp).post(templatesUrl(`/${ids.system}/archive`)).set(auth);
  expect(res.status).toBe(409);
  expect(res.body.code).toBe('TEMPLATE_IS_DEFAULT');

  await ok(request(templatesApp).post(templatesUrl(`/${ids.wedding}/default`)).set(auth));
  const contract = await createContract();
  expect(contract.templateId).toBe(ids.wedding);

  res = await request(templatesApp).post(templatesUrl(`/${ids.system}/archive`)).set(auth);
  expect(res.status).toBe(200);
  await ok(request(templatesApp).post(templatesUrl(`/${ids.system}/restore`)).set(auth));
  await ok(request(templatesApp).post(templatesUrl(`/${ids.system}/default`)).set(auth));
});

test('editing a contract keeps its frozen text and refuses a stale save', async () => {
  const contract = ids.weddingContract;
  const blocks = contract.inclusions.map((inc) => ({ blockId: inc.blockId, included: true, position: inc.position }));
  const saved = await ok(request(contractsApp).put(`/api/admin/contracts/${contract.id}`).set(auth)
    .send({ blocks, lockVersion: contract.lockVersion, title: 'Hochzeitsvertrag 2' }));
  expect(saved.contract.lockVersion).toBe(contract.lockVersion + 1);
  expect(saved.contract.inclusions[0].bodyOverride.de).toBe('Eigener Text für {{event_name}}');
  expect(saved.contract.inclusions[0].snapshot.en).toBe(ids.block.body_text);

  const stale = await request(contractsApp).put(`/api/admin/contracts/${contract.id}`).set(auth)
    .send({ lockVersion: contract.lockVersion, title: 'Lost update' });
  expect(stale.status).toBe(409);
  expect(stale.body.code).toBe('CONTRACT_CONFLICT');
});

test('sending freezes the resolved content, and the signing page shows it', async () => {
  const contractService = require('../../src/services/contractService');
  const { canonicalSha256 } = require('../../src/utils/canonicalJson');
  const { id } = ids.weddingContract;
  await contractService.sendContract(id, adminId);

  const row = await db('contracts').where({ id }).first();
  const snapshot = JSON.parse(row.rendered_content);
  expect(row.rendered_content_sha256).toBe(canonicalSha256(snapshot));
  expect(snapshot.placeholders.customer_name).toBe('Anna Muster');

  // Later changes to the customer or the library don't reach the sent contract.
  await db('customer_accounts').where({ id: customerId }).update({ first_name: 'Berta' });
  await db('contract_text_sections').where({ contract_id: id }).update({ body: JSON.stringify({ de: 'Geändert' }) });

  // A verified signer (#1446) sees the same content.
  const signerRow = await db('contract_signers').where({ contract_id: id, role: 'customer' }).first();
  const { token: session } = await require('../../src/services/contract/signers').createSession(signerRow.id, 'otp');
  const signingApp = buildRouteApp('/api/public/contract-signing', require('../../src/routes/publicContractSigning'));
  const view = await ok(request(signingApp).get('/api/public/contract-signing/session').set('X-Signing-Session', session));
  const bodies = view.contract.sections.flatMap((s) => s.blocks.map((b) => b.body));
  expect(bodies).toEqual(['Eigener Text für Hochzeit Muster', 'Freitext']);
  expect(view.contract.introText).toBe('Hallo Anna Muster');

  const documents = await ok(request(contractsApp).get(`/api/admin/contracts/${id}/documents`).set(auth));
  expect(documents.documents[0]).toEqual(expect.objectContaining({
    kind: 'unsigned', templateVersionId: ids.weddingVersionId,
  }));
  await db('customer_accounts').where({ id: customerId }).update({ first_name: 'Anna' });
});

test('a preview renders the draft through the real pipeline', async () => {
  const res = await request(templatesApp).post(templatesUrl(`/${ids.wedding}/preview`)).set(auth).send({})
    .buffer(true)
    .parse((r, cb) => { const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
  expect(res.status).toBe(200);
  expect(res.body.subarray(0, 5).toString()).toBe('%PDF-');
});

test('templates sit behind the contracts flag', async () => {
  await setFlag('contracts', false);
  const res = await request(templatesApp).get(templatesUrl()).set(auth);
  expect(res.status).toBe(403);
  expect(res.body.code).toBe('CONTRACTS_DISABLED');
  await setFlag('contracts', true);
});
