/**
 * The pre-send review (#1445, plan slice 7): GET /:id/send-preview resolves
 * what a send would freeze and deliver — content, signers, attachments,
 * price, template version — and the problems that would make it fail, and
 * writes nothing.
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { PDFDocument } = require('pdf-lib');
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
let contractsApp;
let attachmentsApp;
let templatesApp;

const prevCwd = process.cwd();
const auth = { get Authorization() { return `Bearer ${token}`; } };

async function ok(req, status = [200, 201]) {
  const res = await req;
  if (!status.includes(res.status)) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

const count = async (table, where = {}) => Number((await db(table).where(where).count({ n: '*' }).first()).n);

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
  await db('customer_accounts').where({ id: customerId }).update({ first_name: 'Anna', last_name: 'Muster' });
  const profile = await db('business_profile').where({ id: 1 }).first();
  if (profile) await db('business_profile').where({ id: 1 }).update({ company_name: 'Studio Test' });
  contractsApp = buildRouteApp('/api/admin/contracts', require('../../src/routes/adminContracts'));
  attachmentsApp = buildRouteApp('/api/admin/document-attachments', require('../../src/routes/adminDocumentAttachments'));
  templatesApp = buildRouteApp('/api/admin/contract-templates', require('../../src/routes/adminContractTemplates'));
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

async function contractFromQuoteWithAttachment() {
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  const upload = await ok(request(attachmentsApp).post('/api/admin/document-attachments').set(auth)
    .field('name', 'AGB').attach('file', Buffer.from(await doc.save()), { filename: 'agb.pdf', contentType: 'application/pdf' }));
  const created = await ok(request(templatesApp).post('/api/admin/contract-templates').set(auth).send({ name: 'Mit AGB' }));
  const block = await db('contract_blocks').where({ slug: 'quote_line_items_table' }).first();
  let tpl = await ok(request(templatesApp).put(`/api/admin/contract-templates/${created.template.id}/draft`).set(auth).send({
    lockVersion: created.template.lockVersion,
    items: [
      { kind: 'text', section: 'scope', heading: 'Leistung', body: { de: 'Für {{customer_name}}.', en: 'For {{customer_name}}.' } },
      ...(block ? [{ kind: 'block', blockId: block.id }] : []),
    ],
    attachments: [{ attachmentId: upload.attachment.id, delivery: 'merged' }],
  }));
  tpl = await ok(request(templatesApp).post(`/api/admin/contract-templates/${created.template.id}/publish`).set(auth)
    .send({ lockVersion: tpl.template.lockVersion }));

  const quoteService = require('../../src/services/quoteService');
  const quoteId = await quoteService.createQuote({
    customerAccountId: customerId, currency: 'CHF', vatRate: 8.1, eventName: 'Hochzeit',
    lineItems: [{ position: 1, quantity: 1, description: 'Reportage', unit_price_minor: 200000, discount_percent: 0, parent_position: null }],
  }, adminId);
  await quoteService.sendQuote(quoteId, adminId);
  await quoteService.adminAcceptQuote(quoteId, adminId);
  const contractService = require('../../src/services/contractService');
  const { contractId } = await contractService.createFromQuote(quoteId, adminId);
  await db('contract_attachment_inclusions').where({ contract_id: contractId }).del();
  await db('contract_attachment_inclusions').insert({
    contract_id: contractId, attachment_id: upload.attachment.id, position: 1, delivery: 'merged',
    sha256: upload.attachment.sha256, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  // Use the template version for the preview's template line.
  await db('contracts').where({ id: contractId }).update({ template_version_id: tpl.published.id });
  return { contractId, quoteId, attachment: upload.attachment, templateId: created.template.id };
}

test('the review resolves content, signers, attachments, price and template — and writes nothing', async () => {
  const { contractId, quoteId, attachment, templateId } = await contractFromQuoteWithAttachment();
  const before = {
    signers: await count('contract_signers', { contract_id: contractId }),
    log: await count('activity_logs'),
    contract: await db('contracts').where({ id: contractId }).first(),
  };

  const preview = await ok(request(contractsApp).get(`/api/admin/contracts/${contractId}/send-preview`).set(auth));

  // Placeholders filled in with this moment's values, as the send freezes them.
  const bodies = preview.content.sections.flatMap((s) => s.blocks.map((b) => b.body));
  expect(bodies.some((b) => b.includes('Anna Muster'))).toBe(true);
  expect(bodies.some((b) => b.includes('{{'))).toBe(false);
  expect(preview.signers).toEqual([
    // The name the send's signer row will carry (display name first).
    expect.objectContaining({ position: 1, role: 'customer', name: 'Test Customer', email: 'customer@example.com' }),
    expect.objectContaining({ position: 2, role: 'issuer', name: 'Studio Test' }),
  ]);
  expect(preview.signingOrder).toBe('parallel');
  expect(preview.attachments).toEqual([
    expect.objectContaining({ attachmentId: attachment.id, name: 'AGB', delivery: 'merged', pages: 1, sha256: attachment.sha256, ok: true }),
  ]);
  const quote = await db('quotes').where({ id: quoteId }).first();
  expect(preview.totals).toEqual(expect.objectContaining({ currency: 'CHF', grossMinor: Number(quote.total_amount_minor) }));
  expect(preview.content.commercial.lineItems.map((li) => li.description)).toEqual(['Reportage']);
  expect(preview.template).toEqual({ id: templateId, name: 'Mit AGB', version: 1 });
  expect(preview.problems.filter((p) => p.severity === 'error')).toEqual([]);

  expect(await count('contract_signers', { contract_id: contractId })).toBe(before.signers);
  expect(await count('activity_logs')).toBe(before.log);
  const after = await db('contracts').where({ id: contractId }).first();
  expect(after.status).toBe('draft');
  expect(Number(after.lock_version)).toBe(Number(before.contract.lock_version));
  expect(after.rendered_content || null).toBeNull();
});

test('a changed attachment file is reported here instead of failing the send', async () => {
  const { contractId, attachment } = await contractFromQuoteWithAttachment();
  const file = path.join(process.env.STORAGE_PATH, 'business-docs', 'attachments', `${attachment.sha256}.pdf`);
  const original = fs.readFileSync(file);
  fs.appendFileSync(file, '% changed\n');
  try {
    const preview = await ok(request(contractsApp).get(`/api/admin/contracts/${contractId}/send-preview`).set(auth));
    expect(preview.attachments[0]).toEqual(expect.objectContaining({ ok: false }));
    expect(preview.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'ATTACHMENT_CHANGED', severity: 'error', attachmentId: attachment.id }),
    ]));
  } finally {
    fs.writeFileSync(file, original);
  }
});

test('a sent contract and an inactive customer are errors', async () => {
  const { contractId } = await contractFromQuoteWithAttachment();
  await db('contracts').where({ id: contractId }).update({ status: 'sent' });
  await db('customer_accounts').where({ id: customerId }).update({ is_active: false });
  try {
    const preview = await ok(request(contractsApp).get(`/api/admin/contracts/${contractId}/send-preview`).set(auth));
    expect(preview.problems.map((p) => p.code)).toEqual(expect.arrayContaining(['CONTRACT_NOT_DRAFT', 'CUSTOMER_INACTIVE']));
  } finally {
    await db('customer_accounts').where({ id: customerId }).update({ is_active: true });
  }
});

test('a placeholder-looking customer value is not reported; an unknown placeholder in the text is', async () => {
  const { contractId } = await contractFromQuoteWithAttachment();
  await db('customer_accounts').where({ id: customerId }).update({ company_name: '{{not_a_problem}}' });
  await db('contracts').where({ id: contractId }).update({ intro_text: 'Hallo {{custmer_name}}' });
  try {
    const preview = await ok(request(contractsApp).get(`/api/admin/contracts/${contractId}/send-preview`).set(auth));
    const unresolved = preview.problems.find((p) => p.code === 'PLACEHOLDER_UNRESOLVED');
    expect(unresolved.keys).toEqual(['custmer_name']);
  } finally {
    await db('customer_accounts').where({ id: customerId }).update({ company_name: null });
  }
});

test('a send from the review is refused when the contract changed since, and goes out with a fresh review', async () => {
  const { contractId } = await contractFromQuoteWithAttachment();
  const reviewed = await ok(request(contractsApp).get(`/api/admin/contracts/${contractId}/send-preview`).set(auth));
  expect(reviewed.reviewToken).toMatch(/^[0-9a-f]{64}$/);
  // Edited elsewhere while the review was open.
  await db('contracts').where({ id: contractId }).update({ intro_text: 'Geändert' });
  const refused = await request(contractsApp).post(`/api/admin/contracts/${contractId}/send`).set(auth)
    .send({ reviewToken: reviewed.reviewToken });
  expect(refused.status).toBe(409);
  expect(refused.body.code).toBe('CONTRACT_REVIEW_STALE');
  expect((await db('contracts').where({ id: contractId }).first()).status).toBe('draft');

  const fresh = await ok(request(contractsApp).get(`/api/admin/contracts/${contractId}/send-preview`).set(auth));
  await ok(request(contractsApp).post(`/api/admin/contracts/${contractId}/send`).set(auth).send({ reviewToken: fresh.reviewToken }));
  expect((await db('contracts').where({ id: contractId }).first()).status).toBe('sent');
});

test('the review covers the dates and the customer address, and a save during the send is caught', async () => {
  const { contractId } = await contractFromQuoteWithAttachment();
  const token = async () => (await ok(request(contractsApp).get(`/api/admin/contracts/${contractId}/send-preview`).set(auth))).reviewToken;
  const first = await token();
  await db('contracts').where({ id: contractId }).update({ valid_until: '2099-12-31' });
  const second = await token();
  expect(second).not.toBe(first);
  const before = await db('customer_accounts').where({ id: customerId }).first();
  const addressKey = Object.keys(before).find((k) => /address|city/i.test(k));
  await db('customer_accounts').where({ id: customerId }).update({ [addressKey]: 'Neue Strasse 1' });
  try {
    expect(await token()).not.toBe(second);
    // A save lands while the send prepares its signers.
    const reviewed = await token();
    const signingV2 = require('../../src/services/contract/signingV2');
    const real = signingV2.prepareSend;
    const spy = jest.spyOn(signingV2, 'prepareSend').mockImplementation(async (c) => {
      const out = await real(c);
      const current = await db('contracts').where({ id: contractId }).first();
      await db('contracts').where({ id: contractId })
        .update({ intro_text: 'Dazwischen', lock_version: Number(current.lock_version || 1) + 1 });
      return out;
    });
    try {
      const res = await request(contractsApp).post(`/api/admin/contracts/${contractId}/send`).set(auth).send({ reviewToken: reviewed });
      expect(res.status).toBe(409);
      expect((await db('contracts').where({ id: contractId }).first()).status).toBe('draft');
    } finally {
      spy.mockRestore();
    }
  } finally {
    await db('customer_accounts').where({ id: customerId }).update({ [addressKey]: before[addressKey] });
  }
});
