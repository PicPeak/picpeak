const express = require('express');
const request = require('supertest');

const originalEnv = { ...process.env };

jest.mock('../../src/database/db', () => ({ db: jest.fn(), logActivity: jest.fn() }));
jest.mock('../../src/services/recaptcha', () => ({}));
jest.mock('../../src/services/mfaService', () => ({}));
jest.mock('../../src/utils/authSecurity', () => ({}));
jest.mock('../../src/middleware/sessionTimeout', () => ({}));
jest.mock('../../src/utils/tokenRevocation', () => ({}));
jest.mock('../../src/services/shareLinkService', () => ({}));
jest.mock('../../src/services/oidcService', () => ({
  buildAuthorizationRequest: async () => ({
    url: 'https://idp.example/authorize',
    state: 'state',
    nonce: 'nonce',
    codeVerifier: 'verifier',
  }),
}));

describe('OIDC state cookie transport policy', () => {
  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  test.each([
    [undefined, false, true],
    ['true', false, true],
    ['false', false, false],
    ['auto', false, false],
    ['auto', true, true],
  ])('COOKIE_SECURE=%p with HTTPS=%p emits Secure=%p', async (mode, secure, expected) => {
    jest.resetModules();
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'oidc-cookie-transport-policy-test-secret';
    if (mode === undefined) delete process.env.COOKIE_SECURE;
    else process.env.COOKIE_SECURE = mode;

    const app = express();
    app.set('trust proxy', secure ? 'loopback' : false);
    app.use('/api/auth', require('../../src/routes/auth'));
    const response = await request(app).get('/api/auth/admin/sso/login')
      .set('X-Forwarded-Proto', 'https').expect(302);
    const cookie = response.headers['set-cookie'].find((value) => value.startsWith('oidc_state='));

    expect(cookie.includes('; Secure')).toBe(expected);
    expect(cookie).toContain('Max-Age=600');
    expect(cookie).toContain('Path=/api/auth/admin/sso');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(response.headers.location).toBe('https://idp.example/authorize');
  });
});
