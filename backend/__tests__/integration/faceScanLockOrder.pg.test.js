/**
 * Face scan commit vs. purges on PostgreSQL (issue 2069): the lock order.
 *
 * A scan with faces to insert takes the event row (key share, which their
 * foreign keys need anyway), then checks its claim, which locks the photo
 * row, and the purges
 * invalidate the photo before they touch its faces. So everything takes
 * event, photo, faces, in that order. Checked last, an event purge could delete the
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
let openGate = null;
// Which seam parks the scan: 'assign' (assignFaces) or 'people' (the
// people lock, taken right after the claim check, before any face row).
let mockGateAt = 'assign';
// One-hot embeddings by index: the same index is the same person.
let mockFaces = [0];
// Resolvers of transactions a test holds open; released if it fails early.
const held = [];

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
    // get() serves the preview; anything else (an event delete's sweeps)
    // is a no-op.
    jest.doMock('../../src/services/storage', () => ({
      getStorage: () => new Proxy({ get: async () => mockPreviewBuffer, kind: () => 'local' }, {
        get: (target, key) => (key in target ? target[key] : (key === 'then' ? undefined : async () => null)),
      }),
    }));
    jest.doMock('../../src/services/faceClient', () => ({
      detectFaces: async () => ({
        model_version: 'test-v1',
        faces: mockFaces.map((n, k) => ({
          bbox: [10 + k * 100, 10, 50, 60], score: 0.99, yaw: 0, pitch: 0, blur: 500,
          embedding: Array.from({ length: 64 }, (_, i) => (i === n ? 1 : 0)),
        })),
      }),
      SidecarUnavailableError: class extends Error {},
    }));
    jest.doMock('../../src/services/faceClustering', () => {
      const actual = jest.requireActual('../../src/services/faceClustering');
      const park = async (at) => {
        if (mockGate && mockGateAt === at) {
          mockReached();
          await mockGate;
        }
      };
      return {
        ...actual,
        assignFaces: async (...args) => {
          await park('assign');
          return actual.assignFaces(...args);
        },
        lockEventPeople: async (...args) => {
          await park('people');
          return actual.lockEventPeople(...args);
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
    mockGateAt = 'assign';
    mockFaces = [0];
  });

  // A failed assertion must not leave a scan parked with its locks held.
  afterEach(() => {
    if (openGate) openGate();
    openGate = null; mockGate = null;
    while (held.length) held.pop()();
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
    mockGate = new Promise((resolve) => { openGate = resolve; });
    const reached = new Promise((resolve) => { mockReached = resolve; });
    const claimed = await faceQueue.claimNextPhoto();
    const scan = faceProcessor.processPhotoFaces(claimed);
    // A scan that fails before the gate surfaces here instead of hanging.
    await Promise.race([reached, scan.then(() => { throw new Error('scan finished before the gate'); })]);
    return { scan, release: () => { mockGate = null; openGate(); openGate = null; } };
  }

  // Resolves once `promise` is waiting on a row lock (not merely slow), and
  // fails if it settles first. Counts lock waits across the database: the
  // suite expects a PostgreSQL of its own, as the other *.pg tests do.
  // `waitEvent` narrows it to one kind of lock ('advisory', 'tuple', ...).
  async function blockedOnLock(promise, waitEvent = null) {
    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });
    for (let i = 0; i < 100; i += 1) {
      if (settled) throw new Error('expected to wait on a lock, but it finished');
      const { rows } = await owner.raw(
        'select count(*)::int as n from pg_stat_activity where wait_event_type = \'Lock\' and datname = current_database()'
          + (waitEvent ? ' and wait_event = ?' : ''),
        waitEvent ? [waitEvent] : [],
      );
      if (rows[0].n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('never observed a lock wait');
  }

  test('an event purge waits for a scan in its transaction and then erases its faces', async () => {
    const { eventId, photoId } = await seed();
    const { scan, release } = await parkScan();

    const purge = faceProcessor.purgeEvent(eventId);
    // Blocked on the photo row the scan's claim check locked.
    await blockedOnLock(purge);

    release();
    await expect(scan).resolves.toMatchObject({ status: 'done' });
    await purge;

    expect(await db('photo_faces').where({ photo_id: photoId }).count({ c: '*' }).first()).toEqual({ c: '0' });
    expect(await db('event_people').where({ event_id: eventId }).count({ c: '*' }).first()).toEqual({ c: '0' });
    expect(await db('photos').where({ id: photoId }).first()).toMatchObject({ face_status: null, face_attempt_id: null });
  });

  test('a scan and a capped trash restore holding the event row do not deadlock', async () => {
    const { eventId, photoId } = await seed();
    const claimed = await faceQueue.claimNextPhoto();

    // What photoTrash.restorePhotos does in a capped gallery: the event row
    // FOR UPDATE, then the photo. Held open between the two.
    let holdEvent; let eventLocked;
    const hold = new Promise((resolve) => { holdEvent = resolve; held.push(resolve); });
    const locked = new Promise((resolve) => { eventLocked = resolve; });
    const restore = db.transaction(async (trx) => {
      await trx('events').where({ id: eventId }).forUpdate().first();
      eventLocked();
      await hold;
      await trx('photos').where({ id: photoId }).update({ deleted_at: null, purge_after: null });
    });
    await locked;

    const scan = faceProcessor.processPhotoFaces(claimed);
    // Waits for the event row, without holding the photo.
    await blockedOnLock(scan);

    holdEvent();
    await expect(restore).resolves.toBeUndefined();
    await expect(scan).resolves.toMatchObject({ status: 'done' });
    expect(await db('photos').where({ id: photoId }).first()).toMatchObject({ face_status: 'done', face_count: 1 });
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
    await blockedOnLock(refresh);

    release();
    await expect(scan).resolves.toMatchObject({ status: 'done' });
    await expect(refresh).resolves.toBeUndefined();

    expect(await db('photo_faces').where({ photo_id: photoId }).count({ c: '*' }).first()).toEqual({ c: '0' });
    expect(await db('photos').where({ id: photoId }).first()).toMatchObject({ face_status: 'pending' });
  });

  test('an event delete and a no-face re-scan holding its photo do not deadlock', async () => {
    const { eventId, photoId } = await seed();
    // A first scan leaves a face and a person behind for the re-scan to drop.
    await faceProcessor.processPhotoFaces(await faceQueue.claimNextPhoto());
    await db('photos').where({ id: photoId }).update({ face_status: 'pending' });

    // The re-scan finds nobody: it takes no event lock, holds its photo, and
    // parks before it deletes the old face.
    mockFaces = [];
    mockGateAt = 'people';
    const { scan, release } = await parkScan();

    const { deleteEventCascade } = require('../../src/routes/adminEvents/helpers');
    const remove = deleteEventCascade(eventId, { id: null });
    // Waits for the scan's photo before it touches the faces.
    await blockedOnLock(remove);

    release();
    await expect(scan).resolves.toMatchObject({ status: 'done' });
    await expect(remove).resolves.toBeDefined();
    expect(await db('events').where({ id: eventId }).first()).toBeUndefined();
    expect(await db('photo_faces').where({ event_id: eventId }).count({ c: '*' }).first()).toEqual({ c: '0' });
    expect(await db('event_people').where({ event_id: eventId }).count({ c: '*' }).first()).toEqual({ c: '0' });
  });

  test('a merge of people waits for a scan rewriting them instead of deadlocking', async () => {
    const { eventId, photoId } = await seed();
    // Photo P shows people A and B; a second photo Q shows B again.
    mockFaces = [0, 1];
    await faceProcessor.processPhotoFaces(await faceQueue.claimNextPhoto());
    const [q] = await db('photos').insert({
      event_id: eventId, filename: 'q.jpg', path: '/tmp/q.jpg', type: 'individual',
      width: 1920, height: 1440, processing_status: 'complete', face_status: 'pending',
    }).returning('id');
    mockFaces = [1];
    await faceProcessor.processPhotoFaces(await faceQueue.claimNextPhoto());
    // And a third photo R shows A again, so the re-scan of P below rebuilds
    // A rather than deleting it (and the merge target keeps its id).
    await db('photos').insert({
      event_id: eventId, filename: 'r.jpg', path: '/tmp/r.jpg', type: 'individual',
      width: 1920, height: 1440, processing_status: 'complete', face_status: 'pending',
    });
    mockFaces = [0];
    await faceProcessor.processPhotoFaces(await faceQueue.claimNextPhoto());
    const people = await db('photo_faces').where({ photo_id: photoId }).orderBy('bbox_x').pluck('person_id');
    expect(new Set(people).size).toBe(2);
    expect(await db('photo_faces').where({ photo_id: typeof q === 'object' ? q.id : q }).first('person_id'))
      .toEqual({ person_id: people[1] });

    // P is re-scanned and parks holding the people lock, its old faces
    // deleted and its people rebuilt.
    await db('photos').where({ id: photoId }).update({ face_status: 'pending' });
    mockFaces = [0, 1];
    const { scan, release } = await parkScan();

    const { mergePeople } = jest.requireActual('../../src/services/faceClustering');
    const merge = mergePeople(eventId, [people[1]], people[0]);
    // On the people lock, before it has moved a single face.
    await blockedOnLock(merge, 'advisory');

    release();
    await expect(scan).resolves.toMatchObject({ status: 'done' });
    await expect(merge).resolves.toBeDefined();
    // Everyone ends up in A.
    expect(await db('event_people').where({ id: people[1] }).first()).toBeUndefined();
    expect(new Set(await db('photo_faces').where({ event_id: eventId }).pluck('person_id'))).toEqual(new Set([people[0]]));
  });
});
