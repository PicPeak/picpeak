/**
 * Quote answers against a change that lands while they are being recorded.
 *
 * quoteService -> SQLite with the full core-migration run (helpers/crmDb).
 * The response-window setting is read after the quote and before the write
 * on both paths, so a hook on it interleaves the competing change.
 * Pins:
 *   - an admin acceptance of a draft whose terms changed after it was read
 *     is refused, instead of freezing the term from the earlier read;
 *   - a customer answer through a link the quote was reassigned away from
 *     after the link was read is refused.
 */

jest.mock('../../src/utils/appSettings', () => {
  const real = jest.requireActual('../../src/utils/appSettings');
  return {
    ...real,
    getAppSetting: async (key, ...rest) => {
      const hook = global.__quoteRaceHook;
      if (key === 'crm_quotes_accept_window_minutes' && hook) {
        global.__quoteRaceHook = null;
        await hook();
      }
      return real.getAppSetting(key, ...rest);
    },
  };
});

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
  global.__quoteRaceHook = null;
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

const draft = (extra = {}) => quoteService.createQuote({
  customerAccountId: customerId, currency: 'CHF', vatRate: 0,
  lineItems: [{ position: 1, quantity: 1, description: 'Wedding day', unit_price_minor: 100000 }],
  ...extra,
}, adminId);

test('an admin acceptance is refused when the draft\'s terms changed after it was read', async () => {
  const net30 = await insertId('payment_net_days_templates', { name: 'Race Net 30', description: '30 days net', net_days: 30 });
  const net10 = await insertId('payment_net_days_templates', { name: 'Race Net 10', description: '10 days net', net_days: 10 });
  const timing = await insertId('payment_timing_templates', {
    name: 'Race all after', description: 'Everything after the event',
    installments: JSON.stringify([{ percent: 100, label: 'Full' }]),
  });
  const quoteId = await draft({ paymentNetDaysTemplateId: net30, paymentTimingTemplateId: timing });

  global.__quoteRaceHook = () => db('quotes').where({ id: quoteId }).update({ payment_net_days_template_id: net10 });
  await expect(quoteService.adminAcceptQuote(quoteId, adminId)).rejects.toMatchObject({ statusCode: 409, code: 'QUOTE_CHANGED' });

  const row = await db('quotes').where({ id: quoteId }).first();
  expect(row.status).toBe('draft');
});

test('an answer through the old customer\'s link is refused when the quote was reassigned meanwhile', async () => {
  const quoteId = await draft();
  const { token } = await quoteService.sendQuote(quoteId, adminId);

  // Reopened, moved to the other customer and sent to them while the first
  // customer's answer is on its way.
  global.__quoteRaceHook = async () => {
    await quoteService.updateQuote(quoteId, { eventName: 'Reopened' }, adminId);
    await quoteService.updateQuote(quoteId, { customerAccountId: otherCustomerId }, adminId);
    await quoteService.sendQuote(quoteId, adminId);
  };
  await expect(quoteService.recordResponse({ token, action: 'accept', ip: '127.0.0.1' }))
    .rejects.toMatchObject({ statusCode: 410 });

  const row = await db('quotes').where({ id: quoteId }).first();
  expect(row.status).toBe('sent');
  expect(Number(row.customer_account_id)).toBe(otherCustomerId);
  expect(row.accepted_at).toBeNull();
});
