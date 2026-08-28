/**
 * How long a guest stays recognised (#1210).
 *
 * The expiry was 24h and every call site took the default, so a client
 * reviewing a gallery across two weekends lost their identity in between and
 * registered again — and each re-registration is a fresh gallery_guests row
 * whose likes and favourites no longer join up with the first visit's.
 *
 * Pinned as a test because the value is the whole fix: a silent revert to 24h
 * would restore the duplicate churn without breaking anything visible.
 */

const jwt = require('jsonwebtoken');

describe('guest token lifetime (#1210)', () => {
  const load = (ttl) => {
    jest.resetModules();
    process.env.JWT_SECRET = 'guest-ttl-secret';
    if (ttl === undefined) delete process.env.GUEST_TOKEN_TTL;
    else process.env.GUEST_TOKEN_TTL = ttl;
    return require('../../src/middleware/guestAuth');
  };

  const lifetimeDays = (token) => {
    const { iat, exp } = jwt.decode(token);
    return Math.round((exp - iat) / 86400);
  };

  const sign = (mod) => mod.signGuestToken({
    guestId: 1, eventId: 2, identifier: 'abc', name: 'Tina',
  });

  afterAll(() => { delete process.env.GUEST_TOKEN_TTL; });

  it('defaults to 30 days, not 24 hours', () => {
    expect(lifetimeDays(sign(load(undefined)))).toBe(30);
  });

  it('honours an operator override', () => {
    // The value goes straight to jsonwebtoken, so anything it accepts works;
    // an operator who wants the old behaviour back can have it.
    expect(lifetimeDays(sign(load('7d')))).toBe(7);
    expect(lifetimeDays(sign(load('24h')))).toBe(1);
  });

  it('still signs a token the guest middleware accepts', () => {
    const mod = load(undefined);
    const decoded = jwt.verify(sign(mod), process.env.JWT_SECRET, { issuer: 'picpeak-auth' });
    expect(decoded).toMatchObject({ type: 'guest', guestId: 1, eventId: 2, identifier: 'abc' });
  });
});
