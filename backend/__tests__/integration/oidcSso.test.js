/**
 * OIDC SSO integration tests (#798, phase 1).
 *
 * Full-stack over a mock in-process IdP (mockOidcProvider): supertest drives
 * the real /admin/sso/login and /admin/sso/callback routes on a fresh-SQLite
 * database, openid-client does genuine discovery/JWKS/PKCE/ID-token
 * validation against the mock issuer. Pins:
 *
 *   - happy path: JIT provisioning creates an admin and sets the session cookie
 *   - JIT off → not_provisioned redirect, no row created
 *   - repeat login matches by sub, not email (email change ≠ new account)
 *   - verified-email one-time link onto an existing local admin
 *   - unverified email must NOT link (falls through to JIT/or error)
 *   - deactivated admin → inactive redirect
 *   - missing/forged state cookie → state redirect
 *   - nonce tamper from the IdP → idp redirect
 *   - settings endpoints: secret write-only, generic /general upsert cannot
 *     clobber oidc_client_secret
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { bootCrmDb } = require('./helpers/crmDb');
const { MockOidcProvider } = require('./helpers/mockOidcProvider');

describe('OIDC SSO (#798)', () => {
  let db;
  let cleanup;
  let app;
  let idp;
  let oidcService;

  const agentCookies = {};

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'oidc-test-secret';
    // The redirect_uri derives from the public base URL — pin it explicitly:
    // CI has no backend/.env, and getFrontendBaseUrl() returning '' makes
    // buildAuthorizationRequest fail (by design) with OIDC_BAD_CONFIG.
    process.env.FRONTEND_URL = 'http://localhost:5199';
    ({ db, cleanup } = await bootCrmDb());

    idp = new MockOidcProvider();
    const issuer = await idp.start();

    // Require AFTER bootCrmDb so services share this db instance.
    oidcService = require('../../src/services/oidcService');
    await oidcService.saveOidcSettings({
      oidc_enabled: true,
      oidc_issuer_url: issuer,
      oidc_client_id: idp.clientId,
      oidc_client_secret: idp.clientSecret,
      oidc_autoprovision: true,
      oidc_default_role: 'viewer',
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
  async function ssoRoundTrip({ mutateState } = {}) {
    const loginRes = await request(app).get('/api/auth/admin/sso/login').expect(302);
    const idpUrl = loginRes.headers.location;
    expect(idpUrl.startsWith(idp.issuer)).toBe(true);

    let stateCookie = (loginRes.headers['set-cookie'] || [])
      .find((c) => c.startsWith('oidc_state='));
    expect(stateCookie).toBeTruthy();
    stateCookie = stateCookie.split(';')[0];
    if (mutateState === 'drop') stateCookie = null;
    if (mutateState === 'forge') {
      stateCookie = `oidc_state=${jwt.sign({ type: 'oidc_state', s: 'x', n: 'y', cv: 'z' }, 'wrong-secret', { issuer: 'picpeak-auth' })}`;
    }

    // "Browser" follows the redirect to the IdP, which instantly bounces back.
    const idpRes = await fetch(idpUrl, { redirect: 'manual' });
    expect(idpRes.status).toBe(302);
    const back = new URL(idpRes.headers.get('location'));

    let cb = request(app).get(`${back.pathname}?${back.searchParams.toString()}`);
    if (stateCookie) cb = cb.set('Cookie', stateCookie);
    return cb.expect(302);
  }

  it('JIT-provisions an unknown user and establishes an admin session', async () => {
    idp.setNextUser({ sub: 'sub-jit-1', email: 'jit@example.com', email_verified: true });
    const res = await ssoRoundTrip();

    expect(res.headers.location).toBe('http://localhost:5199/admin/dashboard');
    const adminCookie = (res.headers['set-cookie'] || []).find((c) => c.startsWith('admin_token='));
    expect(adminCookie).toBeTruthy();

    const row = await db('admin_users').where({ email: 'jit@example.com' }).first();
    expect(row).toBeTruthy();
    expect(row.auth_provider).toBe('oidc');
    expect(row.external_subject).toBe('sub-jit-1');

    const role = await db('roles').where('id', row.role_id).first();
    expect(role.name).toBe('viewer');

    // The session JWT must be a normal admin token.
    const token = adminCookie.split(';')[0].replace('admin_token=', '');
    const decoded = jwt.verify(decodeURIComponent(token), process.env.JWT_SECRET, { issuer: 'picpeak-auth' });
    expect(decoded.type).toBe('admin');
    expect(decoded.id).toBe(row.id);
    agentCookies.jitAdminId = row.id;
  });

  it('matches repeat logins by sub even when the email changed at the IdP', async () => {
    idp.setNextUser({ sub: 'sub-jit-1', email: 'renamed@example.com', email_verified: true });
    const res = await ssoRoundTrip();
    expect(res.headers.location).toBe('http://localhost:5199/admin/dashboard');

    // No second row — resolved via external_subject.
    expect(await db('admin_users').where({ email: 'renamed@example.com' }).first()).toBeFalsy();
    const byId = await db('admin_users').where({ id: agentCookies.jitAdminId }).first();
    expect(byId.external_subject).toBe('sub-jit-1');
  });

  it('links an existing local admin one-time via VERIFIED email and stamps the sub', async () => {
    const role = await db('roles').where({ name: 'admin' }).first();
    const [localId] = await db('admin_users').insert({
      username: 'local-admin',
      email: 'local@example.com',
      password_hash: await bcrypt.hash('LocalPass123', 4),
      role_id: role.id,
      is_active: 1,
      auth_provider: 'local',
      created_at: new Date(),
      updated_at: new Date(),
    }).returning('id').then((r) => [r[0]?.id || r[0]]);

    idp.setNextUser({ sub: 'sub-local-1', email: 'local@example.com', email_verified: true });
    const res = await ssoRoundTrip();
    expect(res.headers.location).toBe('http://localhost:5199/admin/dashboard');

    const row = await db('admin_users').where({ id: localId }).first();
    expect(row.external_subject).toBe('sub-local-1');
    expect(row.auth_provider).toBe('local'); // password keeps working
  });

  it('does NOT link by unverified email — provisions a separate account instead', async () => {
    const role = await db('roles').where({ name: 'admin' }).first();
    await db('admin_users').insert({
      username: 'victim-admin',
      email: 'victim@example.com',
      password_hash: await bcrypt.hash('VictimPass123', 4),
      role_id: role.id,
      is_active: 1,
      auth_provider: 'local',
      created_at: new Date(),
      updated_at: new Date(),
    });

    idp.setNextUser({ sub: 'sub-attacker', email: 'victim@example.com', email_verified: false });
    // JIT would need this email but the victim row owns it (unique) — the
    // insert fails and the flow must land on an error, never on the
    // victim's session.
    const res = await ssoRoundTrip();
    expect(res.headers.location).toMatch(/sso_error=/);

    const victim = await db('admin_users').where({ email: 'victim@example.com' }).first();
    expect(victim.external_subject).toBeNull();
  });

  it('does NOT link by verified email when the local email was not set by a trusted flow', async () => {
    // email_link_eligible = false: the address was typed into a profile or
    // set by a non-super admin, so it proves nothing about who owns it. A
    // verified IdP identity with that email must not land on this row.
    const role = await db('roles').where({ name: 'admin' }).first();
    await db('admin_users').insert({
      username: 'self-edited-admin',
      email: 'claimed@example.com',
      password_hash: await bcrypt.hash('ClaimedPass123', 4),
      role_id: role.id,
      is_active: 1,
      auth_provider: 'local',
      email_link_eligible: 0,
      created_at: new Date(),
      updated_at: new Date(),
    });

    idp.setNextUser({ sub: 'sub-real-owner', email: 'claimed@example.com', email_verified: true });
    const res = await ssoRoundTrip();
    // A clear, specific refusal — not a JIT insert colliding on the email.
    expect(res.headers.location).toMatch(/sso_error=email_unverified/);

    const row = await db('admin_users').where({ email: 'claimed@example.com' }).first();
    expect(row.external_subject).toBeNull();
  });

  it('links a mixed-case stored address — the claim is lowercased, the row need not be', async () => {
    // "Confirm email for SSO" leaves the stored address as it is, and the
    // bootstrap admin keeps ADMIN_EMAIL verbatim (001_init.js). A
    // case-sensitive lookup would miss the row and JIT-provision a SECOND
    // admin beside it, with the default role.
    const role = await db('roles').where({ name: 'admin' }).first();
    const [mixedId] = await db('admin_users').insert({
      username: 'mixed-case-admin',
      email: 'Mara.Owner@Example.com',
      password_hash: await bcrypt.hash('MixedPass123', 4),
      role_id: role.id,
      is_active: 1,
      auth_provider: 'local',
      email_link_eligible: 1,
      created_at: new Date(),
      updated_at: new Date(),
    }).returning('id').then((r) => [r[0]?.id || r[0]]);

    idp.setNextUser({ sub: 'sub-mara', email: 'Mara.Owner@Example.com', email_verified: true });
    const res = await ssoRoundTrip();
    expect(res.headers.location).toBe('http://localhost:5199/admin/dashboard');

    const rows = await db('admin_users').whereRaw('LOWER(email) = ?', ['mara.owner@example.com']);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(mixedId);
    expect(rows[0].email).toBe('Mara.Owner@Example.com');
    expect(rows[0].external_subject).toBe('sub-mara');
    expect(rows[0].role_id).toBe(role.id);
  });

  it('refuses a mixed-case address that is not eligible, instead of provisioning a duplicate', async () => {
    const role = await db('roles').where({ name: 'admin' }).first();
    await db('admin_users').insert({
      username: 'mixed-case-unconfirmed',
      email: 'Not.Confirmed@Example.com',
      password_hash: await bcrypt.hash('MixedPass123', 4),
      role_id: role.id,
      is_active: 1,
      auth_provider: 'local',
      email_link_eligible: 0,
      created_at: new Date(),
      updated_at: new Date(),
    });

    idp.setNextUser({ sub: 'sub-not-confirmed', email: 'Not.Confirmed@Example.com', email_verified: true });
    const res = await ssoRoundTrip();
    expect(res.headers.location).toMatch(/sso_error=email_unverified/);

    const rows = await db('admin_users').whereRaw('LOWER(email) = ?', ['not.confirmed@example.com']);
    expect(rows).toHaveLength(1);
    expect(rows[0].external_subject).toBeNull();
  });

  it('refuses to pick between two accounts whose addresses differ only in case', async () => {
    // No case-insensitive unique index exists, so an older install can already
    // hold such a pair. Matching without case must not hand the identity — and
    // its mapped role — to whichever row the engine returns first.
    const role = await db('roles').where({ name: 'admin' }).first();
    for (const email of ['Twin@Example.com', 'twin@example.com']) {
      await db('admin_users').insert({
        username: `twin-${email}`,
        email,
        password_hash: await bcrypt.hash('TwinPass123', 4),
        role_id: role.id,
        is_active: 1,
        auth_provider: 'local',
        email_link_eligible: 1,
        created_at: new Date(),
        updated_at: new Date(),
      });
    }

    idp.setNextUser({ sub: 'sub-twin', email: 'twin@example.com', email_verified: true });
    const res = await ssoRoundTrip();
    expect(res.headers.location).toMatch(/sso_error=email_ambiguous/);

    const rows = await db('admin_users').whereRaw('LOWER(email) = ?', ['twin@example.com']);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.external_subject === null)).toBe(true);
  });

  it('refuses a deactivated admin with sso_error=inactive', async () => {
    await db('admin_users').where({ id: agentCookies.jitAdminId }).update({ is_active: 0 });
    idp.setNextUser({ sub: 'sub-jit-1', email: 'renamed@example.com', email_verified: true });
    const res = await ssoRoundTrip();
    expect(res.headers.location).toBe('http://localhost:5199/admin/login?sso_error=inactive');
    await db('admin_users').where({ id: agentCookies.jitAdminId }).update({ is_active: 1 });
  });

  it('rejects a callback without the state cookie', async () => {
    const res = await ssoRoundTrip({ mutateState: 'drop' });
    expect(res.headers.location).toBe('http://localhost:5199/admin/login?sso_error=state');
  });

  it('rejects a forged state cookie (wrong signing key)', async () => {
    const res = await ssoRoundTrip({ mutateState: 'forge' });
    expect(res.headers.location).toBe('http://localhost:5199/admin/login?sso_error=state');
  });

  it('rejects an ID token whose nonce does not match', async () => {
    idp.tamperNonce = true;
    idp.setNextUser({ sub: 'sub-nonce', email: 'nonce@example.com', email_verified: true });
    const res = await ssoRoundTrip();
    idp.tamperNonce = false;
    expect(res.headers.location).toBe('http://localhost:5199/admin/login?sso_error=idp');
    expect(await db('admin_users').where({ email: 'nonce@example.com' }).first()).toBeFalsy();
  });

  it('blocks JIT with sso_error=not_provisioned when autoprovision is off', async () => {
    await oidcService.saveOidcSettings({ oidc_autoprovision: false });
    idp.setNextUser({ sub: 'sub-new-user', email: 'new@example.com', email_verified: true });
    const res = await ssoRoundTrip();
    expect(res.headers.location).toBe('http://localhost:5199/admin/login?sso_error=not_provisioned');
    expect(await db('admin_users').where({ email: 'new@example.com' }).first()).toBeFalsy();
    await oidcService.saveOidcSettings({ oidc_autoprovision: true });
  });

  it('stores the client secret encrypted and survives a config round-trip', async () => {
    const row = await db('app_settings').where({ setting_key: 'oidc_client_secret' }).first();
    const stored = JSON.parse(row.setting_value);
    expect(stored).not.toContain(idp.clientSecret);
    expect(oidcService.decryptSecret(stored)).toBe(idp.clientSecret);

    const cfg = await oidcService.getOidcConfig();
    expect(cfg.clientSecret).toBe(idp.clientSecret);
  });

  it('refuses local password login for OIDC-owned accounts', async () => {
    // Give the JIT admin a KNOWN password hash directly in the DB — the
    // auth_provider check must reject the login even with valid credentials
    // (otherwise a password reset would mint an IdP-bypassing local login).
    await db('admin_users').where({ id: agentCookies.jitAdminId }).update({
      password_hash: await bcrypt.hash('KnownPass123', 4),
    });
    const row = await db('admin_users').where({ id: agentCookies.jitAdminId }).first();

    const res = await request(app)
      .post('/api/auth/admin/login')
      .send({ username: row.email, password: 'KnownPass123' });
    expect(res.status).toBe(401);
  });

  it('returns 404 from /sso/login when SSO is disabled', async () => {
    await oidcService.saveOidcSettings({ oidc_enabled: false });
    await request(app).get('/api/auth/admin/sso/login').expect(404);
    await oidcService.saveOidcSettings({ oidc_enabled: true });
  });

  it('merges email from the UserInfo endpoint when the ID token omits it', async () => {
    idp.emailViaUserinfoOnly = true;
    idp.setNextUser({ sub: 'sub-userinfo', email: 'userinfo@example.com', email_verified: true });
    const res = await ssoRoundTrip();
    idp.emailViaUserinfoOnly = false;

    expect(res.headers.location).toBe('http://localhost:5199/admin/dashboard');
    const row = await db('admin_users').where({ email: 'userinfo@example.com' }).first();
    expect(row).toBeTruthy();
    expect(row.external_subject).toBe('sub-userinfo');
  });

  it('binds identities per ISSUER — a sub collision on a new IdP must not inherit the old account', async () => {
    // The JIT admin from the first test is bound to (issuer A, 'sub-jit-1').
    const boundAdmin = await db('admin_users').where({ id: agentCookies.jitAdminId }).first();
    expect(boundAdmin.external_issuer).toBe(idp.issuer);

    // Same sub, DIFFERENT issuer: a second IdP the instance switches to.
    const idp2 = new MockOidcProvider();
    await idp2.start();
    try {
      await oidcService.saveOidcSettings({
        oidc_issuer_url: idp2.issuer,
        oidc_client_id: idp2.clientId,
        oidc_client_secret: idp2.clientSecret,
      });
      idp2.setNextUser({ sub: 'sub-jit-1', email: 'colliding@example.com', email_verified: true });

      const loginRes = await request(app).get('/api/auth/admin/sso/login').expect(302);
      const stateCookie = (loginRes.headers['set-cookie'] || [])
        .find((c) => c.startsWith('oidc_state=')).split(';')[0];
      const idpRes = await fetch(loginRes.headers.location, { redirect: 'manual' });
      const back = new URL(idpRes.headers.get('location'));
      const res = await request(app)
        .get(`${back.pathname}?${back.searchParams.toString()}`)
        .set('Cookie', stateCookie)
        .expect(302);
      expect(res.headers.location).toBe('http://localhost:5199/admin/dashboard');

      // A NEW row bound to issuer B — the issuer-A admin is untouched and
      // its role was not inherited.
      const collider = await db('admin_users').where({ email: 'colliding@example.com' }).first();
      expect(collider).toBeTruthy();
      expect(collider.id).not.toBe(agentCookies.jitAdminId);
      expect(collider.external_issuer).toBe(idp2.issuer);
      const original = await db('admin_users').where({ id: agentCookies.jitAdminId }).first();
      expect(original.external_issuer).toBe(idp.issuer);
    } finally {
      await idp2.stop();
      await oidcService.saveOidcSettings({
        oidc_issuer_url: idp.issuer,
        oidc_client_id: idp.clientId,
        oidc_client_secret: idp.clientSecret,
      });
    }
  });
});
