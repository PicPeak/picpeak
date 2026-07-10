/**
 * Migration 129: Accounting Layer A — chart of accounts + VAT codes + mappings.
 *
 * Prepares picpeak to feed a Treuhänder's double-entry software once a user
 * crosses the CHF ~500k threshold (LI PGR Art. 1045 → full Buchführung). We do
 * NOT become an ERP here: we attach account + VAT codes to the data we already
 * capture so a "collective journal" export can be imported into Banana / bexio /
 * etc. Native double-entry (journal, Bilanz, Erfolgsrechnung) is Layer B.
 *
 *   - ledger_accounts : chart of accounts (seeded Swiss/LI KMU Kontenrahmen,
 *                       admin-editable — full CRUD).
 *   - vat_codes       : MWST codes (CH/LI rates 8.1 / 2.6 / 3.8 / 0 + reverse
 *                       charge), each linked to its VAT account.
 *   - expense_categories.ledger_account_id : which expense account a category
 *                       books to (mapping, editable).
 *   - app_settings (accounting) : system/default account numbers + the
 *                       tax_treatment→VAT-code and output-rate→VAT-code maps.
 *
 * Everything is hasTable/hasColumn-guarded + idempotent. app_settings rows use
 * setting_key/value/type ONLY (no created_at/updated_at — see migration 103).
 * Legal/financial defaults are EXAMPLES — every surface must point the user at
 * a Treuhänder.
 */

// Swiss/LI KMU-Kontenrahmen (condensed for a services/photography SME).
const SEED_ACCOUNTS = [
  // Aktiven
  { number: '1000', name: 'Kasse', type: 'asset' },
  { number: '1020', name: 'Bank', type: 'asset' },
  { number: '1100', name: 'Forderungen aus Lieferungen und Leistungen (Debitoren)', type: 'asset' },
  { number: '1170', name: 'Vorsteuer MWST', type: 'asset' },
  { number: '1300', name: 'Aktive Rechnungsabgrenzung', type: 'asset' },
  { number: '1500', name: 'Mobiliar und Einrichtungen', type: 'asset' },
  { number: '1520', name: 'Büromaschinen, Informatik, Kommunikation', type: 'asset' },
  // Passiven
  { number: '2000', name: 'Verbindlichkeiten aus Lieferungen und Leistungen (Kreditoren)', type: 'liability' },
  { number: '2200', name: 'Geschuldete MWST (Umsatzsteuer)', type: 'liability' },
  { number: '2300', name: 'Passive Rechnungsabgrenzung', type: 'liability' },
  { number: '2800', name: 'Eigenkapital', type: 'equity' },
  // Ertrag
  { number: '3000', name: 'Produktionsertrag (Fotografie)', type: 'revenue' },
  { number: '3200', name: 'Handelsertrag', type: 'revenue' },
  { number: '3400', name: 'Dienstleistungsertrag', type: 'revenue' },
  { number: '3940', name: 'Weiterverrechnete Spesen', type: 'revenue' },
  // Aufwand
  { number: '4000', name: 'Materialaufwand', type: 'expense' },
  { number: '4400', name: 'Aufwand für bezogene Dienstleistungen', type: 'expense' },
  { number: '6000', name: 'Raumaufwand (Miete)', type: 'expense' },
  { number: '6100', name: 'Unterhalt und Reparaturen', type: 'expense' },
  { number: '6200', name: 'Fahrzeug- und Transportaufwand', type: 'expense' },
  { number: '6300', name: 'Sachversicherungen, Abgaben, Gebühren', type: 'expense' },
  { number: '6500', name: 'Verwaltungsaufwand', type: 'expense' },
  { number: '6510', name: 'Telefon, Internet, Porti', type: 'expense' },
  { number: '6570', name: 'Informatikaufwand (Software)', type: 'expense' },
  { number: '6600', name: 'Werbeaufwand', type: 'expense' },
  { number: '6640', name: 'Reise- und Spesenaufwand', type: 'expense' },
  { number: '6700', name: 'Sonstiger Betriebsaufwand', type: 'expense' },
  { number: '6800', name: 'Abschreibungen', type: 'expense' },
];

// CH/LI MWST codes. `direction` = output (Umsatzsteuer) | input (Vorsteuer).
// `account` is the VAT account number (resolved to an id after the accounts
// are seeded). 0%/exempt codes carry no VAT account.
const SEED_VAT_CODES = [
  { code: 'UN81', name: 'Umsatz Normalsatz 8.1%', rate: 8.1, direction: 'output', account: '2200' },
  { code: 'UN26', name: 'Umsatz reduzierter Satz 2.6%', rate: 2.6, direction: 'output', account: '2200' },
  { code: 'UN38', name: 'Umsatz Beherbergung 3.8%', rate: 3.8, direction: 'output', account: '2200' },
  { code: 'UN00', name: 'Umsatz ohne MWST / befreit', rate: 0, direction: 'output', account: null },
  { code: 'VST81', name: 'Vorsteuer 8.1%', rate: 8.1, direction: 'input', account: '1170' },
  { code: 'VST26', name: 'Vorsteuer 2.6%', rate: 2.6, direction: 'input', account: '1170' },
  { code: 'VST00', name: 'Keine Vorsteuer', rate: 0, direction: 'input', account: null },
  { code: 'BZ', name: 'Bezugsteuer (Reverse Charge) 8.1%', rate: 8.1, direction: 'input', account: '1170' },
];

