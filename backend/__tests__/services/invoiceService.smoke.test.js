/**
 * Smoke tests for invoiceService's primary flows ahead of the god-file
 * decomposition — createInvoice happy path (incl. the line-item
 * totals/VAT math), list/get reads, and the status-transition guards
 * on cancelInvoice / releaseForDelivery.
 *
 * Uses the same deep-mocked db pattern as
 * invoiceService.installmentPlan.test.js — chains are queued per table
 * and assertions probe insert/update call shapes rather than SQL.
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
mockDbFn.schema = { hasTable: jest.fn(async () => false) };

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
  jest.clearAllMocks();
}

const activeCustomer = {
  id: 5, is_active: 1, feature_bills: 1,
  billing_cadence: 'per_event', preferred_language: 'de',
};

describe('createInvoice — happy path + totals', () => {
  beforeEach(() => resetChains());

  it('creates a single invoice with a claimed sequence number and computed totals/VAT', async () => {
    pickChainFor('customer_accounts')._firstValue = { ...activeCustomer };
    pickChainFor('invoices')._insertResult = [{ id: 777 }];

    const result = await invoiceService.createInvoice({
      customerAccountId: 5,
      vatRate: 8.1,
      lineItems: [
        // 2 × 100.00 = 200.00
        { position: 1, description: 'Shoot', quantity: 2, unit_price_minor: 10000 },
        // 50.00 with 10% discount = 45.00
        { position: 2, description: 'Discounted extra', quantity: 1, unit_price_minor: 5000, discount_percent: 10 },
        // Parent header — total auto-resolves from priced sub-items (350.00)
        { position: 3, description: 'Package', quantity: 1, unit_price_minor: 0 },
        { position: 4, description: 'Camera', quantity: 1, unit_price_minor: 15000, parent_position: 3 },
        { position: 5, description: 'Lens', quantity: 1, unit_price_minor: 20000, parent_position: 3 },
      ],
    }, 1);

    expect(result.invoiceIds).toEqual([777]);

    // Net = 20000 + 4500 + 35000 (resolved parent) — sub-items must NOT
    // double-count. VAT = round(59500 × 8.1%) = 4820.
    expect(pickChainFor('invoices').insert).toHaveBeenCalledWith(expect.objectContaining({
      invoice_number: 'R-2026-0042',
      customer_account_id: 5,
      currency: 'CHF',
      status: 'scheduled',
      net_amount_minor: 59500,
      vat_rate: 8.1,
      vat_amount_minor: 4820,
      shipping_amount_minor: 0,
      total_amount_minor: 64320,
      installment_total: 1,
    }));
    // Exactly one sequence number claimed for a single-row create.
    const { claimNextSequence } = require('../../src/utils/documentSequences');
    expect(claimNextSequence).toHaveBeenCalledTimes(1);
    // Line items landed in invoice_line_items.
    expect(pickChainFor('invoice_line_items').insert).toHaveBeenCalled();
  });

  it('409s on a deactivated customer before touching the sequence', async () => {
    pickChainFor('customer_accounts')._firstValue = { ...activeCustomer, is_active: 0 };
    await expect(invoiceService.createInvoice({
      customerAccountId: 5, vatRate: 0, lineItems: [],
    }, 1)).rejects.toMatchObject({ statusCode: 409 });
    const { claimNextSequence } = require('../../src/utils/documentSequences');
    expect(claimNextSequence).not.toHaveBeenCalled();
  });

  it('400s + INVOICE_TOTAL_NEGATIVE when discounts push the total below zero', async () => {
    pickChainFor('customer_accounts')._firstValue = { ...activeCustomer };
    await expect(invoiceService.createInvoice({
      customerAccountId: 5,
      vatRate: 7.7,
      lineItems: [
        { position: 1, description: 'Shoot', quantity: 1, unit_price_minor: 5000 },
        { position: 2, description: 'Rabatt', quantity: 1, unit_price_minor: -8000 },
      ],
    }, 1)).rejects.toMatchObject({ statusCode: 400, code: 'INVOICE_TOTAL_NEGATIVE' });
    const { claimNextSequence } = require('../../src/utils/documentSequences');
    expect(claimNextSequence).not.toHaveBeenCalled();
  });
});

describe('listInvoices / getInvoiceById — read paths (smoke)', () => {
  beforeEach(() => resetChains());

  it('lists invoices with total + pagination echo', async () => {
    pickChainFor('invoices')._selectResult = [
      { id: 1, invoice_number: 'R-2026-0001' },
      { id: 2, invoice_number: 'R-2026-0002' },
    ];
    pickChainFor('invoices')._firstValue = { total: 7 };

    const result = await invoiceService.listInvoices({ page: 2, pageSize: 10 });

    expect(result.rows).toHaveLength(2);
    expect(result.total).toBe(7);
    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(10);
    expect(pickChainFor('invoices').offset).toHaveBeenCalledWith(10);
    expect(pickChainFor('invoices').limit).toHaveBeenCalledWith(10);
  });

  it('getInvoiceById returns { invoice, lineItems, payments } when found', async () => {
    pickChainFor('invoices')._firstValue = { id: 3, invoice_number: 'R-2026-0003' };
    pickChainFor('invoice_line_items as li')._selectResult = [
      { id: 30, position: 1, description: 'Shoot' },
    ];
    pickChainFor('invoice_payment_log')._selectResult = [];

    const result = await invoiceService.getInvoiceById(3);
    expect(result.invoice).toMatchObject({ id: 3, invoice_number: 'R-2026-0003' });
    expect(result.lineItems).toHaveLength(1);
    expect(result.payments).toEqual([]);
  });

  it('getInvoiceById returns null for an unknown id', async () => {
    pickChainFor('invoices')._firstValue = undefined;
    await expect(invoiceService.getInvoiceById(404)).resolves.toBeNull();
  });
});

describe('status transitions — cancelInvoice / releaseForDelivery guards', () => {
  beforeEach(() => resetChains());

  it('soft-cancels a scheduled (never-issued) invoice without a Storno', async () => {
    pickChainFor('invoices')._firstValue = {
      id: 9, status: 'scheduled', kind: 'invoice', event_id: null,
    };
    const result = await invoiceService.cancelInvoice(9, 1);
    expect(result).toEqual({ cancelled: true, stornoId: null });
    expect(pickChainFor('invoices').update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'cancelled' })
    );
  });

  it('409s + ALREADY_CANCELLED on a second cancel', async () => {
    pickChainFor('invoices')._firstValue = {
      id: 9, status: 'cancelled', kind: 'invoice',
    };
    await expect(invoiceService.cancelInvoice(9, 1))
      .rejects.toMatchObject({ statusCode: 409, code: 'ALREADY_CANCELLED' });
  });

  it('409s + IS_STORNO when trying to cancel a Storno document', async () => {
    pickChainFor('invoices')._firstValue = {
      id: 10, status: 'sent', kind: 'storno',
    };
    await expect(invoiceService.cancelInvoice(10, 1))
      .rejects.toMatchObject({ statusCode: 409, code: 'IS_STORNO' });
  });

  it('releaseForDelivery 409s + NOT_PENDING_DELIVERY on a non-pending invoice', async () => {
    pickChainFor('invoices')._firstValue = {
      id: 11, status: 'sent', kind: 'invoice',
    };
    await expect(invoiceService.releaseForDelivery(11, 1))
      .rejects.toMatchObject({ statusCode: 409, code: 'NOT_PENDING_DELIVERY' });
  });
});
