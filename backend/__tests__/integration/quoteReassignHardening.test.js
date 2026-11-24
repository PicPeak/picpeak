/**
 * A draft quote's customer change and payment term, against the send and
 * accept paths.
 *
 * quoteService -> SQLite with the full core-migration run (helpers/crmDb).
 * Pins:
 *   - an edited sent quote accepted on the customer's behalf without a new
 *     send freezes the term the admin last saved, not the one sent before;
 *   - editing a sent or expired quote drops the term it was sent with, so a
 *     decline on the customer's behalf shows the edited term;
 *   - an invoice made from the quote keeps its own term through the edit and
 *     an acceptance (frozen at creation, invoice/paymentTerm);
 *   - an overlapping save that changed the customer refuses the other save;
 *   - a customer change is refused on a quote an invoice was made from even
 *     when the admin may not read invoices;
 *   - a send that read the quote before a customer change records nothing,
 *     mints no link, queues no email and keeps no stored version.
 */

const crypto = require('crypto');
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

const draft = (extra = {}) => quoteService.createQuote({
  customerAccountId: customerId, currency: 'CHF', vatRate: 0,
  lineItems: [{ position: 1, quantity: 1, description: 'Wedding day', unit_price_minor: 100000 }],
  ...extra,
}, adminId);

test('accepting an edited sent quote without a resend freezes the term the admin saved', async () => {
  const net30 = await insertId('payment_net_days_templates', { name: 'Net 30', description: '30 days net', net_days: 30 });
  const net10 = await insertId('payment_net_days_templates', { name: 'Net 10', description: '10 days net', net_days: 10 });
  const timing = await insertId('payment_timing_templates', {
    name: 'All after', description: 'Everything after the event',
    installments: JSON.stringify([{ percent: 100, label: 'Full' }]),
  });
  const quoteId = await draft({ paymentNetDaysTemplateId: net30, paymentTimingTemplateId: timing });
  // Sent with Net 30.
  const { quote } = await quoteService.getQuoteById(quoteId);
  const sentTerm = await quoteService._internal.resolvePaymentTerm(quote);
  await db('quotes').where({ id: quoteId }).update({ status: 'sent', payment_term_snapshot: JSON.stringify(sentTerm) });

  // Edited to Net 10 (back to draft), then accepted on the customer's behalf.
  await quoteService.updateQuote(quoteId, { paymentNetDaysTemplateId: net10 }, adminId);
  await quoteService.adminAcceptQuote(quoteId, adminId);

  const accepted = await quoteService.getQuoteById(quoteId);
  expect(accepted.quote.status).toBe('accepted');
  expect(JSON.parse(accepted.quote.payment_term_snapshot)).toEqual(expect.objectContaining({ net_days: 10 }));
  const ctx = await quoteService._internal.buildRenderContext(accepted.quote, accepted.lineItems);
  expect(ctx.paymentTerm).toEqual(expect.objectContaining({ netDays: 10 }));
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
  expect(await db('email_queue').where({ email_type: 'quote_sent' })).toHaveLength(0);
  const versions = await db('generated_documents').where({ doc_type: 'quote', doc_id: quoteId });
  expect(versions).toHaveLength(0);

  // Sent again, it goes to the new customer.
  await quoteService.sendQuote(quoteId, adminId);
  const sent = await db('quotes').where({ id: quoteId }).first();
  expect(sent.status).toBe('sent');
  expect(await db('generated_documents').where({ doc_type: 'quote', doc_id: quoteId })).toHaveLength(1);
  const queued = await db('email_queue').where({ email_type: 'quote_sent' });
  expect(queued.map((e) => e.recipient_email)).toEqual(['other@example.com']);
});

