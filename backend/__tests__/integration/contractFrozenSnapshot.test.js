/**
 * What a sent contract freezes (#1445, plan slice 1).
 *
 * `rendered_content` froze the contract's words from the start. It did not
 * freeze its price: the `quote_line_items_table` block re-read
 * `quote_line_items` on every render, so `rendered_content_sha256` — the hash
 * a signature is bound to — covered the wording and not the amounts. A sent
 * contract opens its stored PDF, so nothing a customer saw ever changed; but
 * the hash never stood for the commercial terms.
 *
 * Format 2 freezes the counted line items and the quote's own totals. These
 * pin that, the fallback for contracts sent before it, and the audit entries
 * that go with a generated document.
 */

const crypto = require('crypto');
const fs = require('fs');
const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

const parsed = (value) => (typeof value === 'string' ? JSON.parse(value) : value);

let db;
let cleanup;
let tmpDir;
let adminId;
let customerId;
let token;
let contractsApp;
let quoteService;
let contractService;
let renderContext;

const prevCwd = process.cwd();
const auth = { get Authorization() { return `Bearer ${token}`; } };

async function ok(req, status = [200, 201]) {
  const res = await req;
  if (!status.includes(res.status)) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

const lineItem = (position, description, price, extra = {}) => ({
  position, quantity: 1, description, unit_price_minor: price, discount_percent: 0, parent_position: null, ...extra,
});

/** An accepted quote with one plain line and one optional add-on nobody took. */
async function acceptedQuote() {
  const id = await quoteService.createQuote({
    customerAccountId: customerId,
    currency: 'CHF',
    vatRate: 8.1,
    eventName: 'Snapshot shoot',
    lineItems: [
      lineItem(1, 'Reportage, 8h', 240000),
      lineItem(2, 'Second photographer', 90000, { is_optional: true, selected: false }),
    ],
  }, adminId);
  await quoteService.sendQuote(id, adminId);
  await quoteService.adminAcceptQuote(id, adminId);
  return id;
}

/** A contract made from that quote and sent, so its snapshot is frozen. */
async function sentContractFromQuote() {
  const quoteId = await acceptedQuote();
  const { contractId } = await contractService.createFromQuote(quoteId, adminId);
  await ok(request(contractsApp).post(`/api/admin/contracts/${contractId}/send`).set(auth));
  return { quoteId, contractId };
}

const contractRow = (id) => db('contracts').where({ id }).first();

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
  const profile = await db('business_profile').where({ id: 1 }).first();
  const columns = { email: 'studio@example.com', company_name: 'Studio Test' };
  if (profile) await db('business_profile').where({ id: 1 }).update(columns);
  else await db('business_profile').insert({ id: 1, ...columns });

  quoteService = require('../../src/services/quoteService');
  contractService = require('../../src/services/contractService');
  renderContext = require('../../src/services/contract/renderContext');
  contractsApp = buildRouteApp('/api/admin/contracts', require('../../src/routes/adminContracts'));
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

test('the snapshot freezes the counted line items and the quote\'s own totals', async () => {
  const { quoteId, contractId } = await sentContractFromQuote();
  const snapshot = parsed((await contractRow(contractId)).rendered_content);
  const quote = await db('quotes').where({ id: quoteId }).first();

  expect(snapshot.format).toBe(2);
  expect(snapshot.quote.number).toBe(quote.quote_number);
  expect(snapshot.quote.currency).toBe('CHF');

  // The optional add-on nobody selected isn't part of the deal (#1451), so
  // it isn't part of what is signed either.
  expect(snapshot.quote.lineItems.map((li) => li.description)).toEqual(['Reportage, 8h']);

  // The quote's own arithmetic, not a re-derivation of it.
  expect(snapshot.quote.totals).toEqual({
    netMinor: Number(quote.net_amount_minor),
    vatRatePercent: Number(quote.vat_rate),
    vatMinor: Number(quote.vat_amount_minor),
    shippingMinor: Number(quote.shipping_amount_minor),
    grossMinor: Number(quote.total_amount_minor),
  });

  // Every number is a number. PostgreSQL hands bigints and decimals back as
  // strings; freezing them raw would give the same contract a different
  // content hash on the two engines — and that hash is what a signature is
  // bound to.
  for (const li of snapshot.quote.lineItems) {
    expect(typeof li.unit_price_minor).toBe('number');
    expect(typeof li.line_total_minor).toBe('number');
    expect(typeof li.quantity).toBe('number');
    expect(typeof li.discount_percent).toBe('number');
  }
  for (const value of Object.values(snapshot.quote.totals)) expect(typeof value).toBe('number');
});

test('the PDF sent out draws the totals the snapshot freezes', async () => {
  // The send renders the unsigned PDF from a draft, which has no snapshot
  // yet. It used to render first and freeze after: the draft render read the
  // live line items and no totals at all, so the stored PDF named no sum while
  // the signing page and every later re-render did.
  const pdfService = require('../../src/services/pdfService');
  const spy = jest.spyOn(pdfService, 'renderContractWithSlots');
  try {
    const { contractId } = await sentContractFromQuote();
    const snapshot = parsed((await contractRow(contractId)).rendered_content);
    expect(spy).toHaveBeenCalledTimes(1);
    const ctx = spy.mock.calls[0][0];
    expect(ctx.quoteTotals).toEqual(snapshot.quote.totals);
    expect(ctx.quoteLineItems).toEqual(snapshot.quote.lineItems);
    expect(ctx.quoteSourceNumber).toBe(snapshot.quote.number);
  } finally {
    spy.mockRestore();
  }
});

test('editing the source quote after the send changes neither the hash nor the render', async () => {
  const { quoteId, contractId } = await sentContractFromQuote();
  const before = await contractRow(contractId);
  const pdfBefore = await contractService.renderContractPdfBuffer(contractId);

  // The price of the deal, changed on the quote after the contract went out.
  await db('quote_line_items').where({ quote_id: quoteId }).update({
    unit_price_minor: 999900, line_total_minor: 999900, description: 'Rewritten after the fact',
  });
  await db('quotes').where({ id: quoteId }).update({
    net_amount_minor: 999900, vat_amount_minor: 0, total_amount_minor: 999900,
  });

  const after = await contractRow(contractId);
  expect(after.rendered_content_sha256).toBe(before.rendered_content_sha256);
  expect(after.rendered_content).toBe(before.rendered_content);

  // The PDF that was sent is untouched and still hashes to what was recorded.
  expect(crypto.createHash('sha256').update(fs.readFileSync(after.pdf_path)).digest('hex'))
    .toBe(after.pdf_sha256);

  // And a re-render reads the snapshot, not the rewritten quote: the render
  // context is where that is decided, so it is where it is pinned. (The
  // buffers themselves are not compared — every PDFKit render writes a fresh
  // random /ID, so two renders of one unchanged contract differ by
  // construction; pdfService.theme.test.js pins byte stability at the
  // renderer, where `generatedAt` is fixed.)
  const data = await contractService.getContractById(contractId);
  const ctx = await renderContext.buildRenderContext(data.contract, data.inclusions, data.textSections || []);
  expect(ctx.quoteLineItems.map((li) => li.description)).toEqual(['Reportage, 8h']);
  expect(ctx.quoteTotals).toEqual(parsed(before.rendered_content).quote.totals);
  expect(ctx.quoteTotals.grossMinor).not.toBe(999900);
  expect(pdfBefore.length).toBeGreaterThan(0);
});

test('a contract sent before the snapshot carried totals still renders, from the quote', async () => {
  const { quoteId, contractId } = await sentContractFromQuote();
  // Exactly what such a contract holds: a format-1 snapshot, no `quote` key.
  const snapshot = parsed((await contractRow(contractId)).rendered_content);
  delete snapshot.quote;
  snapshot.format = 1;
  await db('contracts').where({ id: contractId }).update({ rendered_content: JSON.stringify(snapshot) });

  const data = await contractService.getContractById(contractId);
  const ctx = await renderContext.buildRenderContext(data.contract, data.inclusions, data.textSections || []);
  // Its commercial terms were never frozen and cannot be reconstructed, so
  // the live quote is the closest thing to the truth left.
  expect(ctx.quoteLineItems.length).toBeGreaterThan(0);
  expect(ctx.quoteTotals).toBeNull();
  expect(ctx.quoteSourceNumber).toBe((await db('quotes').where({ id: quoteId }).first()).quote_number);
  await expect(contractService.renderContractPdfBuffer(contractId)).resolves.toBeInstanceOf(Buffer);
});

test('a contract with no source quote freezes no commercial terms', async () => {
  const id = await contractService.createContract({ customerAccountId: customerId, title: 'No quote' }, adminId);
  await ok(request(contractsApp).post(`/api/admin/contracts/${id}/send`).set(auth));
  const snapshot = parsed((await contractRow(id)).rendered_content);
  expect(snapshot.format).toBe(2);
  expect(snapshot.quote).toBeUndefined();
});

test('the signing page shows the frozen price, and a format-1 contract shows none', async () => {
  const { quoteId, contractId } = await sentContractFromQuote();
  const quote = await db('quotes').where({ id: quoteId }).first();
  const view = await require('../../src/services/contract/publicView').buildPublicView(contractId);

  expect(view.commercial.sourceQuoteNumber).toBe(quote.quote_number);
  expect(view.commercial.lineItems.map((li) => li.description)).toEqual(['Reportage, 8h']);
  expect(view.commercial.totals.grossMinor).toBe(Number(quote.total_amount_minor));

  const snapshot = parsed((await contractRow(contractId)).rendered_content);
  delete snapshot.quote;
  await db('contracts').where({ id: contractId }).update({ rendered_content: JSON.stringify(snapshot) });
  const legacy = await require('../../src/services/contract/publicView').buildPublicView(contractId);
  // Re-reading the live quote here would show a signer figures that are not
  // the ones in the document they are signing.
  expect(legacy.commercial).toBeNull();
});

test('a generated document carries its manifest, and says so in the log', async () => {
  const attachments = require('../../src/services/contract/attachments');
  const { PDFDocument } = require('pdf-lib');
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  const { attachment } = await attachments.storeAttachment(Buffer.from(await pdf.save()), { name: 'Terms' }, adminId);

  const quoteId = await acceptedQuote();
  const { contractId } = await contractService.createFromQuote(quoteId, adminId);
  await db.transaction((trx) => attachments.writeContractAttachments(trx, contractId, [
    { attachmentId: attachment.id, delivery: 'separate' },
  ]));
  await ok(request(contractsApp).post(`/api/admin/contracts/${contractId}/send`).set(auth));

  const { documents } = await ok(request(contractsApp).get(`/api/admin/contracts/${contractId}/documents`).set(auth));
  const unsigned = documents.find((d) => d.kind === 'unsigned');
  // A separately delivered attachment is bound into nothing else, so its
  // checksum in the manifest is the only record of what went out.
  expect(unsigned.manifest.attachments).toEqual([expect.objectContaining({
    name: 'Terms', delivery: 'separate', pages: 1, sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
  })]);
  expect(unsigned.manifest.signaturePage).toBeGreaterThan(0);

  const logged = await db('activity_logs').where({ activity_type: 'contract_document_generated' }).orderBy('id', 'desc');
  const mine = logged.map((row) => parsed(row.metadata)).filter((m) => m.contractId === contractId);
  expect(mine).toHaveLength(1);
  expect(mine[0]).toMatchObject({
    kind: 'unsigned',
    pdfSha256: unsigned.sha256,
    contentSha256: (await contractRow(contractId)).rendered_content_sha256,
  });
  // The file on disk is the one the row names.
  const contract = await contractRow(contractId);
  expect(fs.existsSync(contract.pdf_path)).toBe(true);
});

test('a contract\'s attachments and free text land in its change history', async () => {
  const history = require('../../src/services/accountingHistory');
  const attachments = require('../../src/services/contract/attachments');
  const { PDFDocument } = require('pdf-lib');
  const pdf = await PDFDocument.create();
  pdf.addPage([210, 297]);
  const { attachment } = await attachments.storeAttachment(Buffer.from(await pdf.save()), { name: 'Privacy notice' }, adminId);

  const id = await contractService.createContract({ customerAccountId: customerId, title: 'Audited parts' }, adminId);
  await contractService.updateContract(id, {
    attachments: [{ attachmentId: attachment.id, delivery: 'merged' }],
    textSections: [{ section: 'closing', position: 1, heading: 'Notes', body: { en: 'Free text' } }],
  }, adminId);

  const entries = await history.listHistory('contract', id);
  const entities = entries.map((e) => `${e.entity_type}:${e.action}`);
  expect(entities).toEqual(expect.arrayContaining([
    'contract_attachment_inclusion:created',
    'contract_text_section:created',
  ]));
  // Both are filed under the contract — listHistory is already scoped to it
  // — and carry the source that wrote them rather than the clause wording.
  const textEntry = entries.find((e) => e.entity_type === 'contract_text_section');
  expect(textEntry.source).toBe('contract.update');
  expect(entries.find((e) => e.entity_type === 'contract_attachment_inclusion').source).toBe('contract.update');
});

test('a render that fails leaves the contract a draft with no stored PDF (send fails closed)', async () => {
  const quoteId = await acceptedQuote();
  const { contractId } = await contractService.createFromQuote(quoteId, adminId);
  const isolation = require('../../src/services/pdf/renderIsolation');
  const { AppError } = require('../../src/utils/errors');
  const spy = jest.spyOn(isolation, 'renderInWorker').mockImplementation(async () => {
    throw new AppError('The document could not be rendered', 422, 'PDF_RENDER_FAILED');
  });
  try {
    const res = await request(contractsApp).post(`/api/admin/contracts/${contractId}/send`).set(auth);
    expect(res.status).toBe(422);
    expect(res.body.code || res.body.error?.code).toBe('PDF_RENDER_FAILED');
  } finally {
    spy.mockRestore();
  }
  const row = await contractRow(contractId);
  expect(row.status).toBe('draft');
  expect(row.pdf_path || null).toBeNull();
  expect(row.rendered_content || null).toBeNull();
  const docs = await db('generated_documents').where({ doc_type: 'contract', doc_id: contractId });
  expect(docs).toHaveLength(0);
});
