/**
 * Migration 124: Accounting foundation tables.
 *
 *   - expense_categories : seeded, admin-editable colored labels (feed the
 *                          future Erfolgsrechnung).
 *   - inbound_documents  : received supplier invoices / receipts (system of
 *                          record). Holds best-effort parsed fields plus the
 *                          QR-encoded amount SEPARATELY (untrusted, tamper
 *                          cross-check — the authoritative total is the
 *                          text/line-item value).
 *   - expenses           : the booking created when a document gets a
 *                          disposition (or a manual expense with no document).
 *
 * All money is stored in integer minor units (*_amount_minor). All creates
 * are hasTable-guarded so partial states + re-runs are safe.
 */
const SEED_CATEGORIES = [
  { name: 'Infrastruktur & Miete', color: 'slate' },
  { name: 'Equipment & Hardware', color: 'indigo' },
  { name: 'Software & Lizenzen', color: 'violet' },
  { name: 'Material & Verbrauch', color: 'amber' },
  { name: 'Reise & Spesen', color: 'teal' },
  { name: 'Werbung & Marketing', color: 'rose' },
  { name: 'Dienstleistungen/Fremdleistungen', color: 'blue' },
  { name: 'Versicherungen & Gebühren', color: 'gray' },
  { name: 'Weiterbildung', color: 'green' },
  { name: 'Sonstiges', color: 'zinc' },
];

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('expense_categories'))) {
    await knex.schema.createTable('expense_categories', (table) => {
      table.increments('id').primary();
      table.string('name', 128).notNullable();
      table.string('color', 24);
      table.boolean('is_seed').notNullable().defaultTo(false);
      table.integer('display_order').notNullable().defaultTo(0);
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());
    });
    const rows = SEED_CATEGORIES.map((c, i) => ({
      name: c.name,
      color: c.color,
      is_seed: true,
      display_order: (i + 1) * 10,
    }));
    await knex('expense_categories').insert(rows);
  }

  if (!(await knex.schema.hasTable('inbound_documents'))) {
    await knex.schema.createTable('inbound_documents', (table) => {
      table.increments('id').primary();
      table.string('source', 16).notNullable().defaultTo('upload'); // upload|camera|email|manual
      table.string('original_filename', 512);
      table.string('file_path', 512);
      table.string('mime_type', 128);
      table.string('file_sha256', 64);
      table.string('status', 24).notNullable().defaultTo('unsorted'); // unsorted|categorized|declined|duplicate
      table.string('parse_status', 16).notNullable().defaultTo('pending'); // pending|parsed|failed|manual
      table.text('parse_error');
      table.string('parse_method', 24); // qr|pdf_text|ocr|none
      table.integer('page_count'); // PDF page count (for "jump to last page / QR")
      // Best-effort parsed fields (assist only — always editable/confirmable):
      table.string('supplier_name', 255);
      table.string('invoice_number', 128);
      table.date('invoice_date');
      table.date('due_date');
      table.string('currency', 3);
      table.integer('net_amount_minor');
      table.integer('vat_amount_minor');
      table.integer('total_amount_minor');
      // QR-encoded amount kept SEPARATE + untrusted (tamper cross-check):
      table.integer('qr_amount_minor');
      table.string('iban', 34);
      table.string('payment_reference', 140);
      table.text('raw_parsed'); // JSON blob of the raw extraction result
      table.integer('duplicate_of_id').unsigned()
        .references('id').inTable('inbound_documents').onDelete('SET NULL');
      table.integer('created_by_admin_id').unsigned();
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());
      table.index(['status']);
      table.index(['file_sha256']);
    });
  }

  if (!(await knex.schema.hasTable('expenses'))) {
    await knex.schema.createTable('expenses', (table) => {
      table.increments('id').primary();
      table.integer('inbound_document_id').unsigned()
        .references('id').inTable('inbound_documents').onDelete('SET NULL');
      // rebill|durchlaufend|eigener_aufwand|duplikat|abgelehnt
      table.string('disposition', 24).notNullable();
      // domestic|reverse_charge_service|foreign_vat_non_reclaimable|import_goods
      table.string('tax_treatment', 32).notNullable().defaultTo('domestic');
      // Loose links (no hard FK — kept resilient across SQLite/PG, mirrors the
      // invoice event snapshot approach); indexed for lookups:
      table.integer('event_id').unsigned();
      table.integer('customer_account_id').unsigned();
      table.string('supplier_name', 255);
      table.text('description');
      // FX: capture original + converted base (CHF) amount.
      table.string('original_currency', 3);
      table.integer('original_amount_minor');
      table.integer('chf_amount_minor');
      table.boolean('fx_locked').notNullable().defaultTo(false);
      table.string('fx_lock_reason', 32); // bank_reconciled|auto_30d|billed
      table.integer('net_amount_minor');
      table.integer('vat_amount_minor');
      table.integer('gross_amount_minor');
      // Re-bill markup (Spesen-Zuschlag): expense override else contract clause.
      table.string('markup_type', 8).notNullable().defaultTo('none'); // none|percent|flat
      table.decimal('markup_percent', 5, 2);
      table.integer('markup_flat_minor');
      table.integer('category_id').unsigned()
        .references('id').inTable('expense_categories').onDelete('SET NULL');
      table.text('tags'); // JSON array
      table.integer('billed_invoice_id').unsigned();
      table.integer('billed_invoice_line_item_id').unsigned();
      table.boolean('unbilled_parked').notNullable().defaultTo(false);
      table.timestamp('billed_at');
      // Supplier payment (decoupled from categorisation):
      table.boolean('supplier_paid').notNullable().defaultTo(false);
      table.timestamp('supplier_paid_at');
      // bank_transfer|cash|twint|paypal|card|other
      table.string('payment_method', 16);
      table.string('payment_reference', 140);
      table.string('receipt_path', 512);
      table.text('decline_reason');
      table.string('status', 16).notNullable().defaultTo('open'); // open|parked|billed|declined
      table.integer('created_by_admin_id').unsigned();
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());
      table.index(['disposition']);
      table.index(['status']);
      table.index(['event_id']);
      table.index(['customer_account_id']);
      table.index(['billed_invoice_id']);
      table.index(['supplier_paid']);
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('expenses');
  await knex.schema.dropTableIfExists('inbound_documents');
  await knex.schema.dropTableIfExists('expense_categories');
};
