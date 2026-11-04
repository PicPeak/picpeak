const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.NODE_ENV = 'test';
process.env.DATABASE_CLIENT = 'sqlite3';
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'album-image-size-')), 'db.sqlite');
process.env.JWT_SECRET = 'album-route-tests-long-secret-not-production';
const request = require('supertest');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const express = require('express');
const { bootCrmDb, seedMinimal, mintAdminToken, assignAdminRole } = require('../integration/helpers/crmDb');
const uuid = () => require('crypto').randomUUID();
const idOf = (rows) => rows[0].id ?? rows[0];

// Issue 2397: tiles and the detail view ask for a smaller rendition.
describe('album product image sizes', () => {
  let db; let cleanup; let app; let owner; let gallery; let other; let image; let unrelated;
  const gtoken = (id, claims = {}) => jwt.sign({ type: 'gallery', eventId: id, accessLevel: 'client', jti: uuid(), ...claims }, process.env.JWT_SECRET, { issuer: 'picpeak-auth', expiresIn: '1h' });
  const get = (url, token) => request(app).get(url).set('Authorization', `Bearer ${token}`).buffer(true)
    .parse((res, done) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => done(null, Buffer.concat(chunks))); });
  const url = (id = image.id, slug = 'size-album') => `/api/gallery/${slug}/album-products/images/${id}`;
  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb()); ({ adminId: owner } = await seedMinimal(db));
    await assignAdminRole(db, owner, 'super_admin');
    const addEvent = async (slug) => idOf(await db('events').insert({ slug, event_name: slug, event_type: 'wedding', event_date: '2026-10-01',
      host_email: 'client@example.com', admin_email: 'studio@example.com', password_hash: 'x', share_link: `/gallery/${slug}/share`, share_token: uuid(),
      is_active: true, is_archived: false, is_draft: false, require_password: true, created_by: owner, expires_at: new Date(Date.now() + 864e5).toISOString() }).returning('id'));
    gallery = await addEvent('size-album'); other = await addEvent('size-other');
    await db('feature_flags').where({ key: 'albumProducts' }).update({ value: true });
    require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
    require('../../src/middleware/permissions').clearPermissionCache();
    const service = require('../../src/services/albumProducts/service').application();
    // Noise does not compress, so the original is a realistically large PNG.
    const noise = require('crypto').randomBytes(1000 * 800 * 3);
    image = await service.uploadImage(await sharp(noise, { raw: { width: 1000, height: 800, channels: 3 } }).png().toBuffer(), owner);
    unrelated = await service.uploadImage(await sharp({ create: { width: 20, height: 20, channels: 3, background: '#000' } }).png().toBuffer(), owner);
    const product = { id: uuid(), name: 'Synthetic album', description: '', active: true,
      models: [{ id: uuid(), name: 'Square', active: true, imageId: image.id }],
      colours: [{ id: uuid(), name: 'Natural', active: true, imageId: image.id, modelIds: [] }] };
    await service.saveCatalogue({ revision: 0, products: [product] }); await service.assign(gallery, product.id);
    app = express(); app.use(express.json()); app.use(require('cookie-parser')());
    app.use('/api/admin/album-products', require('../../src/routes/adminAlbumProducts'));
    app.use('/api/gallery', require('../../src/routes/gallery/albumProducts'));
    app.use((err, req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message }));
  }, 180000);
  afterAll(async () => { if (cleanup) await cleanup(); });

  test('a valid size returns a smaller WebP within that size', async () => {
    const original = await get(url(), gtoken(gallery));
    expect(original.status).toBe(200);
    expect(original.headers['content-type']).toMatch(/image\/png/);
    for (const size of [480, 1200]) {
      const res = await get(`${url()}?size=${size}`, gtoken(gallery));
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/image\/webp/);
      expect(res.body.length).toBeLessThan(original.body.length);
      const meta = await sharp(res.body).metadata();
      expect(meta.format).toBe('webp');
      expect(Math.max(meta.width, meta.height)).toBe(Math.min(size, 1000));
    }
  });

  test('the browser may keep it privately and revalidates by the upload hash', async () => {
    const res = await get(`${url()}?size=480`, gtoken(gallery));
    expect(res.headers['cache-control']).toBe('private, max-age=604800, immutable');
    expect(res.headers.etag).toMatch(/-480"$/);
    const again = await request(app).get(`${url()}?size=480`).set('Authorization', `Bearer ${gtoken(gallery)}`)
      .set('If-None-Match', res.headers.etag);
    expect(again.status).toBe(304);
    expect((await get(`${url()}?size=1200`, gtoken(gallery))).headers.etag).not.toBe(res.headers.etag);
  });

  test.each(['100', '481', 'large', '0', '-480'])('size=%s is refused with 400', async (size) => {
    expect((await get(`${url()}?size=${size}`, gtoken(gallery))).status).toBe(400);
    expect((await get(`/api/admin/album-products/images/${image.id}?size=${size}`, mintAdminToken(owner))).status).toBe(400);
  });

  test('a size changes nothing about who may see the image', async () => {
    expect((await request(app).get(`${url()}?size=480`)).status).toBe(401);
    for (const accessLevel of ['guest', 'slideshow'])
      expect((await get(`${url()}?size=480`, gtoken(gallery, { accessLevel }))).status).toBe(403);
    expect((await get(`${url(image.id, 'size-other')}?size=480`, gtoken(other))).status).toBe(404);
    expect((await get(`${url(unrelated.id)}?size=480`, gtoken(gallery))).status).toBe(404);
    // A 304 needs the same access as the image itself.
    const etag = (await get(`${url()}?size=480`, gtoken(gallery))).headers.etag;
    expect((await request(app).get(`${url()}?size=480`).set('If-None-Match', etag)).status).toBe(401);
  });

  test('the admin route keeps serving the original and serves renditions', async () => {
    const original = await get(`/api/admin/album-products/images/${image.id}`, mintAdminToken(owner));
    expect(original.status).toBe(200);
    expect(original.headers['content-type']).toMatch(/image\/png/);
    const small = await get(`/api/admin/album-products/images/${image.id}?size=480`, mintAdminToken(owner));
    expect(small.status).toBe(200);
    expect(small.body.length).toBeLessThan(original.body.length);
  });

  describe('a failure', () => {
    const { Readable } = require('stream');
    const storage = () => require('../../src/services/storage').getStorage();
    const adminUrl = (id, size) => `/api/admin/album-products/images/${id}${size ? `?size=${size}` : ''}`;
    const fresh = async () => require('../../src/services/albumProducts/service').application()
      .uploadImage(await sharp({ create: { width: 60, height: 40, channels: 3, background: '#345' } }).png().toBuffer(), owner);
    afterEach(() => jest.restoreAllMocks());

    test('is not kept by the browser', async () => {
      const img = await fresh();
      jest.spyOn(storage(), 'get').mockRejectedValue(new Error('storage is down'));
      for (const size of [null, '480']) {
        const res = await get(adminUrl(img.id, size), mintAdminToken(owner));
        expect(res.status).toBe(500);
        expect(res.headers['cache-control'] || '').not.toMatch(/immutable/);
        expect(res.headers.etag || '').not.toMatch(/-(original|480)"$/);
      }
    });

    test('of the rendition serves the original instead of an error, uncached', async () => {
      const img = await fresh();
      // The rendition reads bytes the image pool cannot decode; the original
      // is read again and served as stored.
      const real = storage().get.bind(storage());
      jest.spyOn(storage(), 'get').mockImplementationOnce(async () => Readable.from([Buffer.from('not an image')]))
        .mockImplementation(real);
      const res = await get(adminUrl(img.id, '480'), mintAdminToken(owner));
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/image\/png/);
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers.etag).toBeUndefined();
      expect((await sharp(res.body).metadata()).width).toBe(60);
    });
  });
});
