/**
 * Schema-shape regression net for the CRM consolidated migration.
 *
 * Pins the table/column layout that the route + service layer expect
 * after `migrations/core/107_crm_consolidated.js` runs. The schema-
 * drift workflow (#530) catches Postgres-only FK ordering bugs (the
 * forward-reference deferral added in this PR), but it doesn't notice
 * if a future edit silently drops a column the service code reads —
 * SQLite would just return undefined and the broken behavior would
 * land on beta.
 *
 * Touches the lineage chain (deal_uuid + back-pointer FKs) explicitly
 * so a rename or removal there fails the test instead of silently
 * breaking the lineage card.
 */

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

describe('CRM schema after core migrations', () => {
  let db;
  let cleanup;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  describe('table layout', () => {
    const expectedTables = [
      'admin_users', 'customer_accounts', 'business_profile', 'business_bank_accounts',
      'events', 'document_sequences',
      'quotes', 'quote_line_items', 'quote_line_item_presets', 'quote_action_tokens',
      'contracts', 'contract_blocks', 'contract_block_inclusions', 'contract_action_tokens',
      'invoices', 'invoice_line_items', 'invoice_payment_log', 'invoice_payment_check_tokens',
      'customer_hour_entries',
      'payment_term_templates', 'payment_net_days_templates', 'payment_timing_templates',
      'event_payment_plans',
    ];

    it.each(expectedTables)('has table %s', async (table) => {
      expect(await db.schema.hasTable(table)).toBe(true);
    });
  });

  describe('deal_uuid lineage columns', () => {
    // Every document in one engagement shares a deal_uuid — the
    // lineage card joins on it. Drop the column anywhere in the chain
    // and the card silently returns partial data.
    it.each(['quotes', 'contracts', 'invoices'])(
      '%s has deal_uuid column',
      async (table) => {
        expect(await db.schema.hasColumn(table, 'deal_uuid')).toBe(true);
      }
    );

    // The back-pointer FKs were the source of the schema-drift bug
    // we fixed in this PR (forward references). Pin them.
    it('quotes has converted_contract_id back-pointer', async () => {
      expect(await db.schema.hasColumn('quotes', 'converted_contract_id')).toBe(true);
    });
    it('invoices has source_contract_id back-pointer', async () => {
      expect(await db.schema.hasColumn('invoices', 'source_contract_id')).toBe(true);
    });
    it('invoices has source_quote_id back-pointer', async () => {
      expect(await db.schema.hasColumn('invoices', 'source_quote_id')).toBe(true);
    });
  });

  describe('Storno discriminator columns', () => {
    // kind='storno' + cancels_invoice_id + negative totals are the
    // shape every aggregate filter relies on (feedback_storno_filter_
    // everywhere). Pin the columns so a rename doesn't silently break
    // every revenue report.
    it('invoices has kind discriminator', async () => {
      expect(await db.schema.hasColumn('invoices', 'kind')).toBe(true);
    });
    it('invoices has cancels_invoice_id self-ref', async () => {
      expect(await db.schema.hasColumn('invoices', 'cancels_invoice_id')).toBe(true);
    });
    it('invoices has replaces_invoice_id self-ref', async () => {
      expect(await db.schema.hasColumn('invoices', 'replaces_invoice_id')).toBe(true);
    });
  });

  describe('Event time columns (migration 137)', () => {
    // The admin calendar reads these to render timed vs. full-day
    // tiles. Per the feedback_migration_preserve_visuals rule, the
    // default has to be `is_full_day=true` so existing rows keep
    // their pre-migration visual.
    it('events has event_time_start', async () => {
      expect(await db.schema.hasColumn('events', 'event_time_start')).toBe(true);
    });
    it('events has event_time_end', async () => {
      expect(await db.schema.hasColumn('events', 'event_time_end')).toBe(true);
    });
    it('events has is_full_day', async () => {
      expect(await db.schema.hasColumn('events', 'is_full_day')).toBe(true);
    });
  });

  describe('seed paths', () => {
    it('admin + customer seed inserts cleanly', async () => {
      const { adminId, customerId } = await seedMinimal(db);
      expect(adminId).toBeTruthy();
      expect(customerId).toBeTruthy();

      const admin = await db('admin_users').where({ id: adminId }).first();
      const customer = await db('customer_accounts').where({ id: customerId }).first();
      expect(admin.email).toBe('tester@example.com');
      expect(customer.email).toBe('customer@example.com');
    });
  });
});
