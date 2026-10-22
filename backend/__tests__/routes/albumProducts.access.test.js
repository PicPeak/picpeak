const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.NODE_ENV = 'test';
process.env.DATABASE_CLIENT = 'sqlite3';
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'album-access-')), 'db.sqlite');
process.env.JWT_SECRET = 'album-route-tests-long-secret-not-production';
const request = require('supertest');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const express = require('express');
const { bootCrmDb, seedMinimal, mintAdminToken, assignAdminRole } = require('../integration/helpers/crmDb');
const uuid = () => require('crypto').randomUUID();
const idOf = (rows) => rows[0].id ?? rows[0];

describe('album products native access boundary', () => {
  let db; let cleanup; let app; let owner; let outsider; let gallery; let other; let offer; let image; let product;
  const gtoken = (id, claims = {}) => jwt.sign({ type: 'gallery', eventId: id, accessLevel: 'client', jti: uuid(), ...claims }, process.env.JWT_SECRET, { issuer: 'picpeak-auth', expiresIn: '1h' });
  const get = (url, token) => request(app).get(url).set('Authorization', `Bearer ${token}`);
  const endpoint = (id = gallery) => `/api/admin/album-products/events/${id}`;
  const cendpoint = '/api/gallery/test-album/album-products';
  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb()); ({ adminId: owner } = await seedMinimal(db));
    await assignAdminRole(db, owner, 'admin');
    outsider = idOf(await db('admin_users').insert({ username: 'outsider', email: 'other@example.com', password_hash: 'x', must_change_password: false }).returning('id'));
    await assignAdminRole(db, outsider, 'admin');
    // A gallery-scoped role without the cross-gallery grants.
    const roleId = idOf(await db('roles').insert({ name: 'album_editor_own', display_name: 'Album editor' }).returning('id'));
    for (const p of await db('permissions').whereIn('name', ['products.view', 'products.manage', 'products.configure', 'events.view', 'photos.view']))
      await db('role_permissions').insert({ role_id: roleId, permission_id: p.id });
    await db('admin_users').whereIn('id', [owner, outsider]).update({ role_id: roleId });
    const addEvent = async (slug, adminId) => idOf(await db('events').insert({ slug, event_name: slug, event_type: 'wedding', event_date: '2026-10-01',
      host_email: 'client@example.com', admin_email: 'studio@example.com', password_hash: 'x', share_link: `/gallery/${slug}/share`, share_token: uuid(),
      is_active: true, is_archived: false, is_draft: false, require_password: true, created_by: adminId, expires_at: new Date(Date.now() + 864e5).toISOString() }).returning('id'));
    gallery = await addEvent('test-album', owner); other = await addEvent('other-album', outsider);
    await db('feature_flags').where({ key: 'albumProducts' }).update({ value: true });
    require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
    require('../../src/middleware/permissions').clearPermissionCache();
    const service = require('../../src/services/albumProducts/service').application();
    image = await service.uploadImage(await sharp({ create: { width: 24, height: 20, channels: 3, background: '#436950' } }).png().toBuffer(), owner);
    product = { id: uuid(), name: 'Synthetic album', description: '', active: true,
      models: [{ id: uuid(), name: 'Square', active: true, imageId: image.id }],
      colours: [{ id: uuid(), name: 'Natural', active: true, imageId: image.id, modelIds: [] }] };
    await service.saveCatalogue({ revision: 0, products: [product] }); offer = await service.assign(gallery, product.id);
    app = express(); app.use(express.json()); app.use(require('cookie-parser')());
    app.use('/api/admin/album-products', require('../../src/routes/adminAlbumProducts'));
    app.use('/api/gallery', require('../../src/routes/gallery/albumProducts'));
    app.use((err, req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message }));
  }, 180000);
  afterAll(async () => { if (cleanup) await cleanup(); });
  test('owner can read; an equally privileged other photographer cannot', async () => {
    expect((await get(endpoint(), mintAdminToken(owner))).status).toBe(200);
    expect((await get(endpoint(), mintAdminToken(outsider))).status).toBe(403);
    expect((await get(`${endpoint(other)}/offers/${offer.id}/history`, mintAdminToken(outsider))).status).toBe(404);
  });
  test('anonymous, guest and slideshow cannot read products or private option images', async () => {
    expect((await request(app).get(cendpoint)).status).toBe(401);
    for (const accessLevel of ['guest', 'slideshow']) {
      const token = gtoken(gallery, { accessLevel });
      expect((await get(cendpoint, token)).status).toBe(403);
      expect((await get(`${cendpoint}/images/${image.id}`, token)).status).toBe(403);
    }
    expect((await get(cendpoint, gtoken(gallery))).status).toBe(200);
    expect((await get(cendpoint, gtoken(other))).status).toBe(403);
    expect((await get(`/api/gallery/other-album/album-products/images/${image.id}`, gtoken(other))).status).toBe(404);
  });
  test('expiry, archiving and credential rotation revoke existing client authority', async () => {
    const token = gtoken(gallery);
    for (const change of [{ expires_at: new Date(Date.now() - 864e5).toISOString() }, { is_archived: true }, { is_active: false }]) {
      await db('events').where({ id: gallery }).update(change);
      expect((await get(cendpoint, token)).status).not.toBe(200);
      await db('events').where({ id: gallery }).update({ is_archived: false, is_active: true, expires_at: new Date(Date.now() + 864e5).toISOString() });
    }
    await require('../../src/utils/tokenRevocation').revokeToken(token);
    expect((await get(cendpoint, token)).status).not.toBe(200);
  });
  test('disabled flag denies API even to an owner and an authenticated client', async () => {
    await db('feature_flags').where({ key: 'albumProducts' }).update({ value: false });
    require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
    expect((await get(endpoint(), mintAdminToken(owner))).status).toBe(403);
    expect((await get(cendpoint, gtoken(gallery))).status).toBe(403);
  });
});
