/**
 * SSO settings must not hand out more power than the editor holds.
 *
 * PUT /api/admin/settings/sso needs settings.security, which a role below
 * super_admin can hold. The default role and the role mappings decide which
 * role an SSO login lands in, so they are grants: only a Super Admin may
 * target super_admin, and anyone else only roles whose permissions they
 * already hold. Changing the issuer or client also needs the client secret
 * entered again, so a stored secret is never sent to another provider.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-sso-grant-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'sso-grant-test-secret';

const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { bootCrmDb } = require('../integration/helpers/crmDb');

describe('SSO settings: role targets and client secret', () => {
  let db;
  let cleanup;
  let app;
  let oidcService;
  let superToken;
  let managerToken;

  const insertId = async (table, row) => {
    const inserted = await db(table).insert(row).returning('id');
    return inserted[0]?.id ?? inserted[0];
  };

  const createRole = async (name, permissionNames) => {
    const roleId = await insertId('roles', {
      name, display_name: name, description: 'test role', is_system: false, priority: 10,
    });
    const permissions = await db('permissions').whereIn('name', permissionNames).select('id');
    for (const permission of permissions) {
      await db('role_permissions').insert({ role_id: roleId, permission_id: permission.id });
    }
  };

  const tokenFor = async (username, roleName) => {
    const role = await db('roles').where({ name: roleName }).first();
    const id = await insertId('admin_users', {
      username,
      email: `${username}@example.com`,
      password_hash: await bcrypt.hash('Passw0rd!', 4),
      role_id: role.id,
      is_active: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    return jwt.sign(
      { id, username, type: 'admin', role: roleName, loginTime: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' },
    );
  };

  const putSso = (token, body) => request(app)
    .put('/api/admin/settings/sso')
    .set('Authorization', `Bearer ${token}`)
    .send({ oidc_enabled: false, ...body });

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await createRole('sso-manager', ['settings.security', 'settings.view']);
    await createRole('sso-landing', ['settings.view']);
    superToken = await tokenFor('root-admin', 'super_admin');
    managerToken = await tokenFor('sso-manager', 'sso-manager');

    oidcService = require('../../src/services/oidcService');
    app = express();
    app.use(express.json());
    app.use('/api/admin/settings', require('../../src/routes/adminSettings'));
  }, 120000);

  beforeEach(async () => {
    await oidcService.saveOidcSettings({
      oidc_enabled: false, oidc_default_role: 'viewer', oidc_role_mappings: {}, oidc_button_label: '',
    });
  });

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('refuses a non-Super Admin setting the default SSO role to super_admin', async () => {
    const res = await putSso(managerToken, { oidc_default_role: 'super_admin' });

    expect(res.status).toBe(403);
    expect((await oidcService.getOidcConfig()).defaultRole).toBe('viewer');
  });

  it('refuses a non-Super Admin mapping an IdP role to super_admin', async () => {
    const res = await putSso(managerToken, { oidc_role_mappings: { 'idp-owners': 'super_admin' } });

    expect(res.status).toBe(403);
    expect((await oidcService.getOidcConfig()).roleMappings).toEqual({});
  });

  it('refuses a mapping to a role holding permissions the editor lacks', async () => {
    const res = await putSso(managerToken, { oidc_role_mappings: { 'idp-staff': 'admin' } });

    expect(res.status).toBe(403);
    expect((await oidcService.getOidcConfig()).roleMappings).toEqual({});
  });

  it('accepts a mapping to a role whose permissions the editor holds', async () => {
    const res = await putSso(managerToken, { oidc_role_mappings: { 'idp-staff': 'sso-landing' } });

    expect(res.status).toBe(200);
    expect((await oidcService.getOidcConfig()).roleMappings).toEqual({ 'idp-staff': 'sso-landing' });
  });

  it('lets a Super Admin map to super_admin, and a non-Super Admin resave that mapping unchanged', async () => {
    expect((await putSso(superToken, { oidc_role_mappings: { 'idp-owners': 'super_admin' } })).status).toBe(200);

    const res = await putSso(managerToken, {
      oidc_role_mappings: { 'idp-owners': 'super_admin' },
      oidc_button_label: 'Company login',
    });

    expect(res.status).toBe(200);
    const config = await oidcService.getOidcConfig();
    expect(config.buttonLabel).toBe('Company login');
    expect(config.roleMappings).toEqual({ 'idp-owners': 'super_admin' });
  });

  it('asks for the client secret again when the issuer or client ID changes', async () => {
    expect((await putSso(superToken, {
      oidc_issuer_url: 'https://idp-one.example.com',
      oidc_client_id: 'picpeak',
      oidc_client_secret: 'first-secret',
    })).status).toBe(200);

    const newIssuer = await putSso(superToken, { oidc_issuer_url: 'https://idp-two.example.com' });
    const newClient = await putSso(superToken, { oidc_client_id: 'someone-else' });

    expect(newIssuer.status).toBe(400);
    expect(newClient.status).toBe(400);
    let config = await oidcService.getOidcConfig();
    expect(config.issuerUrl).toBe('https://idp-one.example.com');
    expect(config.clientId).toBe('picpeak');

    const withSecret = await putSso(superToken, {
      oidc_issuer_url: 'https://idp-two.example.com',
      oidc_client_secret: 'second-secret',
    });
    expect(withSecret.status).toBe(200);
    config = await oidcService.getOidcConfig();
    expect(config.issuerUrl).toBe('https://idp-two.example.com');
    expect(config.clientSecret).toBe('second-secret');
  });
});
