/**
 * Tests for ledgerService (Accounting Layer A).
 *
 * Two layers:
 *   1. Pure helpers (rateKey, csvEscape, minorToDecimal).
 *   2. buildPostings + exportPostings — db chain + appSettings mocked so we can
 *      feed canned invoices/inbound/expenses and assert the Buchungssätze +
 *      the per-tool CSV shapes.
 */

// ----- canned data per table ------------------------------------------
let accountsRows = [];
let vatRows = [];
let invoiceRows = [];
let inboundRows = [];
let expenseRows = [];

function makeChain(rows) {
  const c = {
    _rows: rows,
    then(onR, onJ) { return Promise.resolve(this._rows).then(onR, onJ); },
    leftJoin() { return this; },
    where() { return this; },
    whereNot() { return this; },
    whereIn() { return this; },
    whereNotIn() { return this; },
    whereBetween() { return this; },
    whereRaw() { return this; },
    orderBy() { return this; },
    orderByRaw() { return this; },
    modify(cb) { if (typeof cb === 'function') cb(this); return this; },
    select() { return Promise.resolve(this._rows); },
    first() { return Promise.resolve(this._rows[0]); },
  };
  return c;
}

const mockDbFn = jest.fn((table) => {
  switch (table) {
    case 'ledger_accounts': return makeChain(accountsRows);
    case 'vat_codes': return makeChain(vatRows);
    case 'invoices': return makeChain(invoiceRows);
    case 'inbound_documents': return makeChain(inboundRows);
    case 'expenses': return makeChain(expenseRows);
    default: return makeChain([]);
  }
});
mockDbFn.raw = (s) => s;
mockDbFn.schema = {
  hasTable: jest.fn(async () => true),
  hasColumn: jest.fn(async () => true),
};

jest.mock('../../src/database/db', () => ({ db: mockDbFn, withRetry: async (fn) => fn() }));

const SETTINGS = {
  ledger_account_debitoren: '1100',
  ledger_account_kreditoren: '2000',
  ledger_account_default_revenue: '3400',
  ledger_account_default_expense: '6700',
  ledger_account_mileage: '6200',
  ledger_account_per_diem: '6640',
  ledger_account_rebilled_revenue: '3940',
  ledger_vat_map: { domestic: 'VST81', reverse_charge_service: 'BZ', foreign_vat_non_reclaimable: 'VST00', import_goods: 'VST81' },
  ledger_output_vat_map: { '8.1': 'UN81', '2.6': 'UN26', '3.8': 'UN38', '0': 'UN00' },
};
jest.mock('../../src/utils/appSettings', () => ({
  getAppSetting: jest.fn(async (key, def) => (key in SETTINGS ? SETTINGS[key] : def)),
}));

const ledgerService = require('../../src/services/ledgerService');
const { rateKey, csvEscape, minorToDecimal } = ledgerService._internal;

beforeEach(() => {
  accountsRows = [
    { id: 1, number: '1100', name: 'Debitoren', type: 'asset' },
    { id: 2, number: '3400', name: 'Dienstleistungsertrag', type: 'revenue' },
    { id: 3, number: '2000', name: 'Kreditoren', type: 'liability' },
    { id: 4, number: '6570', name: 'Informatikaufwand', type: 'expense' },
    { id: 5, number: '6200', name: 'Fahrzeugaufwand', type: 'expense' },
    { id: 6, number: '6700', name: 'Sonstiger Betriebsaufwand', type: 'expense' },
  ];
  vatRows = [{ id: 9, code: 'UN81', rate: 8.1, direction: 'output', account_id: null }];
  invoiceRows = [];
  inboundRows = [];
  expenseRows = [];
});

// ----- pure helpers ----------------------------------------------------
describe('rateKey', () => {
  it('normalises rate to the output-map key', () => {
    expect(rateKey(8.1)).toBe('8.1');
    expect(rateKey(8.10)).toBe('8.1');
    expect(rateKey('2.60')).toBe('2.6');
    expect(rateKey(0)).toBe('0');
    expect(rateKey(null)).toBe('0');
  });
});

