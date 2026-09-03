/**
 * revokeToken() is reachable from the unauthenticated logout endpoints
 * (POST /api/auth/logout, /gallery/logout, /customer-auth/logout). It used
 * to base64-decode the payload without checking the signature and insert a
 * row keyed on `${id}-${iat}-${type}` -- the same key isTokenRevoked()
 * matches for real sessions. Anyone could therefore forge a payload naming
 * another user's id, type and login second and log them out remotely, and
 * with a far-future `exp` the row was never swept.
 *
 * The contract pinned here: only a token whose signature verifies under
 * JWT_SECRET is written to revoked_tokens. Expired-but-genuine tokens are
 * still accepted (logout must stay idempotent).
 */
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'revocation-forgery-test-secret';

const inserted = [];
jest.mock('../../src/database/db', () => {
  const dbFn = () => ({
    insert(row) {
      inserted.push(row);
      return { onConflict: () => ({ ignore: async () => undefined }) };
    },
  });
  return { db: dbFn };
});
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { revokeToken } = require('../../src/utils/tokenRevocation');

const iat = Math.floor(Date.now() / 1000) - 60;

describe('revokeToken signature check', () => {
  beforeEach(() => { inserted.length = 0; });

  it('refuses a forged three-part token and writes nothing', async () => {
    const forgedPayload = Buffer.from(JSON.stringify({
      id: 1, iat, type: 'admin', exp: 9e9,
    })).toString('base64');
    const forged = `eyJhbGciOiJIUzI1NiJ9.${forgedPayload}.notasignature`;

    const result = await revokeToken(forged, 'user_logout');

    expect(result).toBe(false);
    expect(inserted).toHaveLength(0);
  });

  it('refuses a token signed with a different secret', async () => {
    const other = jwt.sign({ id: 1, iat, type: 'admin' }, 'some-other-secret', { expiresIn: '1h' });
    expect(await revokeToken(other, 'user_logout')).toBe(false);
    expect(inserted).toHaveLength(0);
  });

  it('revokes a genuine token', async () => {
    const genuine = jwt.sign({ id: 1, iat, type: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    expect(await revokeToken(genuine, 'user_logout')).toBe(true);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].token_id).toBe(`1-${iat}-admin`);
  });

  it('still revokes a genuine token that has already expired', async () => {
    const expired = jwt.sign({ id: 1, iat, type: 'admin', exp: iat + 1 }, process.env.JWT_SECRET);
    expect(await revokeToken(expired, 'user_logout')).toBe(true);
    expect(inserted).toHaveLength(1);
  });
});
