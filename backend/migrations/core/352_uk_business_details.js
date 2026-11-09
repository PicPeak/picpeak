'use strict';
/**
 * Migration 352: what a business in the United Kingdom has to state on its
 * documents, and the two facts its invoices depend on (issue 2439).
 *
 * business_profile
 *   - legal_form: sole_trader | partnership | ltd | llp (null = not set)
 *   - registered_name: the name on the register, when it differs from the
 *     trading name in company_name (SI 2015/17 reg 24)
 *   - company_number, registered_office: a company's or LLP's disclosures
 *     (SI 2015/17 reg 25)
 *   - jurisdiction: england_wales | scotland | northern_ireland — where a
 *     company is registered, and the law a UK contract is governed by
 *   - proprietor_name: the owner's or partners' names for a sole trader or
 *     partnership trading under another name (Companies Act 2006 s.1202)
 *
 * customer_accounts.customer_kind: business | consumer, null = decided from
 *   company name / VAT ID. Consumer law (cancellation) and the B2B
 *   late-payment notice depend on it.
 *
 * invoices.vat_gbp_rate: a UK invoice in another currency states its VAT
 *   total in sterling and the rate used (VAT Notice 700/21 s.4.1). The admin
 *   enters the rate (GBP per unit of the invoice currency); the sterling
 *   amount is derived from it and the stored VAT total, which an issued
 *   invoice never changes.
 *
 * All columns are nullable and default to null, so every existing row renders
 * exactly as before.
 */

const COLUMNS = [
  ['business_profile', 'legal_form', (t) => t.string('legal_form', 20).nullable()],
  ['business_profile', 'registered_name', (t) => t.string('registered_name', 255).nullable()],
  ['business_profile', 'company_number', (t) => t.string('company_number', 20).nullable()],
  ['business_profile', 'registered_office', (t) => t.text('registered_office').nullable()],
  ['business_profile', 'jurisdiction', (t) => t.string('jurisdiction', 32).nullable()],
  ['business_profile', 'proprietor_name', (t) => t.string('proprietor_name', 255).nullable()],
  ['customer_accounts', 'customer_kind', (t) => t.string('customer_kind', 16).nullable()],
  ['invoices', 'vat_gbp_rate', (t) => t.decimal('vat_gbp_rate', 14, 6).nullable()],
];

exports.up = async function up(knex) {
  for (const [table, column, add] of COLUMNS) {
    if (!(await knex.schema.hasTable(table))) continue;
    if (await knex.schema.hasColumn(table, column)) continue;
    await knex.schema.alterTable(table, (t) => add(t));
  }
};

exports.down = async function down(knex) {
  for (const [table, column] of [...COLUMNS].reverse()) {
    if (!(await knex.schema.hasTable(table))) continue;
    if (!(await knex.schema.hasColumn(table, column))) continue;
    await knex.schema.alterTable(table, (t) => t.dropColumn(column));
  }
};