// expense_categories.name → expense account number.
const CATEGORY_ACCOUNT_MAP = {
  'Infrastruktur & Miete': '6000',
  'Equipment & Hardware': '6700',
  'Software & Lizenzen': '6570',
  'Material & Verbrauch': '4000',
  'Reise & Spesen': '6640',
  'Werbung & Marketing': '6600',
  'Dienstleistungen/Fremdleistungen': '4400',
  'Versicherungen & Gebühren': '6300',
  'Weiterbildung': '6500',
  'Sonstiges': '6700',
};

// app_settings (type 'accounting'). Account references stored as NUMBERS
// (resilient to re-seeding); the maps are JSON keyed by tax_treatment /
// output VAT rate.
const SETTINGS = [
  { key: 'ledger_account_debitoren', value: '1100' },
  { key: 'ledger_account_kreditoren', value: '2000' },
  { key: 'ledger_account_bank', value: '1020' },
  { key: 'ledger_account_cash', value: '1000' },
  { key: 'ledger_account_default_revenue', value: '3400' },
  { key: 'ledger_account_default_expense', value: '6700' },
  { key: 'ledger_account_mileage', value: '6200' },
  { key: 'ledger_account_per_diem', value: '6640' },
  { key: 'ledger_account_rebilled_revenue', value: '3940' },
  { key: 'ledger_vat_map', value: { domestic: 'VST81', reverse_charge_service: 'BZ', foreign_vat_non_reclaimable: 'VST00', import_goods: 'VST81' } },
  { key: 'ledger_output_vat_map', value: { '8.1': 'UN81', '2.6': 'UN26', '3.8': 'UN38', '0': 'UN00' } },
];

exports.up = async function (knex) {
  // 1) ledger_accounts
  if (!(await knex.schema.hasTable('ledger_accounts'))) {
    await knex.schema.createTable('ledger_accounts', (table) => {
      table.increments('id').primary();
      table.string('number', 16).notNullable();
      table.string('name', 200).notNullable();
      // asset|liability|equity|revenue|expense
      table.string('type', 16).notNullable();
      table.boolean('is_seed').notNullable().defaultTo(false);
      table.boolean('active').notNullable().defaultTo(true);
      table.integer('display_order').notNullable().defaultTo(0);
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());
      table.unique(['number']);
      table.index(['type']);
    });
    await knex('ledger_accounts').insert(SEED_ACCOUNTS.map((a, i) => ({
      number: a.number, name: a.name, type: a.type, is_seed: true, active: true, display_order: (i + 1) * 10,
    })));
  }

  // Resolve account number → id for the FK references below.
  const accountRows = await knex('ledger_accounts').select('id', 'number');
  const idByNumber = new Map(accountRows.map((r) => [r.number, r.id]));

  // 2) vat_codes
  if (!(await knex.schema.hasTable('vat_codes'))) {
    await knex.schema.createTable('vat_codes', (table) => {
      table.increments('id').primary();
      table.string('code', 16).notNullable();
      table.string('name', 200).notNullable();
      table.decimal('rate', 5, 2).notNullable().defaultTo(0);
      table.string('direction', 8).notNullable(); // output|input
      table.integer('account_id').unsigned().references('id').inTable('ledger_accounts').onDelete('SET NULL');
      table.boolean('is_seed').notNullable().defaultTo(false);
      table.boolean('active').notNullable().defaultTo(true);
      table.integer('display_order').notNullable().defaultTo(0);
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());
      table.unique(['code']);
      table.index(['direction']);
    });
    await knex('vat_codes').insert(SEED_VAT_CODES.map((v, i) => ({
      code: v.code, name: v.name, rate: v.rate, direction: v.direction,
      account_id: v.account ? (idByNumber.get(v.account) || null) : null,
      is_seed: true, active: true, display_order: (i + 1) * 10,
    })));
  }

  // 3) expense_categories.ledger_account_id (mapping) + seed defaults
  if (await knex.schema.hasTable('expense_categories')) {
    if (!(await knex.schema.hasColumn('expense_categories', 'ledger_account_id'))) {
      await knex.schema.alterTable('expense_categories', (table) => {
        table.integer('ledger_account_id').unsigned().references('id').inTable('ledger_accounts').onDelete('SET NULL');
      });
    }
    // Seed the category→account mapping for the seeded categories only when
    // still unset (don't clobber an admin's choice).
    const cats = await knex('expense_categories').select('id', 'name', 'ledger_account_id');
    for (const c of cats) {
      const accNum = CATEGORY_ACCOUNT_MAP[c.name];
      if (accNum && c.ledger_account_id == null && idByNumber.get(accNum)) {
        // eslint-disable-next-line no-await-in-loop
        await knex('expense_categories').where({ id: c.id }).update({ ledger_account_id: idByNumber.get(accNum) });
      }
    }
  }

  // 4) app_settings defaults (setting_key/value/type only)
  if (await knex.schema.hasTable('app_settings')) {
    for (const s of SETTINGS) {
      // eslint-disable-next-line no-await-in-loop
      const row = await knex('app_settings').where({ setting_key: s.key }).first();
      if (!row) {
        // eslint-disable-next-line no-await-in-loop
        await knex('app_settings').insert({
          setting_key: s.key,
          setting_value: JSON.stringify(s.value),
          setting_type: 'accounting',
        });
      }
    }
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasTable('expense_categories') && await knex.schema.hasColumn('expense_categories', 'ledger_account_id')) {
    await knex.schema.alterTable('expense_categories', (table) => { table.dropColumn('ledger_account_id'); });
  }
  await knex.schema.dropTableIfExists('vat_codes');
  await knex.schema.dropTableIfExists('ledger_accounts');
  if (await knex.schema.hasTable('app_settings')) {
    await knex('app_settings').whereIn('setting_key', SETTINGS.map((s) => s.key)).del();
  }
};
