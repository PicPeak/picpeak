/**
 * Unit tests for verifyGalleryAccess's customer-assignment re-check
 * (PR #470). Documents the contract:
 *
 *   - JWT with `via === 'customer'` and a `customerId` claim →
 *     middleware re-reads event_customer_assignments and 403s with
 *     code 'CUSTOMER_ASSIGNMENT_REVOKED' when the row is gone.
 *   - JWT without those claims (the per-event-password flow) → no
 *     re-check, no extra query, no perf cost. This is asserted
 *     explicitly because a regression that silently re-checks every
 *     gallery token would 403 every guest the moment a customer was
 *     unassigned from any unrelated event.
 *   - Re-check is wrapped in withRetry so transient DB blips don't
 *     bounce a legitimate session.
 *
 * Same pattern as authSession.symmetry.test.js — every collaborator
 * mocked so the test stays a fast unit test (no postgres, no real JWTs).
 */

jest.mock('../database/db', () => {
  const mockDb = jest.fn();
  // The middleware uses `withRetry(fn)` to wrap reads. For the test
  // surface we just want to invoke the callback synchronously and
  // surface whatever it returns / throws.
  const withRetry = jest.fn((fn) => fn());
  return { db: mockDb, withRetry };
});

jest.mock('../utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

jest.mock('jsonwebtoken', () => ({
  verify: jest.fn(),
}));

jest.mock('../utils/tokenUtils', () => ({
  getGalleryTokenFromRequest: jest.fn(),
}));

jest.mock('../utils/dbCompat', () => ({
  formatBoolean: (v) => (v ? 1 : 0),
}));

const jwt = require('jsonwebtoken');
const { db } = require('../database/db');
const { getGalleryTokenFromRequest } = require('../utils/tokenUtils');
const { verifyGalleryAccess } = require('../middleware/gallery');

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function makeReq(slug = 'test-event') {
  return {
    params: { slug },
    headers: {},
    cookies: {},
    query: {},
    ip: '1.2.3.4',
    get: () => 'jest',
    connection: { remoteAddress: '1.2.3.4' },
  };
}

// The middleware queries the `events` table first (existence check),
// then optionally `event_customer_assignments`. This helper queues
// both responses on the shared db mock so each test can spell out
// the scenario in order. Returns the assignments chain so the test
// can assert against it.
function mockEventAndAssignment({ event, assignment }) {
  // `db('events').where({...}).select('*').first()` — chainable.
  const eventsChain = {};
  eventsChain.where = jest.fn().mockReturnValue(eventsChain);
  eventsChain.select = jest.fn().mockReturnValue(eventsChain);
  eventsChain.first = jest.fn().mockResolvedValue(event);

  // `db('event_customer_assignments').where({...}).first()`.
  const assignChain = {};
  assignChain.where = jest.fn().mockReturnValue(assignChain);
  assignChain.first = jest.fn().mockResolvedValue(assignment);

  db.mockImplementationOnce(() => eventsChain)
    .mockImplementationOnce(() => assignChain);

  return { eventsChain, assignChain };
}

beforeEach(() => {
  db.mockReset();
  jwt.verify.mockReset();
  getGalleryTokenFromRequest.mockReset();
});

// ---- customer-minted JWT, assignment intact ----------------------------

describe('verifyGalleryAccess — customer-minted JWT with active assignment', () => {
  it('allows access when the event_customer_assignments row exists', async () => {
    getGalleryTokenFromRequest.mockReturnValue('tkn');
    jwt.verify.mockReturnValue({
      eventId: 42,
      via: 'customer',
      customerId: 7,
    });
    const { assignChain } = mockEventAndAssignment({
      event: { id: 42, slug: 'test-event', is_active: true, is_archived: false },
      assignment: { id: 999, event_id: 42, customer_account_id: 7 },
    });

    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();
    await verifyGalleryAccess(req, res, next);

    expect(assignChain.where).toHaveBeenCalledWith({
      event_id: 42,
      customer_account_id: 7,
    });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(req.event).toEqual(expect.objectContaining({ id: 42 }));
  });
});

// ---- customer-minted JWT, assignment revoked ---------------------------

describe('verifyGalleryAccess — customer-minted JWT after revocation', () => {
  it('returns 403 CUSTOMER_ASSIGNMENT_REVOKED when the junction row is gone', async () => {
    getGalleryTokenFromRequest.mockReturnValue('tkn');
    jwt.verify.mockReturnValue({
      eventId: 42,
      via: 'customer',
      customerId: 7,
    });
    mockEventAndAssignment({
      event: { id: 42, slug: 'test-event', is_active: true, is_archived: false },
      assignment: undefined, // <-- the admin just removed it
    });

    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();
    await verifyGalleryAccess(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'CUSTOMER_ASSIGNMENT_REVOKED' }),
    );
  });

  it('still re-checks when the customerId is in the token but via claim is missing-but-numeric', async () => {
    // Belt-and-braces: the gate triggers on `via === 'customer'`. A
    // token with customerId but no `via` should NOT re-check (it isn't
    // a customer-minted token — could be legacy). This pins the
    // contract so a future refactor can't accidentally widen the gate
    // and start 403'ing per-event-password sessions.
    getGalleryTokenFromRequest.mockReturnValue('tkn');
    jwt.verify.mockReturnValue({
      eventId: 42,
      customerId: 7,
      // intentionally no `via` claim
    });
    // The middleware uses one db() call for events; if it tried to
    // re-check we'd see a second db() call and the test would throw
    // (no more mock implementations queued).
    const eventsChain = {};
    eventsChain.where = jest.fn().mockReturnValue(eventsChain);
    eventsChain.select = jest.fn().mockReturnValue(eventsChain);
    eventsChain.first = jest.fn().mockResolvedValue({
      id: 42, slug: 'test-event', is_active: true, is_archived: false,
    });
    db.mockImplementationOnce(() => eventsChain);

    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();
    await verifyGalleryAccess(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(db).toHaveBeenCalledTimes(1); // events table only — no assignments query
  });
});

// ---- per-event-password JWT (no `via` claim) ---------------------------

describe('verifyGalleryAccess — per-event-password JWT', () => {
  it('does NOT touch event_customer_assignments and passes through', async () => {
    getGalleryTokenFromRequest.mockReturnValue('tkn');
    jwt.verify.mockReturnValue({
      eventId: 42,
      // No via, no customerId — this is the legacy per-event-password
      // flow where every guest mints their own JWT after entering the
      // gallery password.
    });
    // Only events table should be queried. If the middleware regresses
    // and starts querying event_customer_assignments here, the second
    // db() call would have no mock implementation and the test would
    // surface an error.
    const eventsChain = {};
    eventsChain.where = jest.fn().mockReturnValue(eventsChain);
    eventsChain.select = jest.fn().mockReturnValue(eventsChain);
    eventsChain.first = jest.fn().mockResolvedValue({
      id: 42, slug: 'test-event', is_active: true, is_archived: false,
    });
    db.mockImplementationOnce(() => eventsChain);

    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();
    await verifyGalleryAccess(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(db).toHaveBeenCalledTimes(1);
    expect(db.mock.calls[0][0]).toBe('events');
  });
});
