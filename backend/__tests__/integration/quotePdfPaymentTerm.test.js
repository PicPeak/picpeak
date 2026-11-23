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
});
