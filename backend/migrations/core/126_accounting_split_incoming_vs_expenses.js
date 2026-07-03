/**
 * Migration 126: split Incoming invoices (external) from Expenses (internal).
 *
 * Incoming invoices now own their payable + disposition + re-bill on the
 * `inbound_documents` row itself (no derived `expenses` row), so a supplier
 * invoice lives ONLY in the inbox/incoming-invoices surface. The `expenses`
 * table becomes internal-only (mileage / per-diem / cash with proof).
 *
 * Both can be booked to an event (event_id) or to the company (event_id NULL).
 *
 * Additive + hasColumn-guarded so it runs forward cleanly on dev (122-125 are
 * already deployed there — no in-place edits).
 */
async function addColumn(knex, table, column, builder) {
  // eslint-disable-next-line no-await-in-loop
  if (!(await knex.schema.hasColumn(table, column))) {
    await knex.schema.alterTable(table, builder);
  }
}

exports.up = async function (knex) {
  if (await knex.schema.hasTable('inbound_documents')) {
    // Disposition + classification (now stored on the document itself).
    await addColumn(knex, 'inbound_documents', 'disposition', (t) => t.string('disposition', 24));
    await addColumn(knex, 'inbound_documents', 'tax_treatment', (t) => t.string('tax_treatment', 32));
    await addColumn(knex, 'inbound_documents', 'category_id', (t) => t.integer('category_id').unsigned());
    // Booking target: event_id NULL = booked to the company.
    await addColumn(knex, 'inbound_documents', 'event_id', (t) => t.integer('event_id').unsigned());
    // Re-bill (Weiterverrechnung) linkage + markup.
    await addColumn(knex, 'inbound_documents', 'markup_type', (t) => t.string('markup_type', 8));
    await addColumn(knex, 'inbound_documents', 'markup_percent', (t) => t.decimal('markup_percent', 5, 2));
    await addColumn(knex, 'inbound_documents', 'markup_flat_minor', (t) => t.integer('markup_flat_minor'));
    await addColumn(knex, 'inbound_documents', 'billed_invoice_id', (t) => t.integer('billed_invoice_id').unsigned());
    await addColumn(knex, 'inbound_documents', 'billed_invoice_line_item_id', (t) => t.integer('billed_invoice_line_item_id').unsigned());
    // Supplier payment (the payable is paid HERE, on the incoming invoice).
    await addColumn(knex, 'inbound_documents', 'supplier_paid', (t) => t.boolean('supplier_paid').notNullable().defaultTo(false));
    await addColumn(knex, 'inbound_documents', 'supplier_paid_at', (t) => t.timestamp('supplier_paid_at'));
    await addColumn(knex, 'inbound_documents', 'supplier_payment_method', (t) => t.string('supplier_payment_method', 16));
    await addColumn(knex, 'inbound_documents', 'supplier_payment_ref', (t) => t.string('supplier_payment_ref', 140));
  }

  if (await knex.schema.hasTable('expenses')) {
    // Internal-expense kind + quantity-driven amount (mileage / per-diem).
    await addColumn(knex, 'expenses', 'kind', (t) => t.string('kind', 16).notNullable().defaultTo('amount')); // amount|mileage|per_diem
    await addColumn(knex, 'expenses', 'quantity', (t) => t.decimal('quantity', 10, 2)); // km count or number of days
    await addColumn(knex, 'expenses', 'rate_minor', (t) => t.integer('rate_minor')); // snapshotted km/day rate
  }
};

exports.down = async function (knex) {
  const dropCols = async (table, cols) => {
    if (!(await knex.schema.hasTable(table))) return;
    for (const col of cols) {
      // eslint-disable-next-line no-await-in-loop
      if (await knex.schema.hasColumn(table, col)) {
        // eslint-disable-next-line no-await-in-loop
        await knex.schema.alterTable(table, (t) => t.dropColumn(col));
      }
    }
  };
  await dropCols('inbound_documents', [
    'disposition', 'tax_treatment', 'category_id', 'event_id',
    'markup_type', 'markup_percent', 'markup_flat_minor',
    'billed_invoice_id', 'billed_invoice_line_item_id',
    'supplier_paid', 'supplier_paid_at', 'supplier_payment_method', 'supplier_payment_ref',
  ]);
  await dropCols('expenses', ['kind', 'quantity', 'rate_minor']);
};
