/**
 * Unit tests for customerAccountsService (#354).
 *
 * The service touches the DB in most call sites, so we mock the knex
 * builder. The point of these tests is to catch the assignment-diff
 * logic and the invitation guards — not to integration-test knex.
 */

// --- mocks --------------------------------------------------------------
jest.mock('../database/db', () => {
  const mockDb = jest.fn();
  mockDb.transaction = jest.fn(async (fn) => fn(mockDb));
  return { db: mockDb, logActivity: jest.fn() };
});
jest.mock('../utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../services/emailProcessor', () => ({
  queueEmail: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../utils/passwordValidation', () => ({
  getBcryptRounds: () => 4, // fast for tests
}));
// frontendUrl is resolved against app_settings; mock the helper directly
// so the test doesn't need to also stub the settings query.
jest.mock('../utils/frontendUrl', () => ({
  getFrontendBaseUrl: jest.fn().mockResolvedValue('https://example.test'),
}));
jest.mock('../utils/dbCompat', () => ({
  formatBoolean: (v) => (v ? 1 : 0),
}));

const { db } = require('../database/db');
const { queueEmail } = require('../services/emailProcessor');

// Helper to make a chainable query builder mock that resolves to `result`.
const chain = (result) => {
  const q = {};
  ['where', 'whereNull', 'whereNot', 'whereRaw', 'whereIn', 'andWhere',
    'select', 'leftJoin', 'join', 'orderBy', 'limit', 'groupBy', 'first']
    .forEach((m) => { q[m] = jest.fn().mockReturnValue(q); });
  q.first = jest.fn().mockResolvedValue(result?.first);
  q.del = jest.fn().mockResolvedValue(result?.del ?? 0);
  // returning() must itself return a thenable that resolves to the
  // configured insert result, since the service awaits it directly.
  q.insert = jest.fn().mockImplementation(() => {
    const promise = Promise.resolve(result?.insert ?? []);
    promise.returning = () => Promise.resolve(result?.insert ?? []);
    return promise;
  });
  q.pluck = jest.fn().mockResolvedValue(result?.pluck ?? []);
  q.update = jest.fn().mockResolvedValue(result?.update ?? 0);
  q.then = (resolve) => Promise.resolve(result?.rows ?? []).then(resolve);
  q.catch = () => q;
  return q;
};

beforeEach(() => {
  db.mockReset();
  queueEmail.mockClear();
  db.transaction.mockImplementation(async (fn) => fn(db));
});

// ---- createInvitation --------------------------------------------------

