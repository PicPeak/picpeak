/**
 * "Delete all face data" (faceProcessor.purgeEvent) vs. the transactions that
 * hold the event row FOR UPDATE before they touch its photos, on PostgreSQL
 * (issue 2108): a capped trash restore and an archive delete.
 *
 * The purge used to rewrite faces, people and photos and update the event
 * row last; holding the event, the other side then waited for a photo or a
 * face row the purge held. The purge now takes the event row first (NO KEY
 * UPDATE, the lock its own update takes), so the two serialise on it.
 *
 * Gated on PICPEAK_PG_TEST_URL; runs the core migrations in a schema of its
 * own and drops it afterwards. Not run locally.
 */
const pgUrl = process.env.PICPEAK_PG_TEST_URL;

// photoTrash.restorePhotos counts the gallery's photos after it has locked
// the event and before it touches a photo: a restore parked here holds the
// event row FOR UPDATE.
let mockGate = null;
let mockReached = null;
let openGate = null;
const held = [];

(pgUrl ? describe : describe.skip)('purgeEvent lock order on PostgreSQL (issue 2108)', () => {
  let owner; let db; let teardown;
  let faceProcessor; let photoTrash;
  let blockedOnLock; let heldTransaction; let seedEvent; let seedPhoto;

  beforeAll(async () => {
    ({ blockedOnLock, heldTransaction, seedEvent, seedPhoto } = require('./helpers/pgLockOrder'));
    jest.doMock('../../src/services/photoCap', () => {
      const actual = jest.requireActual('../../src/services/photoCap');
      return {
        ...actual,
        countEventPhotos: async (...args) => {
          if (mockGate) {
            mockReached();
            await mockGate;
          }
          return actual.countEventPhotos(...args);
        },
      };
    });
    ({ owner, db, teardown } = await require('./helpers/pgLockOrder').bootPgSchema(pgUrl, 'purge_lock'));
    faceProcessor = require('../../src/services/faceProcessor');
    photoTrash = require('../../src/services/photoTrash');
  }, 180000);

  afterAll(async () => { if (teardown) await teardown(); });

  afterEach(() => {
    if (openGate) openGate();
    openGate = null; mockGate = null;
    while (held.length) held.pop()();
  });

  // A scanned photo with one face in one person, and a photo in the trash.
  async function seed() {
    const eventId = await seedEvent(db, { face_recognition_enabled: true, photo_cap: 100 });
    const scanned = await seedPhoto(db, eventId, { face_status: 'done', face_count: 1 });
    const trashed = await seedPhoto(db, eventId, {
      face_status: 'done',
      face_count: 0,
      deleted_at: new Date().toISOString(),
      purge_after: new Date(Date.now() + 86400000).toISOString(),
    });
    const [person] = await db('event_people').insert({
      event_id: eventId, face_count_total: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).returning('id');
    await db('photo_faces').insert({
      photo_id: scanned, event_id: eventId, person_id: typeof person === 'object' ? person.id : person,
      bbox_x: 1, bbox_y: 1, bbox_w: 10, bbox_h: 10, model_version: 'test-v1', created_at: new Date().toISOString(),
    });
    return { eventId, scanned, trashed };
  }

  test('a purge and a capped trash restore holding the event do not deadlock', async () => {
    const { eventId, trashed } = await seed();
    const event = await db('events').where({ id: eventId }).first();

    mockGate = new Promise((resolve) => { openGate = resolve; });
    const reached = new Promise((resolve) => { mockReached = resolve; });
    const restore = photoTrash.restorePhotos(event, [trashed]);
    await Promise.race([reached, restore.then(() => { throw new Error('restore finished before the gate'); })]);

    const purge = faceProcessor.purgeEvent(eventId);
    // Waits for the event row, without holding a photo.
    await blockedOnLock(owner, purge);

    mockGate = null; openGate(); openGate = null;
    await expect(restore).resolves.toEqual({ restored: [trashed], failed: [] });
    await expect(purge).resolves.toEqual({ faces: 1, people: 1 });
    expect(await db('photos').where({ id: trashed }).first()).toMatchObject({ deleted_at: null, face_status: null });
  });

  test('a purge and an archive delete holding the event do not deadlock', async () => {
    const { eventId } = await seed();

    // What the archive delete (adminArchives.js) does: the event row FOR
    // UPDATE, then the event's faces, people and photos.
    const archiveDelete = heldTransaction(db, held,
      (trx) => trx('events').where({ id: eventId }).forUpdate().first(),
      async (trx) => {
        await trx('photo_faces').where('event_id', eventId).del();
        await trx('event_people').where('event_id', eventId).del();
        await trx('photos').where('event_id', eventId).del();
      });
    await archiveDelete.locked;

    const purge = faceProcessor.purgeEvent(eventId);
    await blockedOnLock(owner, purge);

    archiveDelete.release();
    await expect(archiveDelete.done).resolves.toBeUndefined();
    // Nothing left for it by then.
    await expect(purge).resolves.toEqual({ faces: 0, people: 0 });
    expect(await db('photos').where({ event_id: eventId }).count({ c: '*' }).first()).toEqual({ c: '0' });
  });
});
