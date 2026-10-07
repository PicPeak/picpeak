const ORIGINAL_ENV = { ...process.env };

function cookieOptionsFor(env, secure = false) {
  jest.resetModules();
  process.env = { ...ORIGINAL_ENV, ...env };
  if (env.COOKIE_SECURE === undefined) delete process.env.COOKIE_SECURE;

  const { buildCookieOptionsWithExpiry } = require('../../src/utils/tokenUtils');
  return buildCookieOptionsWithExpiry({ req: { secure } });
}

describe('authentication cookie transport defaults', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.resetModules();
  });

  test('fails closed with Secure cookies in production', () => {
    expect(cookieOptionsFor({ NODE_ENV: 'production', COOKIE_SECURE: undefined }).secure).toBe(true);
  });

  test('keeps local development HTTP-compatible', () => {
    expect(cookieOptionsFor({ NODE_ENV: 'development', COOKIE_SECURE: undefined }).secure).toBe(false);
  });

  test('supports explicit mixed-protocol compatibility mode', () => {
    expect(cookieOptionsFor({ NODE_ENV: 'production', COOKIE_SECURE: 'auto' }, false).secure).toBe(false);
    expect(cookieOptionsFor({ NODE_ENV: 'production', COOKIE_SECURE: 'auto' }, true).secure).toBe(true);
  });

  test('supports an explicit HTTP-only override', () => {
    expect(cookieOptionsFor({ NODE_ENV: 'production', COOKIE_SECURE: 'false' }).secure).toBe(false);
  });
});
