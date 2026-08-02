/**
 * The roles-join fallback in adminAuth fabricates `role_name = 'super_admin'`
 * to keep existing sessions working across the RBAC upgrade window. The catch
 * around it used to be unconditional, so ANY transient database failure —
 * connection reset, deadlock, statement timeout, pool exhaustion — took the
 * same branch and handed the caller super_admin for the duration of the fault.
 *
 * `roleName` is the sole discriminator for every ownership check (ownership.js,
 * adminProjects, adminUsers, adminApiTokens, projectService, ...), so that
 * inverted the whole authorization model rather than failing the request.
 * Issue #968. Same treatment apiTokenAuth already got for the v1 surface.
 */

const jwt = require('jsonwebtoken');

jest.mock('../../src/utils/tokenRevocation', () => ({ isTokenRevoked: jest.fn().mockResolvedValue(false) }));
jest.mock('../../src/utils/sessionCutoff', () => ({ isTokenBeforeCutoff: jest.fn().mockResolvedValue(false) }));
jest.mock('../../src/utils/logger', () => ({ warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() }));

// The joined query throws whatever the test stages; the role-less fallback
// query (no .leftJoin) always succeeds, which is what made the original bug
// reachable — it is the cheaper single-table read.
// `mock`-prefixed so jest's module-factory hoisting allows the reference.
let mockJoinError = null;
const mockAdminRow = { id: 7, username: 'scoped', email: 's@example.com', password_changed_at: null };

jest.mock('../../src/database/db', () => ({
  db: () => ({
    _joined: false,
    leftJoin() { this._joined = true; return this; },
    where() { return this; },
    select() { return this; },
    first() {
      if (this._joined && mockJoinError) return Promise.reject(mockJoinError);
      return Promise.resolve({ ...mockAdminRow });
    },
  }),
}));

const { adminAuth } = require('../../src/middleware/auth');

const SECRET = 'test-secret-for-admin-auth-fallback';

function makeReq() {
  const token = jwt.sign(
    { id: mockAdminRow.id, type: 'admin' },
    SECRET,
    { algorithm: 'HS256', issuer: 'picpeak-auth' },
  );
  return { headers: { authorization: `Bearer ${token}` }, ip: '127.0.0.1', connection: {} };
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

describe('adminAuth roles-join fallback (#968)', () => {
  const OLD_SECRET = process.env.JWT_SECRET;
  beforeAll(() => { process.env.JWT_SECRET = SECRET; });
  afterAll(() => { process.env.JWT_SECRET = OLD_SECRET; });
  beforeEach(() => { mockJoinError = null; });

  it('grants the upgrade-window fallback only for a genuinely missing roles table', async () => {
    mockJoinError = new Error('SQLITE_ERROR: no such table: roles');
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await adminAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.admin.roleName).toBe('super_admin');
  });

  it.each([
    ['connection reset', new Error('Connection terminated unexpectedly')],
    ['deadlock', new Error('deadlock detected')],
    ['pool exhaustion', new Error('Knex: Timeout acquiring a connection')],
    ['statement timeout', new Error('canceling statement due to statement timeout')],
  ])('does NOT fabricate super_admin on a transient failure (%s)', async (_label, err) => {
    mockJoinError = err;
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await adminAuth(req, res, next);

    // Fails closed: request rejected, req.admin never populated. The specific
    // status is 401 (adminAuth's blanket outer catch) — what matters is that
    // the caller is not elevated and does not reach the route.
    expect(next).not.toHaveBeenCalled();
    expect(req.admin).toBeUndefined();
    expect(res.statusCode).toBe(401);
  });

  it('does NOT fabricate super_admin when an unrelated table is missing', async () => {
    mockJoinError = new Error('SQLITE_ERROR: no such table: admin_sessions');
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await adminAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(req.admin).toBeUndefined();
  });
});
