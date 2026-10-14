/**
 * The quote, invoice and PDF theme services log who acted. logActivity reads
 * an `{ type, id, name }` actor; these services used to pass strings like
 * `admin:5`, which it stored as the system with no id, so the activity log
 * attributed every quote and invoice action to nobody. The source scan in
 * __tests__/services/logActivityActorShape.test.js keeps the string shape out.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'crm-route-test-secret';

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');
// The admin's username, stored with the entry when it is written, so the
// log still names them after the account is gone (seedMinimal's admin).
const ADMIN_NAME = 'tester';

jest.setTimeout(120000);

let db; let cleanup; let tmpDir; let adminId; let customerId;
let quoteService; let invoiceService; let pdfThemeService;
const prevCwd = process.cwd();

const actorOf = async (activityType) => {
  const row = await db('activity_logs').where({ activity_type: activityType }).orderBy('id', 'desc').first();
  return { type: row.actor_type, id: row.actor_id === null ? null : Number(row.actor_id), name: row.actor_name };
};

async function enableFlag(key) {
  const updated = await db('feature_flags').where({ key }).update({ value: true });
  if (!updated) await db('feature_flags').insert({ key, value: true });
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  // Service code's `new Date()` is a sandbox Date that node-sqlite3 stores as
  // "[object Object]"; bind ISO strings instead (see crmMintPaths.test.js).
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
  await enableFlag('quotes');
  await enableFlag('bills');
  await db('customer_accounts').where({ id: customerId }).update({ feature_quotes: true, feature_bills: true });
  quoteService = require('../../src/services/quoteService');
  invoiceService = require('../../src/services/invoiceService');
  pdfThemeService = require('../../src/services/pdfThemeService');
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

const createQuote = () => quoteService.createQuote({
  customerAccountId: customerId,
  currency: 'CHF',
  vatRate: 0,
  eventName: 'Actor shoot',
  lineItems: [{ position: 1, quantity: 1, description: 'Package', unit_price_minor: 100000, discount_percent: 0 }],
}, adminId);

it('quote actions inside and after a transaction record the admin', async () => {
  const id = await createQuote();
  expect(await actorOf('quote_created')).toEqual({ type: 'admin', id: adminId, name: ADMIN_NAME });
  await quoteService.sendQuote(id, adminId);
  expect(await actorOf('quote_sent')).toEqual({ type: 'admin', id: adminId, name: ADMIN_NAME });
});

it('a response through the public quote link records the public link, not an admin', async () => {
  const id = await createQuote();
  const { token } = await quoteService.sendQuote(id, adminId);
  await quoteService.recordResponse({ token, action: 'decline', ip: '127.0.0.1' });
  expect(await actorOf('quote_declined')).toEqual({ type: 'public', id: null, name: 'quote-link' });
});

it('a payment records the admin who booked it', async () => {
  const { invoiceIds: [id] } = await invoiceService.createInvoice({
    customerAccountId: customerId,
    currency: 'CHF',
    vatRate: 0,
    lineItems: [{ position: 1, quantity: 1, description: 'Coverage', unit_price_minor: 5000, discount_percent: 0 }],
  }, adminId);
  expect(await actorOf('invoice_created')).toEqual({ type: 'admin', id: adminId, name: ADMIN_NAME });
  await db('invoices').where({ id }).update({ status: 'sent', updated_at: new Date().toISOString() });
  await invoiceService.markPaid(id, { amountMinor: 5000 }, adminId);
  expect(await actorOf('invoice_paid')).toEqual({ type: 'admin', id: adminId, name: ADMIN_NAME });
});

it('a theme save records the admin, and one without an admin the system', async () => {
  await pdfThemeService.saveTheme('quote', {}, adminId);
  expect(await actorOf('pdf_theme_updated')).toEqual({ type: 'admin', id: adminId, name: ADMIN_NAME });
  await pdfThemeService.saveTheme('quote', {}, null);
  expect(await actorOf('pdf_theme_updated')).toEqual({ type: 'system', id: null, name: null });
});
