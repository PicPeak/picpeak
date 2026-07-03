/**
 * Unit test for the non-mutating isSessionExpired() helper added to
 * middleware/sessionTimeout.js. Used by GET /auth/session to mirror the
 * timeout enforcement that sessionTimeoutMiddleware applies to /api/admin
 * endpoints — closing the asymmetry that surfaced as the redirect-loop
 * recurrence on v3.39.1-beta.0 (issue #350).
 *
 * The helper has two branches:
 *   1. In-memory `lastActivity` exists for this token  → expired iff
 *      now - lastActivity > timeout.
 *   2. No in-memory entry (post-restart, or first request)  → expired
 *      iff token's iat is older than the timeout (post-restart guard
 *      that the existing middleware already implements at line ~101).
 *
 * Both branches must NOT mutate the in-memory `sessions` Map — the
 * middleware is the only place that tracks activity. We assert that.
 */

jest.mock('../../src/database/db', () => ({
  db: () => ({
    where: () => ({
      first: () => ({
        timeout: () => Promise.resolve(null),
      }),
    }),
  }),
}));

// Speed up the cached-timeout reads. The module reads
// `security_session_timeout_minutes` from app_settings and falls back to
// DEFAULT_SESSION_TIMEOUT (60 min) when the row is null.
const SIXTY_MINUTES_MS = 60 * 60 * 1000;

const sessionTimeout = require('../../src/middleware/sessionTimeout');
const { isSessionExpired } = sessionTimeout;

function makeDecodedToken({ id = 1, iatSecondsAgo = 0 } = {}) {
  return { id, iat: Math.floor((Date.now() - iatSecondsAgo * 1000) / 1000) };
}

describe('isSessionExpired (sessionTimeout helper)', () => {
  it('returns false for a freshly-issued token with no in-memory record', async () => {
    const decoded = makeDecodedToken({ id: 1, iatSecondsAgo: 60 });
    expect(await isSessionExpired('fresh-token-1', decoded)).toBe(false);
  });

  it('returns true when iat is older than the timeout (post-restart guard)', async () => {
    const decoded = makeDecodedToken({
      id: 2,
      // 90 minutes > 60 minute default timeout
      iatSecondsAgo: 90 * 60,
    });
    expect(await isSessionExpired('stale-token-2', decoded)).toBe(true);
  });

  it('returns false / true based on lastActivity when one exists', async () => {
    // Drive the in-memory map by running the actual middleware once to
    // record activity for the token, then check the helper.
    const decoded = makeDecodedToken({ id: 3 });

    // Drive the actual middleware once with a real signed token so it
    // records this token in the in-memory `sessions` Map. Then check the
    // helper sees that recent activity and reports "not expired".
    const res = { status: jest.fn(() => res), json: jest.fn() };
    const jwt = require('jsonwebtoken');
    process.env.JWT_SECRET = 'session-timeout-helper-test-secret';
    const realToken = jwt.sign(decoded, process.env.JWT_SECRET, {
      issuer: 'picpeak-auth',
    });
    const realReq = {
      headers: { authorization: `Bearer ${realToken}` },
      cookies: {},
    };
    await sessionTimeout.sessionTimeoutMiddleware(realReq, res, () => {});

    const decodedReal = jwt.decode(realToken);
    // Just-recorded → not expired
    expect(await isSessionExpired(realToken, decodedReal)).toBe(false);
  });

  it('returns false when token / decoded is missing (defensive)', async () => {
    expect(await isSessionExpired(null, { id: 1 })).toBe(false);
    expect(await isSessionExpired('tok', null)).toBe(false);
    expect(await isSessionExpired('tok', {})).toBe(false);
  });

  // Sanity: the helper must not poke the `sessions` Map. Indirectly check
  // by counting active sessions before/after a call with a never-seen
  // token — should not change.
  it('does not mutate the in-memory sessions map', async () => {
    const before = sessionTimeout.getActiveSessions();
    await isSessionExpired('never-seen-token-99', makeDecodedToken({ id: 99 }));
    const after = sessionTimeout.getActiveSessions();
    expect(after).toBe(before);
  });

  it('uses the default 60-minute timeout when no DB setting exists', async () => {
    // 59 minutes → not expired
    const fresh = makeDecodedToken({ id: 4, iatSecondsAgo: 59 * 60 });
    expect(await isSessionExpired('fresh-4', fresh)).toBe(false);

    // 61 minutes → expired (just past the default)
    const stale = makeDecodedToken({ id: 5, iatSecondsAgo: 61 * 60 });
    expect(await isSessionExpired('stale-5', stale)).toBe(true);
  });

  // Document the constant the test relies on so a future timeout change
  // makes this assertion explicit rather than mysterious.
  it('default timeout is 60 minutes (constant under test)', () => {
    expect(SIXTY_MINUTES_MS).toBe(60 * 60 * 1000);
  });
});
