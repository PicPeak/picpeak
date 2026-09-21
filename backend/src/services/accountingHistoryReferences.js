// ON DELETE actions affecting audited records. Apply them explicitly before
// deleting the parent so the history captures them on PostgreSQL and on
// SQLite installations without foreign-key enforcement. Tables outside the
// recorder's current scope are skipped. RESTRICT relationships remain the
// database's responsibility; any refusal rolls the whole operation back.
const nullRef = (table, column) => ({ table, column, action: 'null' });
const cascade = (table, column) => ({ table, column, action: 'delete' });

module.exports = {
  expense_categories: [nullRef('expenses', 'category_id')],
  business_bank_accounts: [nullRef('quotes', 'business_bank_account_id'), nullRef('invoices', 'business_bank_account_id')],
  events: [
    nullRef('quotes', 'converted_event_id'), nullRef('contracts', 'converted_event_id'),
    nullRef('invoices', 'event_id'),
  ],
  admin_users: [
    ...['quotes', 'contracts', 'invoices', 'customer_accounts'].map((table) => nullRef(table, 'created_by_admin_id')),
    nullRef('invoice_payment_log', 'recorded_by_admin_id'),
    nullRef('customer_hour_entries', 'recorded_by_admin_id'),
  ],
  invoices: [
    ...['cancels_invoice_id', 'replaces_invoice_id', 'cancellation_storno_id'].map((column) => nullRef('invoices', column)),
    cascade('invoice_line_items', 'invoice_id'), cascade('invoice_payment_log', 'invoice_id'),
    nullRef('customer_hour_entries', 'invoice_id'),
  ],
  invoice_line_items: [
    cascade('invoice_line_items', 'parent_line_item_id'),
    nullRef('customer_hour_entries', 'invoice_line_item_id'),
  ],
  quote_line_items: [cascade('quote_line_items', 'parent_line_item_id')],
  quotes: [
    cascade('quote_line_items', 'quote_id'), nullRef('invoices', 'source_quote_id'),
    nullRef('contracts', 'source_quote_id'),
  ],
  contracts: [
    cascade('contract_block_inclusions', 'contract_id'),
    // Both became audited with #1445: a deleted contract takes its free text
    // and its attachment inclusions with it, and that is a change to audited
    // rows, so the recorder has to see it.
    cascade('contract_text_sections', 'contract_id'),
    cascade('contract_attachment_inclusions', 'contract_id'),
    nullRef('invoices', 'source_contract_id'),
    nullRef('quotes', 'converted_contract_id'),
  ],
  inbound_documents: [nullRef('expenses', 'inbound_document_id'), nullRef('inbound_documents', 'duplicate_of_id')],
  projects: [
    nullRef('quotes', 'project_id'), nullRef('contracts', 'project_id'),
    nullRef('customer_hour_entries', 'project_id'),
  ],
  customer_accounts: [cascade('customer_hour_entries', 'customer_account_id')],
  ledger_accounts: [nullRef('vat_codes', 'account_id'), nullRef('expense_categories', 'ledger_account_id')],
  payment_term_templates: [nullRef('invoices', 'payment_term_template_id')],
  payment_net_days_templates: [
    nullRef('quotes', 'payment_net_days_template_id'), nullRef('invoices', 'payment_net_days_template_id'),
  ],
  payment_timing_templates: [
    nullRef('quotes', 'payment_timing_template_id'), nullRef('invoices', 'payment_timing_template_id'),
  ],
  business_profile: [cascade('business_bank_accounts', 'business_profile_id')],
  // Contract templates (#1445): a deleted template or version leaves the
  // contracts made from it, with the reference nulled — which is a change to
  // an audited row, so it goes through the recorder.
  contract_templates: [nullRef('contracts', 'template_id')],
  contract_template_versions: [nullRef('contracts', 'template_version_id')],
};
