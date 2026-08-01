/**
 * Authorization / ownership gaps (GHSA permission cluster):
 *  - jm7j: API-token list must scope to the caller (non-super sees only own)
 *  - gprq: API-token revoke must be owner-or-super_admin
 *  - 3rqx: event update must not mass-assign identity/secret columns
 *  - j2f4: category hero must belong to that category
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-authz-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'authz-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-authz-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken,
} = require('../integration/helpers/crmDb');

describe('authorization / ownership gaps', () => {
  let db; let cleanup; let app;
  let superId; let superTok; let adminId; let adminTok;

  const grantPermissionToRole = async (roleName, permName) => {
    const role = await db('roles').where({ name: roleName }).first();
    const perm = await db('permissions').where({ name: permName }).first();
    const exists = await db('role_permissions')
      .where({ role_id: role.id, permission_id: perm.id }).first();
    if (!exists) {
      await db('role_permissions').insert({ role_id: role.id, permission_id: perm.id });
    }
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId: superId } = await seedMinimal(db));
    await assignAdminRole(db, superId, 'super_admin');
    superTok = mintAdminToken(superId);

    const pass = await bcrypt.hash('x', 4);
    const ins = await db('admin_users').insert({
      username: 'plain-admin', email: 'plain@example.com',
      password_hash: pass, must_change_password: false, created_at: new Date(),
    }).returning('id');
    adminId = ins[0]?.id ?? ins[0];
    await assignAdminRole(db, adminId, 'admin');
    // Grant settings.edit to the admin role BEFORE any request populates the
    // 60s permission cache, so the revoke test exercises the ownership check
    // (404) rather than the missing-permission gate (403). This models a
    // custom role that carries settings.edit — the scenario GHSA-gprq needs.
    await grantPermissionToRole('admin', 'settings.edit');
    adminTok = mintAdminToken(adminId);

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/api-tokens', require('../../src/routes/adminApiTokens'));
    app.use('/api/admin/events', require('../../src/routes/adminEvents'));
    app.use('/api/admin/categories', require('../../src/routes/adminCategories'));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
      res.status(err.statusCode || err.status || 500).json({ error: err.message, code: err.code });
    });
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  const auth = (req, tok) => req.set('Authorization', `Bearer ${tok}`);

  describe('API tokens (jm7j / gprq)', () => {
    let superTokenId;

    beforeAll(async () => {
      const res = await auth(request(app).post('/api/admin/api-tokens'), superTok)
        .send({ name: 'super-token', scopes: ['read'] });
      expect(res.status).toBe(201);
      superTokenId = res.body.id;
    });

    it('non-super admin does not see another admin\'s tokens in the list', async () => {
      const res = await auth(request(app).get('/api/admin/api-tokens'), adminTok);
      expect(res.status).toBe(200);
      expect(res.body.find((t) => t.id === superTokenId)).toBeUndefined();
    });

    it('super_admin sees all tokens', async () => {
      const res = await auth(request(app).get('/api/admin/api-tokens'), superTok);
      expect(res.status).toBe(200);
      expect(res.body.find((t) => t.id === superTokenId)).toBeDefined();
    });

    it('a non-owner (with settings.edit) cannot revoke another admin\'s token', async () => {
      const res = await auth(request(app).delete(`/api/admin/api-tokens/${superTokenId}`), adminTok);
      expect(res.status).toBe(404);
      const row = await db('api_tokens').where({ id: superTokenId }).first();
      expect(row.revoked_at).toBeFalsy();
    });

    it('the owner can revoke their own token', async () => {
      const res = await auth(request(app).delete(`/api/admin/api-tokens/${superTokenId}`), superTok);
      expect(res.status).toBe(200);
    });
  });

  describe('event update mass-assignment (3rqx)', () => {
    it('ignores identity/secret columns in the request body', async () => {
      const seedShareToken = 'orig-share-token';
      const ins = await db('events').insert({
        slug: 'authz-mass-assign', event_type: 'wedding', event_name: 'Before',
        event_date: '2026-08-01', host_email: 'h@example.com', admin_email: 'a@example.com',
        password_hash: 'orig-hash', share_link: '/gallery/authz/share', share_token: seedShareToken, expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
        is_active: 1, is_archived: 0, is_draft: 0, created_by: superId,
        created_at: new Date().toISOString(),
      }).returning('id');
      const eventId = ins[0]?.id ?? ins[0];

      const res = await auth(request(app).put(`/api/admin/events/${eventId}`), superTok).send({
        event_name: 'After',
        created_by: 99999,
        slug: 'hijacked-slug',
        share_token: 'hijacked-token',
        password_hash: 'hijacked-hash',
        is_archived: 1,
        archive_path: '/hijacked/archive/path',
        hero_logo_path: '/etc/passwd',
        is_draft: 1,
        project_id: 99999,
        // Case-variant keys — SQLite matches columns case-insensitively.
        Password_Hash: 'case-hijack-hash',
        Created_By: 88888,
      });
      expect(res.status).toBe(200);

      const row = await db('events').where({ id: eventId }).first();
      expect(row.event_name).toBe('After');        // legit field applied
      expect(row.created_by).toBe(superId);         // ownership untouched (+ case-variant)
      expect(row.slug).toBe('authz-mass-assign');   // routing identity untouched
      expect(row.share_token).toBe(seedShareToken); // secret untouched
      expect(row.password_hash).toBe('orig-hash');  // secret untouched (+ case-variant)
      expect(row.is_archived).toBeFalsy();          // archive lifecycle untouched
      expect(row.archive_path).toBeFalsy();         // forged archive path rejected
      expect(row.hero_logo_path).toBeFalsy();       // fs.unlink primitive blocked
      expect(row.is_draft).toBeFalsy();             // publish workflow not bypassed
      expect(row.project_id).toBeFalsy();           // server-managed relationship untouched
    });

    it('returns 200 (no-op) when the body contains only protected fields', async () => {
      const ins = await db('events').insert({
        slug: 'authz-empty-update', event_type: 'wedding', event_name: 'Keep',
        event_date: '2026-08-01', host_email: 'h@example.com', admin_email: 'a@example.com',
        password_hash: 'x', share_link: '/gallery/authz-empty/share', share_token: 'authz-empty-share',
        expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
        is_active: 1, is_archived: 0, is_draft: 0, created_by: superId,
        created_at: new Date().toISOString(),
      }).returning('id');
      const id = ins[0]?.id ?? ins[0];
      // Body reduces to {} after the denylist — must not 500 (Knex rejects
      // .update({})).
      const res = await auth(request(app).put(`/api/admin/events/${id}`), superTok)
        .send({ created_by: 1, slug: 'x', is_archived: 1 });
      expect(res.status).toBe(200);
      const row = await db('events').where({ id }).first();
      expect(row.event_name).toBe('Keep');
    });
  });

  describe('category hero cross-category (j2f4)', () => {
    it('rejects a hero photo that is not in the category', async () => {
      const evIns = await db('events').insert({
        slug: 'authz-cat', event_type: 'wedding', event_name: 'Cat Event',
        event_date: '2026-08-01', host_email: 'h@example.com', admin_email: 'a@example.com',
        password_hash: 'x', share_link: '/gallery/authz-cat/share', share_token: 'authz-cat-share', expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
        is_active: 1, is_archived: 0, is_draft: 0, created_by: superId,
        created_at: new Date().toISOString(),
      }).returning('id');
      const evId = evIns[0]?.id ?? evIns[0];

      const mkCat = async (name) => {
        const c = await db('photo_categories').insert({
          event_id: evId, name, slug: name.toLowerCase(), created_at: new Date().toISOString(),
        }).returning('id');
        return c[0]?.id ?? c[0];
      };
      const cat1 = await mkCat('Cat1');
      const cat2 = await mkCat('Cat2');

      const pIns = await db('photos').insert({
        event_id: evId, filename: 'p.jpg', path: 'authz-cat/p.jpg', type: 'individual',
        category_id: cat1, uploaded_at: new Date().toISOString(),
      }).returning('id');
      const photoInCat1 = pIns[0]?.id ?? pIns[0];

      // Pointing cat2's hero at a photo that lives in cat1 must be refused.
      const bad = await auth(request(app).put(`/api/admin/categories/${cat2}/hero`), superTok)
        .send({ hero_photo_id: photoInCat1 });
      expect(bad.status).toBe(404);

      // The photo's own category accepts it.
      const ok = await auth(request(app).put(`/api/admin/categories/${cat1}/hero`), superTok)
        .send({ hero_photo_id: photoInCat1 });
      expect(ok.status).toBe(200);
    });
  });
});
