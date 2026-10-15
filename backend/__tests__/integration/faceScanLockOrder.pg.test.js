/**
 * Face scan commit vs. purges on PostgreSQL (issue 2069): the lock order.
 *
 * The scan checks its claim FIRST in its transaction, which locks the photo
 * row, and the purges invalidate the photo before they touch its faces. So
 * both take photo, then faces. Checked last, an event purge could delete the
 * faces, the scan commit new ones and the purge then only clear the status
 * (the erasure does not stick), and an external refresh holding the photo
 * could deadlock with a scan holding the photo's old face rows.
 *
 * Gated on PICPEAK_PG_TEST_URL; runs the core migrations in a schema of its
 * own and drops it afterwards.
 */
const knex = require('knex');
const { randomUUID } = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const pgUrl = process.env.PICPEAK_PG_TEST_URL;

let mockPreviewBuffer;
// assignFaces runs inside the scan transaction, after the claim check: a
// scan parked here holds whatever locks it has taken so far.
let mockGate = null;
let mockReached = null;

(pgUrl ? describe : describe.skip)('face scan lock order on PostgreSQL (issue 2069)', () => {
  let owner; let db; let schema; let tmpDir; let cleanup; let previousClient;
  let faceProcessor; let faceQueue;

  beforeAll(async () => {
    schema = `face_lock_${randomUUID().replace(/-/g, '')}`;
    owner = knex({ client: 'pg', connection: pgUrl });
    await owner.schema.createSchema(schema);
    previousClient = process.env.DATABASE_CLIENT;
    process.env.DATABASE_CLIENT = 'pg';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'face-lock-order-pg-test-secret-at-least-32-characters';
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-face-lock-pg-'));
    process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
    jest.doMock('../../knexfile', () => ({ client: 'pg', connection: pgUrl, searchPath: [schema] }));

    const sharp = require('sharp');
    mockPreviewBuffer = await sharp({
      create: { width: 1920, height: 1440, channels: 3, background: { r: 20, g: 40, b: 80 } },
    }).jpeg().toBuffer();
    jest.doMock('../../src/services/imageProcessor', () => ({
      ...jest.requireActual('../../src/services/imageProcessor'),
      ensurePreviewImage: async () => 'previews/preview_test.jpg',
    }));
    jest.doMock('../../src/services/storage', () => ({
      getStorage: () => ({ get: async () => mockPreviewBuffer }),
    }));
    jest.doMock('../../src/services/faceClient', () => ({
      detectFaces: async () => ({
        model_version: 'test-v1',
        faces: [{
          bbox: [10, 10, 50, 60], score: 0.99, yaw: 0, pitch: 0, blur: 500,
          embedding: Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0)),
        }],
      }),
      SidecarUnavailableError: class extends Error {},
    }));
    jest.doMock('../../src/services/faceClustering', () => {
      const actual = jest.requireActual('../../src/services/faceClustering');
      return {
        ...actual,
        assignFaces: async (...args) => {
          if (mockGate) {
            mockReached();
            await mockGate;
          }
          return actual.assignFaces(...args);
        },
      };
    });

    ({ db } = require('../../src/database/db'));
    ({ cleanup } = await require('./helpers/crmDb').bootCrmDb());
    await db('feature_flags').insert({ key: 'faces', value: true })
      .onConflict('key').merge()
      .catch(async () => { await db('feature_flags').where({ key: 'faces' }).update({ value: true }); });
    faceProcessor = require('../../src/services/faceProcessor');
    faceQueue = require('../../src/services/faceQueue');
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup(); else if (db) await db.destroy();
    if (owner) { await owner.schema.dropSchema(schema, true); await owner.destroy(); }
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    if (previousClient === undefined) delete process.env.DATABASE_CLIENT; else process.env.DATABASE_CLIENT = previousClient;
    jest.dontMock('../../knexfile');
  });

  beforeEach(async () => {
    await db('photo_faces').del();
    await db('event_people').del();
    await db('photos').del();
    mockGate = null;
  });

  async function seed() {
    const [e] = await db('events').insert({
      slug: `lock-${randomUUID().slice(0, 8)}`,
      event_type: 'wedding',
      event_name: 'lock',
      event_date: '2026-01-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: `lock-${randomUUID()}`,
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      face_recognition_enabled: true,
    }).returning('id');
    const eventId = typeof e === 'object' ? e.id : e;
    const [p] = await db('photos').insert({
      event_id: eventId, filename: 'p.jpg', path: '/tmp/p.jpg', type: 'individual',
      width: 1920, height: 1440, processing_status: 'complete', face_status: 'pending',
    }).returning('id');
    return { eventId, photoId: typeof p === 'object' ? p.id : p };
  }

  // Starts a scan and returns once it is parked inside its transaction.
  async function parkScan() {
    let open;
    mockGate = new Promise((resolve) => { open = resolve; });
    const reached = new Promise((resolve) => { mockReached = resolve; });
    const claimed = await faceQueue.claimNextPhoto();
    const scan = faceProcessor.processPhotoFaces(claimed);
    await reached;
    return { scan, release: () => { mockGate = null; open(); } };
  }

  const settledWithin = (promise, ms) => Promise.race([
    promise.then(() => true, () => true),
    new Promise((resolve) => setTimeout(() => resolve(false), ms)),
  ]);

  test('an event purge waits for a scan in its transaction and then erases its faces', async () => {
    const { eventId, photoId } = await seed();
    const { scan, release } = await parkScan();

    const purge = faceProcessor.purgeEvent(eventId);
    // Blocked on the photo row the scan's claim check locked.
    expect(await settledWithin(purge, 500)).toBe(false);

    release();
    await expect(scan).resolves.toMatchObject({ status: 'done' });
    await purge;

    expect(await db('photo_faces').where({ photo_id: photoId }).count({ c: '*' }).first()).toEqual({ c: '0' });
    expect(await db('event_people').where({ event_id: eventId }).count({ c: '*' }).first()).toEqual({ c: '0' });
    expect(await db('photos').where({ id: photoId }).first()).toMatchObject({ face_status: null, face_attempt_id: null });
  });

  test('an external refresh and a re-scan holding the old faces do not deadlock', async () => {
    const { photoId } = await seed();
    // A first scan, so the re-scan below has old face rows to delete (and lock).
    await faceProcessor.processPhotoFaces(await faceQueue.claimNextPhoto());
    await db('photos').where({ id: photoId }).update({ face_status: 'pending' });

    const { scan, release } = await parkScan();

    // What externalImportService does for a file edited in place: the photo
    // first, then its faces.
    const refresh = db.transaction(async (trx) => {
      await trx('photos').where({ id: photoId }).update({ size_bytes: 2 });
      await faceProcessor.purgePhotoFaces(photoId, trx);
      await trx('photos').where({ id: photoId }).update({ face_status: 'pending' });
    });
    expect(await settledWithin(refresh, 500)).toBe(false);

    release();
    await expect(scan).resolves.toMatchObject({ status: 'done' });
    await expect(refresh).resolves.toBeUndefined();

    expect(await db('photo_faces').where({ photo_id: photoId }).count({ c: '*' }).first()).toEqual({ c: '0' });
    expect(await db('photos').where({ id: photoId }).first()).toMatchObject({ face_status: 'pending' });
  });
});
