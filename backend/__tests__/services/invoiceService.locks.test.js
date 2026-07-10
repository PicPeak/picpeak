/**
 * Tests for invoiceService lock + state-transition guards.
 *
 * Focuses on the rules that protect tax/audit integrity:
 *   - reissueInvoice refuses to act on `scheduled` (use Edit)
 *   - reissueInvoice cancels + clones any other status
 *   - releaseForDelivery refuses to act on non-pending_delivery
 *   - recordPaymentCheckAction refuses already-used / expired tokens
 *
 * db is deep-mocked so the tests are deterministic and fast.
 */

// Mock db chain: each table call returns a builder whose methods
// chain (return `this`) until a terminal method (.first / .update /
// .insert / .returning) resolves with the queued value.

const chains = [];
function makeChain() {
  const c = {
    _firstValue: undefined,
    _updateResult: 1,
    _insertResult: [{ id: 999 }],
    _selectResult: [],
    _allRows: [],
    // knex chains are thenable — awaiting them runs the query and
    // resolves with the row set. We mirror that so callers can
    // `await trx('t').where(...).orderBy(...)` and get an array.
    then: function (onResolve, onReject) {
      return Promise.resolve(this._selectResult).then(onResolve, onReject);
    },
    where: jest.fn(function () { return this; }),
    whereNot: jest.fn(function () { return this; }),
    whereNotIn: jest.fn(function () { return this; }),
    whereIn: jest.fn(function () { return this; }),
    whereNull: jest.fn(function () { return this; }),
    whereNotNull: jest.fn(function () { return this; }),
    andWhere: jest.fn(function () { return this; }),
    orderBy: jest.fn(function () { return this; }),
    limit: jest.fn(function () { return this; }),
    // select is both chainable (`.select('col').first()`) and awaitable
    // via the chain's `then` (`await q.select(...)` returns `_selectResult`).
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
// db.transaction(cb) runs the callback with a "trx" — for our
// purposes the same chain factory works as trx.
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

describe('invoiceService.reissueInvoice', () => {
  beforeEach(() => resetChains());

  it('throws USE_EDIT_INSTEAD when the source is still scheduled', async () => {
    pickChainFor('invoices')._firstValue = { id: 1, status: 'scheduled' };
    await expect(invoiceService.reissueInvoice(1, 42))
      .rejects.toMatchObject({ statusCode: 409, code: 'USE_EDIT_INSTEAD' });
  });

  it('throws when the source invoice does not exist', async () => {
    pickChainFor('invoices')._firstValue = null;
    await expect(invoiceService.reissueInvoice(999, 42))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('cancels the original and creates a new row when status is sent', async () => {
    pickChainFor('invoices')._firstValue = {
      id: 1, status: 'sent', customer_account_id: 5,
      currency: 'CHF', language: 'de', vat_rate: 7.7,
      shipping_amount_minor: 0, cc_pdf_email: null,
      business_bank_account_id: null, qr_format: null,
      payment_term_template_id: null, event_id: null,
      source_quote_id: null,
    };
    pickChainFor('customer_accounts')._firstValue = {
      id: 5, is_active: 1, feature_bills: 1,
    };
    pickChainFor('invoice_line_items')._selectResult = [];
    pickChainFor('app_settings')._firstValue = null;
    // document_sequences row used by claimNextSequence.
    pickChainFor('document_sequences')._firstValue = { current_value: 42 };

    const result = await invoiceService.reissueInvoice(1, 42);
    expect(result.id).toBeDefined();
    expect(result.replaces).toBe(1);
  });
});

describe('invoiceService.createStorno', () => {
  beforeEach(() => resetChains());

  it('rejects when the source invoice does not exist (404)', async () => {
    pickChainFor('invoices')._firstValue = null;
    await expect(invoiceService.createStorno(999, 42))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects when the source is still scheduled (drafts edit in place)', async () => {
    pickChainFor('invoices')._firstValue = { id: 1, status: 'scheduled', kind: 'invoice' };
    await expect(invoiceService.createStorno(1, 42))
      .rejects.toMatchObject({ statusCode: 409, code: 'USE_EDIT_INSTEAD' });
  });

  it('rejects when the source is already cancelled (no double-Storno)', async () => {
    pickChainFor('invoices')._firstValue = { id: 1, status: 'cancelled', kind: 'invoice' };
    await expect(invoiceService.createStorno(1, 42))
      .rejects.toMatchObject({ statusCode: 409, code: 'ALREADY_CANCELLED' });
  });

  it('rejects when asked to Storno a Storno', async () => {
    pickChainFor('invoices')._firstValue = { id: 1, status: 'sent', kind: 'storno' };
    await expect(invoiceService.createStorno(1, 42))
      .rejects.toMatchObject({ statusCode: 409, code: 'IS_STORNO' });
  });

  it('inserts a Storno row and flips the original on a sent invoice', async () => {
    // Original is `sent`, no line items, no event.
    const invoicesChain = pickChainFor('invoices');
    invoicesChain._firstValue = {
      id: 1, status: 'sent', kind: 'invoice', customer_account_id: 5,
      currency: 'CHF', language: 'de', vat_rate: 7.7,
      net_amount_minor: 30000, vat_amount_minor: 2310,
      total_amount_minor: 32310, shipping_amount_minor: 0,
      cc_pdf_email: null, event_id: null,
    };
    pickChainFor('invoice_line_items')._selectResult = [];
    pickChainFor('app_settings')._firstValue = null;
    // document_sequences row used by claimNextSequence.
    pickChainFor('document_sequences')._firstValue = { current_value: 42 };

    const stornoId = await invoiceService.createStorno(1, 42);
    expect(stornoId).toBeDefined();

    // The mock chain's .update() is called twice on `invoices`:
    //   1) `.insert(...).returning('id')` for the Storno row
    //   2) `.update({status:'cancelled', cancellation_storno_id})` on the original
    // We just verify the helpers were exercised on the right table.
    expect(invoicesChain.insert).toHaveBeenCalled();
    expect(invoicesChain.update).toHaveBeenCalled();
    // The Storno insert payload should carry kind='storno' and
    // negated row-level totals. Inspect the first insert call's
    // payload to confirm.
    const insertedRow = invoicesChain.insert.mock.calls[0][0];
    expect(insertedRow.kind).toBe('storno');
    expect(insertedRow.net_amount_minor).toBe(-30000);
    expect(insertedRow.vat_amount_minor).toBe(-2310);
    expect(insertedRow.total_amount_minor).toBe(-32310);
    expect(insertedRow.cancels_invoice_id).toBe(1);
    expect(insertedRow.status).toBe('scheduled');
    // No payment instrument on a Storno.
    expect(insertedRow.business_bank_account_id).toBeNull();
    expect(insertedRow.qr_format).toBeNull();
    expect(insertedRow.payment_term_template_id).toBeNull();
    // Storni have no real payment due, but the schema's NOT NULL
    // constraint on due_date forces a value — we mirror issue_date.
    expect(insertedRow.due_date).toBe(insertedRow.issue_date);
  });
});

describe('invoiceService.cancelInvoice', () => {
  beforeEach(() => resetChains());

  it('rejects when the invoice does not exist (404)', async () => {
    pickChainFor('invoices')._firstValue = null;
    await expect(invoiceService.cancelInvoice(999, 42))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects with ALREADY_CANCELLED when status is cancelled', async () => {
    pickChainFor('invoices')._firstValue = { id: 1, status: 'cancelled', kind: 'invoice' };
    await expect(invoiceService.cancelInvoice(1, 42))
      .rejects.toMatchObject({ statusCode: 409, code: 'ALREADY_CANCELLED' });
  });

  it('rejects with IS_STORNO when asked to cancel a Storno', async () => {
    pickChainFor('invoices')._firstValue = { id: 1, status: 'sent', kind: 'storno' };
    await expect(invoiceService.cancelInvoice(1, 42))
      .rejects.toMatchObject({ statusCode: 409, code: 'IS_STORNO' });
  });

  it('soft-cancels a scheduled (draft) invoice without generating a Storno', async () => {
    pickChainFor('invoices')._firstValue = { id: 1, status: 'scheduled', kind: 'invoice', event_id: null };
    const result = await invoiceService.cancelInvoice(1, 42);
    expect(result).toEqual({ cancelled: true, stornoId: null });
  });
});

describe('invoiceService.releaseForDelivery', () => {
  beforeEach(() => resetChains());

  it('refuses when status is not pending_delivery', async () => {
    pickChainFor('invoices')._firstValue = { id: 1, status: 'sent' };
    await expect(invoiceService.releaseForDelivery(1, 42))
      .rejects.toMatchObject({ statusCode: 409, code: 'NOT_PENDING_DELIVERY' });
  });

  it('404s when the invoice does not exist', async () => {
    pickChainFor('invoices')._firstValue = null;
    await expect(invoiceService.releaseForDelivery(999, 42))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('invoiceService.recordPaymentCheckAction', () => {
  beforeEach(() => resetChains());

  it('rejects invalid actions', async () => {
    await expect(invoiceService.recordPaymentCheckAction({
      token: 'abc', action: 'foo',
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('404s when the token is not on file', async () => {
    pickChainFor('invoice_payment_check_tokens')._firstValue = null;
    await expect(invoiceService.recordPaymentCheckAction({
      token: 'a'.repeat(64), action: 'unpaid',
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('410s + TOKEN_ALREADY_USED when the row has used_at set', async () => {
    pickChainFor('invoice_payment_check_tokens')._firstValue = {
      id: 1, used_at: new Date(),
      expires_at: new Date(Date.now() + 86400000),
    };
    await expect(invoiceService.recordPaymentCheckAction({
      token: 'a'.repeat(64), action: 'unpaid',
    })).rejects.toMatchObject({ statusCode: 410, code: 'TOKEN_ALREADY_USED' });
  });

  it('410s + TOKEN_EXPIRED when the row is past expires_at', async () => {
    pickChainFor('invoice_payment_check_tokens')._firstValue = {
      id: 1, used_at: null,
      expires_at: new Date(Date.now() - 86400000),
    };
    await expect(invoiceService.recordPaymentCheckAction({
      token: 'a'.repeat(64), action: 'unpaid',
    })).rejects.toMatchObject({ statusCode: 410, code: 'TOKEN_EXPIRED' });
  });

  it('rejects partial with amount <= 0', async () => {
    pickChainFor('invoice_payment_check_tokens')._firstValue = {
      id: 1, used_at: null,
      expires_at: new Date(Date.now() + 86400000),
    };
    pickChainFor('invoices')._firstValue = {
      id: 5, total_amount_minor: 10000, paid_amount_minor: 0, late_fee_amount_minor: 0,
    };
    await expect(invoiceService.recordPaymentCheckAction({
      token: 'a'.repeat(64), action: 'partial', amountMinor: 0,
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects partial with amount > outstanding', async () => {
    pickChainFor('invoice_payment_check_tokens')._firstValue = {
      id: 1, used_at: null,
      expires_at: new Date(Date.now() + 86400000),
    };
    pickChainFor('invoices')._firstValue = {
      id: 5, total_amount_minor: 5000, paid_amount_minor: 0, late_fee_amount_minor: 0,
    };
    await expect(invoiceService.recordPaymentCheckAction({
      token: 'a'.repeat(64), action: 'partial', amountMinor: 9999,
    })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('invoiceService.queuePaymentCheckEmail', () => {
  beforeEach(() => resetChains());

  it('skips when invoice does not exist', async () => {
    pickChainFor('invoices')._firstValue = null;
    const res = await invoiceService.queuePaymentCheckEmail(1);
    expect(res).toEqual({ sent: false, reason: 'not_found' });
  });

  it('skips when status is not sent/overdue', async () => {
    pickChainFor('invoices')._firstValue = {
      id: 1, status: 'paid',
    };
    const res = await invoiceService.queuePaymentCheckEmail(1);
    expect(res.sent).toBe(false);
    expect(res.reason).toMatch(/wrong_status_paid/);
  });

  it('respects the 24h throttle', async () => {
    pickChainFor('invoices')._firstValue = {
      id: 1, status: 'overdue',
      last_payment_check_at: new Date(Date.now() - 3600 * 1000),
    };
    const res = await invoiceService.queuePaymentCheckEmail(1);
    expect(res).toEqual({ sent: false, reason: 'throttled_24h' });
  });

  it('bypasses the throttle when skipThrottle=true', async () => {
    pickChainFor('invoices')._firstValue = {
      id: 1, status: 'overdue',
      customer_account_id: 5,
      created_by_admin_id: 42,
      total_amount_minor: 10000,
      currency: 'CHF',
      language: 'de',
      reminder_level: 0,
      due_date: '2026-05-01',
      last_payment_check_at: new Date(Date.now() - 3600 * 1000),
      event_id: null,
    };
    pickChainFor('admin_users')._firstValue = { id: 42, email: 'admin@example.com', username: 'admin' };
    pickChainFor('business_profile')._firstValue = null;
    pickChainFor('customer_accounts')._firstValue = { id: 5, email: 'c@example.com', display_name: 'Test' };

    const res = await invoiceService.queuePaymentCheckEmail(1, { skipThrottle: true });
    expect(res.sent).toBe(true);
    expect(res.token).toMatch(/^[a-f0-9]{64}$/);
  });
});
