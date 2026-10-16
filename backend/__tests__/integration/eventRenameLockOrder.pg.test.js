/**
 * Event rename vs. the writers of an event's photos, on PostgreSQL (issue
 * 2108).
 *
 * The rename changes the slug, which has a unique index, so its event update
 * takes the row FOR UPDATE, and every child insert of the event takes a key
 * share on it through the foreign key. The rename used to rewrite the photo
 * rows first and reach the event last; a face scan inserting faces holds the
 * event (key share) and then updates its photo, so each waited for the other.
 * The rename now takes the event row before the photos.
 *
 * That turns one older writer around: the shared colour tag locked its photo
 * and then inserted the tag row (key share on the event). It now takes the
 * event first as well, so the rename and a guest's tap serialise on it. And
 * deleting a gallery's hero photo updates the event row through the
 * hero_photo_id foreign key after it has locked the photo: the delete now
 * takes that event row first.
 *
 * Gated on PICPEAK_PG_TEST_URL; runs the core migrations in a schema of its
 * own and drops it afterwards. Not run locally.
 */
const pgUrl = process.env.PICPEAK_PG_TEST_URL;

let mockPreviewBuffer;
// assignFaces runs inside the scan transaction, after the face rows are
// written: a scan parked here holds the event (key share) and its photo.
let mockGate = null;
let mockReached = null;
let openGate = null;
const held = [];

(pgUrl ? describe : describe.skip)('event rename lock order on PostgreSQL (issue 2108)', () => {
  let owner; let db; let teardown;
  let faceProcessor; let faceQueue; let renameService; let feedbackService; let photoTrash;
  let blockedOnLock; let heldTransaction; let seedEvent; let seedPhoto;

  beforeAll(async () => {
    ({ blockedOnLock, heldTransaction, seedEvent, seedPhoto } = require('./helpers/pgLockOrder'));
    const sharp = require('sharp');
    mockPreviewBuffer = await sharp({
      create: { width: 1920, height: 1440, channels: 3, background: { r: 20, g: 40, b: 80 } },
    }).jpeg().toBuffer();
    jest.doMock('../../src/services/imageProcessor', () => ({
      ...jest.requireActual('../../src/services/imageProcessor'),
      ensurePreviewImage: async () => 'previews/preview_test.jpg',
    }));
    // Local backend with no files: the folder rename finds nothing to move.
    jest.doMock('../../src/services/storage', () => ({
      getStorage: () => ({
        kind: () => 'local',
        get: async () => mockPreviewBuffer,
        exists: async () => false,
        list: async () => [],
        delete: async () => {},
        rename: async () => {},
        stat: async () => ({}),
      }),
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

    ({ owner, db, teardown } = await require('./helpers/pgLockOrder').bootPgSchema(pgUrl, 'rename_lock'));
    await db('feature_flags').insert({ key: 'faces', value: true })
      .onConflict('key').merge()
      .catch(async () => { await db('feature_flags').where({ key: 'faces' }).update({ value: true }); });
    faceProcessor = require('../../src/services/faceProcessor');
    faceQueue = require('../../src/services/faceQueue');
    renameService = require('../../src/services/eventRenameService');
    feedbackService = require('../../src/services/feedbackService');
    photoTrash = require('../../src/services/photoTrash');
  }, 180000);

  afterAll(async () => { if (teardown) await teardown(); });

  afterEach(() => {
    if (openGate) openGate();
    openGate = null; mockGate = null;
    while (held.length) held.pop()();
  });

  // processPhotoFaces takes the claimed row once the claim guard of issue
  // 2069 is in, and the photo id before it.
  const scanArg = (claimed) => (faceProcessor.claimGuard ? claimed : claimed.id);

  test('a rename and a face scan that holds the event do not deadlock', async () => {
    // The rename rebuilds the share link from the token.
    const eventId = await seedEvent(db, { face_recognition_enabled: true, share_token: 'rename-lock-share' });
    const photoId = await seedPhoto(db, eventId, { face_status: 'pending' });

    mockGate = new Promise((resolve) => { openGate = resolve; });
    const reached = new Promise((resolve) => { mockReached = resolve; });
    const scan = faceProcessor.processPhotoFaces(scanArg(await faceQueue.claimNextPhoto()));
    await Promise.race([reached, scan.then(() => { throw new Error('scan finished before the gate'); })]);

    const rename = renameService.renameEvent(eventId, 'Renamed Gallery');
    // Waits for the event row, without holding the photo.
    await blockedOnLock(owner, rename);

    mockGate = null; openGate(); openGate = null;
    await expect(scan).resolves.toMatchObject({ status: 'done' });
    await expect(rename).resolves.toMatchObject({ success: true });

    const event = await db('events').where({ id: eventId }).first();
    expect(event.event_name).toBe('Renamed Gallery');
    expect(await db('photos').where({ id: photoId }).first()).toMatchObject({ face_status: 'done', face_count: 1 });
  });

  test('a rename holding the event and a shared colour tag do not deadlock', async () => {
    const eventId = await seedEvent(db);
    const photoId = await seedPhoto(db, eventId);

    // The rename's order: the event row FOR UPDATE, then the photo.
    const rename = heldTransaction(db, held,
      (trx) => trx('events').where({ id: eventId }).forUpdate().first(),
      (trx) => trx('photos').where({ id: photoId }).update({ path: '/tmp/renamed.jpg' }));
    await rename.locked;

    const tag = feedbackService.submitSharedColorLabel(photoId, eventId, 'red', { ip_address: '127.0.0.1' });
    // Waits for the event row, without holding the photo.
    await blockedOnLock(owner, tag);

    rename.release();
    await expect(rename.done).resolves.toBeUndefined();
    await expect(tag).resolves.toMatchObject({ created: true, shared: true });
    expect(await db('photos').where({ id: photoId }).first()).toMatchObject({ path: '/tmp/renamed.jpg' });
  });

  test('a rename holding the event and the delete of its hero photo do not deadlock', async () => {
    const eventId = await seedEvent(db);
    const photoId = await seedPhoto(db, eventId);
    await db('events').where({ id: eventId }).update({ hero_photo_id: photoId });
    const photo = await db('photos').where({ id: photoId }).first();
    const event = await db('events').where({ id: eventId }).first();

    // The rename's order: the event row FOR UPDATE, then the photo.
    const rename = heldTransaction(db, held,
      (trx) => trx('events').where({ id: eventId }).forUpdate().first(),
      (trx) => trx('photos').where({ id: photoId }).update({ path: '/tmp/renamed.jpg' }));
    await rename.locked;

    const removal = photoTrash.deletePhotoForGood(event, photo);
    // Waits for the event row, without holding the photo.
    await blockedOnLock(owner, removal);

    rename.release();
    await expect(rename.done).resolves.toBeUndefined();
    await expect(removal).resolves.toBeUndefined();
    expect(await db('photos').where({ id: photoId }).first()).toBeUndefined();
    expect(await db('events').where({ id: eventId }).first()).toMatchObject({ hero_photo_id: null });
  });
});
