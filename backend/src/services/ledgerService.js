/**
 * ledgerService — Accounting Layer A: chart of accounts + VAT codes + a
 * Treuhänder export.
 *
 * picpeak is NOT a double-entry ledger (that's Layer B). This service:
 *   1. CRUD for `ledger_accounts` (Swiss/LI KMU-Kontenrahmen) + `vat_codes`,
 *      plus the category→account and tax_treatment→VAT-code mappings.
 *   2. buildPostings(): turns the data we already capture (revenue invoices,
 *      incoming supplier invoices, internal expenses) into balanced
 *      "Buchungssätze" — accrual-dated, single-row Soll/Haben entries with a
 *      VAT code the target software expands.
 *   3. Export formatters (generic / Banana / bexio) so a Treuhänder can import
 *      the collective journal.
 *
 * Accrual basis only — payment/bank postings are Layer B (bank reconciliation).
 * Legal/financial output is a GUIDELINE: every surface must point the user at a
 * Treuhänder ([[feedback_legal_financial_examples_only]]).
 */

const { db, withRetry } = require('../database/db');
const { getAppSetting } = require('../utils/appSettings');
const { buildCustomerLabel } = require('./taxReportService')._internal;
const { ensureInt } = require('../utils/numericHelpers');
const { neutralizeSpreadsheetFormula } = require('../utils/spreadsheetSafe');

const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'];
const VAT_DIRECTIONS = ['output', 'input'];

// Statuses we book. Mirrors taxReportService: cancelled originals are excluded
// (the storno reissue, a negative-total row, carries the reversal).
const REVENUE_STATUSES = ['sent', 'paid', 'overdue', 'pending_delivery'];

// ── helpers ──────────────────────────────────────────────────────────
function rateKey(rate) {
  // Normalise 8.10 → '8.1', 0 → '0' so it matches the seeded output-VAT map.
  const n = Number(rate);
  if (!Number.isFinite(n)) return '0';
  return String(Number(n.toFixed(2)));
}

/**
 * Resolve all the config the posting engine needs in one shot: account
 * lookup maps + VAT-code lookup + the default-account / VAT-mapping settings.
 */
async function getConfig() {
  const [accounts, vatCodes] = await Promise.all([
    db('ledger_accounts').select('id', 'number', 'name', 'type', 'active'),
    db('vat_codes').select('id', 'code', 'name', 'rate', 'direction', 'account_id', 'active'),
  ]);
  const accountByNumber = new Map(accounts.map((a) => [a.number, a]));
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  const [
    debitoren, kreditoren, defaultRevenue, defaultExpense, mileage, perDiem, rebilled,
    vatMap, outputVatMap,
  ] = await Promise.all([
    getAppSetting('ledger_account_debitoren', '1100'),
    getAppSetting('ledger_account_kreditoren', '2000'),
    getAppSetting('ledger_account_default_revenue', '3400'),
    getAppSetting('ledger_account_default_expense', '6700'),
    getAppSetting('ledger_account_mileage', '6200'),
    getAppSetting('ledger_account_per_diem', '6640'),
    getAppSetting('ledger_account_rebilled_revenue', '3940'),
    getAppSetting('ledger_vat_map', {}),
    getAppSetting('ledger_output_vat_map', {}),
  ]);

  return {
    accounts, vatCodes, accountByNumber, accountById,
    settings: {
      debitoren, kreditoren, defaultRevenue, defaultExpense, mileage, perDiem, rebilled,
    },
    vatMap: vatMap || {},
    outputVatMap: outputVatMap || {},
  };
}

// ── CRUD: accounts ───────────────────────────────────────────────────
async function listAccounts() {
  return db('ledger_accounts').orderBy('number', 'asc').select('*');
}

