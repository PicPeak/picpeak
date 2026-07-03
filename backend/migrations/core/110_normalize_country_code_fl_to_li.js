/**
 * Migration: normalize the Liechtenstein country code from the
 * colloquial vehicle-plate code `FL` to the ISO 3166-1 alpha-2 code
 * `LI`.
 *
 * Background: the customer create/edit UI used to accept a free-text
 * 2-char country code and the placeholder suggested `FL` for
 * Liechtenstein. That code isn't ISO — the PDF renderer's locale-aware
 * lookup (services/pdfService.js countryName) and the new country
 * dropdown both key on ISO, so `FL` rows render as the bare code
 * instead of "Liechtenstein". The dropdown now stores `LI`; this
 * migration brings existing rows in line so they display correctly and
 * match new records.
 *
 * Scope: customer_accounts.country_code and business_profile.country_code.
 * Case-insensitive so a hand-entered `fl` is caught too. The free-text
 * country_name override column is left untouched — it exists precisely
 * for operators who want a custom display string.
 *
 * Idempotent: re-runs only touch rows still holding FL, so a second run
 * is a no-op.
 */

async function normalizeColumn(knex, table) {
  if (!(await knex.schema.hasTable(table))) return;
  if (!(await knex.schema.hasColumn(table, 'country_code'))) return;
  await knex(table)
    .whereRaw('UPPER(country_code) = ?', ['FL'])
    .update({ country_code: 'LI' });
}

exports.up = async function(knex) {
  await normalizeColumn(knex, 'customer_accounts');
  await normalizeColumn(knex, 'business_profile');
};

// Irreversible by design: once normalized to the ISO code there's no
// way to know which `LI` rows were originally `FL`, and reverting would
// reintroduce the non-ISO value the rest of the system can't read.
exports.down = async function() {};
