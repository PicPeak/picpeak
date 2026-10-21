const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const knex = require('knex');
const sharp = require('sharp');
const migration = require('../../migrations/core/315_album_product_configurator');
const { createService } = require('../../src/services/albumProducts/service');
const V = require('../../src/services/albumProducts/validation');
const LocalFsStorage = require('../../src/services/storage/LocalFsStorage');
const uuid = () => crypto.randomUUID();

describe('native album product catalogue and choices', () => {
  let db; let storage; let service; let dir; let product; let image;
  const event = { id: 1, event_name: 'Synthetic gallery' };
  const client = { type: 'client', id: 'session-digest', name: 'Test Client' };
  const admin = { type: 'admin', id: 1, name: 'Photographer' };
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'album-products-'));
    db = knex(process.env.ALBUM_TEST_PG_URL
      ? { client: 'pg', connection: process.env.ALBUM_TEST_PG_URL }
      : { client: 'sqlite3', connection: { filename: path.join(dir, 'db.sqlite') }, useNullAsDefault: true });
    await db.schema.createTable('admin_users', (t) => t.integer('id').primary());
    await db.schema.createTable('events', (t) => t.integer('id').primary());
    await db.schema.createTable('activity_logs', (t) => {
      t.increments(); t.integer('event_id'); t.string('activity_type'); t.string('actor_type');
      t.string('actor_id'); t.string('actor_name'); t.text('metadata'); t.timestamp('created_at');
    });
    await db('admin_users').insert({ id: 1 });
    await db('events').insert([{ id: 1 }, { id: 2 }]);
    await migration.up(db); await migration.up(db);
    storage = new LocalFsStorage({ root: path.join(dir, 'storage') });
    await storage.init();
    service = createService({ db, storage, sharp });
    image = await service.uploadImage(await sharp({ create: { width: 40, height: 30, channels: 3, background: '#987654' } }).png().toBuffer(), 1);
  });
  afterAll(async () => { if (db) await db.destroy(); if (dir) await fs.rm(dir, { recursive: true, force: true }); });
  beforeEach(async () => {
    await db('album_product_choice_history').del(); await db('event_album_products').del(); await db('activity_logs').del();
    await db('album_product_catalogue').where({ id: 1 }).update({ revision: 0, products: '[]' });
    product = { id: uuid(), name: 'Layflat album', description: '', active: true,
      models: [{ id: uuid(), name: 'Portrait', imageId: image.id, active: true }],
      colours: [{ id: uuid(), name: 'Sand', imageId: image.id, active: true, modelIds: [] }] };
    product = V.products([product])[0];
    await service.saveCatalogue({ revision: 0, products: [product] });
  });
  const choose = (offer, extra = {}) => service.mutate(event, { id: offer.id, revision: offer.revision,
    mutationId: uuid(), productVersion: V.hash(product), modelId: product.models[0].id,
    colourId: product.colours[0].id, submit: true, ...extra }, client);

  test('catalogue conflicts preserve another editor; unknown images are rejected', async () => {
    await expect(service.saveCatalogue({ revision: 0, products: [] })).rejects.toMatchObject({ statusCode: 409 });
    const changed = structuredClone(product); changed.models[0].imageId = uuid();
    await expect(service.saveCatalogue({ revision: 1, products: [changed] })).rejects.toMatchObject({ statusCode: 400 });
    expect((await service.catalogue()).products).toEqual([product]);
  });
  test('strict validation rejects malformed identifiers, compatibility and missing images', () => {
    for (const change of [(p) => { p.id = '../escape'; }, (p) => { p.colours[0].modelIds = 'all'; },
      (p) => { p.colours[0].modelIds = [uuid()]; }, (p) => { p.models[0].imageId = null; },
      (p) => { p.name = 'bad\ntext'; }, (p) => { p.colours[0].id = p.models[0].id; }]) {
      const p = structuredClone(product); change(p); expect(() => V.products([p])).toThrow();
    }
  });
  test('assignment is idempotent; another gallery cannot fetch its images or choices', async () => {
    const offer = await service.assign(1, product.id);
    expect((await service.assign(1, product.id)).id).toBe(offer.id);
    await expect(service.offer(2, offer.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.clientImage(2, image.id)).rejects.toMatchObject({ statusCode: 404 });
    expect((await service.clientImage(1, image.id)).id).toBe(image.id);
  });
  test('submission retries produce one immutable history entry and one notification', async () => {
    const offer = await service.assign(1, product.id), mutationId = uuid();
    const saved = await choose(offer, { mutationId });
    expect(saved.status).toBe('submitted'); expect(saved.revision).toBe(2);
    expect((await choose(offer, { mutationId })).revision).toBe(2);
    expect((await choose(saved)).revision).toBe(2);
    expect(await db('activity_logs')).toHaveLength(1);
    expect(await service.history(1, offer.id)).toHaveLength(1);
    await expect(choose(offer)).rejects.toMatchObject({ statusCode: 409 });
  });
  test('a retry identifier belonging to another actor cannot be replayed', async () => {
    const offer = await service.assign(1, product.id), mutationId = uuid(); await choose(offer, { mutationId });
    await expect(service.mutate(event, { id: offer.id, revision: 1, mutationId }, { ...client, id: 'other' }))
      .rejects.toMatchObject({ statusCode: 409 });
  });
  test('locks require a submission; locked snapshots survive removal and block edits', async () => {
    const offer = await service.assign(1, product.id);
    await expect(service.mutate(event, { id: offer.id, revision: 1, mutationId: uuid(), action: 'lock' }, admin, { admin: true }))
      .rejects.toMatchObject({ statusCode: 409 });
    const submitted = await choose(offer);
    const locked = await service.mutate(event, { id: offer.id, revision: submitted.revision, mutationId: uuid(), action: 'lock' }, admin, { admin: true });
    await expect(choose(locked)).rejects.toMatchObject({ statusCode: 403 });
    await service.saveCatalogue({ revision: 1, products: [] });
    const [visible] = await service.clientOffers(1);
    expect(visible.product).toBeNull(); expect(visible.selection.model.name).toBe('Portrait');
    expect((await service.clientImage(1, image.id)).id).toBe(image.id);
    expect((await service.history(1, offer.id))[1].selection).toEqual(submitted.selection);
  });
  test('catalogue changes invalidate stale picks and prevent locking an outdated choice', async () => {
    const offer = await service.assign(1, product.id), submitted = await choose(offer);
    const changed = structuredClone(product); changed.models[0].name = 'Landscape';
    await service.saveCatalogue({ revision: 1, products: [changed] });
    await expect(choose(submitted)).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.mutate(event, { id: offer.id, revision: 2, mutationId: uuid(), action: 'lock' }, admin, { admin: true })).rejects.toThrow(/changed/);
  });
  test('hidden offers immediately withdraw image access and edits', async () => {
    const offer = await service.assign(1, product.id);
    const hidden = await service.mutate(event, { id: offer.id, revision: 1, mutationId: uuid(), enabled: false }, admin, { admin: true });
    expect(await service.clientOffers(1)).toEqual([]);
    await expect(service.clientImage(1, image.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(choose(hidden)).rejects.toMatchObject({ statusCode: 403 });
  });
  test('required-key recovery inventory includes private product images', async () => {
    const row = await service.image(image.id);
    const refs = await require('../../src/services/recoveryFiles').requiredKeys(new Map([['album_product_images', [row]]]), () => true);
    expect([...refs]).toEqual([row.storage_key]);
  });
  test('uploads normalize real PNG bytes under generated keys', async () => {
    const row = await service.image(image.id), chunks = [];
    for await (const chunk of await storage.get(row.storage_key)) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    expect((await sharp(bytes).metadata()).format).toBe('png'); expect(V.hash(bytes)).toBe(row.sha256);
    await expect(service.uploadImage(Buffer.from('<svg/>'), 1)).rejects.toMatchObject({ statusCode: 400 });
  });
});
