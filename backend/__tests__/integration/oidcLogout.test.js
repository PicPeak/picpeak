/**
 * OIDC logout-to-IdP integration tests (#798 phase 3).
 *
 * Same full-stack shape as oidcSso.test.js: real routes over a mock
 * in-process IdP, genuine discovery/JWKS/PKCE via openid-client. Pins:
 *
 *   - the SSO callback stores the raw ID token in the oidc_id_token cookie
 *   - /logout with that cookie + oidc_logout_from_idp=true returns the
 *     IdP end-session URL (id_token_hint, post_logout_redirect_uri,
 *     client_id) and clears the cookie
 *   - feature off → no ssoLogoutUrl even for an SSO session
 *   - no oidc_id_token cookie (local-password session) → no ssoLogoutUrl
 *     even with the feature on — local sessions never bounce to the IdP
 *   - IdP without an end_session_endpoint → no ssoLogoutUrl, logout still 200
 *   - settings surface: GET exposes the flag + post_logout_redirect_uri,
 *     PUT persists the flag
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');

const { bootCrmDb } = require('./helpers/crmDb');
const { MockOidcProvider } = require('./helpers/mockOidcProvider');

describe('OIDC logout-to-IdP (#798 phase 3)', () => {
  let db;
  let cleanup;
  let app;
  let idp;
  let oidcService;

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'oidc-logout-test-secret';
    process.env.FRONTEND_URL = 'http://localhost:5199';
    ({ db, cleanup } = await bootCrmDb());

    idp = new MockOidcProvider();
    const issuer = await idp.start();

    oidcService = require('../../src/services/oidcService');
    await oidcService.saveOidcSettings({
      oidc_enabled: true,
      oidc_issuer_url: issuer,
      oidc_client_id: idp.clientId,
      oidc_client_secret: idp.clientSecret,
      oidc_autoprovision: true,
      oidc_default_role: 'viewer',
      oidc_logout_from_idp: true,
    });

    const authRouter = require('../../src/routes/auth');
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/auth', authRouter);
  }, 120000);

  afterAll(async () => {
    if (idp) await idp.stop();
    if (cleanup) await cleanup();
  });

  /** Drive login → IdP → callback like a browser; returns the callback response. */
  async function ssoRoundTrip() {
    const loginRes = await request(app).get('/api/auth/admin/sso/login').expect(302);
    const stateCookie = (loginRes.headers['set-cookie'] || [])
      .find((c) => c.startsWith('oidc_state='))
      .split(';')[0];

    const idpRes = await fetch(loginRes.headers.location, { redirect: 'manual' });
    expect(idpRes.status).toBe(302);
    const back = new URL(idpRes.headers.get('location'));

    return request(app)
      .get(`${back.pathname}?${back.searchParams.toString()}`)
      .set('Cookie', stateCookie)
      .expect(302);
  }

  /**
   * The oidc_id_token cookie pair ("oidc_id_token=<jwt>") from a callback
   * response. The callback carries TWO Set-Cookie headers for this name —
   * establishAdminSession clears any stale marker, then the callback sets
   * the fresh one — and browsers apply them in order, so the LAST wins.
   */
  function idTokenCookie(res) {
    const cookies = (res.headers['set-cookie'] || []).filter((c) => c.startsWith('oidc_id_token='));
    const last = cookies[cookies.length - 1];
    return last ? last.split(';')[0] : null;
  }

  it('stores the raw ID token in the oidc_id_token cookie on SSO login', async () => {
    idp.setNextUser({ sub: 'logout-sub-1', email: 'logout@example.com', email_verified: true });
    const res = await ssoRoundTrip();
    expect(res.headers.location).toBe('http://localhost:5199/admin/dashboard');

    const cookie = idTokenCookie(res);
    expect(cookie).toBeTruthy();
    // Raw JWT, HttpOnly, scoped to /api/auth.
    const raw = decodeURIComponent(cookie.replace('oidc_id_token=', ''));
    expect(raw.split('.')).toHaveLength(3);
    const setCookies = (res.headers['set-cookie'] || []).filter((c) => c.startsWith('oidc_id_token='));
    const full = setCookies[setCookies.length - 1];
    expect(full).toMatch(/HttpOnly/i);
    expect(full).toMatch(/Path=\/api\/auth/i);
  });

  it('returns the IdP end-session URL on logout and clears the cookie', async () => {
    idp.setNextUser({ sub: 'logout-sub-2', email: 'logout2@example.com', email_verified: true });
    const cbRes = await ssoRoundTrip();
    const cookie = idTokenCookie(cbRes);
    const rawIdToken = decodeURIComponent(cookie.replace('oidc_id_token=', ''));

    const res = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', cookie)
      .expect(200);

    expect(res.body.ssoLogoutUrl).toBeTruthy();
    const url = new URL(res.body.ssoLogoutUrl);
    expect(url.href.startsWith(`${idp.issuer}/logout`)).toBe(true);
    expect(url.searchParams.get('id_token_hint')).toBe(rawIdToken);
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('http://localhost:5199/admin/login');
    expect(url.searchParams.get('client_id')).toBe(idp.clientId);

    // Cookie must be cleared so a later local-password logout in the same
    // browser doesn't bounce to the IdP again.
    const cleared = (res.headers['set-cookie'] || []).find((c) => c.startsWith('oidc_id_token='));
    expect(cleared).toBeTruthy();
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/i);
  });

  it('omits ssoLogoutUrl when the feature is disabled', async () => {
    idp.setNextUser({ sub: 'logout-sub-3', email: 'logout3@example.com', email_verified: true });
    const cbRes = await ssoRoundTrip();
    const cookie = idTokenCookie(cbRes);

    await oidcService.saveOidcSettings({ oidc_logout_from_idp: false });
    try {
      const res = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', cookie)
        .expect(200);
      expect(res.body.ssoLogoutUrl).toBeUndefined();
    } finally {
      await oidcService.saveOidcSettings({ oidc_logout_from_idp: true });
    }
  });

  it('omits ssoLogoutUrl without an oidc_id_token cookie (local-password session)', async () => {
    const res = await request(app).post('/api/auth/logout').expect(200);
    expect(res.body.ssoLogoutUrl).toBeUndefined();
  });

  it('omits ssoLogoutUrl when the IdP advertises no end_session_endpoint', async () => {
    // Separate provider whose discovery document lacks end_session_endpoint;
    // repointing the settings invalidates the discovery cache.
    const bareIdp = new MockOidcProvider();
    bareIdp.advertiseEndSession = false;
    const bareIssuer = await bareIdp.start();
    try {
      await oidcService.saveOidcSettings({
        oidc_issuer_url: bareIssuer,
        oidc_client_id: bareIdp.clientId,
        oidc_client_secret: bareIdp.clientSecret,
      });

      bareIdp.setNextUser({ sub: 'logout-sub-4', email: 'logout4@example.com', email_verified: true });
      const cbRes = await ssoRoundTrip();
      const cookie = idTokenCookie(cbRes);
      expect(cookie).toBeTruthy();

      const res = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', cookie)
        .expect(200);
      expect(res.body.ssoLogoutUrl).toBeUndefined();
    } finally {
      await bareIdp.stop();
      await oidcService.saveOidcSettings({
        oidc_issuer_url: idp.issuer,
        oidc_client_id: idp.clientId,
        oidc_client_secret: idp.clientSecret,
      });
    }
  });

  it('stores a bare marker for oversized ID tokens; logout still round-trips, without a hint', async () => {
    idp.setNextUser({
      sub: 'logout-sub-5',
      email: 'logout5@example.com',
      email_verified: true,
      // ~9KB of group claims — far past the 4KB cookie limit.
      groups: Array.from({ length: 300 }, (_, i) => `group-${String(i).padStart(4, '0')}-xxxxxxxxxxxxxxxx`),
    });
    const cbRes = await ssoRoundTrip();
    const cookie = idTokenCookie(cbRes);
    expect(cookie).toBeTruthy();
    expect(decodeURIComponent(cookie.replace('oidc_id_token=', ''))).toBe('sso');

    const res = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body.ssoLogoutUrl).toBeTruthy();
    const url = new URL(res.body.ssoLogoutUrl);
    expect(url.searchParams.get('id_token_hint')).toBeNull();
    expect(url.searchParams.get('client_id')).toBe(idp.clientId);
  });

  it('a fresh local-password login clears a stale SSO marker', async () => {
    const role = await db('roles').where({ name: 'admin' }).first();
    await db('admin_users').insert({
      username: 'stale-marker-admin',
      email: 'stale-marker@example.com',
      password_hash: await bcrypt.hash('StaleMarker123!', 4),
      role_id: role.id,
      is_active: 1,
      must_change_password: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Stale marker from a dead SSO session rides along on the login request.
    const res = await request(app)
      .post('/api/auth/admin/login')
      .set('Cookie', 'oidc_id_token=stale.jwt.value')
      .send({ username: 'stale-marker-admin', password: 'StaleMarker123!' })
      .expect(200);

    const cleared = (res.headers['set-cookie'] || []).find((c) => c.startsWith('oidc_id_token='));
    expect(cleared).toBeTruthy();
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/i);
  });

  it('skips the round-trip when the stored hint was issued by a DIFFERENT issuer (config changed)', async () => {
    // Fake-but-well-formed JWT from another IdP — payload is all that matters,
    // buildEndSessionUrl decodes without verification for routing only.
    const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const foreignToken = `${b64({ alg: 'none' })}.${b64({ iss: 'http://other-idp.example', aud: idp.clientId })}.sig`;

    const res = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', `oidc_id_token=${foreignToken}`)
      .expect(200);
    expect(res.body.ssoLogoutUrl).toBeUndefined();
  });

  it('drops only the hint when the issuer matches but the client changed', async () => {
    const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const oldClientToken = `${b64({ alg: 'none' })}.${b64({ iss: idp.issuer, aud: 'previous-client-id' })}.sig`;

    const res = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', `oidc_id_token=${oldClientToken}`)
      .expect(200);
    expect(res.body.ssoLogoutUrl).toBeTruthy();
    const url = new URL(res.body.ssoLogoutUrl);
    expect(url.searchParams.get('id_token_hint')).toBeNull();
    expect(url.searchParams.get('client_id')).toBe(idp.clientId);
  });

  it('exposes the flag and post_logout_redirect_uri via getOidcConfig/getPostLogoutRedirectUri', async () => {
    // Settings-route auth chains are covered in oidcSso.test.js; here the
    // service surface the routes read from is pinned directly.
    const cfg = await oidcService.getOidcConfig();
    expect(cfg.logoutFromIdp).toBe(true);
    expect(await oidcService.getPostLogoutRedirectUri()).toBe('http://localhost:5199/admin/login');
  });
});
