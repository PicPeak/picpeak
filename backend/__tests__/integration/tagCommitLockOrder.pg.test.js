/**
 * A scene-tag commit vs. the transactions that hold the event row FOR UPDATE
 * before they touch its photos, on PostgreSQL (issue 2108): a capped trash
 * restore and an archive delete.
 *
 * The commit locks its photo through the claim guard and then inserts the tag
 * rows, whose foreign key takes a key share on the event. Holding the event,
 * the other side then waited for the photo. A commit with tags to insert now
 * takes that key share before the photo.
 *
 * Gated on PICPEAK_PG_TEST_URL; runs the core migrations in a schema of its
 * own and drops it afterwards. Not run locally.
 */
const { randomUUID } = require('crypto');

const pgUrl = process.env.PICPEAK_PG_TEST_URL;

// photoTrash.restorePhotos counts the gallery's photos after it has locked
// the event and before it touches a photo: a restore parked here holds the
// event row FOR UPDATE.
let mockGate = null;
let mockReached = null;
let openGate = null;
const held = [];

(pgUrl ? describe : describe.skip)('tag commit lock order on PostgreSQL (issue 2108)', () => {
  let owner; let db; let teardown;
  let tagProcessor; let photoTrash;
  let blockedOnLock; let heldTransaction; let seedEvent; let seedPhoto;

  beforeAll(async () => {
    ({ blockedOnLock, heldTransaction, seedEvent, seedPhoto } = require('./helpers/pgLockOrder'));
    const sharp = require('sharp');
    const thumbnail = await sharp({
      create: { width: 300, height: 200, channels: 3, background: { r: 20, g: 40, b: 80 } },
    }).jpeg().toBuffer();
    jest.doMock('../../src/services/imageProcessor', () => ({
      ...jest.requireActual('../../src/services/imageProcessor'),
      ensureThumbnail: async () => 'thumbnails/thumb_test.jpg',
    }));
    jest.doMock('../../src/services/storage', () => ({
      getStorage: () => ({ get: async () => thumbnail, stat: async () => ({}) }),
    }));
    jest.doMock('../../src/services/faceClient', () => ({
      tagImage: async () => ({ tags: [{ tag: 'beach', score: 0.9 }] }),
      SidecarUnavailableError: class extends Error {},
    }));
    jest.doMock('../../src/services/tagSettings', () => ({
      ...jest.requireActual('../../src/services/tagSettings'),
      isEnabledForEvent: async () => true,
    }));
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
    ({ owner, db, teardown } = await require('./helpers/pgLockOrder').bootPgSchema(pgUrl, 'tag_lock'));
    tagProcessor = require('../../src/services/tagProcessor');
    photoTrash = require('../../src/services/photoTrash');
  }, 180000);

  afterAll(async () => { if (teardown) await teardown(); });

  afterEach(() => {
    if (openGate) openGate();
    openGate = null; mockGate = null;
    while (held.length) held.pop()();
  });

  // A photo claimed for tagging, the way tagQueue.claimNextPhoto leaves it.
  async function claimed(eventId, extra = {}) {
    const attemptId = randomUUID();
    const id = await seedPhoto(db, eventId, {
      tag_status: 'processing', tag_started_at: new Date().toISOString(), tag_attempt_id: attemptId, ...extra,
    });
    return db('photos').where({ id }).first();
  }

  test('a tag commit and a capped trash restore holding the event do not deadlock', async () => {
    const eventId = await seedEvent(db, { photo_cap: 100 });
    // Trashed after its claim: the restore and the commit want the same row.
    const photo = await claimed(eventId, {
      deleted_at: new Date().toISOString(),
      purge_after: new Date(Date.now() + 86400000).toISOString(),
    });
    const event = await db('events').where({ id: eventId }).first();

    mockGate = new Promise((resolve) => { openGate = resolve; });
    const reached = new Promise((resolve) => { mockReached = resolve; });
    const restore = photoTrash.restorePhotos(event, [photo.id]);
    await Promise.race([reached, restore.then(() => { throw new Error('restore finished before the gate'); })]);

    const commit = tagProcessor.processPhotoTags(photo);
    // Waits for the event row, without holding the photo.
    await blockedOnLock(owner, commit);

    mockGate = null; openGate(); openGate = null;
    await expect(restore).resolves.toEqual({ restored: [photo.id], failed: [] });
    await expect(commit).resolves.toMatchObject({ status: 'done', tagCount: 1 });
    expect(await db('photo_tags').where({ photo_id: photo.id }).pluck('tag')).toEqual(['beach']);
  });

  test('a tag commit and an archive delete holding the event do not deadlock', async () => {
    const eventId = await seedEvent(db);
    const photo = await claimed(eventId);

    // What the archive delete (adminArchives.js) does: the event row FOR
    // UPDATE, then the photos, then their tags.
    const archiveDelete = heldTransaction(db, held,
      (trx) => trx('events').where({ id: eventId }).forUpdate().first(),
      async (trx) => {
        await trx('photos').where('event_id', eventId).del();
        await trx('photo_tags').where('event_id', eventId).del();
      });
    await archiveDelete.locked;

    const commit = tagProcessor.processPhotoTags(photo);
    await blockedOnLock(owner, commit);

    archiveDelete.release();
    await expect(archiveDelete.done).resolves.toBeUndefined();
    // Its photo is gone by then: the claim guard finds nothing to commit.
    await expect(commit).resolves.toMatchObject({ status: 'skipped' });
    expect(await db('photo_tags').where({ photo_id: photo.id }).count({ c: '*' }).first()).toEqual({ c: '0' });
  });
});