async function createAccount({ number, name, type }) {
  if (!number || !name) throw httpError(400, 'number and name are required', 'VALIDATION');
  if (!ACCOUNT_TYPES.includes(type)) throw httpError(400, 'invalid account type', 'VALIDATION');
  const exists = await db('ledger_accounts').where({ number }).first();
  if (exists) throw httpError(409, 'an account with this number already exists', 'DUPLICATE');
  const [row] = await db('ledger_accounts')
    .insert({ number, name, type, is_seed: false, active: true })
    .returning('*');
  return row || db('ledger_accounts').where({ number }).first();
}

async function updateAccount(id, { number, name, type, active }) {
  const patch = { updated_at: new Date() };
  if (number !== undefined) patch.number = number;
  if (name !== undefined) patch.name = name;
  if (type !== undefined) {
    if (!ACCOUNT_TYPES.includes(type)) throw httpError(400, 'invalid account type', 'VALIDATION');
    patch.type = type;
  }
  if (active !== undefined) patch.active = !!active;
  if (patch.number) {
    const clash = await db('ledger_accounts').where({ number: patch.number }).whereNot({ id }).first();
    if (clash) throw httpError(409, 'an account with this number already exists', 'DUPLICATE');
  }
  await db('ledger_accounts').where({ id }).update(patch);
  return db('ledger_accounts').where({ id }).first();
}

/** Hard-delete only when nothing references the account; otherwise tell the
 *  caller to deactivate instead (keeps mappings + exports stable). */
async function deleteAccount(id) {
  const acct = await db('ledger_accounts').where({ id }).first();
  if (!acct) throw httpError(404, 'account not found', 'NOT_FOUND');
  const refs = await accountReferences(acct);
  if (refs.length) throw httpError(409, `account is in use (${refs.join(', ')}) — deactivate it instead`, 'IN_USE');
  await db('ledger_accounts').where({ id }).del();
  return { deleted: true };
}

async function accountReferences(acct) {
  const refs = [];
  const vat = await db('vat_codes').where({ account_id: acct.id }).first();
  if (vat) refs.push('VAT code');
  if (await db.schema.hasColumn('expense_categories', 'ledger_account_id')) {
    const cat = await db('expense_categories').where({ ledger_account_id: acct.id }).first();
    if (cat) refs.push('expense category');
  }
  // Default-account settings reference accounts by NUMBER.
  const settingKeys = ['ledger_account_debitoren', 'ledger_account_kreditoren', 'ledger_account_bank',
    'ledger_account_cash', 'ledger_account_default_revenue', 'ledger_account_default_expense',
    'ledger_account_mileage', 'ledger_account_per_diem', 'ledger_account_rebilled_revenue'];
  const settingRows = await db('app_settings').whereIn('setting_key', settingKeys).select('setting_value');
  if (settingRows.some((r) => safeParse(r.setting_value) === acct.number)) refs.push('default-account setting');
  return refs;
}

// ── CRUD: VAT codes ──────────────────────────────────────────────────
async function listVatCodes() {
  return db('vat_codes').orderBy('display_order', 'asc').select('*');
}

async function createVatCode({ code, name, rate, direction, accountId }) {
  if (!code || !name) throw httpError(400, 'code and name are required', 'VALIDATION');
  if (!VAT_DIRECTIONS.includes(direction)) throw httpError(400, 'invalid direction', 'VALIDATION');
  const exists = await db('vat_codes').where({ code }).first();
  if (exists) throw httpError(409, 'a VAT code with this code already exists', 'DUPLICATE');
  const [row] = await db('vat_codes')
    .insert({ code, name, rate: Number(rate) || 0, direction, account_id: accountId || null, is_seed: false, active: true })
    .returning('*');
  return row || db('vat_codes').where({ code }).first();
}

