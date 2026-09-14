/**
 * Quote updates and hour entries must not deadlock on SQLite.
 *
 * updateQuote and customerHoursService.createEntry checked optional columns
 * (quotes.project_id / vat_code / event_type / booking_workflow_id and
 * customer_hour_entries.project_id) with hasColumnCached INSIDE their
 * transaction. hasColumnCached reads the schema through the global db, and
 * on SQLite's single-connection pool that read waits for the connection the
 * transaction holds: knex gives up after its 60s acquire timeout and the save
 * fails. Postgres has more than one connection and was unaffected. Same bug
 * as the contract draft save (issue 1447).
 *
 * hasColumnCached remembers a column for the life of the process, which hides
 * a check left inside a transaction as soon as anything else resolved it. Each
 * call under test therefore starts from a cleared cache, the way the first
 * save after a restart does, and is time-limited well below 60s so a
 * deadlock fails here instead of passing slowly.
 */

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

const WITHIN = 15000;

describe('schema checks stay outside CRM transactions', () => {
  let db;
  let cleanup;
  let adminId;
  let customerId;
  let quoteService;
  let customerHoursService;
  const clearSchemaCache = () => require('../../src/utils/schemaCache').invalidateSchemaCache();

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId, customerId } = await seedMinimal(db));
    // Hour logging needs both the per-customer flag and the master flag.
    await db('customer_accounts').where({ id: customerId }).update({ feature_hours_logging: true });
    const hoursFlag = await db('feature_flags').where({ key: 'hoursLogging' }).first();
    if (hoursFlag) await db('feature_flags').where({ key: 'hoursLogging' }).update({ value: true });
    else await db('feature_flags').insert({ key: 'hoursLogging', value: true });
    quoteService = require('../../src/services/quoteService');
    customerHoursService = require('../../src/services/customerHoursService');
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('updates a quote that sends the optional linked fields', async () => {
    const id = await quoteService.createQuote({
      customerAccountId: customerId,
      currency: 'CHF',
      vatRate: 0,
      eventName: 'Testshooting',
      lineItems: [
        { position: 1, quantity: 1, description: 'Photo package', unit_price_minor: 150000, discount_percent: 0 },
      ],
    }, adminId);
    // createQuote resolves these columns before its own transaction.
    clearSchemaCache();

    await quoteService.updateQuote(id, {
      eventName: 'Testshooting (geändert)',
      projectId: null,
      vatCode: null,
      eventType: null,
      bookingWorkflowId: null,
      lineItems: [
        { position: 1, quantity: 1, description: 'Photo package', unit_price_minor: 150000, discount_percent: 0 },
      ],
    }, adminId);

    const row = await db('quotes').where({ id }).first();
    expect(row.event_name).toBe('Testshooting (geändert)');
    // The audit insert used to run through the global db inside the
    // transaction: it stalled the save for the acquire timeout and was lost.
    const audit = await db('activity_logs').where({ activity_type: 'quote_updated' });
    expect(audit).toHaveLength(1);
  }, WITHIN);

  it('records an hour entry that sends projectId', async () => {
    clearSchemaCache();

    await customerHoursService.createEntry(customerId, {
      entryDate: '2026-09-01',
      startTime: '09:00',
      endTime: '10:30',
      hourlyRateMinorOverride: 12000,
      description: 'Bildbearbeitung',
      projectId: null,
    }, adminId);

    const rows = await db('customer_hour_entries').where({ customer_account_id: customerId });
    expect(rows).toHaveLength(1);
    expect(rows[0].duration_minutes).toBe(90);
  }, WITHIN);

  it('records a full payment, keeps its audit row and queues the admin notification', async () => {
    const invoiceService = require('../../src/services/invoiceService');
    const { invoiceIds } = await invoiceService.createInvoice({
      customerAccountId: customerId,
      currency: 'CHF',
      vatRate: 7.7,
      lineItems: [
        { position: 1, quantity: 1, description: 'Wedding coverage', unit_price_minor: 200000, discount_percent: 0 },
      ],
    }, adminId);
    const id = invoiceIds[0];
    await db('invoices').where({ id }).update({ status: 'sent', updated_at: new Date().toISOString() });
    const invoice = await db('invoices').where({ id }).first();
    clearSchemaCache();
    const queuedBefore = (await db('email_queue')).length;

    await invoiceService.markPaid(id, { amountMinor: invoice.total_amount_minor }, adminId);

    expect((await db('invoices').where({ id }).first()).status).toBe('paid');
    // Both used to run through the global db inside the transaction: the
    // payment stalled on the pool and they were dropped.
    expect(await db('activity_logs').where({ activity_type: 'invoice_paid' })).toHaveLength(1);
    const queued = (await db('email_queue')).slice(queuedBefore);
    expect(queued.some((row) => JSON.stringify(row).includes('tester@example.com'))).toBe(true);
  }, WITHIN);
});
