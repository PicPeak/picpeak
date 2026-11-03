/**
 * Guided album order (issue 2320): catalogue, photo roles, binding
 * confirmation, release and multi-customer scoping, through the real routes.
 *
 * SQLite by default; PICPEAK_PG_TEST_URL runs the same suite on PostgreSQL in
 * a scratch schema.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID: uuid } = require('crypto');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guided-album-')), 'db.sqlite');
process.env.JWT_SECRET = 'guided-album-tests-long-secret-not-production';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const express = require('express');
const knex = require('knex');
const { bootCrmDb, seedMinimal, mintAdminToken, assignAdminRole } = require('./helpers/crmDb');

const pgUrl = process.env.PICPEAK_PG_TEST_URL;
const idOf = (rows) => rows[0].id ?? rows[0];

describe('guided album order', () => {
  let db; let cleanup; let app; let owner; let outsider; let image; let service; let pgOwner; let schema;
  const ids = {};
  let material; let colour; let format; let size;
  let albumA; let albumB; let classic;

  const admin = (id = owner) => `Bearer ${mintAdminToken(id)}`;
  const pinToken = (gallery) => jwt.sign(
    { type: 'gallery', eventId: gallery.id, accessLevel: 'client', jti: uuid() },
    process.env.JWT_SECRET, { issuer: 'picpeak-auth', expiresIn: '1h' },
  );
  const portalToken = (gallery, customerId) => jwt.sign(
    { type: 'gallery', eventId: gallery.id, via: 'customer', customerId, jti: uuid() },
    process.env.JWT_SECRET, { issuer: 'picpeak-auth', expiresIn: '1h' },
  );
  const asClient = (token) => ({
    list: (gallery) => request(app).get(`/api/gallery/${gallery.slug}/album-products`).set('Authorization', `Bearer ${token}`),
    image: (gallery, id) => request(app).get(`/api/gallery/${gallery.slug}/album-products/images/${id}`).set('Authorization', `Bearer ${token}`),
    put: (gallery, offer, body) => request(app).put(`/api/gallery/${gallery.slug}/album-products/${offer.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ revision: offer.revision, mutationId: uuid(), productVersion: offer.product?.version, submit: false, ...body }),
  });
  const adminPut = (gallery, offer, body, id = owner) => request(app)
    .put(`/api/admin/album-products/events/${gallery.id}/offers/${offer.id}`)
    .set('Authorization', admin(id))
    .send({ revision: offer.revision, mutationId: uuid(), ...body });
  const assign = (gallery, productId, customerId) => request(app)
    .post(`/api/admin/album-products/events/${gallery.id}/offers`)
    .set('Authorization', admin())
    .send({ productId, ...(customerId ? { customerId } : {}) });
  const adminOffers = async (gallery) => (await request(app)
    .get(`/api/admin/album-products/events/${gallery.id}`).set('Authorization', admin())).body.offers;

  const values = (m = ids.silk, c = ids.ivory, f = ids.square, s = ids.square2550) => ({
    [material]: m ? [m] : [], [colour]: c ? [c] : [], [format]: f ? [f] : [], [size]: s ? [s] : [],
  });

  async function addPhoto(gallery, extra = {}) {
    const filename = `${uuid()}.jpg`;
    return idOf(await db('photos').insert({
      event_id: gallery.id, filename, path: `events/${gallery.slug}/${filename}`, type: 'individual',
      original_filename: `DSC_${filename}`, ...extra,
    }).returning('id'));
  }
  async function addCustomer(gallery) {
    const id = idOf(await db('customer_accounts').insert({
      email: `${uuid()}@example.test`, display_name: 'Customer', is_active: true,
    }).returning('id'));
    if (gallery) await db('event_customer_assignments').insert({ event_id: gallery.id, customer_account_id: id });
    return id;
  }
  async function makeGallery() {
    const slug = `album-${uuid().slice(0, 8)}`;
    const gallery = {
      slug,
      id: idOf(await db('events').insert({
        slug, event_name: slug, event_type: 'wedding', event_date: '2026-10-01', host_email: 'client@example.com',
        admin_email: 'studio@example.com', password_hash: 'x', share_link: `/gallery/${slug}/share`, share_token: uuid(),
        is_active: true, is_archived: false, is_draft: false, require_password: true, created_by: owner,
        expires_at: new Date(Date.now() + 864e5).toISOString(),
      }).returning('id')),
    };
    gallery.photos = [];
    for (let i = 0; i < 4; i += 1) gallery.photos.push(await addPhoto(gallery));
    return gallery;
  }
  const released = async (gallery, product = albumA, customerId) => {
    const offer = (await assign(gallery, product.id, customerId)).body;
    const res = await adminPut(gallery, offer, { enabled: true });
    expect(res.status).toBe(200);
    return res.body;
  };
  const clientOffer = async (client, gallery, id) => {
    const res = await client.list(gallery);
    expect(res.status).toBe(200);
    return res.body.offers.find((o) => o.id === id);
  };
  const complete = (gallery, extra = {}) => ({
    values: values(), photoRoles: { cover: [gallery.photos[0]], poster: [gallery.photos[1]] }, name: 'Client', ...extra,
  });
  const historyOf = (offer) => db('album_product_choice_history').where({ offer_id: offer.id }).orderBy('revision');
  const metadataOf = (log) => (typeof log.metadata === 'string' ? JSON.parse(log.metadata) : log.metadata);
  const activityOf = (gallery, type) => db('activity_logs').where({ event_id: gallery.id, activity_type: type });

  async function saveCatalogue(products, overrides = {}) {
    const catalogue = await service.catalogue();
    return service.saveCatalogue({ ...catalogue, revision: catalogue.revision, products, ...overrides });
  }
  const libraryAndType = () => {
    for (const key of ['materials', 'colours', 'formats', 'sizes', 'cotton', 'silk', 'leather', 'natural', 'ivory',
      'black', 'landscape', 'square', 'landscape2570', 'landscape3080', 'square2550', 'square3060', 'type'])
      ids[key] ||= uuid();
    material ||= uuid(); colour ||= uuid(); format ||= uuid(); size ||= uuid();
    const option = (id, name, extra = {}) => ({ id, name, active: true, imageId: null, ...extra });
    const cm = (id, name, width, height) => option(id, name, { width, height, unit: 'cm' });
    const library = [
      { id: ids.materials, name: 'Material', kind: 'choice', options: [option(ids.cotton, 'Cotton'), option(ids.silk, 'Silk'), option(ids.leather, 'Leather')] },
      { id: ids.colours, name: 'Colour', kind: 'colour', options: [option(ids.natural, 'Natural', { hex: '#D8CFC0' }), option(ids.ivory, 'Ivory', { hex: '#fff8e7' }), option(ids.black, 'Black')] },
      { id: ids.formats, name: 'Format', kind: 'choice', options: [option(ids.landscape, 'Landscape'), option(ids.square, 'Square')] },
      { id: ids.sizes, name: 'Size', kind: 'size', options: [cm(ids.landscape2570, '25 × 70 cm', 70, 25), cm(ids.landscape3080, '30 × 80 cm', 80, 30), cm(ids.square2550, '25 × 50 cm', 50, 25), cm(ids.square3060, '30 × 60 cm', 60, 30)] },
    ];
    const attribute = (id, name, groupId, optionIds, extra) => ({ id, name, groupId, optionIds, required: true, multiple: false, addOn: false, dependsOn: [], ...extra });
    const types = [{
      id: ids.type, name: 'Album', active: true,
      attributes: [
        attribute(material, 'Material', ids.materials, [ids.cotton, ids.silk, ids.leather], { role: 'material' }),
        attribute(colour, 'Colour', ids.colours, [ids.natural, ids.ivory, ids.black], {
          role: 'colour',
          availableWhen: { attributeId: material, options: { [ids.natural]: [ids.cotton], [ids.ivory]: [ids.silk], [ids.black]: [ids.leather, ids.cotton] } },
        }),
        attribute(format, 'Format', ids.formats, [ids.landscape, ids.square], { role: 'format' }),
        attribute(size, 'Size', ids.sizes, [ids.landscape2570, ids.landscape3080, ids.square2550, ids.square3060], {
          role: 'size', spread: true,
          availableWhen: {
            attributeId: format,
            options: { [ids.landscape2570]: [ids.landscape], [ids.landscape3080]: [ids.landscape], [ids.square2550]: [ids.square], [ids.square3060]: [ids.square] },
          },
        }),
      ],
    }];
    return { library, types };
  };
  const guided = (poster = { min: 1, max: 2 }, cover = { min: 1, max: 1 }, clientFinal = true) => ({
    clientFinal, photoRoles: [{ key: 'cover', ...cover }, { key: 'poster', ...poster }],
  });
  const album = (name, extra = {}) => ({ id: uuid(), name, description: '', active: true, typeId: ids.type, heroImageId: image.id, guided: guided(), ...extra });

  beforeAll(async () => {
    if (pgUrl) {
      schema = `guided_album_${uuid().replace(/-/g, '')}`;
      pgOwner = knex({ client: 'pg', connection: pgUrl });
      await pgOwner.schema.createSchema(schema);
      process.env.DATABASE_CLIENT = 'pg';
      jest.doMock('../../knexfile', () => ({ client: 'pg', connection: pgUrl, searchPath: [schema] }));
    } else {
      process.env.DATABASE_CLIENT = 'sqlite3';
    }
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId: owner } = await seedMinimal(db));
    await assignAdminRole(db, owner, 'admin');
    outsider = idOf(await db('admin_users').insert({ username: 'outsider', email: 'outsider@example.com', password_hash: 'x', must_change_password: false }).returning('id'));
    const roleId = idOf(await db('roles').insert({ name: 'album_own', display_name: 'Album' }).returning('id'));
    for (const p of await db('permissions').whereIn('name', ['products.view', 'products.manage', 'products.configure', 'events.view', 'photos.view']))
      await db('role_permissions').insert({ role_id: roleId, permission_id: p.id });
    await db('admin_users').whereIn('id', [owner, outsider]).update({ role_id: roleId });
    await db('feature_flags').where({ key: 'albumProducts' }).update({ value: true });
    require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
    require('../../src/middleware/permissions').clearPermissionCache();
    service = require('../../src/services/albumProducts/service').application();
    image = await service.uploadImage(await sharp({ create: { width: 24, height: 20, channels: 3, background: '#436950' } }).png().toBuffer(), owner);
    const { library, types } = libraryAndType();
    albumA = album('Album A');
    albumB = album('Album B');
    classic = { id: uuid(), name: 'Classic print', description: '', active: true, typeId: ids.type };
    await saveCatalogue([albumA, albumB, classic], { library, types });
    app = express();
    app.use(express.json());
    app.use(require('cookie-parser')());
    app.use('/api/admin/album-products', require('../../src/routes/adminAlbumProducts'));
    app.use('/api/gallery', require('../../src/routes/gallery/albumProducts'));
    app.use('/api/customer', (req, res, next) => {
      // Stands in for customerAuth: the portal read models are what is tested.
      req.customer = { id: Number(req.headers['x-customer']) };
      next();
    });
    app.get('/api/customer/overview/:slug', async (req, res) => res.json(await require('../../src/services/customerPortalService').getEventOverview(req.customer.id, req.params.slug)));
    app.get('/api/customer/dashboard', async (req, res) => res.json(await require('../../src/services/customerPortalService').getDashboard(req.customer.id)));
    app.use((err, req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message, code: err.code }));
  }, 180000);

  afterAll(async () => {
    await require('../../src/services/serviceShutdown').stopServices?.();
    if (cleanup) await cleanup();
    if (pgOwner) { await pgOwner.schema.dropSchema(schema, true); await pgOwner.destroy(); }
  });

  describe('catalogue and presentation', () => {
    test('a client sees the album title, hero image, swatch values and dependencies', async () => {
      const gallery = await makeGallery();
      const offer = await released(gallery);
      const client = asClient(pinToken(gallery));
      const seen = await clientOffer(client, gallery, offer.id);
      expect(seen.product).toMatchObject({ name: 'Album A', heroImageId: image.id, guided: guided() });
      const byRole = Object.fromEntries(seen.product.attributes.map((a) => [a.role, a]));
      expect(byRole.material.options.map((o) => o.name)).toEqual(['Cotton', 'Silk', 'Leather']);
      expect(byRole.colour.options.find((o) => o.id === ids.ivory).hex).toBe('#fff8e7');
      expect(byRole.colour.availableWhen.options[ids.ivory]).toEqual([ids.silk]);
      expect(byRole.size.spread).toBe(true);
      expect(byRole.size.options.find((o) => o.id === ids.landscape2570)).toMatchObject({ width: 70, height: 25, unit: 'cm' });
      const hero = await client.image(gallery, image.id);
      expect(hero.status).toBe(200);
      expect(hero.headers['content-type']).toMatch(/png/);
    });

    test('keeps a product without album settings free of the new keys, so its version is unchanged', async () => {
      const { products, library, types } = await service.catalogue();
      const stored = products.find((p) => p.id === classic.id);
      expect(Object.keys(stored).sort()).toEqual(['active', 'description', 'id', 'name', 'typeId']);
      expect(library[0].options[0]).toEqual({ id: ids.cotton, name: 'Cotton', active: true, imageId: null });
      expect(Object.keys(types[0].attributes[0])).not.toContain('availableWhen');
    });

    test.each([
      ['a guided album on a legacy product', (p) => p.map((x) => (x.id === albumA.id ? { ...x, typeId: undefined, models: [], colours: [] } : x)), {}, /needs a product type/],
      ['too many cover photos', (p) => p.map((x) => (x.id === albumA.id ? { ...x, guided: guided({ min: 1, max: 2 }, { min: 1, max: 2 }) } : x)), {}, /Photo counts/],
      ['a poster minimum over its maximum', (p) => p.map((x) => (x.id === albumA.id ? { ...x, guided: guided({ min: 3, max: 2 }) } : x)), {}, /Photo counts/],
      ['an unavailable hero image', (p) => p.map((x) => (x.id === albumA.id ? { ...x, heroImageId: uuid() } : x)), {}, /image is unavailable/],
    ])('refuses %s', async (_name, change, _unused, message) => {
      const { products } = await service.catalogue();
      await expect(saveCatalogue(change(products))).rejects.toThrow(message);
    });

    test.each([
      ['an album type without a colour role', (t) => { delete t.attributes[1].role; }, /required colour attribute/],
      ['a material that needs a later step', (t) => { t.attributes[0].dependsOn = [{ attributeId: t.attributes.find((x) => x.role === 'format').id, optionIds: t.attributes.find((x) => x.role === 'format').optionIds.slice(0, 1) }]; }, /earlier step/],
      ['a material that waits for a later step', (t) => { t.attributes[0].availableWhen = { attributeId: t.attributes.find((x) => x.role === 'format').id, options: {} }; }, /earlier step/],
      ['colours not tied to a material', (t) => { delete t.attributes[1].availableWhen; }, /colours by material/],
      ['two attributes with one role', (t) => { t.attributes[3].role = 'format'; }, /Duplicate/],
      ['an unknown role', (t) => { t.attributes[0].role = 'paper'; }, /Unknown attribute role/],
      ['a dependency cycle', (t) => { t.attributes[0].availableWhen = { attributeId: colour, options: {} }; }, /cycles/],
      ['a dependency on an unknown option', (t) => { t.attributes[1].availableWhen.options[ids.natural] = [uuid()]; }, /Invalid option dependency/],
      ['a material left without any colour', (t) => {
        const options = t.attributes[1].availableWhen.options;
        options[ids.natural] = [ids.cotton]; options[ids.ivory] = [ids.cotton]; options[ids.black] = [ids.cotton];
      }, /has no available option/],
    ])('refuses %s', async (_name, change, message) => {
      const catalogue = await service.catalogue();
      const types = JSON.parse(JSON.stringify(catalogue.types));
      change(types[0]);
      await expect(saveCatalogue(catalogue.products, { types })).rejects.toThrow(message);
    });

    test('refuses a colour value that is not a hex code', async () => {
      const catalogue = await service.catalogue();
      const library = JSON.parse(JSON.stringify(catalogue.library));
      library[1].options[0].hex = 'url(evil)';
      await expect(saveCatalogue(catalogue.products, { library })).rejects.toThrow(/hex code/);
    });

    test('an inactive guided draft may stay incomplete while the studio builds it', async () => {
      const catalogue = await service.catalogue();
      const draft = album('Unfinished', { active: false, typeId: undefined });
      delete draft.guided;
      const typed = { ...draft, typeId: ids.type, guided: guided() };
      const types = JSON.parse(JSON.stringify(catalogue.types));
      types.push({ id: uuid(), name: 'Bare', active: true, attributes: [] });
      const saved = await saveCatalogue([...catalogue.products, { ...typed, typeId: types[1].id }], { types });
      expect(saved.products).toHaveLength(catalogue.products.length + 1);
      await saveCatalogue(catalogue.products, { types: catalogue.types });
    });
  });

  describe('invalid combinations', () => {
    test.each([
      ['a colour of another material', () => values(ids.silk, ids.natural)],
      ['a size of another format', () => values(ids.silk, ids.ivory, ids.landscape, ids.square2550)],
      ['a colour with no material', () => values(null, ids.ivory)],
      ['a size with no format', () => values(ids.silk, ids.ivory, null, ids.square2550)],
    ])('rejects %s on a draft and on submission', async (_name, chosen) => {
      const gallery = await makeGallery();
      const offer = await released(gallery);
      const client = asClient(pinToken(gallery));
      const seen = await clientOffer(client, gallery, offer.id);
      for (const submit of [false, true]) {
        const res = await client.put(gallery, seen, { ...complete(gallery), values: chosen(), submit });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/not available|Choose/);
      }
      expect((await db('event_album_products').where({ id: offer.id }).first()).selection).toBeNull();
    });

    test('accepts a colour shared by two materials with either of them', async () => {
      const gallery = await makeGallery();
      const offer = await released(gallery);
      const client = asClient(pinToken(gallery));
      const seen = await clientOffer(client, gallery, offer.id);
      const res = await client.put(gallery, seen, { ...complete(gallery), values: values(ids.leather, ids.black) });
      expect(res.status).toBe(200);
    });

    test('a quote line runs through the same dependency rule', () => {
      const G = require('../../src/services/albumProducts/library');
      return service.catalogue().then((catalogue) => {
        const product = G.resolve(catalogue.products.find((p) => p.id === albumA.id), catalogue);
        expect(() => G.selection(product, { productVersion: product.version, values: values(ids.silk, ids.natural) })).toThrow(/not available/);
      });
    });
  });

  describe('gallery photos', () => {
    let gallery; let offer; let client;
    beforeAll(async () => {
      gallery = await makeGallery();
      offer = await released(gallery);
      client = asClient(pinToken(gallery));
    });
    const seen = () => clientOffer(client, gallery, offer.id);

    test.each([
      ['hidden', { visibility: 'hidden' }],
      ['held for moderation', { moderation_status: 'pending' }],
      ['rejected in moderation', { moderation_status: 'rejected' }],
      ['in the trash', { deleted_at: new Date().toISOString() }],
      ['still processing', { processing_status: 'processing' }],
      ['gone from its share', { unavailable_reason: 'missing' }],
      ['a video by media type', { media_type: 'video' }],
      ['a video by MIME type', { mime_type: 'video/mp4' }],
    ])('rejects a photo that is %s', async (_name, row) => {
      const photo = await addPhoto(gallery, row);
      for (const photos of [{ cover: [photo], poster: [gallery.photos[1]] }, { cover: [gallery.photos[0]], poster: [photo] }]) {
        const res = await client.put(gallery, await seen(), { ...complete(gallery), photoRoles: photos, submit: true });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('PHOTO_UNAVAILABLE');
      }
    });

    test('rejects a photo of another gallery', async () => {
      const other = await makeGallery();
      const res = await client.put(gallery, await seen(), { ...complete(gallery), photoRoles: { cover: [other.photos[0]], poster: [gallery.photos[1]] } });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PHOTO_UNAVAILABLE');
    });

    test.each([
      ['no cover', () => ({ poster: [gallery.photos[1]] }), 'PHOTO_COUNT'],
      ['two covers', () => ({ cover: gallery.photos.slice(0, 2), poster: [gallery.photos[2]] }), 'PHOTO_COUNT'],
      ['no poster', () => ({ cover: [gallery.photos[0]] }), 'PHOTO_COUNT'],
      ['three posters', () => ({ cover: [gallery.photos[0]], poster: gallery.photos.slice(1, 4) }), 'PHOTO_COUNT'],
    ])('rejects a confirmation with %s', async (_name, photos, code) => {
      const res = await client.put(gallery, await seen(), { ...complete(gallery), photoRoles: photos(), submit: true });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(code);
    });

    test.each([
      ['a repeated photo', () => ({ cover: [gallery.photos[0]], poster: [gallery.photos[1], gallery.photos[1]] })],
      ['an id that is not a number', () => ({ cover: ['1'], poster: [] })],
      ['an id beyond int4', () => ({ cover: [2147483648], poster: [] })],
      ['an unknown role', () => ({ cover: [gallery.photos[0]], inside: [gallery.photos[1]] })],
    ])('rejects %s', async (_name, photos) => {
      expect((await client.put(gallery, await seen(), { ...complete(gallery), photoRoles: photos() })).status).toBe(400);
    });

    test('takes a partial draft, keeps the studio counts on it and allows one photo in two roles', async () => {
      const partial = await client.put(gallery, await seen(), { values: values(ids.silk, null, null, null), photoRoles: { cover: [gallery.photos[0]] } });
      expect(partial.status).toBe(200);
      expect(partial.body.status).toBe('draft');
      const over = await client.put(gallery, await seen(), { values: values(), photoRoles: { poster: gallery.photos.slice(0, 3) } });
      expect(over.body.code).toBe('PHOTO_COUNT');
      const both = await client.put(gallery, await seen(), { values: values(), photoRoles: { cover: [gallery.photos[0]], poster: [gallery.photos[0]] } });
      expect(both.status).toBe(200);
    });

    test('the studio changes the allowed poster count without touching code', async () => {
      const catalogue = await service.catalogue();
      await saveCatalogue(catalogue.products.map((p) => (p.id === albumB.id ? { ...p, guided: guided({ min: 2, max: 2 }) } : p)));
      const other = await makeGallery();
      const two = await released(other, albumB);
      const pin = asClient(pinToken(other));
      const one = await pin.put(other, await clientOffer(pin, other, two.id), { ...complete(other), submit: true });
      expect(one.status).toBe(400);
      expect(one.body.error).toBe('Poster photos: choose 2');
      const ok = await pin.put(other, await clientOffer(pin, other, two.id), { ...complete(other), photoRoles: { cover: [other.photos[0]], poster: other.photos.slice(1, 3) }, submit: true });
      expect(ok.status).toBe(200);
      await saveCatalogue(catalogue.products);
    });

    test('rechecks at submission: a photo hidden after the draft blocks the confirmation', async () => {
      const other = await makeGallery();
      const held = await released(other);
      const pin = asClient(pinToken(other));
      expect((await pin.put(other, await clientOffer(pin, other, held.id), complete(other))).status).toBe(200);
      await db('photos').where({ id: other.photos[0] }).update({ visibility: 'hidden' });
      const draft = await clientOffer(pin, other, held.id);
      expect(draft.selection.photoRoles[0].photos[0]).toEqual({ id: other.photos[0], available: false });
      const res = await pin.put(other, draft, { ...complete(other), submit: true });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PHOTO_UNAVAILABLE');
      expect((await db('event_album_products').where({ id: held.id }).first()).status).toBe('draft');
      expect(await activityOf(other, 'album_product_submitted')).toHaveLength(0);
    });

    test('the product API holds references only, and the client not even the filenames', async () => {
      const other = await makeGallery();
      const held = await released(other);
      const pin = asClient(pinToken(other));
      const confirmed = await pin.put(other, await clientOffer(pin, other, held.id), { ...complete(other), submit: true });
      const [photo] = await db('photos').where({ id: other.photos[0] });
      const adminBody = JSON.stringify(await adminOffers(other));
      for (const body of [JSON.stringify(confirmed.body), JSON.stringify((await pin.list(other)).body)]) {
        expect(body).toContain(`"id":${photo.id}`);
        expect(body).not.toContain(photo.filename);
        expect(body).not.toContain(photo.path);
      }
      expect(adminBody).toContain(photo.filename);
      expect(adminBody).toContain(photo.original_filename);
      expect(adminBody).not.toContain(photo.path);
      expect(adminBody).not.toMatch(/\/api\/|"url"/);
    });

    test('the frozen reference survives the photo: the studio still reads it, marked unavailable', async () => {
      const other = await makeGallery();
      const held = await released(other);
      const pin = asClient(pinToken(other));
      await pin.put(other, await clientOffer(pin, other, held.id), { ...complete(other), submit: true });
      const [{ filename }] = await db('photos').where({ id: other.photos[0] });
      await db('photos').where({ id: other.photos[0] }).del();
      const [stored] = await adminOffers(other);
      expect(stored.selection.photoRoles[0].photos[0]).toMatchObject({ id: other.photos[0], filename, available: false });
    });
  });

  describe('binding confirmation', () => {
    test('a repeated request confirms once: one history entry, one notification, same answer', async () => {
      const gallery = await makeGallery();
      const offer = await released(gallery);
      const client = asClient(pinToken(gallery));
      const seen = await clientOffer(client, gallery, offer.id);
      const mutationId = uuid();
      const first = await client.put(gallery, seen, { ...complete(gallery), submit: true, mutationId });
      const retry = await client.put(gallery, seen, { ...complete(gallery), submit: true, mutationId });
      expect(first.status).toBe(200);
      expect(first.body.status).toBe('submitted');
      expect(first.body.selection.clientFinal).toBe(true);
      expect(retry.status).toBe(200);
      expect(retry.body).toEqual(first.body);
      expect((await historyOf(offer)).filter((h) => h.status === 'submitted')).toHaveLength(1);
      expect(await activityOf(gallery, 'album_product_submitted')).toHaveLength(1);
    });

    test('two tabs: the stale one gets a conflict, a fresh second confirmation is refused', async () => {
      const gallery = await makeGallery();
      const offer = await released(gallery);
      const client = asClient(pinToken(gallery));
      const seen = await clientOffer(client, gallery, offer.id);
      expect((await client.put(gallery, seen, { ...complete(gallery), submit: true })).status).toBe(200);
      const stale = await client.put(gallery, seen, { ...complete(gallery), submit: true });
      expect(stale.status).toBe(409);
      const reloaded = await clientOffer(client, gallery, offer.id);
      const again = await client.put(gallery, reloaded, { ...complete(gallery), submit: true });
      expect(again.status).toBe(403);
      expect((await historyOf(offer)).filter((h) => h.status === 'submitted')).toHaveLength(1);
    });

    test('a second album cannot be confirmed for the same client in another tab', async () => {
      const gallery = await makeGallery();
      const first = await released(gallery, albumA);
      const second = await released(gallery, albumB);
      const client = asClient(pinToken(gallery));
      expect((await client.put(gallery, await clientOffer(client, gallery, first.id), { ...complete(gallery), submit: true })).status).toBe(200);
      const res = await client.put(gallery, await clientOffer(client, gallery, second.id), { ...complete(gallery), submit: true });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already confirmed/);
    });

    test('the only customer cannot confirm one album from each audience', async () => {
      const gallery = await makeGallery();
      const anna = await addCustomer(gallery);
      const shared = await released(gallery, albumA);
      const own = await released(gallery, albumB, anna);
      const client = asClient(portalToken(gallery, anna));
      expect((await client.put(gallery, await clientOffer(client, gallery, shared.id), { ...complete(gallery), submit: true })).status).toBe(200);
      const res = await client.put(gallery, await clientOffer(client, gallery, own.id), { ...complete(gallery), submit: true });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already confirmed/);
    });

    test('a confirmation stays out of it once its customer has left the gallery', async () => {
      const gallery = await makeGallery();
      const anna = await addCustomer(gallery);
      const ben = await addCustomer(gallery);
      const first = await released(gallery, albumA, anna);
      const second = await released(gallery, albumB, ben);
      const a = asClient(portalToken(gallery, anna));
      const b = asClient(portalToken(gallery, ben));
      await a.put(gallery, await clientOffer(a, gallery, first.id), { ...complete(gallery), submit: true });
      await db('event_customer_assignments').where({ event_id: gallery.id, customer_account_id: anna }).del();
      expect((await b.put(gallery, await clientOffer(b, gallery, second.id), { ...complete(gallery), submit: true })).status).toBe(200);
    });

    test('one customer\'s confirmation leaves another customer\'s offer open', async () => {
      const gallery = await makeGallery();
      const anna = await addCustomer(gallery);
      const ben = await addCustomer(gallery);
      const first = await released(gallery, albumA, anna);
      const second = await released(gallery, albumB, ben);
      const a = asClient(portalToken(gallery, anna));
      const b = asClient(portalToken(gallery, ben));
      expect((await a.put(gallery, await clientOffer(a, gallery, first.id), { ...complete(gallery), submit: true })).status).toBe(200);
      expect((await b.put(gallery, await clientOffer(b, gallery, second.id), { ...complete(gallery), submit: true })).status).toBe(200);
    });

    test('a confirmed selection is read-only for the client, frozen and complete', async () => {
      const gallery = await makeGallery();
      const offer = await released(gallery);
      const client = asClient(pinToken(gallery));
      const before = await client.put(gallery, await clientOffer(client, gallery, offer.id), { ...complete(gallery), submit: true });
      const seen = await clientOffer(client, gallery, offer.id);
      expect(seen.needsReview).toBe(false);
      for (const submit of [false, true]) {
        const res = await client.put(gallery, seen, { ...complete(gallery), photoRoles: { cover: [gallery.photos[2]], poster: [gallery.photos[3]] }, submit });
        expect(res.status).toBe(403);
      }
      const [stored] = await adminOffers(gallery);
      expect(stored.selection.attributes.map((a) => [a.role, a.options[0].name])).toEqual([
        ['material', 'Silk'], ['colour', 'Ivory'], ['format', 'Square'], ['size', '25 × 50 cm'],
      ]);
      expect(stored.selection.attributes[1].options[0].hex).toBe('#fff8e7');
      expect(stored.selection.photoRoles.map((r) => r.photos[0].id)).toEqual([gallery.photos[0], gallery.photos[1]]);
      expect(stored.selection.confirmedAt).toBe(before.body.selection.confirmedAt);
      expect(typeof stored.selection.confirmedAt).toBe('string');
      const [log] = await activityOf(gallery, 'album_product_submitted');
      expect(metadataOf(log).choice).toMatch(/Material: Silk .* Cover: .* Poster: /);
    });

    test('a confirmation needs the name, a guided draft does not', async () => {
      const gallery = await makeGallery();
      const offer = await released(gallery);
      const client = asClient(pinToken(gallery));
      const seen = await clientOffer(client, gallery, offer.id);
      const body = complete(gallery);
      delete body.name;
      expect((await client.put(gallery, seen, body)).status).toBe(200);
      const res = await client.put(gallery, await clientOffer(client, gallery, offer.id), { ...body, submit: true });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('A name is required');
    });

    test('a configured product keeps today\'s resubmit-until-locked behaviour with no client-final', async () => {
      const catalogue = await service.catalogue();
      await saveCatalogue(catalogue.products.map((p) => (p.id === albumB.id ? { ...p, guided: guided(undefined, undefined, false) } : p)));
      const gallery = await makeGallery();
      const offer = await released(gallery, albumB);
      const client = asClient(pinToken(gallery));
      const first = await client.put(gallery, await clientOffer(client, gallery, offer.id), { ...complete(gallery), submit: true });
      expect(first.body.selection.clientFinal).toBeUndefined();
      const again = await client.put(gallery, await clientOffer(client, gallery, offer.id), { ...complete(gallery), values: values(ids.cotton, ids.natural), submit: true });
      expect(again.status).toBe(200);
      expect((await adminPut(gallery, again.body, { action: 'reopen' })).status).toBe(409);
      await saveCatalogue(catalogue.products);
    });

    test('a product without album settings is unchanged: visible on assignment, resubmittable, no photos', async () => {
      const gallery = await makeGallery();
      const offer = (await assign(gallery, classic.id)).body;
      expect(offer.enabled).toBe(true);
      const client = asClient(pinToken(gallery));
      const seen = await clientOffer(client, gallery, offer.id);
      const body = { values: values(), name: 'Client', submit: true };
      expect((await client.put(gallery, seen, body)).status).toBe(200);
      const reloaded = await clientOffer(client, gallery, offer.id);
      expect((await client.put(gallery, reloaded, { ...body, values: values(ids.cotton, ids.natural) })).status).toBe(200);
      const noName = await client.put(gallery, await clientOffer(client, gallery, offer.id), { values: values() });
      expect(noName.status).toBe(409);
      expect((await client.put(gallery, await clientOffer(client, gallery, offer.id), { ...body, photoRoles: { cover: [gallery.photos[0]] } })).status).toBe(400);
    });
  });

  describe('locking and reopening', () => {
    test('reopen is explicit, audited and hands the selection back to the client', async () => {
      const gallery = await makeGallery();
      const offer = await released(gallery);
      const client = asClient(pinToken(gallery));
      await client.put(gallery, await clientOffer(client, gallery, offer.id), { ...complete(gallery), submit: true });
      const [submitted] = await adminOffers(gallery);
      expect((await adminPut(gallery, submitted, { action: 'lock' })).body.status).toBe('locked');
      const [locked] = await adminOffers(gallery);
      const refused = await client.put(gallery, await clientOffer(client, gallery, offer.id), { ...complete(gallery), submit: true });
      expect(refused.status).toBe(403);
      const reopened = await adminPut(gallery, locked, { action: 'reopen' });
      expect(reopened.status).toBe(200);
      expect(reopened.body.status).toBe('draft');
      expect(reopened.body.selection.product.name).toBe('Album A');
      const [log] = await activityOf(gallery, 'album_product_reopened');
      expect(log.actor_type).toBe('admin');
      expect(log.actor_name).toBe('tester');
      expect(metadataOf(log)).toMatchObject({ productName: 'Album A', previousStatus: 'locked', offerId: offer.id });
      const history = await historyOf(offer);
      expect(history[history.length - 1]).toMatchObject({ status: 'draft', actor_type: 'admin' });
      const again = await client.put(gallery, await clientOffer(client, gallery, offer.id), { ...complete(gallery), photoRoles: { cover: [gallery.photos[2]], poster: [gallery.photos[3]] }, submit: true });
      expect(again.status).toBe(200);
      expect(await activityOf(gallery, 'album_product_submitted')).toHaveLength(2);
    });

    test('a confirmed selection can be reopened before it is locked, and a free draft cannot', async () => {
      const gallery = await makeGallery();
      const offer = await released(gallery);
      expect((await adminPut(gallery, offer, { action: 'reopen' })).status).toBe(409);
      const client = asClient(pinToken(gallery));
      await client.put(gallery, await clientOffer(client, gallery, offer.id), { ...complete(gallery), submit: true });
      const [submitted] = await adminOffers(gallery);
      const reopened = await adminPut(gallery, submitted, { action: 'reopen' });
      expect(reopened.body.status).toBe('draft');
    });

    test('unlocking a confirmed selection is audited and leaves the client read-only', async () => {
      const gallery = await makeGallery();
      const offer = await released(gallery);
      const client = asClient(pinToken(gallery));
      await client.put(gallery, await clientOffer(client, gallery, offer.id), { ...complete(gallery), submit: true });
      const [submitted] = await adminOffers(gallery);
      await adminPut(gallery, submitted, { action: 'lock' });
      const [locked] = await adminOffers(gallery);
      expect((await adminPut(gallery, locked, { action: 'unlock' })).body.status).toBe('submitted');
      expect(await activityOf(gallery, 'album_product_unlocked')).toHaveLength(1);
      expect((await client.put(gallery, await clientOffer(client, gallery, offer.id), { ...complete(gallery), submit: true })).status).toBe(403);
    });

    test('reopening takes the gallery owner: another photographer is refused', async () => {
      const gallery = await makeGallery();
      const offer = await released(gallery);
      const client = asClient(pinToken(gallery));
      await client.put(gallery, await clientOffer(client, gallery, offer.id), { ...complete(gallery), submit: true });
      const [submitted] = await adminOffers(gallery);
      expect((await adminPut(gallery, submitted, { action: 'reopen' }, outsider)).status).toBe(403);
      // A teammate reaches the gallery but is not its owner.
      await db('event_admin_assignments').insert({ admin_user_id: outsider, event_id: gallery.id, assigned_by: owner });
      expect((await adminPut(gallery, submitted, { action: 'reopen' }, outsider)).status).toBe(403);
      expect((await adminPut(gallery, submitted, { enabled: false }, outsider)).status).toBe(200);
    });

    test('a locked product with a changed catalogue must be reopened, not silently locked', async () => {
      const catalogue = await service.catalogue();
      const gallery = await makeGallery();
      const offer = await released(gallery);
      const client = asClient(pinToken(gallery));
      await client.put(gallery, await clientOffer(client, gallery, offer.id), { ...complete(gallery), submit: true });
      const library = JSON.parse(JSON.stringify(catalogue.library));
      library[0].options[1].name = 'Silk renamed';
      await saveCatalogue(catalogue.products, { library });
      const [submitted] = await adminOffers(gallery);
      expect((await adminPut(gallery, submitted, { action: 'lock' })).status).toBe(409);
      await saveCatalogue(catalogue.products, { library: catalogue.library });
    });
  });

  describe('release and multiple customers', () => {
    test('a guided album stays invisible until the studio releases it, and the release is audited', async () => {
      const gallery = await makeGallery();
      const client = asClient(pinToken(gallery));
      const offer = (await assign(gallery, albumA.id)).body;
      expect(offer.enabled).toBe(false);
      expect((await client.list(gallery)).body.offers).toEqual([]);
      expect((await client.image(gallery, image.id)).status).toBe(404);
      await adminPut(gallery, offer, { enabled: true });
      expect((await client.list(gallery)).body.offers).toHaveLength(1);
      const [log] = await activityOf(gallery, 'album_product_released');
      expect(metadataOf(log)).toMatchObject({ productName: 'Album A', offerId: offer.id });
    });

    test('a customer\'s release reaches that customer alone, on read, write, retry and image', async () => {
      const gallery = await makeGallery();
      const anna = await addCustomer(gallery);
      const ben = await addCustomer(gallery);
      const offer = await released(gallery, albumA, anna);
      const mine = asClient(portalToken(gallery, anna));
      const theirs = asClient(portalToken(gallery, ben));
      const pin = asClient(pinToken(gallery));
      const seen = await clientOffer(mine, gallery, offer.id);
      expect(seen.releasedCustomerId).toBeUndefined();
      for (const other of [theirs, pin]) {
        expect((await other.list(gallery)).body.offers).toEqual([]);
        expect((await other.image(gallery, image.id)).status).toBe(404);
        expect((await other.put(gallery, seen, complete(gallery))).status).toBe(404);
      }
      const mutationId = uuid();
      expect((await mine.put(gallery, seen, { ...complete(gallery), submit: true, mutationId })).status).toBe(200);
      expect((await theirs.put(gallery, seen, { ...complete(gallery), submit: true, mutationId })).status).toBe(404);
      const [history] = (await historyOf(offer)).filter((h) => h.status === 'submitted');
      expect(Number(history.customer_account_id)).toBe(anna);
    });

    test('two customers hold their own offer for one album, with separate selections', async () => {
      const gallery = await makeGallery();
      const anna = await addCustomer(gallery);
      const ben = await addCustomer(gallery);
      const first = await released(gallery, albumA, anna);
      const second = await released(gallery, albumA, ben);
      expect(second.id).not.toBe(first.id);
      const a = asClient(portalToken(gallery, anna));
      const b = asClient(portalToken(gallery, ben));
      await a.put(gallery, await clientOffer(a, gallery, first.id), { ...complete(gallery), submit: true });
      const res = await b.put(gallery, await clientOffer(b, gallery, second.id), { ...complete(gallery), values: values(ids.cotton, ids.natural), submit: true });
      expect(res.status).toBe(200);
      expect((await a.list(gallery)).body.offers.map((o) => o.id)).toEqual([first.id]);
      expect((await b.list(gallery)).body.offers[0].selection.attributes[0].options[0].name).toBe('Cotton');
      expect((await a.list(gallery)).body.offers[0].selection.attributes[0].options[0].name).toBe('Silk');
    });

    test('assigning the same audience twice returns the one offer', async () => {
      const gallery = await makeGallery();
      const anna = await addCustomer(gallery);
      const first = (await assign(gallery, albumA.id, anna)).body;
      const again = (await assign(gallery, albumA.id, anna)).body;
      const whole = (await assign(gallery, albumA.id)).body;
      const wholeAgain = (await assign(gallery, albumA.id)).body;
      expect(again.id).toBe(first.id);
      expect(wholeAgain.id).toBe(whole.id);
      expect(whole.id).not.toBe(first.id);
    });

    test('with several customers an unscoped offer reaches the PIN client, none of the customers', async () => {
      const gallery = await makeGallery();
      const anna = await addCustomer(gallery);
      const offer = await released(gallery);
      const a = asClient(portalToken(gallery, anna));
      expect((await a.list(gallery)).body.offers.map((o) => o.id)).toEqual([offer.id]);
      const ben = await addCustomer(gallery);
      expect((await a.list(gallery)).body.offers).toEqual([]);
      expect((await asClient(portalToken(gallery, ben)).list(gallery)).body.offers).toEqual([]);
      expect((await asClient(pinToken(gallery)).list(gallery)).body.offers).toHaveLength(1);
    });

    test('an offer cannot move to another audience once it holds a choice, nor to a stranger', async () => {
      const gallery = await makeGallery();
      const anna = await addCustomer(gallery);
      const ben = await addCustomer(gallery);
      const stranger = await addCustomer();
      const offer = await released(gallery, albumA, anna);
      const unassigned = await adminPut(gallery, offer, { releasedCustomerId: stranger });
      expect(unassigned.status).toBe(400);
      const moved = await adminPut(gallery, offer, { releasedCustomerId: ben });
      expect(moved.status).toBe(200);
      expect(moved.body.releasedCustomerId).toBe(ben);
      const b = asClient(portalToken(gallery, ben));
      await b.put(gallery, await clientOffer(b, gallery, offer.id), complete(gallery));
      const [held] = await adminOffers(gallery);
      expect((await adminPut(gallery, held, { releasedCustomerId: anna })).status).toBe(409);
      expect((await adminPut(gallery, held, { releasedCustomerId: null })).status).toBe(409);
    });

    test('two offers cannot be moved onto the same customer', async () => {
      const gallery = await makeGallery();
      const anna = await addCustomer(gallery);
      const ben = await addCustomer(gallery);
      await released(gallery, albumA, anna);
      const second = await released(gallery, albumA, ben);
      expect((await adminPut(gallery, second, { releasedCustomerId: anna })).status).toBe(409);
    });

    test('losing the gallery assignment ends the customer\'s access to their offer', async () => {
      const gallery = await makeGallery();
      const anna = await addCustomer(gallery);
      await released(gallery, albumA, anna);
      const a = asClient(portalToken(gallery, anna));
      expect((await a.list(gallery)).body.offers).toHaveLength(1);
      await db('event_customer_assignments').where({ event_id: gallery.id, customer_account_id: anna }).del();
      expect((await a.list(gallery)).status).toBe(403);
    });

    test('a portal session that entered the PIN stays that customer', async () => {
      const gallery = await makeGallery();
      const anna = await addCustomer(gallery);
      const ben = await addCustomer(gallery);
      const offer = await released(gallery, albumA, anna);
      const token = jwt.sign({ type: 'gallery', eventId: gallery.id, via: 'customer', customerId: ben, accessLevel: 'client', jti: uuid() },
        process.env.JWT_SECRET, { issuer: 'picpeak-auth', expiresIn: '1h' });
      expect((await asClient(token).list(gallery)).body.offers).toEqual([]);
      expect(offer.releasedCustomerId).toBe(anna);
    });

    test('the portal keeps showing a confirmed album after the studio retires the product', async () => {
      const gallery = await makeGallery();
      const anna = await addCustomer(gallery);
      const offer = await released(gallery, albumB, anna);
      const a = asClient(portalToken(gallery, anna));
      await a.put(gallery, await clientOffer(a, gallery, offer.id), { ...complete(gallery), submit: true });
      const overview = async () => (await request(app).get(`/api/customer/overview/${gallery.slug}`).set('x-customer', String(anna))).body.productOffers;
      expect((await overview())[0]).toMatchObject({ confirmed: true, guided: true });
      const { products } = await service.catalogue();
      await saveCatalogue(products.map((p) => (p.id === albumB.id ? { ...p, active: false } : p)));
      try {
        expect((await overview())[0]).toMatchObject({ confirmed: true, guided: true });
      } finally {
        await saveCatalogue(products);
      }
    });

    test('the portal lists only this customer\'s released offers and flags an unconfirmed album', async () => {
      const gallery = await makeGallery();
      const anna = await addCustomer(gallery);
      const ben = await addCustomer(gallery);
      const offer = await released(gallery, albumA, anna);
      const overview = async (id) => (await request(app).get(`/api/customer/overview/${gallery.slug}`).set('x-customer', String(id))).body;
      const dashboard = async (id) => (await request(app).get('/api/customer/dashboard').set('x-customer', String(id))).body;
      expect((await overview(anna)).productOffers).toEqual([{ id: offer.id, name: 'Album A', status: 'draft', confirmed: false, guided: true }]);
      expect((await overview(ben)).productOffers).toEqual([]);
      expect((await dashboard(anna)).needsAction.albums).toEqual([{ eventName: gallery.slug, link: `/customer/events/${gallery.slug}` }]);
      expect((await dashboard(ben)).needsAction.albums).toEqual([]);
      const a = asClient(portalToken(gallery, anna));
      await a.put(gallery, await clientOffer(a, gallery, offer.id), { ...complete(gallery), submit: true });
      expect((await overview(anna)).productOffers[0]).toMatchObject({ status: 'submitted', confirmed: true });
      expect((await dashboard(anna)).needsAction.albums).toEqual([]);
      const [submitted] = await adminOffers(gallery);
      await adminPut(gallery, submitted, { action: 'reopen' });
      expect((await overview(anna)).productOffers[0]).toMatchObject({ status: 'draft', confirmed: false });
      expect((await dashboard(anna)).needsAction.albums).toHaveLength(1);
    });
  });

  describe('disabled offers', () => {
    test('disabling stops the client at once and keeps the choice and its history', async () => {
      const gallery = await makeGallery();
      const offer = await released(gallery);
      const client = asClient(pinToken(gallery));
      const seen = await clientOffer(client, gallery, offer.id);
      const mutationId = uuid();
      const saved = await client.put(gallery, seen, { ...complete(gallery), mutationId });
      expect(saved.status).toBe(200);
      const before = await historyOf(offer);
      const withdrawn = await adminPut(gallery, saved.body, { enabled: false });
      expect(withdrawn.status).toBe(200);
      expect((await client.list(gallery)).body.offers).toEqual([]);
      expect((await client.image(gallery, image.id)).status).toBe(404);
      expect((await client.put(gallery, { ...seen, revision: withdrawn.body.revision }, complete(gallery))).status).toBe(403);
      // A retry of a request that succeeded is no way back in either.
      expect((await client.put(gallery, seen, { ...complete(gallery), mutationId })).status).toBe(403);
      const [stored] = await adminOffers(gallery);
      expect(stored.selection.product.name).toBe('Album A');
      expect(stored.enabled).toBe(false);
      expect((await historyOf(offer)).length).toBe(before.length + 1);
      expect(await activityOf(gallery, 'album_product_withdrawn')).toHaveLength(1);
      await adminPut(gallery, stored, { enabled: true });
      expect((await clientOffer(client, gallery, offer.id)).selection.product.name).toBe('Album A');
    });

    test('a guest, a slideshow and the switched-off configurator cannot reach a released album', async () => {
      const gallery = await makeGallery();
      await released(gallery);
      const guest = jwt.sign({ type: 'gallery', eventId: gallery.id, accessLevel: 'guest', jti: uuid() }, process.env.JWT_SECRET, { issuer: 'picpeak-auth', expiresIn: '1h' });
      const slideshow = jwt.sign({ type: 'gallery', eventId: gallery.id, accessLevel: 'slideshow', jti: uuid() }, process.env.JWT_SECRET, { issuer: 'picpeak-auth', expiresIn: '1h' });
      expect((await asClient(guest).list(gallery)).status).toBe(403);
      expect((await asClient(slideshow).list(gallery)).status).toBe(403);
      await db('feature_flags').where({ key: 'albumProducts' }).update({ value: false });
      require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
      const anna = await addCustomer(gallery);
      expect((await asClient(pinToken(gallery)).list(gallery)).status).toBe(403);
      expect((await request(app).get(`/api/customer/overview/${gallery.slug}`).set('x-customer', String(anna))).body.productOffers).toEqual([]);
      await db('feature_flags').where({ key: 'albumProducts' }).update({ value: true });
      require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
    });
  });

  describe('personal data, backup and schema', () => {
    test('customer erasure drops the name and session digest and withdraws the offer', async () => {
      const gallery = await makeGallery();
      const anna = await addCustomer(gallery);
      const ben = await addCustomer(gallery);
      const offer = await released(gallery, albumA, anna);
      const whole = await released(gallery, albumB, ben);
      const a = asClient(portalToken(gallery, anna));
      const b = asClient(portalToken(gallery, ben));
      await a.put(gallery, await clientOffer(a, gallery, offer.id), { ...complete(gallery), name: 'Anna Example', submit: true });
      await b.put(gallery, await clientOffer(b, gallery, whole.id), { ...complete(gallery), name: 'Ben Example' });
      const [row] = await adminOffers(gallery);
      await adminPut(gallery, row, { action: 'lock' });
      await require('../../src/services/customerAccountsService').eraseCustomer(anna, owner);
      const client = (await historyOf(offer)).filter((h) => h.actor_type === 'client');
      expect(client.length).toBeGreaterThan(0);
      for (const entry of client) expect(entry).toMatchObject({ actor_name: null, actor_id: null, customer_account_id: null });
      expect((await historyOf(offer)).some((h) => h.actor_type === 'admin' && h.actor_name)).toBe(true);
      const stored = await db('event_album_products').where({ id: offer.id }).first();
      expect(JSON.parse(stored.selection).product.name).toBe('Album A');
      expect(JSON.stringify(stored)).not.toContain('Anna Example');
      expect((await adminOffers(gallery)).find((o) => o.id === offer.id).enabled).toBe(false);
      // Nobody else's data goes with it.
      expect((await historyOf(whole)).find((h) => h.actor_type === 'client').actor_name).toBe('Ben Example');
    });

    test('both backup formats carry the offer and history tables and the hero image', async () => {
      const { listDataTables, EXCLUDED_TABLES } = require('../../src/services/picpeakExportService');
      // listDataTables reads the public schema, and this suite may run in a scratch one.
      const tables = pgUrl ? null : await listDataTables();
      for (const table of ['event_album_products', 'album_product_choice_history', 'album_product_catalogue', 'album_product_images']) {
        expect(EXCLUDED_TABLES.has(table)).toBe(false);
        if (tables) expect(tables).toContain(table);
      }
      // recoveryFiles and the album-products backup path walk this table.
      const { products } = await service.catalogue();
      const hero = products.find((p) => p.id === albumA.id).heroImageId;
      expect(await db('album_product_images').where({ id: hero }).first()).toMatchObject({ storage_key: `album-products/${hero}.png` });
    });

    test('the migration is idempotent, and rolls back only when no customer would lose an offer', async () => {
      const migration = require('../../migrations/core/345_guided_album_order');
      await migration.up(db);
      await migration.up(db);
      const gallery = await makeGallery();
      const anna = await addCustomer(gallery);
      const ben = await addCustomer(gallery);
      const first = (await assign(gallery, albumA.id, anna)).body;
      const second = (await assign(gallery, albumA.id, ben)).body;
      expect(second.id).not.toBe(first.id);
      await expect(migration.down(db)).rejects.toThrow(/Several customers/);
      await db('album_product_choice_history').del();
      await db('event_album_products').whereNot({ id: first.id }).del();
      await migration.down(db);
      expect(await db.schema.hasColumn('event_album_products', 'released_customer_id')).toBe(false);
      await expect(db('event_album_products').insert({
        id: uuid(), event_id: gallery.id, product_id: albumA.id, enabled: true, revision: 1, status: 'draft',
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      })).rejects.toThrow(/unique/i);
      await migration.up(db);
      expect(await db.schema.hasColumn('event_album_products', 'released_customer_id')).toBe(true);
      expect((await db('event_album_products').where({ id: first.id }).first()).status).toBe('draft');
    });
  });
});