async function updateVatCode(id, { code, name, rate, direction, accountId, active }) {
  const patch = { updated_at: new Date() };
  if (code !== undefined) patch.code = code;
  if (name !== undefined) patch.name = name;
  if (rate !== undefined) patch.rate = Number(rate) || 0;
  if (direction !== undefined) {
    if (!VAT_DIRECTIONS.includes(direction)) throw httpError(400, 'invalid direction', 'VALIDATION');
    patch.direction = direction;
  }
  if (accountId !== undefined) patch.account_id = accountId || null;
  if (active !== undefined) patch.active = !!active;
  if (patch.code) {
    const clash = await db('vat_codes').where({ code: patch.code }).whereNot({ id }).first();
    if (clash) throw httpError(409, 'a VAT code with this code already exists', 'DUPLICATE');
  }
  await db('vat_codes').where({ id }).update(patch);
  return db('vat_codes').where({ id }).first();
}

async function deleteVatCode(id) {
  const vat = await db('vat_codes').where({ id }).first();
  if (!vat) throw httpError(404, 'VAT code not found', 'NOT_FOUND');
  // Referenced by the tax_treatment / output-rate maps?
  const [vatMap, outputVatMap] = await Promise.all([
    getAppSetting('ledger_vat_map', {}), getAppSetting('ledger_output_vat_map', {}),
  ]);
  const used = Object.values(vatMap || {}).includes(vat.code) || Object.values(outputVatMap || {}).includes(vat.code);
  if (used) throw httpError(409, 'VAT code is referenced by a mapping — change the mapping first', 'IN_USE');
  await db('vat_codes').where({ id }).del();
  return { deleted: true };
}

// ── mappings (categories + settings) ─────────────────────────────────
async function getMappings() {
  const hasCol = await db.schema.hasColumn('expense_categories', 'ledger_account_id');
  const categories = await db('expense_categories')
    .orderBy('display_order', 'asc')
    .select('id', 'name', 'color', hasCol ? 'ledger_account_id' : db.raw('NULL as ledger_account_id'));
  const settingKeys = ['ledger_account_debitoren', 'ledger_account_kreditoren', 'ledger_account_bank',
    'ledger_account_cash', 'ledger_account_default_revenue', 'ledger_account_default_expense',
    'ledger_account_mileage', 'ledger_account_per_diem', 'ledger_account_rebilled_revenue',
    'ledger_vat_map', 'ledger_output_vat_map'];
  const rows = await db('app_settings').whereIn('setting_key', settingKeys).select('setting_key', 'setting_value');
  const settings = {};
  for (const r of rows) settings[r.setting_key] = safeParse(r.setting_value);
  return { categories, settings };
}

async function setCategoryAccount(categoryId, ledgerAccountId) {
  if (!(await db.schema.hasColumn('expense_categories', 'ledger_account_id'))) {
    throw httpError(409, 'category→account mapping column missing', 'SCHEMA');
  }
  await db('expense_categories').where({ id: categoryId }).update({ ledger_account_id: ledgerAccountId || null });
  return db('expense_categories').where({ id: categoryId }).first();
}

/** Update the ledger_* app_settings (default accounts + VAT maps). Only
 *  whitelisted keys; values stored JSON-stringified (matching the store). */
async function updateSettings(patch) {
  const allowed = new Set(['ledger_account_debitoren', 'ledger_account_kreditoren', 'ledger_account_bank',
    'ledger_account_cash', 'ledger_account_default_revenue', 'ledger_account_default_expense',
    'ledger_account_mileage', 'ledger_account_per_diem', 'ledger_account_rebilled_revenue',
    'ledger_vat_map', 'ledger_output_vat_map']);
  const updated = [];
  for (const [key, value] of Object.entries(patch || {})) {
    if (!allowed.has(key)) continue;
    const existing = await db('app_settings').where({ setting_key: key }).first();
    if (existing) {
      await db('app_settings').where({ setting_key: key }).update({ setting_value: JSON.stringify(value) });
    } else {
      await db('app_settings').insert({ setting_key: key, setting_value: JSON.stringify(value), setting_type: 'accounting' });
    }
    updated.push(key);
  }
  return { updated };
}

