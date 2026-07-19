/**
 * CRM mint-and-send paths — integration tests (#587).
 *
 * Pins the three document "mint" flows end-to-end through the real
 * HTTP → route → service → DB → email-queue → file pipeline:
 *
 *   1. POST /api/admin/quotes/:id/send        (draft → sent + PDF + token + email)
 *   2. POST /api/admin/invoices/:id/cancel    (issued → cancelled + Storno row)
 *      — the issue spec named this /:id/storno; the real route is
 *        /:id/cancel (invoiceService.cancelInvoice → createStorno).
 *   3. POST /api/admin/contracts/:id/countersign
 *      (signed_by_customer → fully_signed + stamped PDF + sha256 + email)
 *
 * Real SQLite with the full core-migration run (helpers/crmDb), real
 * pdfkit/pdf-lib rendering — no mock-fs, no network.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

// Full migration run + cold-requiring pdfService/emailProcessor is slow
// under CI load; match the other CRM integration suites.
jest.setTimeout(120000);

const CUSTOMER_EMAIL = 'customer@example.com';

// 1x1 transparent PNG — smallest valid signature pad output.
const SIGNATURE_DATA_URL = 'data:image/png;base64,'
  + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// SQLite round-trips dates inconsistently (epoch ms number, numeric
// string, or ISO string) — parse robustly before comparing.
const toMillis = (v) => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return Date.parse(v);
};

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Count embedded image XObjects per page via pdf-lib — used to prove BOTH
// signature stamps (customer + admin) made it into the final PDF instead of
// only asserting file existence/hash (codex review of #850 round 2).
async function countImagesPerPage(pdfPath) {
  const { PDFDocument, PDFName, PDFDict } = require('pdf-lib');
  const doc = await PDFDocument.load(fs.readFileSync(pdfPath));
  return doc.getPages().map((page) => {
    const resources = page.node.Resources();
    const xobjects = resources && resources.lookupMaybe(PDFName.of('XObject'), PDFDict);
    if (!xobjects) return 0;
    let images = 0;
    for (const [, ref] of xobjects.entries()) {
      const stream = page.doc.context.lookup(ref);
      const subtype = stream && stream.dict && stream.dict.get(PDFName.of('Subtype'));
      if (subtype && subtype.toString() === '/Image') images += 1;
    }
    return images;
  });
}

let db;
let cleanup;
let tmpDir;
// Real (symlink-resolved) storage root — on macOS os.tmpdir() returns
// /var/... while the services persist under process.cwd() which
// resolves to /private/var/....
let storageRoot;
let adminId;
let customerId;
let token;
let quoteApp;
let invoiceApp;
let contractApp;
let quoteService;
let invoiceService;
let contractService;

const prevCwd = process.cwd();

const auth = { get Authorization() { return `Bearer ${token}`; } };

async function enableFlag(key) {
  const updated = await db('feature_flags').where({ key }).update({ value: true });
  if (!updated) await db('feature_flags').insert({ key, value: true });
}

// ----- per-path seed helpers -----------------------------------------

async function seedQuote() {
  const id = await quoteService.createQuote({
    customerAccountId: customerId,
    currency: 'CHF',
    vatRate: 0,
    eventName: 'Testshooting',
    lineItems: [
      { position: 1, quantity: 1, description: 'Photo package', unit_price_minor: 150000, discount_percent: 0 },
    ],
  }, adminId);
  return id;
}

async function seedIssuedInvoice(status = 'sent') {
  const { invoiceIds } = await invoiceService.createInvoice({
    customerAccountId: customerId,
    currency: 'CHF',
    vatRate: 7.7,
    lineItems: [
      { position: 1, quantity: 1, description: 'Wedding coverage', unit_price_minor: 200000, discount_percent: 0 },
    ],
  }, adminId);
  const id = invoiceIds[0];
  // Fast-forward past the send step — Storno only applies to issued
  // documents (sent/paid/overdue), and rendering+sending the original
  // is covered by the quote path already.
  await db('invoices').where({ id }).update({
    status, sent_at: new Date(), updated_at: new Date(),
  });
  return db('invoices').where({ id }).first();
}

async function seedCustomerSignedContract() {
  const id = await contractService.createContract({
    customerAccountId: customerId,
    title: 'Fotografie-Vertrag',
  }, adminId);
  // Real send + customer-sign flow (codex review of #850): a direct
  // status UPDATE skipped the customer's signature asset and stamped
  // PDF, so countersign exercised its unsigned-PDF fallback and a
  // regression dropping the customer's signature would stay green.
  const { token } = await contractService.sendContract(id, adminId);
  await contractService.recordCustomerSignature({
    token,
    name: 'Custo Mer',
    ip: '127.0.0.1',
    signatureDataUrl: SIGNATURE_DATA_URL,
    accepted: true,
  });
  return db('contracts').where({ id }).first();
}

// ----- suite ----------------------------------------------------------

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  // Business-doc PDFs (quotes/invoices/contracts) persist under
  // `process.cwd()/storage/business-docs/...` — chdir into the temp dir
  // so every test artifact lands isolated and gets cleaned up.
  process.chdir(tmpDir);
  storageRoot = path.join(fs.realpathSync(tmpDir), 'storage', 'business-docs');

  // Fail-fast on the pre-existing logActivity-inside-transaction
  // deadlock: createContract and createStorno call logActivity() from
  // inside a knex transaction WITHOUT passing the trx as executor, so
  // the audit insert tries to grab a second connection from the
  // single-connection SQLite pool while the trx holds it. In
  // production that stalls each call for the full 60 s acquire
  // timeout (the error is then swallowed by logActivity's catch);
  // here we shrink the timeout so the same swallowed failure costs
  // 2 s instead of blowing the per-test budget. Behaviour under test
  // is unchanged — the mint paths themselves never wait on this.
  db.client.pool.acquireTimeoutMillis = 2000;

  // node-sqlite3 detects Date bind params via `InstanceOf(global.Date)`
  // against the NATIVE realm's Date — under jest's vm sandbox the
  // service code's `new Date()` is a different constructor, the check
  // fails, and the value stringifies to the literal "[object Object]"
  // (the exact pathology helpers/crmDb.js documents for
  // createPublicToken). Normalize Date bindings to ISO strings before
  // they reach the driver so the real service inserts round-trip the
  // same way they do outside jest.
  // Patch on the prototype — knex mints transaction clients via
  // Object.create(prototype), so an instance-level patch would miss
  // every query issued inside a db.transaction().
  const clientProto = Object.getPrototypeOf(db.client);
  const origQuery = clientProto._query;
  clientProto._query = function patchedQuery(connection, obj) {
    if (obj && Array.isArray(obj.bindings)) {
      obj.bindings = obj.bindings.map(
        (b) => (b && typeof b === 'object' && typeof b.toISOString === 'function' ? b.toISOString() : b),
      );
    }
    return origQuery.call(this, connection, obj);
  };

  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);

  // CRM surfaces are feature-flagged; migration 107 seeds them OFF.
  await enableFlag('quotes');
  await enableFlag('bills');
  await enableFlag('contracts');

  quoteService = require('../../src/services/quoteService');
  invoiceService = require('../../src/services/invoiceService');
  contractService = require('../../src/services/contractService');

  quoteApp = buildRouteApp('/api/admin/quotes', require('../../src/routes/adminQuotes'));
  invoiceApp = buildRouteApp('/api/admin/invoices', require('../../src/routes/adminInvoices'));
  contractApp = buildRouteApp('/api/admin/contracts', require('../../src/routes/adminContracts'));
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

describe('POST /api/admin/quotes/:id/send', () => {
  test('draft quote: 200 → sent + sent_at + PDF on disk + action token + quote_sent email', async () => {
    const quoteId = await seedQuote();
    await db('email_queue').del();

    const res = await request(quoteApp)
      .post(`/api/admin/quotes/${quoteId}/send`)
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(true);
    expect(res.body.token).toMatch(/^[0-9a-f]{64}$/);

    // DB state
    const quote = await db('quotes').where({ id: quoteId }).first();
    expect(quote.status).toBe('sent');
    expect(quote.sent_at).toBeTruthy();

    // PDF persisted inside the isolated storage root
    expect(quote.pdf_path).toBeTruthy();
    expect(quote.pdf_path.startsWith(path.join(storageRoot, 'quote'))).toBe(true);
    expect(fs.existsSync(quote.pdf_path)).toBe(true);
    expect(fs.statSync(quote.pdf_path).size).toBeGreaterThan(0);

    // Action token row: right quote, future expiry
    const tokenRow = await db('quote_action_tokens').where({ token: res.body.token }).first();
    expect(tokenRow).toBeTruthy();
    expect(tokenRow.quote_id).toBe(quoteId);
    expect(toMillis(tokenRow.expires_at)).toBeGreaterThan(Date.now());

    // Email queued to the customer's primary address
    const emails = await db('email_queue').where({ email_type: 'quote_sent' });
    expect(emails).toHaveLength(1);
    expect(emails[0].recipient_email).toBe(CUSTOMER_EMAIL);
    const emailData = JSON.parse(emails[0].email_data);
    expect(emailData.quote_number).toBe(quote.quote_number);
  });

  test('already-sent quote: 409 (spec said 400; service throws 409)', async () => {
    const quoteId = await seedQuote();
    await request(quoteApp).post(`/api/admin/quotes/${quoteId}/send`).set(auth).expect(200);

    const res = await request(quoteApp)
      .post(`/api/admin/quotes/${quoteId}/send`)
      .set(auth);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/cannot send a quote with status 'sent'/i);
  });
});

describe('POST /api/admin/invoices/:id/cancel (Storno mint)', () => {
  test('sent invoice: original cancelled, Storno row minted with negated totals + lineage', async () => {
    const original = await seedIssuedInvoice('sent');
    await db('email_queue').del();

    const res = await request(invoiceApp)
      .post(`/api/admin/invoices/${original.id}/cancel`)
      .set(auth);
    // Route responds via successResponse default — 200, not the 201
    // the issue spec assumed.
    expect(res.status).toBe(200);
    expect(res.body.cancelled).toBe(true);
    expect(res.body.stornoId).toBeGreaterThan(0);

    const storno = await db('invoices').where({ id: res.body.stornoId }).first();
    expect(storno.kind).toBe('storno');
    expect(storno.cancels_invoice_id).toBe(original.id);
    expect(storno.deal_uuid).toBe(original.deal_uuid);

    // Negated amounts
    expect(storno.net_amount_minor).toBe(-original.net_amount_minor);
    expect(storno.vat_amount_minor).toBe(-original.vat_amount_minor);
    expect(storno.total_amount_minor).toBe(-original.total_amount_minor);

    // Freshly sequenced number from the same series
    expect(typeof storno.invoice_number).toBe('string');
    expect(storno.invoice_number.length).toBeGreaterThan(0);
    expect(storno.invoice_number).not.toBe(original.invoice_number);

    // Line items snapshotted onto the Storno
    const originalItems = await db('invoice_line_items').where({ invoice_id: original.id });
    const stornoItems = await db('invoice_line_items').where({ invoice_id: storno.id });
    expect(stornoItems).toHaveLength(originalItems.length);

    // Original flipped + back-linked
    const refreshed = await db('invoices').where({ id: original.id }).first();
    expect(refreshed.status).toBe('cancelled');
    expect(refreshed.cancellation_storno_id).toBe(storno.id);

    // sendStorno side effects (codex review of #850): cancelInvoice
    // swallows a sendStorno failure by design, so without these
    // assertions a broken render/persist/queue leg would stay green.
    const sentStorno = await db('invoices').where({ id: storno.id }).first();
    expect(sentStorno.status).toBe('sent');
    expect(sentStorno.pdf_path).toBeTruthy();
    expect(fs.existsSync(sentStorno.pdf_path)).toBe(true);
    const stornoEmails = await db('email_queue').where({ email_type: 'storno_issued' });
    expect(stornoEmails.length).toBeGreaterThanOrEqual(1);
    expect(stornoEmails[0].recipient_email).toBe(CUSTOMER_EMAIL);
  });

  test('paid invoice can be cancelled via Storno too (refund document leg)', async () => {
    const original = await seedIssuedInvoice('paid');

    const res = await request(invoiceApp)
      .post(`/api/admin/invoices/${original.id}/cancel`)
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body.stornoId).toBeGreaterThan(0);

    const refreshed = await db('invoices').where({ id: original.id }).first();
    expect(refreshed.status).toBe('cancelled');
  });

  test('already-cancelled invoice: 409 ALREADY_CANCELLED', async () => {
    const original = await seedIssuedInvoice('sent');
    await request(invoiceApp).post(`/api/admin/invoices/${original.id}/cancel`).set(auth).expect(200);

    const res = await request(invoiceApp)
      .post(`/api/admin/invoices/${original.id}/cancel`)
      .set(auth);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_CANCELLED');
  });
});

describe('POST /api/admin/contracts/:id/countersign', () => {
  test('customer-signed contract: 200 → fully_signed + stamped PDF + sha256 + signature asset + email with attachment', async () => {
    const contract = await seedCustomerSignedContract();
    await db('email_queue').del();

    const res = await request(contractApp)
      .post(`/api/admin/contracts/${contract.id}/countersign`)
      .set(auth)
      .send({ name: 'Admin Tester', signatureDataUrl: SIGNATURE_DATA_URL });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('fully_signed');

    const row = await db('contracts').where({ id: contract.id }).first();
    expect(row.status).toBe('fully_signed');
    expect(row.signed_admin_name).toBe('Admin Tester');
    expect(row.signed_by_admin_at).toBeTruthy();

    // The customer's own signature (from the real sign flow in the seed)
    // must survive countersigning — layered, not replaced.
    expect(row.signed_customer_signature_path).toBeTruthy();
    expect(fs.existsSync(row.signed_customer_signature_path)).toBe(true);
    expect(row.signed_customer_name).toBe('Custo Mer');

    // Admin signature image persisted under the storage root
    expect(row.signed_admin_signature_path).toBeTruthy();
    expect(row.signed_admin_signature_path.startsWith(
      path.join(storageRoot, 'contract', 'signatures'),
    )).toBe(true);
    expect(fs.existsSync(row.signed_admin_signature_path)).toBe(true);

    // Stamped, fully-signed PDF written and hashed. The issue spec
    // called this `integrity_hash`; the real column is
    // `signed_pdf_sha256` (plus `pdf_sha256` for the unsigned base).
    expect(row.signed_pdf_render_failed_at).toBeFalsy();
    expect(row.signed_pdf_path).toBeTruthy();
    expect(fs.existsSync(row.signed_pdf_path)).toBe(true);
    expect(row.signed_pdf_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256(fs.readFileSync(row.signed_pdf_path))).toBe(row.signed_pdf_sha256);

    // BOTH stamps must be embedded in the final document — a regression
    // stamping the admin onto the unsigned base PDF would keep every
    // path/hash assertion above green (codex review of #850 round 2).
    const imagesPerPage = await countImagesPerPage(row.signed_pdf_path);
    const maxImagesOnAPage = Math.max(...imagesPerPage);
    expect(maxImagesOnAPage).toBeGreaterThanOrEqual(2);

    // contract_fully_signed email to the customer's primary address,
    // carrying the signed PDF as attachment (plus the audit cert).
    const emails = await db('email_queue').where({ email_type: 'contract_fully_signed' });
    const customerCopy = emails.find((e) => e.recipient_email === CUSTOMER_EMAIL);
    expect(customerCopy).toBeTruthy();
    const emailData = JSON.parse(customerCopy.email_data);
    expect(emailData.contract_number).toBe(contract.contract_number);
    expect(Array.isArray(emailData.attachments)).toBe(true);
    const pdfAttachment = emailData.attachments.find(
      (a) => a.filename === `${contract.contract_number}-signed.pdf`,
    );
    expect(pdfAttachment).toBeTruthy();
    expect(pdfAttachment.contentType).toBe('application/pdf');
    expect(fs.existsSync(pdfAttachment.contentPath)).toBe(true);
  });

  test('draft contract: 409 — countersign requires sent/signed_by_customer', async () => {
    const draftId = await contractService.createContract({
      customerAccountId: customerId,
      title: 'Noch nicht versendet',
    }, adminId);

    const res = await request(contractApp)
      .post(`/api/admin/contracts/${draftId}/countersign`)
      .set(auth)
      .send({ name: 'Admin Tester' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/cannot counter-sign a contract with status 'draft'/i);
  });
});
