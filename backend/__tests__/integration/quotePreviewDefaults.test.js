/**
 * The editor sends no language for a new quote, so the preview has to fall
 * back the way the save does: to the customer's, then the business's, and
 * never to German on its own.
 */

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let tmpDir;
let customerId;
const prevCwd = process.cwd();

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  ({ customerId } = await seedMinimal(db));
  await db('customer_accounts').where({ id: customerId }).update({ preferred_language: null });
  await db('business_profile').where({ id: 1 }).update({ default_locale: 'en', default_currency: 'USD' });
});

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

test('a preview uses the language and currency the saved quote will have', async () => {
  const pdfService = require('../../src/services/pdfService');
  const spy = jest.spyOn(pdfService, 'renderQuoteToBuffer');
  await require('../../src/services/quoteService').renderQuotePdfFromPayload({
    customerAccountId: customerId, vatRate: 0,
    lineItems: [{ description: 'Full session', quantity: 1, unitPriceMinor: 17500, kind: 'item' }],
  });
  const [ctx] = spy.mock.calls[0];
  expect(ctx.locale).toBe('en');
  expect(ctx.currency).toBe('USD');
  spy.mockRestore();
});
