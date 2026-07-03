/**
 * Tests for invoiceService.updateInstallmentPlan + validateInstallmentPlanInput.
 *
 * Validation tests run against the pure validator directly. Orchestration
 * tests use the same deep-mocked db pattern as invoiceService.locks.test.js
 * — chains are queued per table and assertions probe insert/update/delete
 * call shapes rather than SQL.
 */

const chains = [];
function makeChain() {
  const c = {
    _firstValue: undefined,
    _updateResult: 1,
    _insertResult: [{ id: 999 }],
    _selectResult: [],
    then: function (onResolve, onReject) {
      return Promise.resolve(this._selectResult).then(onResolve, onReject);
    },
    where: jest.fn(function () { return this; }),
    whereNot: jest.fn(function () { return this; }),
    whereIn: jest.fn(function () { return this; }),
    whereNull: jest.fn(function () { return this; }),
    whereNotNull: jest.fn(function () { return this; }),
    andWhere: jest.fn(function () { return this; }),
    orderBy: jest.fn(function () { return this; }),
    limit: jest.fn(function () { return this; }),
    select: jest.fn(function () { return this; }),
    sum: jest.fn(function () { return this; }),
    count: jest.fn(function () { return this; }),
    clone: jest.fn(function () { return this; }),
    clearSelect: jest.fn(function () { return this; }),
    clearOrder: jest.fn(function () { return this; }),
    offset: jest.fn(function () { return this; }),
    first: jest.fn(function () { return Promise.resolve(this._firstValue); }),
    update: jest.fn(function () { return Promise.resolve(this._updateResult); }),
    insert: jest.fn(function () { return this; }),
    returning: jest.fn(function () { return Promise.resolve(this._insertResult); }),
    del: jest.fn(function () { return Promise.resolve(1); }),
    onConflict: jest.fn(function () { return this; }),
    ignore: jest.fn(function () { return Promise.resolve(1); }),
    merge: jest.fn(function () { return Promise.resolve(1); }),
    increment: jest.fn(function () { return this; }),
    forUpdate: jest.fn(function () { return this; }),
    leftJoin: jest.fn(function () { return this; }),
  };
  chains.push(c);
  return c;
}

const tableChains = {};
function pickChainFor(name) {
  if (!tableChains[name]) tableChains[name] = makeChain();
  return tableChains[name];
}

const mockDbFn = jest.fn((name) => pickChainFor(name));
mockDbFn.transaction = jest.fn(async (cb) => cb(mockDbFn));

jest.mock('../../src/database/db', () => ({
  db: mockDbFn,
  withRetry: jest.fn(async (fn) => fn()),
  logActivity: jest.fn(async () => {}),
}));

jest.mock('../../src/utils/appSettings', () => ({
  getAppSetting: jest.fn(async () => null),
}));

jest.mock('../../src/services/businessProfileService', () => ({
  getProfile: jest.fn(async () => ({ profile: { default_currency: 'CHF' } })),
  resolveBankAccountForCurrency: jest.fn(async () => null),
}));

jest.mock('../../src/utils/documentSequences', () => {
  const claimNextSequence = jest.fn(async () => 42);
  // Delegates to the claimNextSequence mock so call-count assertions
  // below keep observing sequence claims.
  const nextDocumentNumber = jest.fn(async (kind, settingKey, defaultFormat, trx) => {
    const seq = await claimNextSequence(kind, 2026, trx);
    return `R-2026-${String(seq).padStart(4, '0')}`;
  });
  return { claimNextSequence, nextDocumentNumber };
});

jest.mock('../../src/services/pdfService', () => ({
  renderInvoiceToBuffer: jest.fn(async () => Buffer.from('pdf')),
  renderQuoteToBuffer: jest.fn(async () => Buffer.from('pdf')),
}));

jest.mock('../../src/services/emailProcessor', () => ({
  queueEmail: jest.fn(async () => {}),
}));

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

const invoiceService = require('../../src/services/invoiceService');

