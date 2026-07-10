/**
 * Smoke tests for taxReportService.renderTaxReportPdf and
 * renderTaxReportCsv. We deep-mock the db (canned invoice rows) +
 * businessProfileService (canned issuer) and assert that the
 * rendered output meets a few hard requirements:
 *
 *   - PDF starts with the %PDF magic bytes, is non-empty
 *   - CSV header contains the localised column names
 *   - CSV body contains the invoice numbers in order
 *   - CSV totals row contains the grand totals
 */

let invoiceRowsForRun = [];
let replacementsRowsForRun = [];
let callCount = 0;

function makeChain(initialRows) {
  return {
    _rows: initialRows,
    then(onResolve, onReject) {
      return Promise.resolve(this._rows).then(onResolve, onReject);
    },
    leftJoin: jest.fn(function () { return this; }),
    where: jest.fn(function () { return this; }),
    whereNot: jest.fn(function () { return this; }),
    whereIn: jest.fn(function () { return this; }),
    whereNotIn: jest.fn(function () { return this; }),
    whereBetween: jest.fn(function () { return this; }),
    whereRaw: jest.fn(function () { return this; }),
    orderBy: jest.fn(function () { return this; }),
    orderByRaw: jest.fn(function () { return this; }),
    select: jest.fn(function () { return Promise.resolve(this._rows); }),
  };
}

const mockDbFn = jest.fn((tableName) => {
  // Route by table name when supplied — the Skonto aggregate (added
  // by migration 126) queries `invoice_payment_log`; the #4 cost side
  // queries `inbound_documents` + `expenses`; everything else (main
  // listing, replacements lookup) hits `invoices`.
  if (tableName === 'invoice_payment_log') return makeChain([]);
  if (tableName === 'inbound_documents') return makeChain([]);
  if (tableName === 'expenses') return makeChain([]);
  callCount += 1;
  if (callCount === 1) return makeChain(invoiceRowsForRun);
  return makeChain(replacementsRowsForRun);
});
// `.raw()` is used in the .select() column list for the event_name
// COALESCE (migration 123). The chain's select() ignores its
// arguments so the raw() return value just needs to exist.
mockDbFn.raw = jest.fn((sql) => sql);
// #4 loadCosts schema-guards each cost table; default the PDF/CSV
// fixtures to "no accounting tables" so these renderers exercise the
// revenue path unchanged.
mockDbFn.schema = { hasTable: jest.fn(async () => false) };

jest.mock('../../src/database/db', () => ({
  db: mockDbFn,
  withRetry: jest.fn(async (fn) => fn()),
}));

jest.mock('../../src/services/businessProfileService', () => ({
  getProfile: jest.fn(async () => ({
    profile: {
      company_name: 'ACME Test GmbH',
      address_line1: 'Teststrasse 1',
      postal_code: '8000',
      city: 'Zürich',
      country_code: 'CH',
      email: 'hello@example.com',
      default_locale: 'de',
      default_currency: 'CHF',
      pdf_show_logo: 1,
      pdf_show_company_name: 1,
      pdf_logo_height: 56,
      pdf_company_name_inline: 0,
      pdf_folding_marks: 'none',
      logo_path: null,
      pdf_font_ttf_path: null,
    },
    bankAccounts: [],
  })),
}));

jest.mock('../../src/utils/appSettings', () => ({
  getAppSetting: jest.fn(async () => ({ format: 'DD.MM.YYYY' })),
}));

const taxReportService = require('../../src/services/taxReportService');

beforeEach(() => {
  invoiceRowsForRun = [];
  replacementsRowsForRun = [];
  callCount = 0;
  mockDbFn.mockClear();
});

const SAMPLE_ROW = (override = {}) => ({
  id: 1, invoice_number: 'R-2026-0001', issue_date: '2026-01-15',
  currency: 'CHF', status: 'paid', vat_rate: 7.7,
  net_amount_minor: 10000, vat_amount_minor: 770, total_amount_minor: 10770,
  late_fee_amount_minor: 0, replaces_invoice_id: null,
  customer_company_name: 'Test Kunde GmbH', customer_first_name: null,
  customer_last_name: null, customer_display_name: null, customer_email: null,
  event_name: 'Hochzeit Müller',
  ...override,
});

