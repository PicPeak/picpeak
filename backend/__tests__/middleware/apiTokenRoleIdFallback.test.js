/**
 * The roles-schema fallback in apiTokenAuth must survive the state that sent
 * it there.
 *
 * `isMissingRolesSchema()` deliberately accepts TWO upgrade-window states
 * (dbErrors.js:41-45): `roles` absent (pre-054), and `roles` present but
 * `admin_users.role_id` not yet added (post-054/pre-057). The fallback query
 * then selected `role_id` — the very column whose absence is one of those two
 * states — so in that window it threw a second time, fell out to the outer
 * catch, and answered 500 on every API-token request.
 *
 * apiTokenRoleFallback.test.js asserts the predicate accepts both states but
 * never drives the query, which is exactly how this survived: the suite says
 * the state is legitimate while the code cannot handle it.
 *
 * sessionAccessService's fallback omits role_id and nulls it afterwards
 * (sessionAccessService.js:53-58); this brings apiTokenAuth in line.
 *
 * The db mock (helpers/projectingDb.js) therefore treats the fixture row's keys
 * as the schema: a fallback projection naming role_id rejects, which is what
 * the real driver does when the column is missing. A mock that answers every
 * select regardless cannot see this bug.
 */

const crypto = require('crypto');

jest.mock('../../src/utils/logger', () => ({ warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() }));

const TOKEN = 'pp_live_' + 'a'.repeat(32);
const HASHED = crypto.createHash('sha256').update(TOKEN).digest('hex');

const mockTokenRow = {
  id: 3, name: 'ci', scopes: JSON.stringify(['read']),
  created_by: 9, revoked_at: null, expires_at: null, hashed_token: HASHED,
};
// Models the post-054/pre-057 window: `roles` exists, admin_users.role_id
// does not — so the row has no role_id, and a projection naming it rejects.
const mockAdminRow = { id: 9, username: 'owner', email: 'o@example.com', must_change_password: false };

// The join names admin_users.role_id in its ON clause, so it fails the same way.
const missingRoleId = () => Object.assign(
  new Error('select ... - SQLITE_ERROR: no such column: admin_users.role_id'),
  { code: 'SQLITE_ERROR' },
);

jest.mock('../../src/database/db', () => ({
  db: require('../helpers/projectingDb').projectingDb(({ table, joined }) => {
    if (table === 'api_tokens') return mockTokenRow;
    return joined ? missingRoleId() : mockAdminRow;
  }),
}));

const { apiTokenAuth } = require('../../src/middleware/apiTokenAuth');

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

describe('apiTokenAuth roles fallback with admin_users.role_id missing', () => {
  afterEach(() => { mockAdminRow.must_change_password = false; });
  it('enforces required password changes even in the roles fallback', async () => {
    mockAdminRow.must_change_password = true;
    const req = { headers: { authorization: `Bearer ${TOKEN}` } };
    const res = makeRes();
    const next = jest.fn();
    await apiTokenAuth(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('MUST_CHANGE_PASSWORD');
    expect(next).not.toHaveBeenCalled();
  });
  it('authenticates instead of 500ing when the column that triggered the fallback is absent', async () => {
    const req = { headers: { authorization: `Bearer ${TOKEN}` } };
    const res = makeRes();
    const next = jest.fn();

    await apiTokenAuth(req, res, next);

    // Fails against the projection that selected role_id: the fallback threw
    // a second time and the outer catch answered 500.
    expect(res.statusCode).not.toBe(500);
    expect(next).toHaveBeenCalled();
    expect(req.admin.roleName).toBe('super_admin');
    expect(req.admin.roleId).toBeNull();
  });
});
