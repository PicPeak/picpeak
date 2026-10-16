/**
 * The person rows of an event on PostgreSQL (issue 2108).
 *
 * - Two scans of one event: a re-scan rebuilt the people its old faces
 *   belonged to (person row locks) and then waited for the event's clustering
 *   lock (pg_advisory_xact_lock(1074, event)), which a second scan held while
 *   writing those same people. The re-scan now takes the clustering lock
 *   before it rebuilds them.
 * - A merge against a scan rebuilding the same people: the merge takes a key
 *   share on its target (moving the faces) before it deletes the sources, a
 *   scan locks them in its own order. No single order fits every scan, so a
 *   merge that loses the deadlock runs once more.
 * - Auto-categorisation applies a rule only while the photo still carries the
 *   scan result it was matched against.
 *
 * Gated on PICPEAK_PG_TEST_URL; runs the core migrations in a schema of its
 * own and drops it afterwards. Not run locally.
 */
const pgUrl = process.env.PICPEAK_PG_TEST_URL;

let mockPreviewBuffer;
const held = [];
const unit = () => Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0));

(pgUrl ? describe : describe.skip)('face people lock order on PostgreSQL (issue 2108)', () => {
  let owner; let db; let teardown;
  let faceProcessor; let faceQueue; let clustering; let autoCategories;
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
    jest.doMock('../../src/services/storage', () => ({
      getStorage: () => ({ get: async () => mockPreviewBuffer }),
    }));
    jest.doMock('../../src/services/faceClient', () => ({
      detectFaces: async () => ({
        model_version: 'test-v1',
        faces: [{ bbox: [10, 10, 50, 60], score: 0.99, yaw: 0, pitch: 0, blur: 500, embedding: unit() }],
      }),
      SidecarUnavailableError: class extends Error {},
    }));

    ({ owner, db, teardown } = await require('./helpers/pgLockOrder').bootPgSchema(pgUrl, 'people_lock'));
    await db('feature_flags').insert({ key: 'faces', value: true })
      .onConflict('key').merge()
      .catch(async () => { await db('feature_flags').where({ key: 'faces' }).update({ value: true }); });
    await db('app_settings').where('setting_key', 'face_auto_categorize_enabled')
      .update({ setting_value: JSON.stringify(true) });
    faceProcessor = require('../../src/services/faceProcessor');
    faceQueue = require('../../src/services/faceQueue');
    clustering = require('../../src/services/faceClustering');
    autoCategories = require('../../src/services/faceAutoCategories');
  }, 180000);

  afterAll(async () => { if (teardown) await teardown(); });

  afterEach(() => { while (held.length) held.pop()(); });

  // processPhotoFaces takes the claimed row once the claim guard of issue
  // 2069 is in, and the photo id before it.
  const scanArg = (claimed) => (faceProcessor.claimGuard ? claimed : claimed.id);

  async function person(eventId) {
    const [row] = await db('event_people').insert({
      event_id: eventId,
      centroid: clustering.packEmbedding(unit()),
      face_count_total: 1,
      model_version: 'test-v1',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).returning('id');
    return typeof row === 'object' ? row.id : row;
  }

  async function face(eventId, photoId, personId) {
    const [row] = await db('photo_faces').insert({
      photo_id: photoId, event_id: eventId, person_id: personId,
      bbox_x: 1, bbox_y: 1, bbox_w: 400, bbox_h: 400, det_score: 0.99, blur: 500,
      embedding: clustering.packEmbedding(unit()), model_version: 'test-v1', created_at: new Date().toISOString(),
    }).returning('id');
    return typeof row === 'object' ? row.id : row;
  }

  test('a re-scan waits for the clustering lock before it rebuilds its old people', async () => {
    const eventId = await seedEvent(db, { face_recognition_enabled: true });
    const photoId = await seedPhoto(db, eventId, { face_status: 'pending' });
    const old = await person(eventId);
    await face(eventId, photoId, old);

    // A second scan inside assignFaces: the clustering lock, then a write to
    // a person its faces matched.
    const other = heldTransaction(db, held,
      (trx) => trx.raw('SELECT pg_advisory_xact_lock(?, ?)', [1074, Number(eventId)]),
      (trx) => trx('event_people').where({ id: old }).update({ updated_at: new Date().toISOString() }));
    await other.locked;

    const scan = faceProcessor.processPhotoFaces(scanArg(await faceQueue.claimNextPhoto()));
    // Waits for the clustering lock, without holding the old person.
    await blockedOnLock(owner, scan);

    other.release();
    await expect(other.done).resolves.toBeUndefined();
    await expect(scan).resolves.toMatchObject({ status: 'done', faceCount: 1 });
    expect(await db('photo_faces').where({ photo_id: photoId }).count({ c: '*' }).first()).toEqual({ c: '1' });
  });

  test('a merge that loses a deadlock to a scan runs again and lands', async () => {
    const eventId = await seedEvent(db, { face_recognition_enabled: true });
    const source = await person(eventId);
    const target = await person(eventId);
    const moved = await face(eventId, await seedPhoto(db, eventId, { face_status: 'done', face_count: 1 }), source);
    await face(eventId, await seedPhoto(db, eventId, { face_status: 'done', face_count: 1 }), target);

    // A scan rebuilding both people: it updates the source first, and then
    // takes the target the way deleting an emptied person does.
    const scan = heldTransaction(db, held,
      (trx) => trx('event_people').where({ id: source }).update({ updated_at: new Date().toISOString() }),
      (trx) => trx('event_people').where({ id: target }).forUpdate().first());
    await scan.locked;

    // Moves the face (key share on the target), then waits to delete the source.
    const merge = clustering.mergePeople(eventId, [source], target);
    await blockedOnLock(owner, merge);

    // Closes the cycle. The merge has waited longer, so PostgreSQL's deadlock
    // check aborts it; the retry then waits for the scan to commit.
    scan.release();
    await expect(scan.done).resolves.toBeUndefined();
    await expect(merge).resolves.toEqual({ moved: 1 });
    expect(await db('event_people').where({ id: source }).first()).toBeUndefined();
    expect(await db('photo_faces').where({ id: moved }).first()).toMatchObject({ person_id: target });
  });

  test('auto-categorisation skips a photo re-queued after it was read', async () => {
    const eventId = await seedEvent(db);
    const photoId = await seedPhoto(db, eventId, { face_status: 'done', face_count: 3 });

    // A purge or re-queue landing between the engine's read and its write.
    const requeue = heldTransaction(db, held,
      (trx) => trx('photos').where({ id: photoId }).update({ face_status: 'pending' }));
    await requeue.locked;

    const run = autoCategories.categorizeEvent(eventId);
    // The write waits on the row; PostgreSQL re-checks its conditions once
    // the re-queue commits.
    await blockedOnLock(owner, run);
    requeue.release();
    await requeue.done;

    await expect(run).resolves.toMatchObject({ assigned: 0 });
    expect(await db('photos').where({ id: photoId }).first()).toMatchObject({ category_id: null, face_status: 'pending' });
  });
});
