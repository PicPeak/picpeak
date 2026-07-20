/**
 * OIDC role mapping + login policy integration tests (#798, phase 2).
 *
 * Same harness as oidcSso.test.js: supertest over the real routes, mock
 * in-process IdP with genuine RS256/PKCE validation, fresh-SQLite DB. Pins:
 *
 *   - JIT provisioning takes the MAPPED role from a nested dot-path claim
 *     (Keycloak's realm_access.roles), not the static default
 *   - roles are re-evaluated on every SSO login (upgrade AND downgrade)
 *   - several mapped roles → the highest-priority one wins
 *   - non-strict: unmapped login keeps the current role / default at JIT
 *   - strict (require_mapped_role): unmapped login → sso_error=no_role
 *   - the last active super_admin is never demoted by mapping
 *   - space-separated string claim values work (flat `roles` claim)
 *   - disable_local_login: password login → 403; OIDC_BREAK_GLASS=true
 *     re-opens it; flag is inert while SSO is disabled
 *   - PUT /sso validation: unknown mapping target and
 *     disable-local-login-without-SSO are rejected
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { bootCrmDb } = require('./helpers/crmDb');
const { MockOidcProvider } = require('./helpers/mockOidcProvider');

describe('OIDC role mapping + login policy (#798 phase 2)', () => {
  let db;
  let cleanup;
  let app;
  let idp;
  let oidcService;
  let superAdminToken;

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'oidc-test-secret';
    process.env.FRONTEND_URL = 'http://localhost:5199';
    delete process.env.OIDC_BREAK_GLASS;
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
      oidc_role_mapping_enabled: true,
      oidc_roles_claim: 'realm_access.roles',
      oidc_role_mappings: {
        'pp-super': 'super_admin',
        'pp-admins': 'admin',
        'pp-view': 'viewer',
      },
    });

    const authRouter = require('../../src/routes/auth');
    const adminSettingsRouter = require('../../src/routes/adminSettings');
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/auth', authRouter);
    app.use('/api/admin/settings', adminSettingsRouter);

    // A real super_admin row + token for the settings-validation tests.
    const superRole = await db('roles').where({ name: 'super_admin' }).first();
    const [rootId] = await db('admin_users').insert({
      username: 'root-admin',
      email: 'root@example.com',
      password_hash: await bcrypt.hash('RootPass123', 4),
      role_id: superRole.id,
      is_active: 1,
      auth_provider: 'local',
      created_at: new Date(),
      updated_at: new Date(),
    }).returning('id').then((r) => [r[0]?.id || r[0]]);
    superAdminToken = jwt.sign(
      { id: rootId, username: 'root-admin', type: 'admin', role: 'super_admin', loginTime: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' }
    );
  }, 120000);

  afterAll(async () => {
    delete process.env.OIDC_BREAK_GLASS;
    if (idp) await idp.stop();
    if (cleanup) await cleanup();
  });

  /** Drive login → IdP → callback like a browser; returns the callback response. */
  async function ssoRoundTrip() {
    const loginRes = await request(app).get('/api/auth/admin/sso/login').expect(302);
    const stateCookie = (loginRes.headers['set-cookie'] || [])
      .find((c) => c.startsWith('oidc_state=')).split(';')[0];
    const idpRes = await fetch(loginRes.headers.location, { redirect: 'manual' });
    expect(idpRes.status).toBe(302);
    const back = new URL(idpRes.headers.get('location'));
    return request(app)
      .get(`${back.pathname}?${back.searchParams.toString()}`)
      .set('Cookie', stateCookie)
      .expect(302);
  }

  async function roleOf(email) {
    const row = await db('admin_users').where({ email }).first();
    const role = await db('roles').where({ id: row.role_id }).first();
    return role.name;
  }

  it('JIT-provisions with the role mapped from the nested dot-path claim', async () => {
    idp.setNextUser({
      sub: 'sub-map-1',
      email: 'mapped@example.com',
      email_verified: true,
      realm_access: { roles: ['irrelevant', 'pp-admins'] },
    });
    const res = await ssoRoundTrip();
    expect(res.headers.location).toBe('http://localhost:5199/admin/dashboard');
    expect(await roleOf('mapped@example.com')).toBe('admin');
  });

  it('re-evaluates the role on every login — downgrade lands', async () => {
    idp.setNextUser({
      sub: 'sub-map-1',
      email: 'mapped@example.com',
      email_verified: true,
      realm_access: { roles: ['pp-view'] },
    });
    const res = await ssoRoundTrip();
    expect(res.headers.location).toBe('http://localhost:5199/admin/dashboard');
    expect(await roleOf('mapped@example.com')).toBe('viewer');
  });

  it('re-evaluates the role on every login — upgrade lands and the session JWT carries it', async () => {
    idp.setNextUser({
      sub: 'sub-map-1',
      email: 'mapped@example.com',
      email_verified: true,
      realm_access: { roles: ['pp-admins'] },
    });
    const res = await ssoRoundTrip();
    expect(await roleOf('mapped@example.com')).toBe('admin');

    // The freshly-minted session token must already carry the NEW role —
    // the sync happens before session establishment.
    const adminCookie = (res.headers['set-cookie'] || []).find((c) => c.startsWith('admin_token='));
    const token = decodeURIComponent(adminCookie.split(';')[0].replace('admin_token=', ''));
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'picpeak-auth' });
    expect(decoded.role).toBe('admin');
  });

  it('picks the highest-priority role when several IdP values map', async () => {
    idp.setNextUser({
      sub: 'sub-multi',
      email: 'multi@example.com',
      email_verified: true,
      realm_access: { roles: ['pp-view', 'pp-admins'] },
    });
    await ssoRoundTrip();
    expect(await roleOf('multi@example.com')).toBe('admin');
  });

  it('non-strict: an unmapped login keeps the current role / gets the default at JIT', async () => {
    // Existing admin keeps its role.
    idp.setNextUser({
      sub: 'sub-map-1',
      email: 'mapped@example.com',
      email_verified: true,
      realm_access: { roles: ['nothing-mapped'] },
    });
    let res = await ssoRoundTrip();
    expect(res.headers.location).toBe('http://localhost:5199/admin/dashboard');
    expect(await roleOf('mapped@example.com')).toBe('admin');

    // JIT falls back to the configured default role.
    idp.setNextUser({
      sub: 'sub-unmapped-jit',
      email: 'unmapped@example.com',
      email_verified: true,
      realm_access: { roles: ['nothing-mapped'] },
    });
    res = await ssoRoundTrip();
    expect(res.headers.location).toBe('http://localhost:5199/admin/dashboard');
    expect(await roleOf('unmapped@example.com')).toBe('viewer');
  });

  it('strict mode refuses unmapped logins with sso_error=no_role and no session', async () => {
    await oidcService.saveOidcSettings({ oidc_require_mapped_role: true });
    idp.setNextUser({
      sub: 'sub-map-1',
      email: 'mapped@example.com',
      email_verified: true,
      realm_access: { roles: ['nothing-mapped'] },
    });
    const res = await ssoRoundTrip();
    await oidcService.saveOidcSettings({ oidc_require_mapped_role: false });

    expect(res.headers.location).toBe('http://localhost:5199/admin/login?sso_error=no_role');
    expect((res.headers['set-cookie'] || []).find((c) => c.startsWith('admin_token='))).toBeFalsy();
    // Role untouched by the refused attempt.
    expect(await roleOf('mapped@example.com')).toBe('admin');
  });

  it('never demotes the last active super_admin', async () => {
    // Make the SSO admin the ONLY active super_admin.
    const superRole = await db('roles').where({ name: 'super_admin' }).first();
    const ssoAdmin = await db('admin_users').where({ email: 'mapped@example.com' }).first();
    await db('admin_users').where({ role_id: superRole.id }).update({ is_active: 0 });
    await db('admin_users').where({ id: ssoAdmin.id }).update({ role_id: superRole.id, is_active: 1 });

    idp.setNextUser({
      sub: 'sub-map-1',
      email: 'mapped@example.com',
      email_verified: true,
      realm_access: { roles: ['pp-view'] },
    });
    const res = await ssoRoundTrip();
    expect(res.headers.location).toBe('http://localhost:5199/admin/dashboard');
    // Still super_admin — the demotion was refused, the login was not.
    expect(await roleOf('mapped@example.com')).toBe('super_admin');

    // Restore: root admin back to active super_admin, SSO admin back to admin.
    const adminRole = await db('roles').where({ name: 'admin' }).first();
    await db('admin_users').where({ email: 'root@example.com' }).update({ is_active: 1 });
    await db('admin_users').where({ id: ssoAdmin.id }).update({ role_id: adminRole.id });

    // With ANOTHER active super_admin present the same downgrade goes through.
    idp.setNextUser({
      sub: 'sub-map-1',
      email: 'mapped@example.com',
      email_verified: true,
      realm_access: { roles: ['pp-view'] },
    });
    await db('admin_users').where({ id: ssoAdmin.id }).update({ role_id: superRole.id });
    await ssoRoundTrip();
    expect(await roleOf('mapped@example.com')).toBe('viewer');
  });

  it('never demotes the last LOCAL-password super_admin even when an OIDC-owned super exists', async () => {
    const superRole = await db('roles').where({ name: 'super_admin' }).first();
    const viewerRole = await db('roles').where({ name: 'viewer' }).first();

    // A local-password super admin, SSO-linked via verified email so role
    // sync applies to it.
    const [localId] = await db('admin_users').insert({
      username: 'local-super',
      email: 'local-super@example.com',
      password_hash: await bcrypt.hash('LocalSuper123', 4),
      role_id: superRole.id,
      is_active: 1,
      auth_provider: 'local',
      created_at: new Date(),
      updated_at: new Date(),
    }).returning('id').then((r) => [r[0]?.id || r[0]]);

    // The only OTHER active super is OIDC-owned (root goes inactive) — the
    // plain last-super guard would allow the demotion, the break-glass
    // guard must not.
    const ssoAdmin = await db('admin_users').where({ email: 'mapped@example.com' }).first();
    await db('admin_users').where({ id: ssoAdmin.id }).update({ role_id: superRole.id });
    await db('admin_users').where({ email: 'root@example.com' }).update({ is_active: 0 });

    idp.setNextUser({
      sub: 'sub-local-super',
      email: 'local-super@example.com',
      email_verified: true,
      realm_access: { roles: ['pp-view'] },
    });
    const res = await ssoRoundTrip();

    const row = await db('admin_users').where({ id: localId }).first();
    // Restore the fixture state before asserting.
    await db('admin_users').where({ email: 'root@example.com' }).update({ is_active: 1 });
    await db('admin_users').where({ id: ssoAdmin.id }).update({ role_id: viewerRole.id });
    await db('admin_users').where({ id: localId }).update({ is_active: 0 });

    expect(res.headers.location).toBe('http://localhost:5199/admin/dashboard');
    expect(row.role_id).toBe(superRole.id); // kept — it is the break-glass account
  });

  it('treats prototype-property IdP values (constructor/toString) as unmapped, not as an error', async () => {
    idp.setNextUser({
      sub: 'sub-proto',
      email: 'proto@example.com',
      email_verified: true,
      realm_access: { roles: ['constructor', 'toString', '__proto__'] },
    });
    const res = await ssoRoundTrip();
    // Non-strict: unmapped → JIT with the default role, login succeeds.
    expect(res.headers.location).toBe('http://localhost:5199/admin/dashboard');
    expect(await roleOf('proto@example.com')).toBe('viewer');
  });

  it('accepts a space-separated string value on a flat claim', async () => {
    await oidcService.saveOidcSettings({ oidc_roles_claim: 'roles' });
    idp.setNextUser({
      sub: 'sub-flat',
      email: 'flat@example.com',
      email_verified: true,
      roles: 'other pp-admins',
    });
    const res = await ssoRoundTrip();
    await oidcService.saveOidcSettings({ oidc_roles_claim: 'realm_access.roles' });

    expect(res.headers.location).toBe('http://localhost:5199/admin/dashboard');
    expect(await roleOf('flat@example.com')).toBe('admin');
  });

  it('refuses local password login while disable_local_login is effective', async () => {
    await oidcService.saveOidcSettings({ oidc_disable_local_login: true });
    const res = await request(app)
      .post('/api/auth/admin/login')
      .send({ username: 'root@example.com', password: 'RootPass123' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('LOCAL_LOGIN_DISABLED');
  });

  it('OIDC_BREAK_GLASS=true re-opens local login despite the policy', async () => {
    process.env.OIDC_BREAK_GLASS = 'true';
    const res = await request(app)
      .post('/api/auth/admin/login')
      .send({ username: 'root@example.com', password: 'RootPass123' });
    delete process.env.OIDC_BREAK_GLASS;
    expect(res.status).toBe(200);
    expect(res.body.user).toBeTruthy();
  });

  it('the stored flag is inert while SSO is disabled', async () => {
    // Simulate a torn-down SSO config with the stale flag still set — the
    // runtime check must ignore it (no lockout).
    await db('app_settings').where({ setting_key: 'oidc_enabled' })
      .update({ setting_value: JSON.stringify(false) });
    expect(await oidcService.isLocalLoginDisabled()).toBe(false);
    await db('app_settings').where({ setting_key: 'oidc_enabled' })
      .update({ setting_value: JSON.stringify(true) });
    expect(await oidcService.isLocalLoginDisabled()).toBe(true);
    await oidcService.saveOidcSettings({ oidc_disable_local_login: false });
  });

  it('the policy disarms itself when no active local-password super admin remains', async () => {
    await oidcService.saveOidcSettings({ oidc_disable_local_login: true });
    expect(await oidcService.isLocalLoginDisabled()).toBe(true);
    // The break-glass account disappears (e.g. manual demotion/deactivation
    // while the policy is on) → local login must re-open by itself.
    await db('admin_users').where({ email: 'root@example.com' }).update({ auth_provider: 'oidc' });
    expect(await oidcService.isLocalLoginDisabled()).toBe(false);
    await db('admin_users').where({ email: 'root@example.com' }).update({ auth_provider: 'local' });
    await oidcService.saveOidcSettings({ oidc_disable_local_login: false });
  });

  it('PUT /sso rejects a mapping onto an unknown role', async () => {
    const res = await request(app)
      .put('/api/admin/settings/sso')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ oidc_role_mappings: { 'pp-admins': 'does_not_exist' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does_not_exist/);
    // Stored mapping unchanged.
    const cfg = await oidcService.getOidcConfig();
    expect(cfg.roleMappings['pp-admins']).toBe('admin');
  });

  it('PUT /sso rejects disabling local login while SSO is (being turned) off', async () => {
    const res = await request(app)
      .put('/api/admin/settings/sso')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ oidc_enabled: false, oidc_disable_local_login: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/while SSO is enabled/);
  });

  it('PUT /sso refuses SSO-only mode without an active local-password super admin', async () => {
    // Make every active super_admin OIDC-owned — break-glass would then
    // re-open a password route that no account can use.
    const superRole = await db('roles').where({ name: 'super_admin' }).first();
    await db('admin_users').where({ role_id: superRole.id }).update({ auth_provider: 'oidc' });
    const denied = await request(app)
      .put('/api/admin/settings/sso')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ oidc_disable_local_login: true });
    // Restore the local break-glass account, then the same request passes.
    await db('admin_users').where({ email: 'root@example.com' }).update({ auth_provider: 'local' });
    expect(denied.status).toBe(400);
    expect(denied.body.error).toMatch(/break-glass/);

    const allowed = await request(app)
      .put('/api/admin/settings/sso')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ oidc_disable_local_login: true });
    expect(allowed.status).toBe(200);
    await oidcService.saveOidcSettings({ oidc_disable_local_login: false });
  });

  it('GET /sso returns the phase-2 fields', async () => {
    const res = await request(app)
      .get('/api/admin/settings/sso')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.oidc_role_mapping_enabled).toBe(true);
    expect(res.body.oidc_roles_claim).toBe('realm_access.roles');
    expect(res.body.oidc_role_mappings).toEqual({
      'pp-super': 'super_admin',
      'pp-admins': 'admin',
      'pp-view': 'viewer',
    });
    expect(res.body.oidc_require_mapped_role).toBe(false);
    expect(res.body.oidc_disable_local_login).toBe(false);
  });
});
