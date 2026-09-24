/**
 * The roles-join fallback in sessionAccessService grants super_admin, so it
 * must fire only for the two upgrade-window states (roles table absent,
 * admin_users.role_id absent). On Postgres every missing column raises 42703,
 * including columns the join merely projects, and the predicate used to accept
 * the SQLSTATE alone: a projection naming a column the install lacked turned
 * every admin into super_admin instead of failing the request.
 *
 * The db mock (helpers/projectingDb.js) rejects the joined query with the
 * error the test names and answers the fallback projection from the row.
 */

jest.mock('../../src/utils/tokenRevocation', () => ({ isTokenRevoked: jest.fn().mockResolvedValue(false) }));
jest.mock('../../src/utils/sessionCutoff', () => ({ isTokenBeforeCutoff: jest.fn().mockResolvedValue(false) }));
jest.mock('../../src/utils/logger', () => ({ warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() }));

const mockAdminRow = { id: 11, username: 'owner', email: 'o@example.com', password_changed_at: null, must_change_password: 0 };
let mockJoinError;

jest.mock('../../src/database/db', () => ({
  db: require('../helpers/projectingDb').projectingDb(({ joined }) => (joined ? mockJoinError : mockAdminRow)),
}));

const sessionAccess = require('../../src/services/sessionAccessService');
const session = { id: mockAdminRow.id, type: 'admin', iat: Math.floor(Date.now() / 1000) - 60 };
const pg = (message) => Object.assign(new Error(message), { code: '42703' });

it('rethrows a Postgres 42703 for a column the join only projects, instead of granting super_admin', async () => {
  mockJoinError = pg('column admin_users.avatar_url does not exist');
  await expect(sessionAccess.admin(session)).rejects.toBe(mockJoinError);
});

it('still falls back to super_admin when admin_users.role_id is the missing column', async () => {
  mockJoinError = pg('column admin_users.role_id does not exist');
  await expect(sessionAccess.admin(session)).resolves.toMatchObject({ id: 11, role_id: null, role_name: 'super_admin' });
});
