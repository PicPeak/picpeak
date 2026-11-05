/**
 * Migration 349: invoice activity rows written before the number was logged
 * get it from the invoice they name, so their lines stop showing the raw
 * "{{invoiceNumber}}" placeholder.
 */
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const migration = require('../../migrations/core/349_backfill_invoice_activity_numbers');

describe('migration 349 — invoice numbers on invoice activity rows', () => {
  let db; let cleanup; let invoiceId; let stornoId;

  const insertId = async (q) => { const [row] = await q.returning('id'); return row && typeof row === 'object' ? row.id : row; };
  const invoice = (customerId, number) => ({
    customer_account_id: customerId,
    invoice_number: number,
    status: 'sent',
    currency: 'CHF',
    issue_date: '2026-01-01',
    due_date: '2026-01-31',
    net_amount_minor: 10000,
    vat_amount_minor: 0,
    total_amount_minor: 10000,
  });
  const log = (type, metadata) => ({
    activity_type: type, actor_type: 'system', metadata: JSON.stringify(metadata), created_at: new Date().toISOString(),
  });
  const metaOf = async (type) => {
    const row = await db('activity_logs').where({ activity_type: type }).first();
    return typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { customerId } = await seedMinimal(db);
    invoiceId = await insertId(db('invoices').insert(invoice(customerId, 'R-2026-0042')));
    stornoId = await insertId(db('invoices').insert(invoice(customerId, 'S-2026-0007')));
    await db('activity_logs').insert([
      log('invoice_payment_check_sent', { invoiceId, token: 'abcd1234' }),
      log('invoice_reissued', { originalInvoiceId: invoiceId, newInvoiceId: 999, stornoId }),
      log('storno_sent', { stornoId, stornoNumber: 'S-2026-0007', originalInvoiceId: invoiceId }),
      log('invoice_sent', { invoiceId: 123456 }),
      log('invoice_created', { invoiceId, invoiceNumber: 'R-OLD' }),
      log('quote_sent', { invoiceId }),
    ]);
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('fills in the number of the invoice each row names', async () => {
    await migration.up(db);

    expect(await metaOf('invoice_payment_check_sent')).toEqual({ invoiceId, token: 'abcd1234', invoiceNumber: 'R-2026-0042' });
    expect((await metaOf('invoice_reissued')).invoiceNumber).toBe('R-2026-0042');
    expect((await metaOf('storno_sent')).invoiceNumber).toBe('S-2026-0007');
  });

  it('leaves rows it cannot or need not change', async () => {
    expect(await metaOf('invoice_sent')).toEqual({ invoiceId: 123456 });
    expect((await metaOf('invoice_created')).invoiceNumber).toBe('R-OLD');
    expect(await metaOf('quote_sent')).toEqual({ invoiceId });
  });

  it('is idempotent on re-run', async () => {
    await expect(migration.up(db)).resolves.toBeUndefined();
    expect((await metaOf('invoice_payment_check_sent')).invoiceNumber).toBe('R-2026-0042');
  });
});