describe('renderTaxReportPdf', () => {
  it('produces a non-empty PDF buffer with the %PDF magic header', async () => {
    invoiceRowsForRun = [SAMPLE_ROW()];
    const buf = await taxReportService.renderTaxReportPdf({
      from: '2026-01-01', to: '2026-03-31', currency: 'CHF',
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('renders a header even when no invoices are in the period', async () => {
    invoiceRowsForRun = [];
    const buf = await taxReportService.renderTaxReportPdf({
      from: '2026-01-01', to: '2026-03-31', currency: 'CHF',
    });
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('renders successfully when cancelled rows are present', async () => {
    invoiceRowsForRun = [
      SAMPLE_ROW({ id: 1, invoice_number: 'R-2026-0001', status: 'cancelled' }),
      SAMPLE_ROW({ id: 2, invoice_number: 'R-2026-0002', replaces_invoice_id: 1 }),
    ];
    replacementsRowsForRun = [{ replaces_invoice_id: 1, invoice_number: 'R-2026-0002' }];
    const buf = await taxReportService.renderTaxReportPdf({
      from: '2026-01-01', to: '2026-03-31', currency: 'CHF', locale: 'de',
    });
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('renders without throwing when a row has long text that must wrap', async () => {
    // Customer + event labels long enough to force multi-line wrap
    // in their narrow columns. The dynamic row-height logic should
    // grow the row to fit rather than overlapping the next one.
    invoiceRowsForRun = [
      SAMPLE_ROW({
        customer_company_name: 'Sehr lange Firmenbezeichnung mit Adresszusatz GmbH & Co. KG',
        event_name: 'Hochzeit Müller & Schmidt — ganztägige Reportage inkl. Empfang und Trauung',
      }),
      SAMPLE_ROW({ id: 2, invoice_number: 'R-2026-0002' }),
    ];
    const buf = await taxReportService.renderTaxReportPdf({
      from: '2026-01-01', to: '2026-03-31', currency: 'CHF', locale: 'de',
    });
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('honours the locale parameter (en) without throwing', async () => {
    invoiceRowsForRun = [SAMPLE_ROW()];
    const buf = await taxReportService.renderTaxReportPdf({
      from: '2026-01-01', to: '2026-03-31', currency: 'CHF', locale: 'en',
    });
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  });

  // Regression: the page-number footer used to place its baseline
  // inside the bottom margin, which made PDFKit auto-paginate one
  // empty page per existing page (so a 1-page report ended up as 2,
  // and so on). Counting `/Type /Page` markers in the raw PDF bytes
  // is the cheapest way to detect a recurrence without parsing the
  // PDF — every page object in the xref table carries that marker
  // exactly once.
  it('does not duplicate pages when stamping the page-number footer', async () => {
    invoiceRowsForRun = [SAMPLE_ROW()];
    const buf = await taxReportService.renderTaxReportPdf({
      from: '2026-01-01', to: '2026-03-31', currency: 'CHF', locale: 'de',
    });
    const pageMarkers = buf.toString('binary').match(/\/Type\s*\/Page\b(?!s)/g) || [];
    // Small single-row report should fit on a single page. The
    // previous buggy renderer produced 2 (1 content + 1 footer-only).
    expect(pageMarkers.length).toBe(1);
  });
});

describe('renderTaxReportCsv', () => {
  it('returns a CSV blob with the de localised header row', async () => {
    invoiceRowsForRun = [SAMPLE_ROW()];
    const { content, filename, contentType } = await taxReportService.renderTaxReportCsv({
      from: '2026-01-01', to: '2026-03-31', currency: 'CHF', locale: 'de',
    });
    expect(contentType).toMatch(/text\/csv/);
    expect(filename).toBe('tax_report_2026-01-01_to_2026-03-31_CHF.csv');
    const lines = content.split('\r\n');
    // Unified ledger CSV: Typ / Referenz / Kunde-Lieferant columns replace the
    // old Rechnung/Kunde split.
    expect(lines[0]).toContain('Typ');       // de header for tax_col_type
    expect(lines[0]).toContain('Referenz');  // de header for tax_col_reference
    expect(lines[0]).toContain('Kunde');     // "Kunde / Lieferant"
    expect(lines[0]).toContain('Netto');
  });

  it('lists each invoice on its own row in order', async () => {
    invoiceRowsForRun = [
      SAMPLE_ROW({ id: 1, invoice_number: 'R-2026-0001' }),
      SAMPLE_ROW({ id: 2, invoice_number: 'R-2026-0002' }),
      SAMPLE_ROW({ id: 3, invoice_number: 'R-2026-0003' }),
    ];
    const { content } = await taxReportService.renderTaxReportCsv({
      from: '2026-01-01', to: '2026-03-31', currency: 'CHF', locale: 'en',
    });
    const idxA = content.indexOf('R-2026-0001');
    const idxB = content.indexOf('R-2026-0002');
    const idxC = content.indexOf('R-2026-0003');
    expect(idxA).toBeGreaterThan(0);
    expect(idxB).toBeGreaterThan(idxA);
    expect(idxC).toBeGreaterThan(idxB);
  });

  it('appends a trailing totals row with the grand totals', async () => {
    invoiceRowsForRun = [
      SAMPLE_ROW({
        net_amount_minor: 10000, vat_amount_minor: 770, total_amount_minor: 10770,
      }),
      SAMPLE_ROW({
        id: 2, invoice_number: 'R-2026-0002',
        net_amount_minor: 5000, vat_amount_minor: 385, total_amount_minor: 5385,
      }),
    ];
    const { content } = await taxReportService.renderTaxReportCsv({
      from: '2026-01-01', to: '2026-03-31', currency: 'CHF', locale: 'en',
    });
    // Grand totals: net = 150.00, vat = 11.55, total = 161.55.
    expect(content).toMatch(/"150\.00"/);
    expect(content).toMatch(/"11\.55"/);
    expect(content).toMatch(/"161\.55"/);
  });

  it('flags a cancelled row with a "(Cancelled)" suffix on its Reference cell', async () => {
    invoiceRowsForRun = [
      SAMPLE_ROW({ status: 'cancelled' }),
    ];
    const { content } = await taxReportService.renderTaxReportCsv({
      from: '2026-01-01', to: '2026-03-31', currency: 'CHF', locale: 'en',
    });
    // Unified ledger CSV has no separate cancelled column — a cancelled row is
    // flagged by appending the localised "(Cancelled)" tag to its Reference.
    const dataRow = content.split('\r\n')[1];
    expect(dataRow).toContain('R-2026-0001 (Cancelled)');
  });

  it('uses CRLF line endings (RFC 4180) and BOM-free body', async () => {
    invoiceRowsForRun = [SAMPLE_ROW()];
    const { content } = await taxReportService.renderTaxReportCsv({
      from: '2026-01-01', to: '2026-03-31', currency: 'CHF', locale: 'en',
    });
    expect(content).toContain('\r\n');
    // The route wraps the BOM around the content; the service output
    // itself is BOM-free so callers (tests) get a clean string.
    expect(content.charCodeAt(0)).not.toBe(0xFEFF);
  });
});
