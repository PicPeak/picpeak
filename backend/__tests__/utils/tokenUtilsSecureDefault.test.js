const ORIGINAL_ENV = { ...process.env };

let warn;

function cookieOptionsFor(env, secure = false) {
  jest.resetModules();
  process.env = { ...ORIGINAL_ENV, ...env };
  if (env.COOKIE_SECURE === undefined) delete process.env.COOKIE_SECURE;

  warn = jest.spyOn(require('../../src/utils/logger'), 'warn').mockImplementation(() => {});
  const { buildCookieOptionsWithExpiry } = require('../../src/utils/tokenUtils');
  return buildCookieOptionsWithExpiry({ req: { secure } });
}

describe('authentication cookie transport defaults', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.restoreAllMocks();
    jest.resetModules();
  });

  // Upgrade safety: an install with no COOKIE_SECURE served over plain HTTP
  // (all-in-one image at http://nas:3000) must still be able to log in.
  test('unset in production follows the request protocol', () => {
    const env = { NODE_ENV: 'production', COOKIE_SECURE: undefined };
    expect(cookieOptionsFor(env, false).secure).toBe(false);
    expect(cookieOptionsFor(env, true).secure).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  test('keeps local development HTTP-compatible', () => {
    expect(cookieOptionsFor({ NODE_ENV: 'development', COOKIE_SECURE: undefined }).secure).toBe(false);
  });

  test('supports explicit mixed-protocol compatibility mode', () => {
    expect(cookieOptionsFor({ NODE_ENV: 'production', COOKIE_SECURE: 'auto' }, false).secure).toBe(false);
    expect(cookieOptionsFor({ NODE_ENV: 'production', COOKIE_SECURE: 'auto' }, true).secure).toBe(true);
  });

  test.each(['true', ' TRUE ', '1', 'yes', 'on'])(
    'COOKIE_SECURE=%p always sets Secure',
    (value) => {
      expect(cookieOptionsFor({ NODE_ENV: 'production', COOKIE_SECURE: value }, false).secure).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    }
  );

  test.each(['false', 'false ', '0', 'no', 'Off'])(
    'COOKIE_SECURE=%p never sets Secure',
    (value) => {
      expect(cookieOptionsFor({ NODE_ENV: 'production', COOKIE_SECURE: value }, true).secure).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    }
  );

  test('an unrecognised value means auto and warns once at load', () => {
    const env = { NODE_ENV: 'production', COOKIE_SECURE: 'ture' };
    expect(cookieOptionsFor(env, false).secure).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('COOKIE_SECURE');
    expect(cookieOptionsFor(env, true).secure).toBe(true);
  });
});