const netAndTiming = async (name, net) => ({
  paymentNetDaysTemplateId: await insertId('payment_net_days_templates', { name, description: `${net.net_days} days net`, ...net }),
  paymentTimingTemplateId: await insertId('payment_timing_templates', {
    name: `${name} timing`, description: 'Everything after the event',
    installments: JSON.stringify([{ percent: 100, label: 'Full' }]),
  }),
});
const sendWith = async (quoteId) => {
  const { quote } = await quoteService.getQuoteById(quoteId);
  const sentTerm = await quoteService._internal.resolvePaymentTerm(quote);
  await db('quotes').where({ id: quoteId }).update({ status: 'sent', payment_term_snapshot: JSON.stringify(sentTerm) });
};
const pdfTerm = async (quoteId) => {
  const { quote, lineItems } = await quoteService.getQuoteById(quoteId);
  return (await quoteService._internal.buildRenderContext(quote, lineItems)).paymentTerm;
};

test('a sent Net 30 quote edited to Net 10 and declined on the customer\'s behalf shows Net 10', async () => {
  const net30 = await netAndTiming('Decline Net 30', { net_days: 30 });
  const net10 = await netAndTiming('Decline Net 10', { net_days: 10 });
  const quoteId = await draft(net30);
  await sendWith(quoteId);

  await quoteService.updateQuote(quoteId, { paymentNetDaysTemplateId: net10.paymentNetDaysTemplateId }, adminId);
  expect((await db('quotes').where({ id: quoteId }).first()).payment_term_snapshot).toBeNull();
  await quoteService.adminDeclineQuote(quoteId, adminId);

  expect((await db('quotes').where({ id: quoteId }).first()).status).toBe('declined');
  expect(await pdfTerm(quoteId)).toEqual(expect.objectContaining({ netDays: 10 }));
});

test('an edited expired quote keeps no stale term', async () => {
  const net30 = await netAndTiming('Expired Net 30', { net_days: 30 });
  const net10 = await netAndTiming('Expired Net 10', { net_days: 10 });
  const quoteId = await draft(net30);
  await sendWith(quoteId);
  await db('quotes').where({ id: quoteId }).update({ status: 'expired' });

  await quoteService.updateQuote(quoteId, { paymentNetDaysTemplateId: net10.paymentNetDaysTemplateId }, adminId);

  const row = await db('quotes').where({ id: quoteId }).first();
  expect(row.status).toBe('expired');
  expect(row.payment_term_snapshot).toBeNull();
  expect(await pdfTerm(quoteId)).toEqual(expect.objectContaining({ netDays: 10 }));
});

test('an invoice made from a sent quote keeps its Skonto through an edit and an admin acceptance', async () => {
  const skonto3 = await netAndTiming('Keep Skonto 3', { net_days: 20, skonto_percent: 3, skonto_within_days: 10 });
  const skonto1 = await netAndTiming('Keep Skonto 1', { net_days: 10, skonto_percent: 1, skonto_within_days: 5 });
  const quoteId = await draft(skonto3);
  await sendWith(quoteId);
  const invoiceService = require('../../src/services/invoiceService');
  const { invoiceIds: [invoiceId] } = await invoiceService.createInvoice({
    customerAccountId: customerId, sourceQuoteId: quoteId, currency: 'CHF', vatRate: 0,
    lineItems: [{ position: 1, quantity: 1, description: 'Deposit', unit_price_minor: 10000 }],
  }, adminId);
  const invoice = () => db('invoices').where({ id: invoiceId }).first();
  expect(await invoiceService.resolveSkontoPercentForInvoice(await invoice())).toBe(3);

  await quoteService.updateQuote(quoteId, { paymentNetDaysTemplateId: skonto1.paymentNetDaysTemplateId }, adminId);
  expect(await invoiceService.resolveSkontoPercentForInvoice(await invoice())).toBe(3);
  await quoteService.adminAcceptQuote(quoteId, adminId);

  expect(JSON.parse((await db('quotes').where({ id: quoteId }).first()).payment_term_snapshot))
    .toEqual(expect.objectContaining({ skonto_percent: 1 }));
  expect(await invoiceService.resolveSkontoPercentForInvoice(await invoice())).toBe(3);
  const { buildInvoiceRenderContext } = require('../../src/services/invoice/render');
  expect((await buildInvoiceRenderContext(await invoice(), [])).paymentTerm)
    .toEqual(expect.objectContaining({ netDays: 20, skontoPercent: 3, skontoWithinDays: 10 }));
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
  const row = await db('quotes').where({ id: quoteId }).first();
  expect(row.currency).toBe('CHF');
});
