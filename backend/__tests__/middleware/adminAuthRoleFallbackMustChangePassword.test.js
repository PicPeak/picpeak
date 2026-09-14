/**
 * The roles-join fallback must carry `must_change_password` through.
 *
 * Stable selected it in both admin lookup paths (origin/stable
 * backend/src/middleware/auth.js:105). The refactor that moved the lookup into
 * sessionAccessService kept it on the joined query but dropped it from the
 * role-less fallback projection, so on an install where the roles table is
 * missing — the one case the fallback exists for — adminAuth read `undefined`
 * and let the request through instead of answering 403 MUST_CHANGE_PASSWORD.
 *
 * Found while promoting main into stable: the fix was present on both branches
 * under the same commit subject, but only stable's implementation still had the
 * field, which is why a subject-level parity audit missed it.
 *
 * Unlike adminAuthRoleFallback.test.js, the db mock here HONOURS the
 * projection — a mock that returns the whole row regardless of `select()`
 * cannot see this bug at all.
 */

const jwt = require('jsonwebtoken');

jest.mock('../../src/utils/tokenRevocation', () => ({ isTokenRevoked: jest.fn().mockResolvedValue(false) }));
jest.mock('../../src/utils/sessionCutoff', () => ({ isTokenBeforeCutoff: jest.fn().mockResolvedValue(false) }));
jest.mock('../../src/utils/logger', () => ({ warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() }));

const mockAdminRow = {
  id: 11,
  username: 'must-change',
  email: 'mc@example.com',
  password_changed_at: null,
  must_change_password: 1,
  role_id: null,
  role_name: null,
};

jest.mock('../../src/database/db', () => ({
  db: () => ({
    _joined: false,
    _cols: [],
    leftJoin() { this._joined = true; return this; },
    where() { return this; },
    select(...cols) { this._cols = cols.flat(); return this; },
    first() {
      if (this._joined) return Promise.reject(new Error('SQLITE_ERROR: no such table: roles'));
      // Honour the projection, the way a real driver would. An alias like
      // `admin_users.must_change_password` resolves to its bare column name.
      const out = {};
      for (const col of this._cols) {
        const bare = String(col).split(' as ').pop().split('.').pop();
        if (bare in mockAdminRow) out[bare] = mockAdminRow[bare];
      }
      return Promise.resolve(out);
    },
  }),
}));

const { adminAuth } = require('../../src/middleware/auth');

const SECRET = 'test-secret-for-must-change-password-fallback';

function makeReq() {
  const token = jwt.sign({ id: mockAdminRow.id, type: 'admin' }, SECRET,
    { algorithm: 'HS256', issuer: 'picpeak-auth' });
  return {
    headers: { authorization: `Bearer ${token}` },
    ip: '127.0.0.1',
    connection: {},
    originalUrl: '/api/admin/events',
  };
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

describe('adminAuth roles-join fallback carries must_change_password', () => {
  const OLD_SECRET = process.env.JWT_SECRET;
  beforeAll(() => { process.env.JWT_SECRET = SECRET; });
  afterAll(() => { process.env.JWT_SECRET = OLD_SECRET; });

  it('still answers 403 MUST_CHANGE_PASSWORD when the roles table is missing', async () => {
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await adminAuth(req, res, next);

    // Fails against the projection that omitted must_change_password: there
    // the flag read undefined and next() was called.
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('MUST_CHANGE_PASSWORD');
  });
});