// ── posting engine ───────────────────────────────────────────────────
/**
 * Build the accrual collective journal for [from, to] in `cur`.
 *
 * Returns { postings, currency, period }. Each posting is a single
 * Buchungssatz:
 *   { date, docNumber, description, debitAccount, debitName, creditAccount,
 *     creditName, grossMinor, netMinor, vatMinor, vatCode, vatRate, source,
 *     eventName }
 * Amount is GROSS (the VAT code lets the target software expand net+VAT).
 * `netMinor`/`vatMinor` are included for tooling that imports net amounts.
 */
async function buildPostings({ from, to, currency } = {}) {
  if (!from || !to) throw httpError(400, '`from` and `to` are required (YYYY-MM-DD)', 'VALIDATION');
  if (!currency) throw httpError(400, '`currency` is required', 'VALIDATION');
  const cur = String(currency).toUpperCase();
  // Inclusive end-of-day bound; plain range comparison (no SQL date()) so it's
  // valid on both Postgres and SQLite.
  const toEnd = `${to} 23:59:59.999`;

  return withRetry(async () => {
    const cfg = await getConfig();
    const nameOf = (number) => cfg.accountByNumber.get(number)?.name || '';
    const postings = [];

    // 1) Revenue invoices → Dr Debitoren / Cr Ertrag (gross, output VAT code).
    // Migration 130 — prefer the snapshotted vat_code; guard for pre-130 DBs.
    const hasInvVatCode = await db.schema.hasColumn('invoices', 'vat_code');
    const invoices = await db('invoices')
      .leftJoin('customer_accounts', 'invoices.customer_account_id', 'customer_accounts.id')
      .leftJoin('events', 'invoices.event_id', 'events.id')
      .whereBetween('invoices.issue_date', [from, to])
      .where('invoices.currency', cur)
      .whereIn('invoices.status', REVENUE_STATUSES)
      .orderBy('invoices.issue_date', 'asc')
      .select(
        'invoices.id', 'invoices.invoice_number', 'invoices.issue_date', 'invoices.vat_rate',
        ...(hasInvVatCode ? ['invoices.vat_code'] : []),
        'invoices.net_amount_minor', 'invoices.vat_amount_minor', 'invoices.total_amount_minor',
        'customer_accounts.company_name as customer_company_name',
        'customer_accounts.first_name as customer_first_name',
        'customer_accounts.last_name as customer_last_name',
        'customer_accounts.display_name as customer_display_name',
        'customer_accounts.email as customer_email',
        db.raw('COALESCE(invoices.event_name, events.event_name) AS event_name'),
      );
    for (const inv of invoices) {
      const revAcct = cfg.settings.defaultRevenue;
      // Prefer the snapshot taken at issue time; legacy rows fall back to the
      // (mutable) rate→code map.
      const vatCode = inv.vat_code || cfg.outputVatMap[rateKey(inv.vat_rate)] || '';
      const label = buildCustomerLabel(inv);
      postings.push({
        date: inv.issue_date,
        docNumber: inv.invoice_number || '',
        description: [inv.invoice_number, label].filter(Boolean).join(' · '),
        debitAccount: cfg.settings.debitoren, debitName: nameOf(cfg.settings.debitoren),
        creditAccount: revAcct, creditName: nameOf(revAcct),
        grossMinor: ensureInt(inv.total_amount_minor),
        netMinor: ensureInt(inv.net_amount_minor),
        vatMinor: ensureInt(inv.vat_amount_minor),
        vatCode, vatRate: Number(inv.vat_rate) || 0,
        source: 'revenue', eventName: inv.event_name || '',
      });
    }

    // 2) Incoming supplier invoices → Dr Aufwand / Cr Kreditoren (input VAT).
    if (await db.schema.hasTable('inbound_documents')) {
      const hasCatCol = await db.schema.hasColumn('expense_categories', 'ledger_account_id');
      const inbound = await db('inbound_documents')
        .leftJoin('events', 'inbound_documents.event_id', 'events.id')
        .modify((q) => {
          if (hasCatCol) q.leftJoin('expense_categories', 'inbound_documents.category_id', 'expense_categories.id');
        })
        .where((qb) => {
          qb.whereBetween('inbound_documents.invoice_date', [from, to])
            .orWhere((q2) => q2.whereNull('inbound_documents.invoice_date')
              .andWhere('inbound_documents.created_at', '>=', from)
              .andWhere('inbound_documents.created_at', '<=', toEnd));
        })
        .where((qb) => { qb.where('inbound_documents.currency', cur).orWhereNull('inbound_documents.currency'); })
        .whereNotIn('inbound_documents.status', ['declined', 'duplicate'])
        .orderBy('inbound_documents.created_at', 'asc')
        .select(
          'inbound_documents.id', 'inbound_documents.invoice_number', 'inbound_documents.invoice_date',
          'inbound_documents.created_at', 'inbound_documents.supplier_name', 'inbound_documents.tax_treatment',
          'inbound_documents.net_amount_minor', 'inbound_documents.vat_amount_minor', 'inbound_documents.total_amount_minor',
          'inbound_documents.event_id',
          hasCatCol ? 'expense_categories.ledger_account_id as cat_account_id' : db.raw('NULL as cat_account_id'),
          'events.event_name as event_name',
        );
      for (const d of inbound) {
        const acctNumber = cfg.accountById.get(d.cat_account_id)?.number || cfg.settings.defaultExpense;
        const vatCode = cfg.vatMap[d.tax_treatment || 'domestic'] || '';
        const gross = ensureInt(d.total_amount_minor) || (ensureInt(d.net_amount_minor) + ensureInt(d.vat_amount_minor));
        postings.push({
          date: d.invoice_date || d.created_at,
          docNumber: d.invoice_number || '',
          description: [d.supplier_name, d.invoice_number].filter(Boolean).join(' · '),
          debitAccount: acctNumber, debitName: nameOf(acctNumber),
          creditAccount: cfg.settings.kreditoren, creditName: nameOf(cfg.settings.kreditoren),
          grossMinor: gross,
          netMinor: ensureInt(d.net_amount_minor) || (gross - ensureInt(d.vat_amount_minor)),
          vatMinor: ensureInt(d.vat_amount_minor),
          vatCode, vatRate: 0,
          source: 'incoming', eventName: d.event_id ? (d.event_name || '') : '',
        });
      }
    }

    // 3) Internal expenses → Dr Aufwand / Cr Kreditoren (input VAT).
    if (await db.schema.hasTable('expenses')) {
      const hasCatCol = await db.schema.hasColumn('expense_categories', 'ledger_account_id');
      const expenses = await db('expenses')
        .leftJoin('events', 'expenses.event_id', 'events.id')
        .modify((q) => {
          if (hasCatCol) q.leftJoin('expense_categories', 'expenses.category_id', 'expense_categories.id');
        })
        .whereRaw('expenses.created_at >= ? AND expenses.created_at <= ?', [from, toEnd])
        .whereNot('expenses.status', 'declined')
        .whereNotIn('expenses.disposition', ['duplikat', 'abgelehnt'])
        .modify((q) => { if (cur !== 'CHF') q.where('expenses.original_currency', cur); })
        .orderBy('expenses.created_at', 'asc')
        .select(
          'expenses.id', 'expenses.created_at', 'expenses.kind', 'expenses.supplier_name', 'expenses.description',
          'expenses.tax_treatment', 'expenses.event_id',
          'expenses.original_amount_minor', 'expenses.chf_amount_minor',
          'expenses.net_amount_minor', 'expenses.vat_amount_minor', 'expenses.gross_amount_minor',
          hasCatCol ? 'expense_categories.ledger_account_id as cat_account_id' : db.raw('NULL as cat_account_id'),
          'events.event_name as event_name',
        );
      const isChf = cur === 'CHF';
      for (const e of expenses) {
        // Account: category mapping → kind default (mileage/per-diem) → default expense.
        let acctNumber = cfg.accountById.get(e.cat_account_id)?.number;
        if (!acctNumber && e.kind === 'mileage') acctNumber = cfg.settings.mileage;
        if (!acctNumber && e.kind === 'per_diem') acctNumber = cfg.settings.perDiem;
        if (!acctNumber) acctNumber = cfg.settings.defaultExpense;
        const vatCode = cfg.vatMap[e.tax_treatment || 'domestic'] || '';
        const base = isChf ? ensureInt(e.chf_amount_minor) : ensureInt(e.original_amount_minor);
        const gross = ensureInt(e.gross_amount_minor) || ((ensureInt(e.net_amount_minor) || ensureInt(e.vat_amount_minor)) ? ensureInt(e.net_amount_minor) + ensureInt(e.vat_amount_minor) : base);
        postings.push({
          date: e.created_at,
          docNumber: `EXP-${e.id}`,
          description: e.description || e.supplier_name || `Expense #${e.id}`,
          debitAccount: acctNumber, debitName: nameOf(acctNumber),
          creditAccount: cfg.settings.kreditoren, creditName: nameOf(cfg.settings.kreditoren),
          grossMinor: gross,
          netMinor: ensureInt(e.net_amount_minor) || (gross - ensureInt(e.vat_amount_minor)),
          vatMinor: ensureInt(e.vat_amount_minor),
          vatCode, vatRate: 0,
          source: 'expense', eventName: e.event_id ? (e.event_name || '') : '',
        });
      }
    }

    postings.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
    return { postings, currency: cur, period: { from, to } };
  });
}

