/**
 * "Recalculate rates" on a draft quote.
 *
 * quoteService -> SQLite with the full core-migration run (helpers/crmDb).
 * Pins: a changed customer rate reaches a line whose price came from that
 * rate, a changed business default reaches hour and day lines priced from
 * it, and a typed price is left alone.
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

  it('re-applies changed business default hour and day rates', async () => {
    await db('customer_accounts').where({ id: customerId })
      .update({ hourly_rate_minor: null, day_rate_minor: null });
    await db('business_profile').where({ id: 1 })
      .update({ default_hourly_rate_minor: 9000, default_day_rate_minor: 60000 });
    const quoteId = await quoteService.createQuote({
      customerAccountId: customerId, currency: 'CHF', vatRate: 0, lineItems: [
        { position: 1, quantity: 3, description: 'Editing', unit_price_minor: 0, price_mode: 'hour', rate_source: 'auto' },
        { position: 2, quantity: 2, description: 'Shooting day', unit_price_minor: 0, price_mode: 'day', rate_source: 'auto' },
      ],
    }, adminId);

    let { lineItems } = await quoteService.getQuoteById(quoteId);
    expect(lineItems.map((li) => li.rate_source)).toEqual(['default', 'default']);
    expect(lineItems.map((li) => Number(li.unit_price_minor))).toEqual([9000, 60000]);

    await db('business_profile').where({ id: 1 })
      .update({ default_hourly_rate_minor: 9500, default_day_rate_minor: 65000 });
    await quoteService.recalculateRates(quoteId, adminId);

    ({ lineItems } = await quoteService.getQuoteById(quoteId));
    expect(lineItems.map((li) => li.rate_source)).toEqual(['default', 'default']);
    expect(lineItems.map((li) => Number(li.unit_price_minor))).toEqual([9500, 65000]);
    expect(lineItems.map((li) => Number(li.line_total_minor))).toEqual([28500, 130000]);
  });
});