function resetChains() {
  for (const k of Object.keys(tableChains)) delete tableChains[k];
}

describe('validateInstallmentPlanInput', () => {
  const { validateInstallmentPlanInput } = invoiceService;

  it('throws on empty array', () => {
    expect(() => validateInstallmentPlanInput([]))
      .toThrow(/non-empty array/);
  });

  it('throws on non-array', () => {
    expect(() => validateInstallmentPlanInput(null))
      .toThrow(/non-empty array/);
  });

  it('throws on out-of-range percent', () => {
    expect(() => validateInstallmentPlanInput([
      { percent: 150, trigger: 'quote_accepted', offset_days: 0 },
    ])).toThrow(/percent must be between 0 and 100/);
    expect(() => validateInstallmentPlanInput([
      { percent: -5, trigger: 'quote_accepted', offset_days: 0 },
    ])).toThrow(/percent must be between 0 and 100/);
  });

  it('throws on unknown trigger', () => {
    expect(() => validateInstallmentPlanInput([
      { percent: 100, trigger: 'on_friday', offset_days: 0 },
    ])).toThrow(/invalid trigger/);
  });

  it('throws when percents do not sum to 100', () => {
    expect(() => validateInstallmentPlanInput([
      { percent: 30, trigger: 'quote_accepted', offset_days: 0 },
      { percent: 50, trigger: 'before_event', offset_days: -7 },
    ])).toThrow(/must sum to 100/);
  });

  it('accepts a valid three-row plan with mixed triggers', () => {
    expect(() => validateInstallmentPlanInput([
      { percent: 30, trigger: 'quote_accepted', offset_days: 0, label: 'Anzahlung' },
      { percent: 40, trigger: 'before_event', offset_days: -14, label: 'Zwischenrechnung' },
      { percent: 30, trigger: 'after_delivery', offset_days: 0, label: 'Schlussrechnung' },
    ])).not.toThrow();
  });

  it('tolerates 0.001 rounding drift in the sum', () => {
    expect(() => validateInstallmentPlanInput([
      { percent: 33.333, trigger: 'quote_accepted', offset_days: 0 },
      { percent: 33.333, trigger: 'before_event', offset_days: -7 },
      { percent: 33.334, trigger: 'after_event', offset_days: 0 },
    ])).not.toThrow();
  });
});