// ── export formatters ────────────────────────────────────────────────
function csvEscape(cell) {
  // Formula-injection defence (Excel/Numbers/Banana) THEN RFC-4180 quote-wrap.
  const s = neutralizeSpreadsheetFormula(cell === null || cell === undefined ? '' : String(cell));
  return `"${s.replace(/"/g, '""')}"`;
}
function minorToDecimal(m) { return ((Number(m) || 0) / 100).toFixed(2); }
// yyyy-mm-dd, robust to Postgres returning DATE/TIMESTAMP columns as JS Date
// objects (SQLite returns strings). String(dateObj).slice(0,10) yields
// "Thu Jan 15", which Banana / accounting tools reject — so format the calendar
// parts explicitly. Uses local parts (DATE columns come back at local midnight).
function dateOnly(d) {
  if (!d) return '';
  if (d instanceof Date) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  return String(d).slice(0, 10);
}

const EXPORT_FORMATS = ['generic', 'banana', 'banana_ie', 'bexio'];

/**
 * Render the collective journal in the requested format. Returns
 * { content, filename, contentType }. All are single-row Soll/Haben
 * ("two-account") layouts with a VAT-code column — the universal Swiss
 * import shape Banana + bexio both accept.
 */
async function exportPostings({ from, to, currency, format = 'generic' } = {}) {
  const fmt = EXPORT_FORMATS.includes(format) ? format : 'generic';
  const { postings, currency: cur, period } = await buildPostings({ from, to, currency });
  const eol = '\r\n';
  let headers; let rowOf;

  if (fmt === 'banana') {
    // Banana "Conti doppia" import (Actions → Import into accounting → "Text
    // file with column headers"): Date, Doc, Description, AccountDebit,
    // AccountCredit, Amount, VatCode. Amount = gross; VatCode expands VAT.
    // Serialised TAB-separated + .txt below (Banana's required shape).
    headers = ['Date', 'Doc', 'Description', 'AccountDebit', 'AccountCredit', 'Amount', 'VatCode'];
    rowOf = (p) => [dateOnly(p.date), p.docNumber, p.description, p.debitAccount, p.creditAccount, minorToDecimal(p.grossMinor), p.vatCode];
  } else if (fmt === 'banana_ie') {
    // Banana Income & Expense (cash-book / Einnahmen-Ausgaben) import — for a
    // file that is NOT double-entry. Columns: Date, Doc, Description, Income,
    // Expenses, Category (the income/expense category account), VatCode. NOTE:
    // the category column's NameXml in an I&E file is "Category" (verified
    // against a real Banana file) — NOT the double-entry "ContraAccount".
    // Revenue → gross in Income + the revenue account; cost → gross in Expenses
    // + the expense account. VatCode warns harmlessly on a non-VAT file. Same
    // TAB-separated .txt shape as double-entry.
    headers = ['Date', 'Doc', 'Description', 'Income', 'Expenses', 'Category', 'VatCode'];
    rowOf = (p) => {
      const isRevenue = p.source === 'revenue';
      const amount = minorToDecimal(p.grossMinor);
      // Category = the P&L account: revenue account (credit side) for income,
      // expense account (debit side) for costs.
      const category = isRevenue ? p.creditAccount : p.debitAccount;
      return [dateOnly(p.date), p.docNumber, p.description,
        isRevenue ? amount : '', isRevenue ? '' : amount, category, p.vatCode];
    };
  } else if (fmt === 'bexio') {
    // bexio manual-entry import.
    headers = ['date', 'reference_nr', 'description', 'debit_account', 'credit_account', 'amount', 'tax_code', 'currency'];
    rowOf = (p) => [dateOnly(p.date), p.docNumber, p.description, p.debitAccount, p.creditAccount, minorToDecimal(p.grossMinor), p.vatCode, cur];
  } else {
    // Generic — every column a human or any tool could want.
    headers = ['Date', 'DocNumber', 'Description', 'Source', 'Event',
      'DebitAccount', 'DebitAccountName', 'CreditAccount', 'CreditAccountName',
      'VatCode', 'Currency', 'GrossAmount', 'NetAmount', 'VatAmount'];
    rowOf = (p) => [dateOnly(p.date), p.docNumber, p.description, p.source, p.eventName,
      p.debitAccount, p.debitName, p.creditAccount, p.creditName,
      p.vatCode, cur, minorToDecimal(p.grossMinor), minorToDecimal(p.netMinor), minorToDecimal(p.vatMinor)];
  }

  // Banana's "Text file with column headers" import (banana.ch doc 9946/9947)
  // requires a TAB-separated .txt with UNQUOTED values — a comma .csv won't even
  // appear in its *.txt file picker. Both Banana variants use it; generic /
  // bexio stay comma-CSV (RFC 4180).
  const isTab = fmt === 'banana' || fmt === 'banana_ie';
  const sep = isTab ? '\t' : ',';
  // Tab layout: strip any tab/newline from a cell so it can't split the row;
  // CSV cells go through the RFC-4180 quoter instead.
  const fmtCell = isTab
    ? (v) => neutralizeSpreadsheetFormula(String(v == null ? '' : v).replace(/[\t\r\n]+/g, ' '))
    : csvEscape;
  const lines = [headers.map(fmtCell).join(sep)];
  for (const p of postings) lines.push(rowOf(p).map(fmtCell).join(sep));
  const content = lines.join(eol) + eol;
  const ext = isTab ? 'txt' : 'csv';
  const filename = `journal_${period.from}_to_${period.to}_${cur}_${fmt}.${ext}`;
  const contentType = isTab ? 'text/plain; charset=utf-8' : 'text/csv; charset=utf-8';
  return { content, filename, contentType, count: postings.length };
}

// ── small util ───────────────────────────────────────────────────────
function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status; err.statusCode = status; err.code = code;
  return err;
}
function safeParse(v) {
  if (v == null) return null;
  try { return JSON.parse(v); } catch (_) { return v; }
}

module.exports = {
  ACCOUNT_TYPES, VAT_DIRECTIONS, EXPORT_FORMATS,
  listAccounts, createAccount, updateAccount, deleteAccount,
  listVatCodes, createVatCode, updateVatCode, deleteVatCode,
  getMappings, setCategoryAccount, updateSettings,
  getConfig, buildPostings, exportPostings,
  _internal: { rateKey, csvEscape, neutralizeSpreadsheetFormula, minorToDecimal },
};
