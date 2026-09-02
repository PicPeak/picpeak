/**
 * Tests for quoteService lock + state-transition guards:
 *   - updateQuote refuses on accepted / declined / converted
 *   - adminAcceptQuote refuses on already-terminal states + atomic
 *     update path
 *
 * db deep-mocked, same chain pattern as invoiceService tests.
 */

const tableChains = {};
function makeChain() {
  return {
    _firstValue: undefined,
    _updateResult: 1,
    _insertResult: [{ id: 999 }],
    _selectResult: [],
    // knex chains are thenable; mirror that so `await trx('t')...`
    // resolves to an array of rows.
    then: function (onResolve, onReject) {
      return Promise.resolve(this._selectResult).then(onResolve, onReject);
    },
    where: jest.fn(function () { return this; }),
    whereNotIn: jest.fn(function () { return this; }),
    whereIn: jest.fn(function () { return this; }),
    whereNull: jest.fn(function () { return this; }),
    andWhere: jest.fn(function () { return this; }),
    orderBy: jest.fn(function () { return this; }),
    limit: jest.fn(function () { return this; }),
    select: jest.fn(function () { return Promise.resolve(this._selectResult); }),
    first: jest.fn(function () { return Promise.resolve(this._firstValue); }),
    update: jest.fn(function () { return Promise.resolve(this._updateResult); }),
    insert: jest.fn(function () { return this; }),
    returning: jest.fn(function () { return Promise.resolve(this._insertResult); }),
    del: jest.fn(function () { return Promise.resolve(1); }),
    leftJoin: jest.fn(function () { return this; }),
    sum: jest.fn(function () { return this; }),
    count: jest.fn(function () { return this; }),
    clone: jest.fn(function () { return this; }),
    clearSelect: jest.fn(function () { return this; }),
    clearOrder: jest.fn(function () { return this; }),
    offset: jest.fn(function () { return this; }),
  };
}
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
jest.mock('../../src/services/pdfService', () => ({
  renderQuoteToBuffer: jest.fn(async () => Buffer.from('pdf')),
  renderInvoiceToBuffer: jest.fn(async () => Buffer.from('pdf')),
}));
jest.mock('../../src/services/emailProcessor', () => ({
  queueEmail: jest.fn(async () => {}),
}));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

const quoteService = require('../../src/services/quoteService');

function resetChains() {
  for (const k of Object.keys(tableChains)) delete tableChains[k];
}