describe('csvEscape / minorToDecimal', () => {
  it('quotes + doubles inner quotes', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvEscape(null)).toBe('""');
  });
  it('renders minor units as 2dp', () => {
    expect(minorToDecimal(10810)).toBe('108.10');
    expect(minorToDecimal(0)).toBe('0.00');
    expect(minorToDecimal(null)).toBe('0.00');
  });
});

// ----- buildPostings ---------------------------------------------------
describe('buildPostings', () => {
  const period = { from: '2026-01-01', to: '2026-03-31', currency: 'CHF' };

  it('books a revenue invoice as Dr Debitoren / Cr Ertrag with the output VAT code', async () => {
    invoiceRows = [{
      id: 1, invoice_number: 'R-2026-0001', issue_date: '2026-01-10', vat_rate: 8.1,
      net_amount_minor: 10000, vat_amount_minor: 810, total_amount_minor: 10810,
      customer_company_name: 'ACME GmbH', event_name: 'Wedding A',
    }];
    const { postings } = await ledgerService.buildPostings(period);
    expect(postings).toHaveLength(1);
    expect(postings[0]).toMatchObject({
      debitAccount: '1100', debitName: 'Debitoren',
      creditAccount: '3400', creditName: 'Dienstleistungsertrag',
      grossMinor: 10810, netMinor: 10000, vatMinor: 810,
      vatCode: 'UN81', source: 'revenue', eventName: 'Wedding A',
    });
  });

  it('books an incoming invoice as Dr Aufwand(category) / Cr Kreditoren with the input VAT code', async () => {
    inboundRows = [{
      id: 5, invoice_number: 'L-77', invoice_date: '2026-01-12', created_at: '2026-01-13 09:00:00',
      supplier_name: 'Lab AG', tax_treatment: 'domestic',
      net_amount_minor: 2000, vat_amount_minor: 162, total_amount_minor: 2162,
      event_id: 7, cat_account_id: 4, event_name: 'Wedding A',
    }];
    const { postings } = await ledgerService.buildPostings(period);
    expect(postings).toHaveLength(1);
    expect(postings[0]).toMatchObject({
      debitAccount: '6570', creditAccount: '2000',
      grossMinor: 2162, netMinor: 2000, vatMinor: 162,
      vatCode: 'VST81', source: 'incoming', eventName: 'Wedding A',
    });
  });

  it('falls back to the kind default account for a category-less mileage expense', async () => {
    expenseRows = [{
      id: 9, created_at: '2026-02-01 12:00:00', kind: 'mileage', supplier_name: null, description: 'Drive',
      tax_treatment: 'foreign_vat_non_reclaimable', event_id: null,
      original_amount_minor: null, chf_amount_minor: 5000,
      net_amount_minor: null, vat_amount_minor: null, gross_amount_minor: null, cat_account_id: null,
    }];
    const { postings } = await ledgerService.buildPostings(period);
    expect(postings).toHaveLength(1);
    expect(postings[0]).toMatchObject({
      debitAccount: '6200', creditAccount: '2000',
      grossMinor: 5000, vatMinor: 0,
      vatCode: 'VST00', source: 'expense', eventName: '',
    });
  });

  it('sorts the combined journal chronologically across all sources', async () => {
    invoiceRows = [{ id: 1, invoice_number: 'R1', issue_date: '2026-02-20', vat_rate: 8.1, net_amount_minor: 100, vat_amount_minor: 8, total_amount_minor: 108, customer_company_name: 'A' }];
    inboundRows = [{ id: 5, invoice_number: 'L1', invoice_date: '2026-01-05', created_at: '2026-01-05', supplier_name: 'Lab', tax_treatment: 'domestic', net_amount_minor: 50, vat_amount_minor: 4, total_amount_minor: 54, event_id: null, cat_account_id: null }];
    expenseRows = [{ id: 9, created_at: '2026-01-30', kind: 'amount', description: 'x', tax_treatment: 'domestic', event_id: null, chf_amount_minor: 200, net_amount_minor: null, vat_amount_minor: null, gross_amount_minor: null, cat_account_id: null }];
    const { postings } = await ledgerService.buildPostings(period);
    expect(postings.map((p) => p.source)).toEqual(['incoming', 'expense', 'revenue']);
  });

  it('requires from/to/currency', async () => {
    await expect(ledgerService.buildPostings({})).rejects.toThrow(/from.+to/);
    await expect(ledgerService.buildPostings({ from: '2026-01-01', to: '2026-03-31' })).rejects.toThrow(/currency/);
  });
});

