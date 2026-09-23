/** Per-contract claim so two concurrent "Convert to invoice" requests can't
 * both create an invoice for the same contract (issue 1589). Nullable —
 * unset means "not claimed"; conversions.js compare-and-sets it before
 * inserting the invoice. */
exports.up = async function (knex) {
  if (!await knex.schema.hasTable('contracts')) return;
  if (!await knex.schema.hasColumn('contracts', 'invoice_prepared_at')) {
    await knex.schema.alterTable('contracts', table => {
      table.timestamp('invoice_prepared_at');
    });
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasTable('contracts') && await knex.schema.hasColumn('contracts', 'invoice_prepared_at')) {
    await knex.schema.alterTable('contracts', table => table.dropColumn('invoice_prepared_at'));
  }
};
