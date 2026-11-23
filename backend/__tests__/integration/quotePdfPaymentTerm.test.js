/**
 * Quote PDF payment term.
 *
 * quoteService -> SQLite with the full core-migration run (helpers/crmDb).
 * Pins: the quote PDF reads the payment term from the split net-days /
 * timing pickers, like sendQuote, and falls back to the legacy single
 * template. A quote that is no longer a draft renders the term sendQuote
 * snapshotted, even after its template was edited.
 */

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let tmpDir;
let adminId;
let customerId;
let quoteService;

const prevCwd = process.cwd();

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  ({ adminId, customerId } = await seedMinimal(db));
  // Required after bootCrmDb: at module load it would initialise the db
  // module before the helper points it at the temp database.
  quoteService = require('../../src/services/quoteService');
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

describe('buildRenderContext payment term', () => {
  async function insertId(table, row) {
    const [inserted] = await db(table).insert(row).returning('id');
    return inserted?.id ?? inserted;
  }

  it('renders the term from the split pickers when no legacy template is set', async () => {
    const netDaysId = await insertId('payment_net_days_templates', {
      name: 'Net 20', description: 'Payable within 20 days', net_days: 20,
    });
    const timingId = await insertId('payment_timing_templates', {
      name: 'Half now, half later', description: '50% on booking, 50% after the event',
      installments: JSON.stringify([{ percent: 50, label: 'Deposit' }, { percent: 50, label: 'Balance' }]),
    });
    const quoteId = await quoteService.createQuote({
      customerAccountId: customerId, currency: 'CHF', vatRate: 0,
      paymentNetDaysTemplateId: netDaysId, paymentTimingTemplateId: timingId,
      lineItems: [{ position: 1, quantity: 1, description: 'Wedding day', unit_price_minor: 100000 }],
    }, adminId);
    const { quote, lineItems } = await quoteService.getQuoteById(quoteId);
    expect(quote.payment_term_template_id).toBeNull();

    const ctx = await quoteService._internal.buildRenderContext(quote, lineItems);
    expect(ctx.paymentTerm).toEqual(expect.objectContaining({
      description: '50% on booking, 50% after the event',
      netDays: 20,
    }));
  });

  it('still renders the legacy single template', async () => {
    const legacyId = await insertId('payment_term_templates', {
      name: 'Legacy 10', description: 'Legacy: 10 days net', net_days: 10,
      installments: JSON.stringify([{ percent: 100, label: 'Full' }]),
    });
    const quoteId = await quoteService.createQuote({
      customerAccountId: customerId, currency: 'CHF', vatRate: 0, paymentTermTemplateId: legacyId,
      lineItems: [{ position: 1, quantity: 1, description: 'Portraits', unit_price_minor: 50000 }],
    }, adminId);
    const { quote, lineItems } = await quoteService.getQuoteById(quoteId);

    const ctx = await quoteService._internal.buildRenderContext(quote, lineItems);
    expect(ctx.paymentTerm).toEqual(expect.objectContaining({ description: 'Legacy: 10 days net', netDays: 10 }));
  });

  it('renders a sent quote from its snapshot after the template was edited', async () => {
    const netDaysId = await insertId('payment_net_days_templates', {
      name: 'Net 30', description: 'Payable within 30 days', net_days: 30,
    });
    const timingId = await insertId('payment_timing_templates', {
      name: 'All after', description: 'Everything after the event',
      installments: JSON.stringify([{ percent: 100, label: 'Full' }]),
    });
    const quoteId = await quoteService.createQuote({
      customerAccountId: customerId, currency: 'CHF', vatRate: 0,
      paymentNetDaysTemplateId: netDaysId, paymentTimingTemplateId: timingId,
      lineItems: [{ position: 1, quantity: 1, description: 'Album', unit_price_minor: 40000 }],
    }, adminId);
    let { quote } = await quoteService.getQuoteById(quoteId);
    const snapshot = await quoteService._internal.resolvePaymentTerm(quote);
    await db('quotes').where({ id: quoteId })
      .update({ status: 'sent', payment_term_snapshot: JSON.stringify(snapshot) });
    await db('payment_net_days_templates').where({ id: netDaysId }).update({ net_days: 45 });
    await db('payment_timing_templates').where({ id: timingId }).update({ description: 'Edited later' });

    let lineItems;
    ({ quote, lineItems } = await quoteService.getQuoteById(quoteId));
    const sent = await quoteService._internal.buildRenderContext(quote, lineItems);
    expect(sent.paymentTerm).toEqual(expect.objectContaining({ description: 'Everything after the event', netDays: 30 }));

    // Back to draft, the quote shows the templates as they are now.
    const draft = await quoteService._internal.buildRenderContext({ ...quote, status: 'draft' }, lineItems);
    expect(draft.paymentTerm).toEqual(expect.objectContaining({ description: 'Edited later', netDays: 45 }));
  });

  it('freezes the edited term when an edited sent quote is accepted on the customer\'s behalf', async () => {
    const net30 = await insertId('payment_net_days_templates', { name: 'Accept Net 30', description: '30 days net', net_days: 30 });
    const net10 = await insertId('payment_net_days_templates', { name: 'Accept Net 10', description: '10 days net', net_days: 10 });
    const timingId = await insertId('payment_timing_templates', {
      name: 'Accept all after', description: 'Everything after the event',
      installments: JSON.stringify([{ percent: 100, label: 'Full' }]),
    });
    const quoteId = await quoteService.createQuote({
      customerAccountId: customerId, currency: 'CHF', vatRate: 0,
      paymentNetDaysTemplateId: net30, paymentTimingTemplateId: timingId,
      lineItems: [{ position: 1, quantity: 1, description: 'Prints', unit_price_minor: 30000 }],
    }, adminId);
    // Sent with Net 30.
    const { quote } = await quoteService.getQuoteById(quoteId);
    const sentTerm = await quoteService._internal.resolvePaymentTerm(quote);
    await db('quotes').where({ id: quoteId }).update({ status: 'sent', payment_term_snapshot: JSON.stringify(sentTerm) });

    // Edited to Net 10 (back to draft), then accepted without a new send.
    await quoteService.updateQuote(quoteId, { paymentNetDaysTemplateId: net10 }, adminId);
    await quoteService.adminAcceptQuote(quoteId, adminId);

    const accepted = await quoteService.getQuoteById(quoteId);
    expect(accepted.quote.status).toBe('accepted');
    expect(JSON.parse(accepted.quote.payment_term_snapshot)).toEqual(expect.objectContaining({ net_days: 10 }));
    const ctx = await quoteService._internal.buildRenderContext(accepted.quote, accepted.lineItems);
    expect(ctx.paymentTerm).toEqual(expect.objectContaining({ netDays: 10 }));
  });

  it('keeps the term an invoice made from a sent quote inherits when the quote is edited', async () => {
    const netId = await insertId('payment_net_days_templates', {
      name: 'Inherit Net 20', description: '20 days net', net_days: 20, skonto_percent: 3, skonto_within_days: 10,
    });
    const timingId = await insertId('payment_timing_templates', {
      name: 'Inherit all after', description: 'Everything after the event',
      installments: JSON.stringify([{ percent: 100, label: 'Full' }]),
    });
    const quoteId = await quoteService.createQuote({
      customerAccountId: customerId, currency: 'CHF', vatRate: 0,
      paymentNetDaysTemplateId: netId, paymentTimingTemplateId: timingId,
      lineItems: [{ position: 1, quantity: 1, description: 'Prints', unit_price_minor: 30000 }],
    }, adminId);
    const { quote } = await quoteService.getQuoteById(quoteId);
    const sentTerm = await quoteService._internal.resolvePaymentTerm(quote);
    await db('quotes').where({ id: quoteId }).update({ status: 'sent', payment_term_snapshot: JSON.stringify(sentTerm) });
    const invoiceId = await insertId('invoices', {
      invoice_number: `INHERIT-${quoteId}`, customer_account_id: customerId, issue_date: '2026-06-01',
      due_date: '2026-06-30', status: 'draft', currency: 'CHF', net_amount_minor: 10000, vat_amount_minor: 0,
      total_amount_minor: 10000, created_by_admin_id: adminId, deal_uuid: require('crypto').randomUUID(), source_quote_id: quoteId,
    });
    const { resolveSkontoPercentForInvoice } = require('../../src/services/invoiceService');
    const invoice = () => db('invoices').where({ id: invoiceId }).first();
    expect(await resolveSkontoPercentForInvoice(await invoice())).toBe(3);

    await quoteService.updateQuote(quoteId, { eventName: 'Renamed' }, adminId);

    expect(await resolveSkontoPercentForInvoice(await invoice())).toBe(3);
  });

  it('leaves out the timing template\'s schedule text when the quote overrides its installments', async () => {
    const netDaysId = await insertId('payment_net_days_templates', {
      name: 'Override Net 15', description: 'Payable within 15 days', net_days: 15,
    });
    const timingId = await insertId('payment_timing_templates', {
      name: 'Override half', description: '50% on booking, 50% after the event',
      installments: JSON.stringify([{ percent: 50, label: 'Deposit' }, { percent: 50, label: 'Balance' }]),
    });
    const quoteId = await quoteService.createQuote({
      customerAccountId: customerId, currency: 'CHF', vatRate: 0,
      paymentNetDaysTemplateId: netDaysId, paymentTimingTemplateId: timingId,
      installments: [{ percent: 30, label: 'Deposit' }, { percent: 70, label: 'Balance' }],
      lineItems: [{ position: 1, quantity: 1, description: 'Reportage', unit_price_minor: 100000 }],
    }, adminId);
    const { quote, lineItems } = await quoteService.getQuoteById(quoteId);
    expect(quote.payment_term_installments_override).toBeTruthy();

    const ctx = await quoteService._internal.buildRenderContext(quote, lineItems);
    expect(ctx.paymentTerm).toEqual(expect.objectContaining({ description: 'Payable within 15 days', netDays: 15 }));
  });

  it('keeps the term an invoice inherited when an edited quote is accepted on the customer\'s behalf', async () => {
    const net3 = await insertId('payment_net_days_templates', {
      name: 'Accept Skonto 3', description: '20 days net', net_days: 20, skonto_percent: 3, skonto_within_days: 10,
    });
    const net1 = await insertId('payment_net_days_templates', {
      name: 'Accept Skonto 1', description: '10 days net', net_days: 10, skonto_percent: 1, skonto_within_days: 5,
    });
    const timingId = await insertId('payment_timing_templates', {
      name: 'Accept inherit all after', description: 'Everything after the event',
      installments: JSON.stringify([{ percent: 100, label: 'Full' }]),
    });
    const quoteId = await quoteService.createQuote({
      customerAccountId: customerId, currency: 'CHF', vatRate: 0,
      paymentNetDaysTemplateId: net3, paymentTimingTemplateId: timingId,
      lineItems: [{ position: 1, quantity: 1, description: 'Prints', unit_price_minor: 30000 }],
    }, adminId);
    const { quote } = await quoteService.getQuoteById(quoteId);
    const sentTerm = await quoteService._internal.resolvePaymentTerm(quote);
    await db('quotes').where({ id: quoteId }).update({ status: 'sent', payment_term_snapshot: JSON.stringify(sentTerm) });
    const invoiceId = await insertId('invoices', {
      invoice_number: `ACCEPT-INH-${quoteId}`, customer_account_id: customerId, issue_date: '2026-06-01',
      due_date: '2026-06-30', status: 'draft', currency: 'CHF', net_amount_minor: 10000, vat_amount_minor: 0,
      total_amount_minor: 10000, created_by_admin_id: adminId, deal_uuid: require('crypto').randomUUID(), source_quote_id: quoteId,
    });
    const { resolveSkontoPercentForInvoice } = require('../../src/services/invoiceService');
    const invoice = () => db('invoices').where({ id: invoiceId }).first();
    expect(await resolveSkontoPercentForInvoice(await invoice())).toBe(3);

    await quoteService.updateQuote(quoteId, { paymentNetDaysTemplateId: net1 }, adminId);
    await quoteService.adminAcceptQuote(quoteId, adminId);

    expect(JSON.parse((await db('quotes').where({ id: quoteId }).first()).payment_term_snapshot))
      .toEqual(expect.objectContaining({ skonto_percent: 1 }));
    expect(await resolveSkontoPercentForInvoice(await invoice())).toBe(3);
  });

  it('previews an unsaved installments override like the saved quote', async () => {
    const netDaysId = await insertId('payment_net_days_templates', {
      name: 'Preview Net 15', description: 'Payable within 15 days', net_days: 15,
    });
    const timingId = await insertId('payment_timing_templates', {
      name: 'Preview half', description: '50% on booking, 50% after the event',
      installments: JSON.stringify([{ percent: 50, label: 'Deposit' }, { percent: 50, label: 'Balance' }]),
    });
    const pdfService = require('../../src/services/pdfService');
    let previewed;
    const spy = jest.spyOn(pdfService, 'renderQuoteToBuffer').mockImplementationOnce(async (ctx) => {
      previewed = ctx;
      return Buffer.from('%PDF-preview');
    });
    try {
      await quoteService.renderQuotePdfFromPayload({
        customerAccountId: customerId, currency: 'CHF', vatRate: 0,
        paymentNetDaysTemplateId: netDaysId, paymentTimingTemplateId: timingId,
        installments: [{ percent: 30, label: 'Deposit' }, { percent: 70, label: 'Balance' }],
        lineItems: [{ position: 1, quantity: 1, description: 'Reportage', unit_price_minor: 100000 }],
      });
    } finally {
      spy.mockRestore();
    }
    expect(previewed.paymentTerm).toEqual(expect.objectContaining({ description: 'Payable within 15 days', netDays: 15 }));
  });
});
