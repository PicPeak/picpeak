'use strict';
/**
 * Migration 375: the running bill of a monthly- or manual-billing customer
 * (the accumulator draft, src/services/invoice/drafts.js) is kept per
 * currency and VAT rate, and records what was accumulated into it.
 *
 * 1. One open draft per customer, currency and VAT rate. The partial unique
 *    index from migration 107 (mig 133) allowed one per customer, so a EUR
 *    quote converted for a customer with an open CHF draft landed on it as
 *    CHF, and a 0 % quote retaxed the 8.1 % lines already on it. The new
 *    index keeps concurrent appenders converging on one draft per key.
 * 2. `invoice_accumulated_sources`: which quote (and the contract made from
 *    it) was accumulated into which draft. The draft has no source_quote_id
 *    of its own, so a contract-conversion retry or a booking-flow re-run
 *    finds the draft here. One row per quote: a quote converts once.
 *
 * Idempotent: the index is created IF NOT EXISTS after the old one is
 * dropped, the table only when missing. Additive apart from the index swap;
 * down() restores the per-customer index unless a customer has more than
 * one open draft by then.
 */
const OLD_INDEX = 'invoices_one_monthly_draft_per_customer';
const NEW_INDEX = 'invoices_one_monthly_draft_per_key';
const TABLE = 'invoice_accumulated_sources';

function draftPredicate(knex) {
  const client = knex.client.config.client;
  if (client === 'pg' || client === 'postgresql') return 'is_monthly_draft = TRUE';
  if (client === 'sqlite3' || client === 'sqlite' || client === 'better-sqlite3') return 'is_monthly_draft = 1';
  return null;
}

exports.up = async function up(knex) {
  const predicate = draftPredicate(knex);
  if (predicate && await knex.schema.hasTable('invoices')) {
    await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ${NEW_INDEX} `
      + `ON invoices (customer_account_id, currency, vat_rate) WHERE ${predicate}`);
    await knex.raw(`DROP INDEX IF EXISTS ${OLD_INDEX}`);
  }

  if (!(await knex.schema.hasTable(TABLE))) {
    await knex.schema.createTable(TABLE, (table) => {
      table.increments('id').primary();
      table.integer('invoice_id').unsigned().notNullable()
        .references('id').inTable('invoices').onDelete('CASCADE');
      table.integer('quote_id').unsigned().nullable()
        .references('id').inTable('quotes').onDelete('CASCADE');
      table.integer('contract_id').unsigned().nullable()
        .references('id').inTable('contracts').onDelete('SET NULL');
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      table.unique(['quote_id'], { indexName: `${TABLE}_quote_unique` });
      table.index(['invoice_id'], `${TABLE}_invoice_idx`);
      table.index(['contract_id'], `${TABLE}_contract_idx`);
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists(TABLE);
  const predicate = draftPredicate(knex);
  if (predicate && await knex.schema.hasTable('invoices')) {
    // A customer with several open drafts (one per currency / rate) cannot
    // fit the per-customer index: keep the per-key one then.
    const crowded = await knex('invoices').where({ is_monthly_draft: true })
      .groupBy('customer_account_id').havingRaw('count(*) > 1').first('customer_account_id');
    if (!crowded) {
      await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ${OLD_INDEX} `
        + `ON invoices (customer_account_id) WHERE ${predicate}`);
      await knex.raw(`DROP INDEX IF EXISTS ${NEW_INDEX}`);
    }
  }
};