describe('updateInstallmentPlan — guards', () => {
  beforeEach(() => resetChains());

  const goodPlan = [
    { percent: 50, trigger: 'quote_accepted', offset_days: 0, label: 'A' },
    { percent: 50, trigger: 'before_event', offset_days: -14, label: 'B' },
  ];

  it('rejects when dealUuid is missing', async () => {
    await expect(invoiceService.updateInstallmentPlan({
      trx: mockDbFn, dealUuid: '', installments: goodPlan, adminId: 1,
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('404s when the deal has no invoices', async () => {
    pickChainFor('invoices')._selectResult = [];
    await expect(invoiceService.updateInstallmentPlan({
      trx: mockDbFn, dealUuid: 'deal-1', installments: goodPlan, adminId: 1,
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('400s + NOT_INSTALLMENT_PLAN on a single-invoice deal', async () => {
    pickChainFor('invoices')._selectResult = [
      { id: 1, deal_uuid: 'deal-1', installment_total: 1, status: 'scheduled', kind: 'invoice' },
    ];
    await expect(invoiceService.updateInstallmentPlan({
      trx: mockDbFn, dealUuid: 'deal-1', installments: goodPlan, adminId: 1,
    })).rejects.toMatchObject({ statusCode: 400, code: 'NOT_INSTALLMENT_PLAN' });
  });

  it('409s + INVOICE_LOCKED when any sibling has already shipped', async () => {
    pickChainFor('invoices')._selectResult = [
      { id: 1, deal_uuid: 'deal-1', installment_total: 2, installment_index: 0,
        status: 'sent', kind: 'invoice', invoice_number: 'R-2026-0001',
        net_amount_minor: 10000, vat_amount_minor: 770, total_amount_minor: 10770, shipping_amount_minor: 0 },
      { id: 2, deal_uuid: 'deal-1', installment_total: 2, installment_index: 1,
        status: 'scheduled', kind: 'invoice', invoice_number: 'R-2026-0002',
        net_amount_minor: 10000, vat_amount_minor: 770, total_amount_minor: 10770, shipping_amount_minor: 0 },
    ];
    await expect(invoiceService.updateInstallmentPlan({
      trx: mockDbFn, dealUuid: 'deal-1', installments: goodPlan, adminId: 1,
    })).rejects.toMatchObject({ statusCode: 409, code: 'INVOICE_LOCKED' });
  });

  it('409s + PLAN_HAS_STORNO when the deal contains a Storno', async () => {
    pickChainFor('invoices')._selectResult = [
      { id: 1, deal_uuid: 'deal-1', installment_total: 2, installment_index: 0,
        status: 'scheduled', kind: 'storno', invoice_number: 'S-2026-0001',
        net_amount_minor: -5000, vat_amount_minor: -385, total_amount_minor: -5385, shipping_amount_minor: 0 },
      { id: 2, deal_uuid: 'deal-1', installment_total: 2, installment_index: 1,
        status: 'scheduled', kind: 'invoice', invoice_number: 'R-2026-0002',
        net_amount_minor: 10000, vat_amount_minor: 770, total_amount_minor: 10770, shipping_amount_minor: 0 },
    ];
    await expect(invoiceService.updateInstallmentPlan({
      trx: mockDbFn, dealUuid: 'deal-1', installments: goodPlan, adminId: 1,
    })).rejects.toMatchObject({ statusCode: 409, code: 'PLAN_HAS_STORNO' });
  });

  it('rejects an invalid plan (percents not summing to 100) before opening the txn', async () => {
    const badPlan = [
      { percent: 30, trigger: 'quote_accepted', offset_days: 0 },
      { percent: 30, trigger: 'before_event', offset_days: -7 },
    ];
    await expect(invoiceService.updateInstallmentPlan({
      trx: mockDbFn, dealUuid: 'deal-1', installments: badPlan, adminId: 1,
    })).rejects.toMatchObject({ statusCode: 400, code: 'PERCENT_SUM_INVALID' });
  });
});

describe('updateInstallmentPlan — reshape (smoke)', () => {
  beforeEach(() => resetChains());

  const sibling = (overrides) => ({
    id: 0, deal_uuid: 'deal-1', installment_total: 3, installment_index: 0,
    status: 'scheduled', kind: 'invoice', invoice_number: 'R-2026-0001',
    net_amount_minor: 10000, vat_amount_minor: 770, total_amount_minor: 10770,
    shipping_amount_minor: 0, vat_rate: 7.7,
    customer_account_id: 5, source_quote_id: null, event_id: null,
    event_name: 'Wedding', event_date: '2026-08-15',
    language: 'de', currency: 'CHF',
    issue_date: '2026-05-25', due_date: '2026-06-24',
    cc_pdf_email: null,
    payment_net_days_template_id: null, payment_timing_template_id: null,
    payment_term_snapshot: null,
    ...overrides,
  });

  it('keeps invoice_numbers and does not claim new sequence on 3→3 reshape', async () => {
    pickChainFor('invoices')._selectResult = [
      sibling({ id: 1, installment_index: 0, invoice_number: 'R-2026-0001',
        net_amount_minor: 3000, vat_amount_minor: 231, total_amount_minor: 3231 }),
      sibling({ id: 2, installment_index: 1, invoice_number: 'R-2026-0002',
        net_amount_minor: 3000, vat_amount_minor: 231, total_amount_minor: 3231 }),
      sibling({ id: 3, installment_index: 2, invoice_number: 'R-2026-0003',
        net_amount_minor: 4000, vat_amount_minor: 308, total_amount_minor: 4308 }),
    ];
    pickChainFor('customer_accounts')._firstValue = { id: 5, is_active: 1, feature_bills: 1 };
    pickChainFor('invoice_line_items')._selectResult = [];

    const result = await invoiceService.updateInstallmentPlan({
      trx: mockDbFn, dealUuid: 'deal-1', adminId: 42,
      installments: [
        { percent: 20, trigger: 'quote_accepted', offset_days: 0, label: 'A' },
        { percent: 30, trigger: 'before_event', offset_days: -14, label: 'B' },
        { percent: 50, trigger: 'after_event', offset_days: 7, label: 'C' },
      ],
    });

    expect(result.kept).toEqual([1, 2, 3]);
    expect(result.created).toEqual([]);
    expect(result.deleted).toEqual([]);
    // Sequence helper never touched on a same-count reshape.
    const { claimNextSequence } = require('../../src/utils/documentSequences');
    expect(claimNextSequence).not.toHaveBeenCalled();
  });

  it('grows 2→3 by claiming one new invoice_number and keeping the first two', async () => {
    pickChainFor('invoices')._selectResult = [
      sibling({ id: 1, installment_index: 0, invoice_number: 'R-2026-0001',
        net_amount_minor: 5000, vat_amount_minor: 385, total_amount_minor: 5385,
        installment_total: 2 }),
      sibling({ id: 2, installment_index: 1, invoice_number: 'R-2026-0002',
        net_amount_minor: 5000, vat_amount_minor: 385, total_amount_minor: 5385,
        installment_total: 2 }),
    ];
    pickChainFor('customer_accounts')._firstValue = { id: 5, is_active: 1, feature_bills: 1 };
    pickChainFor('invoice_line_items')._selectResult = [];
    pickChainFor('invoices')._insertResult = [{ id: 99 }];

    const result = await invoiceService.updateInstallmentPlan({
      trx: mockDbFn, dealUuid: 'deal-1', adminId: 42,
      installments: [
        { percent: 30, trigger: 'quote_accepted', offset_days: 0, label: 'A' },
        { percent: 30, trigger: 'before_event', offset_days: -14, label: 'B' },
        { percent: 40, trigger: 'after_event', offset_days: 7, label: 'C' },
      ],
    });

    expect(result.kept).toEqual([1, 2]);
    expect(result.created.length).toBe(1);
    expect(result.deleted).toEqual([]);
    const { claimNextSequence } = require('../../src/utils/documentSequences');
    expect(claimNextSequence).toHaveBeenCalledTimes(1);
  });

  it('shrinks 3→2 by deleting the third row + its line items', async () => {
    pickChainFor('invoices')._selectResult = [
      sibling({ id: 1, installment_index: 0, invoice_number: 'R-2026-0001',
        net_amount_minor: 3000, vat_amount_minor: 231, total_amount_minor: 3231 }),
      sibling({ id: 2, installment_index: 1, invoice_number: 'R-2026-0002',
        net_amount_minor: 3000, vat_amount_minor: 231, total_amount_minor: 3231 }),
      sibling({ id: 3, installment_index: 2, invoice_number: 'R-2026-0003',
        net_amount_minor: 4000, vat_amount_minor: 308, total_amount_minor: 4308 }),
    ];
    pickChainFor('customer_accounts')._firstValue = { id: 5, is_active: 1, feature_bills: 1 };
    pickChainFor('invoice_line_items')._selectResult = [];

    const result = await invoiceService.updateInstallmentPlan({
      trx: mockDbFn, dealUuid: 'deal-1', adminId: 42,
      installments: [
        { percent: 40, trigger: 'quote_accepted', offset_days: 0, label: 'A' },
        { percent: 60, trigger: 'after_event', offset_days: 7, label: 'B' },
      ],
    });

    expect(result.kept).toEqual([1, 2]);
    expect(result.created).toEqual([]);
    expect(result.deleted).toEqual([3]);
    // Line items + invoice rows deleted on the trimmed sibling.
    expect(pickChainFor('invoice_line_items').del).toHaveBeenCalled();
    expect(pickChainFor('invoices').del).toHaveBeenCalled();
  });
});