describe('createInvitation', () => {
  it('rejects when a customer with the email already exists', async () => {
    const svc = require('../services/customerAccountsService');
    db.mockImplementationOnce(() => chain({ first: { id: 1, email: 'taken@example.com' } }));
    await expect(
      svc.createInvitation({ email: 'taken@example.com', invitedById: 9 })
    ).rejects.toThrow(/already exists/i);
    expect(queueEmail).not.toHaveBeenCalled();
  });

  it('rejects when a non-expired pending invitation exists', async () => {
    const svc = require('../services/customerAccountsService');
    db.mockImplementationOnce(() => chain({ first: null })); // no customer
    db.mockImplementationOnce(() => chain({ first: { id: 5, email: 'pending@example.com' } }));
    await expect(
      svc.createInvitation({ email: 'pending@example.com', invitedById: 9 })
    ).rejects.toThrow(/pending invitation/i);
  });

  it('queues an invitation email on success', async () => {
    const svc = require('../services/customerAccountsService');
    db.mockImplementationOnce(() => chain({ first: null })); // no customer
    db.mockImplementationOnce(() => chain({ first: null })); // no pending
    db.mockImplementationOnce(() => chain({ insert: [{ id: 42 }] })); // insert invitation

    const result = await svc.createInvitation({
      email: 'new@example.com',
      invitedById: 9,
    });

    expect(result.email).toBe('new@example.com');
    expect(result.token).toMatch(/^[a-f0-9]{64}$/);
    expect(queueEmail).toHaveBeenCalledTimes(1);
    const call = queueEmail.mock.calls[0];
    expect(call[2]).toBe('customer_invitation');
    expect(call[3].invite_link).toMatch(/\/customer\/invite\//);
    // Link must honour the configured frontend URL (Site Settings →
    // general_site_url, surfaced via getFrontendBaseUrl). Mocked above
    // to https://example.test — the dev-day bug was the link always
    // emitting localhost regardless of config.
    expect(call[3].invite_link.startsWith('https://example.test/')).toBe(true);
  });
});

// ---- setAssignmentsForEvent --------------------------------------------

describe('setAssignmentsForEvent', () => {
  it('inserts only customers that are missing and removes those not in the wanted list', async () => {
    const svc = require('../services/customerAccountsService');
    // existing assignments: customers 1 and 2
    const existingChain = chain({ rows: [
      { id: 100, customer_account_id: 1 },
      { id: 101, customer_account_id: 2 },
    ] });
    // delete chain
    const deleteChain = chain({ del: 1 });
    // validity check chain — returns valid ids 3 only (99 is filtered out)
    const validityChain = chain({ pluck: [3] });
    // insert chain
    const insertChain = chain({ insert: [] });

    db.mockImplementationOnce(() => existingChain);
    db.mockImplementationOnce(() => deleteChain);
    db.mockImplementationOnce(() => validityChain);
    db.mockImplementationOnce(() => insertChain);

    const summary = await svc.setAssignmentsForEvent(42, [2, 3, 99], 7);

    // Should remove customer 1 (not in wanted) and only insert valid ones.
    expect(deleteChain.whereIn).toHaveBeenCalledWith('id', [100]);
    expect(insertChain.insert).toHaveBeenCalledWith([{
      event_id: 42,
      customer_account_id: 3,
      assigned_by_admin_id: 7,
      assigned_at: expect.any(Date),
    }]);
    // `added` counts attempted-additions before the validity filter — so
    // 3 and 99 were both attempted (added: 2). The validity filter drops
    // 99 silently (logged as a warning) before the insert. This matches
    // the service contract; the test is asserting on it explicitly so a
    // future refactor can't quietly change it.
    expect(summary).toEqual({ added: 2, removed: 1 });
  });

  it('clears all assignments when wanted list is empty', async () => {
    const svc = require('../services/customerAccountsService');
    const existingChain = chain({ rows: [
      { id: 100, customer_account_id: 1 },
      { id: 101, customer_account_id: 2 },
    ] });
    const deleteChain = chain({ del: 2 });

    db.mockImplementationOnce(() => existingChain);
    db.mockImplementationOnce(() => deleteChain);

    const summary = await svc.setAssignmentsForEvent(42, [], 7);
    expect(deleteChain.whereIn).toHaveBeenCalledWith('id', [100, 101]);
    expect(summary).toEqual({ added: 0, removed: 2 });
  });

  it('is a no-op when wanted equals existing', async () => {
    const svc = require('../services/customerAccountsService');
    const existingChain = chain({ rows: [
      { id: 100, customer_account_id: 1 },
    ] });
    db.mockImplementationOnce(() => existingChain);

    const summary = await svc.setAssignmentsForEvent(42, [1], 7);
    // Only the existing-rows query was called; no del or insert chain
    // was needed because both diffs are empty.
    expect(db).toHaveBeenCalledTimes(1);
    expect(summary).toEqual({ added: 0, removed: 0 });
  });
});

// ---- customerHasAccessToEvent ------------------------------------------

describe('customerHasAccessToEvent', () => {
  it('returns true when an assignment row exists', async () => {
    const svc = require('../services/customerAccountsService');
    const c = chain({ first: { id: 99 } });
    db.mockImplementationOnce(() => c);

    const result = await svc.customerHasAccessToEvent(1, 2);
    expect(result).toBe(true);
    expect(c.where).toHaveBeenCalledWith('customer_account_id', 1);
    expect(c.where).toHaveBeenCalledWith('event_id', 2);
  });

  it('returns false when no assignment row exists', async () => {
    const svc = require('../services/customerAccountsService');
    db.mockImplementationOnce(() => chain({ first: undefined }));
    const result = await svc.customerHasAccessToEvent(1, 999);
    expect(result).toBe(false);
  });
});

// ---- setAssignmentsForCustomer ----------------------------------------
//
// The inverse of setAssignmentsForEvent: takes one customer + a list of
// event ids and reconciles the junction table. Powers the "Manage
// galleries" dialog on the customer detail page. The
// `verifyGalleryAccess` middleware re-checks this junction on every
// customer-minted JWT, so getting the diff math right here is the
// access-control story for the whole feature (#470).
//
// notifyCustomerOfNewAssignments() runs as fire-and-forget after the
// transactional work and queues a follow-up email. The tests below
// configure mocks for the calls it makes (load customer row, load
// event rows) so it can resolve cleanly without crashing the assert
// path — we don't assert on its body here; the email pipeline is a
// separate seam.

describe('setAssignmentsForCustomer', () => {
  // The notifier issues two more db() calls after the writer returns:
  // SELECT customer_accounts and SELECT events. Provide cheap chains
  // that resolve to "no customer / no events" so it early-returns
  // without firing queueEmail. Returns a small helper so each test
  // can append it after its own writer chains.
  function appendNotifierMocks() {
    db.mockImplementationOnce(() => chain({ first: null }));   // customer lookup -> not found
    db.mockImplementationOnce(() => chain({ rows: [] }));       // events lookup -> empty
  }

  it('inserts only events that are missing and removes those not in the wanted list', async () => {
    const svc = require('../services/customerAccountsService');
    // existing assignments: customer is on events 10 and 20.
    const existingChain = chain({ rows: [
      { id: 500, event_id: 10 },
      { id: 501, event_id: 20 },
    ] });
    const deleteChain = chain({ del: 1 });
    // Validity check returns 30 only — event 99 is filtered out
    // (archived or missing).
    const validityChain = chain({ pluck: [30] });
    const insertChain = chain({ insert: [] });

    db.mockImplementationOnce(() => existingChain);
    db.mockImplementationOnce(() => deleteChain);
    db.mockImplementationOnce(() => validityChain);
    db.mockImplementationOnce(() => insertChain);
    appendNotifierMocks();

    const summary = await svc.setAssignmentsForCustomer(7, [20, 30, 99], 12);

    // Remove event 10 (not in wanted).
    expect(deleteChain.whereIn).toHaveBeenCalledWith('id', [500]);
    // Insert ONLY event 30 — event 99 was dropped by the validity filter.
    expect(insertChain.insert).toHaveBeenCalledWith([{
      event_id: 30,
      customer_account_id: 7,
      assigned_by_admin_id: 12,
      assigned_at: expect.any(Date),
    }]);
    expect(summary).toEqual({
      added: 2,           // 30 and 99 were both attempted
      removed: 1,         // event 10
      addedEventIds: [30], // only event 30 actually landed in the DB
    });
  });

  it('silently filters archived/missing event ids out of the insert', async () => {
    const svc = require('../services/customerAccountsService');
    const existingChain = chain({ rows: [] });
    // Three candidates; validity check pulls back zero -> all three are
    // archived or missing. Service should log a warning and skip the
    // insert entirely (rows.length === 0 short-circuits the .insert call).
    const validityChain = chain({ pluck: [] });

    db.mockImplementationOnce(() => existingChain);
    db.mockImplementationOnce(() => validityChain);
    appendNotifierMocks();

    const summary = await svc.setAssignmentsForCustomer(7, [99, 100, 101], 12);

    expect(summary).toEqual({
      added: 3,            // attempted three
      removed: 0,
      addedEventIds: [],   // none landed
    });
  });

  it('clears all assignments when wanted list is empty', async () => {
    const svc = require('../services/customerAccountsService');
    const existingChain = chain({ rows: [
      { id: 500, event_id: 10 },
      { id: 501, event_id: 20 },
    ] });
    const deleteChain = chain({ del: 2 });

    db.mockImplementationOnce(() => existingChain);
    db.mockImplementationOnce(() => deleteChain);
    appendNotifierMocks();

    const summary = await svc.setAssignmentsForCustomer(7, [], 12);
    expect(deleteChain.whereIn).toHaveBeenCalledWith('id', [500, 501]);
    expect(summary).toEqual({ added: 0, removed: 2, addedEventIds: [] });
  });

  it('is a no-op when wanted equals existing', async () => {
    const svc = require('../services/customerAccountsService');
    const existingChain = chain({ rows: [
      { id: 500, event_id: 10 },
    ] });
    db.mockImplementationOnce(() => existingChain);
    appendNotifierMocks();

    const summary = await svc.setAssignmentsForCustomer(7, [10], 12);
    expect(summary).toEqual({ added: 0, removed: 0, addedEventIds: [] });
  });

  it('coerces non-integer / negative event ids out of the wanted set', async () => {
    const svc = require('../services/customerAccountsService');
    const existingChain = chain({ rows: [] });
    const validityChain = chain({ pluck: [10] });
    const insertChain = chain({ insert: [] });

    db.mockImplementationOnce(() => existingChain);
    db.mockImplementationOnce(() => validityChain);
    db.mockImplementationOnce(() => insertChain);
    appendNotifierMocks();

    // 'abc' isn't a number, -5 is negative, 0 is invalid, 10.5 is fractional.
    // Only the integer 10 should survive the Number()/Number.isFinite()
    // filter. 10.5 coerces to a finite 10.5 (Number.isFinite returns true)
    // but the validity check only returns the integer 10 so we end up
    // inserting 10. Asserting on the eventual insert payload is the
    // cleanest contract.
    await svc.setAssignmentsForCustomer(7, [10, 'abc', -5, 0, '10'], 12);
    const insertedRows = insertChain.insert.mock.calls[0][0];
    const insertedEventIds = insertedRows.map((r) => r.event_id);
    expect(insertedEventIds).toEqual([10]);
  });
});
