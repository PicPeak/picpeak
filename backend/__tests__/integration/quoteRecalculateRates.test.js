/**
 * "Recalculate rates" on a draft quote.
 *
 * quoteService -> SQLite with the full core-migration run (helpers/crmDb).
 * Pins: a changed customer rate reaches a line whose price came from that
 * rate, and a typed price is left alone.
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

describe('recalculateRates', () => {
  it('re-applies a changed customer hourly rate to a rate-priced line', async () => {
    await db('customer_accounts').where({ id: customerId }).update({ hourly_rate_minor: 10000 });
    const quoteId = await quoteService.createQuote({
      customerAccountId: customerId, currency: 'CHF', vatRate: 0, lineItems: [
        { position: 1, quantity: 2, description: 'Shooting', unit_price_minor: 0, price_mode: 'hour', rate_source: 'auto' },
        { position: 2, quantity: 1, description: 'Album', unit_price_minor: 30000 },
      ],
    }, adminId);

    let { lineItems } = await quoteService.getQuoteById(quoteId);
    expect(lineItems[0].rate_source).toBe('customer');
    expect(Number(lineItems[0].unit_price_minor)).toBe(10000);

    await db('customer_accounts').where({ id: customerId }).update({ hourly_rate_minor: 12500 });
    await quoteService.recalculateRates(quoteId, adminId);

    ({ lineItems } = await quoteService.getQuoteById(quoteId));
    expect(lineItems[0].rate_source).toBe('customer');
    expect(Number(lineItems[0].unit_price_minor)).toBe(12500);
    expect(Number(lineItems[0].line_total_minor)).toBe(25000);
    // A typed price is left alone.
    expect(lineItems[1].rate_source).toBeNull();
    expect(Number(lineItems[1].unit_price_minor)).toBe(30000);
  });
});