// ----- exportPostings --------------------------------------------------
describe('exportPostings', () => {
  const period = { from: '2026-01-01', to: '2026-03-31', currency: 'CHF' };
  beforeEach(() => {
    invoiceRows = [{ id: 1, invoice_number: 'R-2026-0001', issue_date: '2026-01-10', vat_rate: 8.1, net_amount_minor: 10000, vat_amount_minor: 810, total_amount_minor: 10810, customer_company_name: 'ACME' }];
  });

  it('generic format carries all human-friendly columns', async () => {
    const { content, filename, count } = await ledgerService.exportPostings({ ...period, format: 'generic' });
    const [header, row] = content.trim().split('\r\n');
    expect(count).toBe(1);
    expect(header).toContain('DebitAccountName');
    expect(header).toContain('NetAmount');
    expect(header).toContain('VatCode');
    expect(row).toContain('1100');
    expect(row).toContain('108.10'); // gross 2dp
    expect(filename).toMatch(/_generic\.csv$/);
  });

  it('banana format is a TAB-separated .txt with Banana column names', async () => {
    const { content, filename, contentType } = await ledgerService.exportPostings({ ...period, format: 'banana' });
    const header = content.split('\r\n')[0];
    // Banana's "Text file with column headers" import wants TAB-separated,
    // unquoted values in a .txt — not a comma CSV.
    expect(header).toBe('Date\tDoc\tDescription\tAccountDebit\tAccountCredit\tAmount\tVatCode');
    expect(content.split('\r\n')[1]).toContain('\t');
    expect(content).not.toContain('"');
    expect(filename).toMatch(/_banana\.txt$/);
    expect(contentType).toMatch(/text\/plain/);
  });

  it('banana_ie format is Income & Expense columns, tab-separated .txt', async () => {
    const { content, filename, contentType } = await ledgerService.exportPostings({ ...period, format: 'banana_ie' });
    const [header, row] = content.trim().split('\r\n');
    expect(header).toBe('Date\tDoc\tDescription\tIncome\tExpenses\tCategory\tVatCode');
    // The mock period holds one revenue posting (gross 108.10) → Income filled,
    // Expenses empty, Category = the revenue account.
    const cells = row.split('\t');
    expect(cells[3]).toBe('108.10'); // Income
    expect(cells[4]).toBe('');       // Expenses
    expect(cells[5]).not.toBe('');   // Category (revenue account)
    expect(filename).toMatch(/_banana_ie\.txt$/);
    expect(contentType).toMatch(/text\/plain/);
  });

  it('formats a Postgres Date object as yyyy-mm-dd (not "Thu Jan ...")', async () => {
    // PG returns DATE columns as JS Date objects (SQLite returns strings); the
    // export must still emit an ISO date, or Banana rejects it and the Date
    // column imports empty.
    invoiceRows = [{
      id: 1, invoice_number: 'R-2026-0001', issue_date: new Date(2026, 0, 10),
      vat_rate: 8.1, net_amount_minor: 10000, vat_amount_minor: 810, total_amount_minor: 10810,
      customer_company_name: 'ACME',
    }];
    const { content } = await ledgerService.exportPostings({ ...period, format: 'banana' });
    const dateCell = content.split('\r\n')[1].split('\t')[0];
    expect(dateCell).toBe('2026-01-10');
  });

  it('bexio format includes tax_code + currency', async () => {
    const { content } = await ledgerService.exportPostings({ ...period, format: 'bexio' });
    const header = content.split('\r\n')[0];
    expect(header).toContain('tax_code');
    expect(header).toContain('currency');
  });

  it('unknown format falls back to generic', async () => {
    const { filename } = await ledgerService.exportPostings({ ...period, format: 'nope' });
    expect(filename).toMatch(/_generic\.csv$/);
  });
});
