/**
 * A draft quote's customer change, against the send path.
 *
 * quoteService -> SQLite with the full core-migration run (helpers/crmDb).
 * Pins:
 *   - a resend after a customer change never rewrites the file an earlier
 *     send's queued email attaches;
 *   - a customer change is refused on a quote an invoice was made from even
 *     when the admin may not read invoices;
 *   - a send that read the quote before a customer change records nothing,
 *     mints no link, queues no email and keeps no file;
 *   - an overlapping save that changed the customer refuses the other save.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let tmpDir;
let adminId;
let customerId;
let otherCustomerId;
let quoteService;

const prevCwd = process.cwd();

async function insertId(table, row) {
  const [inserted] = await db(table).insert(row).returning('id');
  return inserted?.id ?? inserted;
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  ({ adminId, customerId } = await seedMinimal(db));
  quoteService = require('../../src/services/quoteService');
  otherCustomerId = await insertId('customer_accounts', {
    email: 'other@example.com', display_name: 'Other Customer', preferred_language: 'en', is_active: 1,
    created_at: new Date().toISOString(),
  });
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

const draft = () => quoteService.createQuote({
  customerAccountId: customerId, currency: 'CHF', vatRate: 0,
  lineItems: [{ position: 1, quantity: 1, description: 'Wedding day', unit_price_minor: 100000 }],
}, adminId);

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const storedFilesOf = (quoteNumber) => {
  const root = path.join(require('../../src/config/storage').getStoragePath(), 'business-docs', 'quote', String(new Date().getFullYear()));
  return fs.existsSync(root) ? fs.readdirSync(root).filter((f) => f.startsWith(quoteNumber)) : [];
};

test('a resend to another customer leaves the file the first send\'s email attaches untouched', async () => {
  const quoteId = await draft();
  const first = await quoteService.sendQuote(quoteId, adminId);
  const firstHash = sha(first.pdfPath);

  // Reopened, moved to another customer and sent again while the first
  // customer's email still waits in the queue.
  await quoteService.updateQuote(quoteId, { eventName: 'Reopened' }, adminId);
  await quoteService.updateQuote(quoteId, { customerAccountId: otherCustomerId }, adminId);
  const second = await quoteService.sendQuote(quoteId, adminId);

  expect(second.pdfPath).not.toBe(first.pdfPath);
  expect(sha(first.pdfPath)).toBe(firstHash);
  expect(fs.existsSync(second.pdfPath)).toBe(true);
});

test('a customer change is refused on a quote an invoice was made from, also for an admin who may not read invoices', async () => {
  const quoteId = await draft();
  await db('invoices').insert({
    invoice_number: `HARD-INV-${quoteId}`, customer_account_id: customerId, issue_date: '2026-06-01',
    due_date: '2026-06-30', status: 'draft', currency: 'CHF', net_amount_minor: 10000, vat_amount_minor: 0,
    total_amount_minor: 10000, created_by_admin_id: adminId, deal_uuid: crypto.randomUUID(), source_quote_id: quoteId,
  });
  const { withCrmActor } = require('../../src/database/crmAccess');
  const quotesOnly = { id: adminId, roleName: 'admin', permissions: new Set(['quotes.view', 'quotes.manage']) };

  await expect(withCrmActor(quotesOnly, () => quoteService.updateQuote(quoteId, { customerAccountId: otherCustomerId }, adminId)))
    .rejects.toMatchObject({ statusCode: 409, code: 'QUOTE_HAS_DOCUMENTS' });
  expect(Number((await db('quotes').where({ id: quoteId }).first()).customer_account_id)).toBe(customerId);
});

test('a send that read the quote before its customer changed records and emails nothing', async () => {
  const quoteId = await draft();
  const { quote_number: quoteNumber } = await db('quotes').where({ id: quoteId }).first();
  const queuedBefore = (await db('email_queue').where({ email_type: 'quote_sent' })).length;
  const pdfService = require('../../src/services/pdfService');
  const realRender = pdfService.renderQuoteToBuffer;
  // The admin saves another customer while the send renders the PDF.
  const spy = jest.spyOn(pdfService, 'renderQuoteToBuffer').mockImplementationOnce(async (...args) => {
    await quoteService.updateQuote(quoteId, { customerAccountId: otherCustomerId }, adminId);
    return realRender(...args);
  });
  try {
    await expect(quoteService.sendQuote(quoteId, adminId)).rejects.toMatchObject({ statusCode: 409, code: 'QUOTE_CHANGED' });
  } finally {
    spy.mockRestore();
  }

  const row = await db('quotes').where({ id: quoteId }).first();
  expect(row.status).toBe('draft');
  expect(Number(row.customer_account_id)).toBe(otherCustomerId);
  expect(row.sent_at).toBeNull();
  expect(await db('quote_action_tokens').where({ quote_id: quoteId })).toHaveLength(0);
  expect(await db('email_queue').where({ email_type: 'quote_sent' })).toHaveLength(queuedBefore);
  expect(storedFilesOf(quoteNumber)).toHaveLength(0);

  // Sent again, it goes to the new customer.
  await quoteService.sendQuote(quoteId, adminId);
  expect((await db('quotes').where({ id: quoteId }).first()).status).toBe('sent');
  const queued = await db('email_queue').where({ email_type: 'quote_sent' });
  expect(queued).toHaveLength(queuedBefore + 1);
  expect(queued[queued.length - 1].recipient_email).toBe('other@example.com');
  expect(storedFilesOf(quoteNumber)).toHaveLength(1);
});

test('a save is refused when another save changed the customer after it was read', async () => {
  const quoteId = await draft();
  const businessProfileService = require('../../src/services/businessProfileService');
  const realResolve = businessProfileService.resolveBankAccountForCurrency;
  // Another save moves the quote to the other customer while this one
  // resolves the new currency's bank account.
  const spy = jest.spyOn(businessProfileService, 'resolveBankAccountForCurrency').mockImplementationOnce(async (...args) => {
    await db('quotes').where({ id: quoteId }).update({ customer_account_id: otherCustomerId });
    return realResolve(...args);
  });
  try {
    await expect(quoteService.updateQuote(quoteId, { currency: 'EUR' }, adminId))
      .rejects.toMatchObject({ statusCode: 409, code: 'QUOTE_CHANGED' });
  } finally {
    spy.mockRestore();
  }
  expect((await db('quotes').where({ id: quoteId }).first()).currency).toBe('CHF');
});