describe('quoteService.updateQuote — lock guards', () => {
  beforeEach(() => resetChains());

  it('404s when the quote does not exist', async () => {
    pickChainFor('quotes')._firstValue = null;
    await expect(quoteService.updateQuote(99, {}, 1))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('locks accepted quotes', async () => {
    pickChainFor('quotes')._firstValue = { id: 1, status: 'accepted' };
    await expect(quoteService.updateQuote(1, {}, 1))
      .rejects.toMatchObject({ statusCode: 409, code: 'QUOTE_LOCKED' });
  });

  it('locks declined quotes', async () => {
    pickChainFor('quotes')._firstValue = { id: 1, status: 'declined' };
    await expect(quoteService.updateQuote(1, {}, 1))
      .rejects.toMatchObject({ statusCode: 409, code: 'QUOTE_LOCKED' });
  });

  it('locks converted quotes', async () => {
    pickChainFor('quotes')._firstValue = { id: 1, status: 'converted' };
    await expect(quoteService.updateQuote(1, {}, 1))
      .rejects.toMatchObject({ statusCode: 409, code: 'QUOTE_LOCKED' });
  });

  it('allows edits on draft + sent + expired (no QUOTE_LOCKED throw)', async () => {
    for (const status of ['draft', 'sent', 'expired']) {
      pickChainFor('quotes')._firstValue = {
        id: 1, status, vat_rate: 0, shipping_amount_minor: 0,
      };
      // The lock check sits at the TOP of updateQuote. The
      // observable behavior we care about is "no QUOTE_LOCKED
      // 409 thrown on these statuses". The full transaction
      // path may resolve to anything (incl. undefined) since
      // the test mocks the trx callback — that's fine.
      let err = null;
      try { await quoteService.updateQuote(1, { lineItems: [] }, 1); }
      catch (e) { err = e; }
      if (err) {
        // Any error other than the QUOTE_LOCKED guard is allowed
        // (we're not exercising the full path here).
        expect(err.code).not.toBe('QUOTE_LOCKED');
      }
      resetChains();
    }
  });
});

describe('quoteService.adminAcceptQuote', () => {
  beforeEach(() => resetChains());

  it('404s when the quote does not exist', async () => {
    pickChainFor('quotes')._firstValue = null;
    await expect(quoteService.adminAcceptQuote(99, 1))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('refuses already-accepted quotes', async () => {
    pickChainFor('quotes')._firstValue = { id: 1, status: 'accepted' };
    await expect(quoteService.adminAcceptQuote(1, 1))
      .rejects.toMatchObject({ statusCode: 409, code: 'QUOTE_ALREADY_ACCEPTED' });
  });

  it('refuses declined quotes', async () => {
    pickChainFor('quotes')._firstValue = { id: 1, status: 'declined' };
    await expect(quoteService.adminAcceptQuote(1, 1))
      .rejects.toMatchObject({ statusCode: 409, code: 'QUOTE_DECLINED' });
  });

  it('refuses converted quotes', async () => {
    pickChainFor('quotes')._firstValue = { id: 1, status: 'converted' };
    await expect(quoteService.adminAcceptQuote(1, 1))
      .rejects.toMatchObject({ statusCode: 409, code: 'QUOTE_CONVERTED' });
  });

  it('accepts draft / sent / expired and returns lockedAt', async () => {
    for (const status of ['draft', 'sent', 'expired']) {
      pickChainFor('quotes')._firstValue = {
        id: 1, status, customer_account_id: 5,
        currency: 'CHF', language: 'de',
        quote_number: 'Q-2026-0001',
        total_amount_minor: 10000,
        event_name: null,
      };
      pickChainFor('customer_accounts')._firstValue = {
        id: 5, email: 'c@example.com', display_name: 'Test',
      };
      pickChainFor('quote_line_items')._selectResult = [];
      pickChainFor('business_profile')._firstValue = null;

      const result = await quoteService.adminAcceptQuote(1, 42);
      expect(result.status).toBe('accepted');
      expect(result.lockedAt).toBeInstanceOf(Date);
      resetChains();
    }
  });
});

/**
 * VALID_QUOTE_TRANSITIONS was a complete state machine that nothing consulted,
 * so `quotes.status` writes were unvalidated. It is now asserted at every
 * status-change site — and reconciled against them, since the original table
 * was missing several transitions the service legitimately performs
 * (draft→accepted, expired→accepted/declined/sent, declined→sent, and the
 * same-status re-affirm inside the response window). The
 * "accepts draft / sent / expired" case above is the valid-transition
 * coverage for the admin-accept path; these pin the rest.
 */
describe('quoteService — quote status transition backstop', () => {
  beforeEach(() => resetChains());

  const respond = (quote, action = 'accept') => {
    pickChainFor('quote_action_tokens')._firstValue = { id: 7, quote_id: quote.id, expires_at: null };
    pickChainFor('quotes')._firstValue = quote;
    return quoteService.recordResponse({ token: 'tok', action, ip: '127.0.0.1' });
  };

  it('allows sent → accepted', async () => {
    const result = await respond({ id: 1, status: 'sent' });
    expect(result.status).toBe('accepted');
  });

  it('allows the accepted → accepted re-affirm inside the toggle window', async () => {
    const now = Date.now();
    const result = await respond({
      id: 1,
      status: 'accepted',
      responded_at: new Date(now - 60_000).toISOString(),
      response_locked_at: new Date(now + 10 * 60_000).toISOString(),
    });
    expect(result.status).toBe('accepted');
  });

  it('refuses to respond to a converted quote', async () => {
    await expect(respond({ id: 1, status: 'converted' }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('409s (not a silent overwrite) on a status the machine does not know', async () => {
    // A legacy / corrupt row. adminAcceptQuote's own guard only excludes
    // accepted / declined / converted, so 'cancelled' sailed straight through
    // and got overwritten with 'accepted'.
    pickChainFor('quotes')._firstValue = { id: 1, status: 'cancelled', customer_account_id: 5 };
    await expect(quoteService.adminAcceptQuote(1, 42))
      .rejects.toMatchObject({ statusCode: 409, code: 'QUOTE_INVALID_TRANSITION' });
  });

  it('409s the same way on the admin decline path', async () => {
    pickChainFor('quotes')._firstValue = { id: 1, status: 'cancelled' };
    await expect(quoteService.adminDeclineQuote(1, 42))
      .rejects.toMatchObject({ statusCode: 409, code: 'QUOTE_INVALID_TRANSITION' });
  });
});
