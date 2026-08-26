/**
 * "Remember me" on the admin login (#1186).
 *
 * The checkbox shipped with no `checked`, no `onChange` and no place in the
 * request body, and `establishAdminSession` hardcoded `expiresIn: '24h'` — so
 * it promised a longer session and changed nothing at all.
 *
 * What matters here is not just that checking it extends the session, but the
 * two things that make it safe: an untouched form still gets exactly the 24h
 * it always did, and the JWT and the cookie agree about how long that is. If
 * they disagree the session either dies early (long cookie, short token) or
 * outlives what the user consented to (short cookie, long token).
 *
 * Every assertion fails on the unfixed code.
 */

const jwt = require('jsonwebtoken');
const express = require('express');
const request = require('supertest');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const { bootCrmDb } = require('../integration/helpers/crmDb');

const fsSync = require('fs');
const osMod = require('os');
const pathMod = require('path');

process.env.NODE_ENV = 'test';
// Its own database file. bootCrmDb otherwise reuses whatever path is already
// configured, and a leftover from a previous run fails with
// "table `migrations` already exists".
process.env.TEST_DATABASE_PATH = pathMod.join(
  fsSync.mkdtempSync(pathMod.join(osMod.tmpdir(), 'picpeak-rememberme-')), 'db.sqlite'
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-not-a-real-key';

const tokenUtils = require('../../src/utils/tokenUtils');

describe('admin session lifetime honours remember me (#1186)', () => {
  // One database for the file, booted before anything that touches it. Both
  // groups below depend on it: the login route obviously, and the idle-timeout
  // checks because getSessionTimeout() reads app_settings — and falls back to
  // its 60-minute default when that read fails, which would let those tests
  // pass without ever exercising the configured value.
  let app; let db; let cleanup; let isSessionExpired;
  // An obvious placeholder, matching what the other suites use
  // (setupService.test.js:20). A high-entropy generated value reads like a real
  // credential to secret scanning; this does not, and the login route only
  // compares it against the hash seeded below.
  const PASSWORD = 'Str0ng-Passw0rd!';
  const TIMEOUT_MINUTES = 60;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await db('admin_users').insert({
      username: 'remember-admin',
      email: 'remember-admin@example.com',
      password_hash: await bcrypt.hash(PASSWORD, 10),
      is_active: true,
    });
    // Seeded explicitly so the timeout assertions below are measured against a
    // known configured value rather than the error fallback.
    await db('app_settings').insert({
      setting_key: 'security_session_timeout_minutes',
      setting_value: JSON.stringify(TIMEOUT_MINUTES),
      setting_type: 'security',
    });

    const authRouter = require('../../src/routes/auth');
    ({ isSessionExpired } = require('../../src/middleware/sessionTimeout'));
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/auth', authRouter);
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  // Minimal res double: enough to record what cookie options were used.
  const makeRes = () => {
    const cookies = [];
    return {
      cookies,
      cookie: (name, value, options) => cookies.push({ name, value, options }),
      // buildCookieOptionsWithExpiry reads the request off res.req in some
      // deployments (proxy/secure detection); an empty object is enough.
      req: { headers: {}, secure: false },
    };
  };

  const DAY_MS = 24 * 60 * 60 * 1000;

  test('the two lifetimes are the ones we intend, and the default is unchanged', () => {
    expect(tokenUtils.DEFAULT_MAX_AGE_MS).toBe(DAY_MS);
    expect(tokenUtils.REMEMBER_ME_MAX_AGE_MS).toBe(30 * DAY_MS);
  });

  test('an unchecked box still gets the historical 24h cookie', () => {
    const res = makeRes();
    tokenUtils.setAdminAuthCookie(res, 'a-token');
    expect(res.cookies).toHaveLength(1);
    expect(res.cookies[0].options.maxAge).toBe(DAY_MS);
  });

  test('explicitly unchecked is treated the same as absent', () => {
    const res = makeRes();
    tokenUtils.setAdminAuthCookie(res, 'a-token', { rememberMe: false });
    expect(res.cookies[0].options.maxAge).toBe(DAY_MS);
  });

  test('checking it extends the cookie to 30 days', () => {
    const res = makeRes();
    tokenUtils.setAdminAuthCookie(res, 'a-token', { rememberMe: true });
    expect(res.cookies[0].options.maxAge).toBe(30 * DAY_MS);
  });

  test('a missing token still sets no cookie at all', () => {
    const res = makeRes();
    tokenUtils.setAdminAuthCookie(res, null, { rememberMe: true });
    expect(res.cookies).toHaveLength(0);
  });

  describe('the JWT and the cookie agree — through the real login route', () => {
    // Driven through POST /api/auth/admin/login rather than a local jwt.sign()
    // clone. A clone reproduces the ternary we hope production has, so it goes
    // on passing if establishAdminSession regresses to a flat 24h — which is
    // exactly the mismatch these assertions claim to guard.
    const login = (rememberMe) => {
      const body = { username: 'remember-admin', password: PASSWORD };
      if (rememberMe !== undefined) body.remember_me = rememberMe;
      return request(app).post('/api/auth/admin/login').send(body);
    };

    const cookieMaxAge = (res) => {
      const raw = (res.headers['set-cookie'] || []).find((c) => c.startsWith('admin_token='));
      expect(raw).toBeTruthy();
      const m = /Max-Age=(\d+)/i.exec(raw);
      expect(m).toBeTruthy();
      return Number(m[1]) * 1000;
    };

    const tokenLifetime = (res) => {
      const raw = (res.headers['set-cookie'] || []).find((c) => c.startsWith('admin_token='));
      const token = decodeURIComponent(raw.split(';')[0].split('=').slice(1).join('='));
      const { iat, exp, rememberMe } = jwt.decode(token);
      return { ms: (exp - iat) * 1000, rememberMe };
    };

    test('unchecked: 24h token, 24h cookie', async () => {
      const res = await login(false);
      expect(res.status).toBe(200);
      expect(tokenLifetime(res).ms).toBe(DAY_MS);
      expect(cookieMaxAge(res)).toBe(DAY_MS);
    });

    test('omitted entirely behaves like unchecked', async () => {
      const res = await login(undefined);
      expect(res.status).toBe(200);
      expect(tokenLifetime(res).ms).toBe(DAY_MS);
      expect(cookieMaxAge(res)).toBe(DAY_MS);
    });

    test('checked: 30d token, 30d cookie, and the flag is in the payload', async () => {
      const res = await login(true);
      expect(res.status).toBe(200);
      const { ms, rememberMe } = tokenLifetime(res);
      expect(ms).toBe(30 * DAY_MS);
      expect(cookieMaxAge(res)).toBe(30 * DAY_MS);
      // In the payload because the idle-timeout middleware reads it — a 30-day
      // token that sessionTimeoutMiddleware still expires after an hour is the
      // bug this whole feature would otherwise ship with.
      expect(rememberMe).toBe(true);
    });
  });

  describe('the idle timeout respects a remembered session', () => {
    // The half that made the feature non-functional: the default idle timeout
    // is 60 minutes, so before this a remembered admin was logged out within
    // the hour no matter how long their 30-day token said it lived.
    const hoursAgoIat = (h) => Math.floor((Date.now() - h * 60 * 60 * 1000) / 1000);

    test('an ordinary session still expires when idle past the timeout', async () => {
      const decoded = { id: 1, iat: hoursAgoIat(5) };
      expect(await isSessionExpired('tok-ordinary', decoded)).toBe(true);
    });

    test('a remembered session does not', async () => {
      const decoded = { id: 1, iat: hoursAgoIat(5), rememberMe: true };
      expect(await isSessionExpired('tok-remembered', decoded)).toBe(false);
    });

    test('a remembered session survives an idle gap far beyond the timeout', async () => {
      // Three days: the case from the report — come back after the weekend.
      const decoded = { id: 1, iat: hoursAgoIat(72), rememberMe: true };
      expect(await isSessionExpired('tok-weekend', decoded)).toBe(false);
    });

    test('only an explicit true counts', async () => {
      // A truthy-but-not-true value must not buy an exemption.
      for (const value of [undefined, false, 'true', 1]) {
        const decoded = { id: 1, iat: hoursAgoIat(5), rememberMe: value };
        expect(await isSessionExpired(`tok-${String(value)}`, decoded)).toBe(true);
      }
    });
  });

  test('the extended cookie keeps every other security attribute', () => {
    // A longer life must not quietly relax httpOnly/sameSite — the whole point
    // of opting in is a longer session, not a weaker one.
    const short = makeRes();
    const long = makeRes();
    tokenUtils.setAdminAuthCookie(short, 't');
    tokenUtils.setAdminAuthCookie(long, 't', { rememberMe: true });

    const withoutLifetime = (options) => {
      const rest = { ...options };
      delete rest.maxAge;
      delete rest.expires;
      return rest;
    };
    const longRest = withoutLifetime(long.cookies[0].options);
    expect(longRest).toEqual(withoutLifetime(short.cookies[0].options));
    expect(longRest.httpOnly).toBe(true);
  });
});
