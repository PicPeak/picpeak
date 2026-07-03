/**
 * Migration 125: add the Spesen-Zuschlag (expense surcharge) clause to
 * contracts. Drives the DEFAULT markup applied when an expense is re-billed
 * to a client on that contract's event (a per-expense override still wins).
 *
 *   - expense_markup_type   : 'none' | 'percent' | 'flat'  (default 'none' = 0%)
 *   - expense_markup_percent: decimal(5,2)  (used when type='percent')
 *   - expense_markup_flat_minor: integer minor units (used when type='flat')
 *
 * Idempotent: each column is hasColumn-guarded so re-runs / partial states
 * are safe. Default 'none' preserves existing behaviour (at-cost re-bill).
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('contracts'))) return;

  if (!(await knex.schema.hasColumn('contracts', 'expense_markup_type'))) {
    await knex.schema.alterTable('contracts', (table) => {
      table.string('expense_markup_type', 8).notNullable().defaultTo('none');
    });
  }
  if (!(await knex.schema.hasColumn('contracts', 'expense_markup_percent'))) {
    await knex.schema.alterTable('contracts', (table) => {
      table.decimal('expense_markup_percent', 5, 2);
    });
  }
  if (!(await knex.schema.hasColumn('contracts', 'expense_markup_flat_minor'))) {
    await knex.schema.alterTable('contracts', (table) => {
      table.integer('expense_markup_flat_minor');
    });
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('contracts'))) return;
  for (const col of ['expense_markup_type', 'expense_markup_percent', 'expense_markup_flat_minor']) {
    if (await knex.schema.hasColumn('contracts', col)) {
      // eslint-disable-next-line no-await-in-loop
      await knex.schema.alterTable('contracts', (table) => table.dropColumn(col));
    }
  }
};
