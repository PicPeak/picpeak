/**
 * Automatic scene tags (issue 1733, migration 297).
 *
 *  1. the worker's state machine, with the sidecar client mocked: both
 *     switches are needed, an unreachable sidecar or storage backend returns
 *     the photo to the queue, only a rejected image fails it, and a photo
 *     that changed under the worker keeps nothing
 *  2. the guest photo list carries tag keys and counts only while tagging is
 *     on for the gallery, and the counts never reach past what the viewer
 *     may see
 *  3. the admin routes: gated on the feature flag, backfill on enabling,
 *     re-run
 *  4. every vocabulary key is translated in all eight locales
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-autotag-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'autotag-test-secret';

const mockTagImage = jest.fn();
jest.mock('../../src/services/faceClient', () => ({
  ...jest.requireActual('../../src/services/faceClient'),
  tagImage: (...args) => mockTagImage(...args),
}));
const mockEnsureThumbnail = jest.fn();
jest.mock('../../src/services/imageProcessor', () => ({
  ...jest.requireActual('../../src/services/imageProcessor'),
  ensureThumbnail: (...args) => mockEnsureThumbnail(...args),
}));
const mockStorageGet = jest.fn();
const mockStorageStat = jest.fn();
jest.mock('../../src/services/storage', () => ({
  ...jest.requireActual('../../src/services/storage'),
  getStorage: () => ({
    get: (...args) => mockStorageGet(...args),
    stat: (...args) => mockStorageStat(...args),
  }),
}));

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

let db; let cleanup;
let tagQueue; let tagProcessor; let faceClient; let flags; let galleryQuery;
let seq = 0;

const unwrap = (rows) => rows[0]?.id ?? rows[0];

async function setFlag(on) {
  await db('feature_flags').where({ key: 'autoTagging' }).del();
  await db('feature_flags').insert({ key: 'autoTagging', value: on });
  flags.invalidateFeatureFlagCache();
}

async function mkEvent(extra = {}) {
  const slug = `autotag-${++seq}`;
  return unwrap(await db('events').insert({
    slug,
    event_type: 'wedding',
    event_name: slug,
    event_date: '2026-01-01',
    host_email: 'h@example.com',
    admin_email: 'a@example.com',
    password_hash: 'x',
    share_link: `${slug}-share`,
    expires_at: new Date(Date.now() + 864e5).toISOString(),
    auto_tagging_enabled: true,
    ...extra,
  }).returning('id'));
}

async function mkPhoto(eventId, extra = {}) {
  return unwrap(await db('photos').insert({
    event_id: eventId,
    filename: `p-${++seq}.jpg`,
    path: `x/p-${seq}.jpg`,
    type: 'individual',
    visibility: 'visible',
    processing_status: 'complete',
    thumbnail_path: `thumbnails/thumb_p-${seq}.jpg`,
    ...extra,
  }).returning('id'));
}

const photoRow = (id) => db('photos').where({ id }).first();
const tagsOf = async (id) => (await db('photo_tags').where({ photo_id: id }).orderBy('tag')).map((r) => r.tag);
// A claim as the worker makes one, on a row that need not be the oldest.
const claim = async (id) => {
  await db('photos').where({ id }).update({
    tag_status: 'processing', tag_started_at: new Date().toISOString(), tag_attempt_id: `attempt-${++seq}`,
  });
  return photoRow(id);
};
const addTags = (eventId, photoId, tags) => db('photo_tags').insert(
  tags.map(([tag, score]) => ({ photo_id: photoId, event_id: eventId, tag, score })),
);

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  flags = require('../../src/middleware/requireFeatureFlag');
  faceClient = require('../../src/services/faceClient');
  tagProcessor = require('../../src/services/tagProcessor');
  tagQueue = require('../../src/services/tagQueue');
  galleryQuery = require('../../src/services/galleryQueryService');
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

beforeEach(async () => {
  mockTagImage.mockReset().mockResolvedValue({ model_version: 'test', tags: [] });
  mockEnsureThumbnail.mockReset().mockImplementation(async (photo) => photo.thumbnail_path);
  mockStorageGet.mockReset().mockResolvedValue(Buffer.from('thumbnail-bytes'));
  mockStorageStat.mockReset().mockResolvedValue(null);
  await db('photos').whereNotNull('tag_status').update({ tag_status: null, tag_attempt_id: null });
  await setFlag(true);
});

describe('tag queue state machine', () => {
  it('migration 297 queues nothing and leaves the gallery switch off', async () => {
    const eventId = await mkEvent({ auto_tagging_enabled: undefined });
    const photoId = await mkPhoto(eventId);
    expect((await db('events').where({ id: eventId }).first()).auto_tagging_enabled).toBeNull();
    expect((await photoRow(photoId)).tag_status).toBeNull();
  });

  it('claims the oldest pending photo and nothing else', async () => {
    const eventId = await mkEvent();
    const first = await mkPhoto(eventId, { tag_status: 'pending' });
    const second = await mkPhoto(eventId, { tag_status: 'pending' });
    await mkPhoto(eventId, { tag_status: 'done' });
    await mkPhoto(eventId);

    expect((await tagQueue.claimNextPhoto()).id).toBe(first);
    expect((await photoRow(first)).tag_status).toBe('processing');
    expect((await photoRow(first)).tag_started_at).toBeTruthy();
    expect((await photoRow(first)).tag_attempt_id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await tagQueue.claimNextPhoto()).id).toBe(second);
    expect(await tagQueue.claimNextPhoto()).toBeNull();
  });

  it('stores the tags the sidecar reports and marks the photo done', async () => {
    const eventId = await mkEvent();
    const photoId = await mkPhoto(eventId);
    mockTagImage.mockResolvedValue({
      model_version: 'test',
      tags: [
        { tag: 'cake', score: 0.91 },
        { tag: 'food', score: 0.4 },
        { tag: 'cake', score: 0.2 }, // duplicate
        { tag: 'Not A Key', score: 0.9 }, // not a vocabulary-shaped key
        { tag: 'night', score: 'high' }, // not a number
      ],
    });

    expect(await tagQueue.runClaimed(await claim(photoId))).toBe('done');

    expect(mockStorageGet).toHaveBeenCalledWith(expect.stringContaining('thumbnails/'));
    expect(mockTagImage.mock.calls[0][0]).toEqual(Buffer.from('thumbnail-bytes'));
    const rows = await db('photo_tags').where({ photo_id: photoId }).orderBy('tag');
    expect(rows.map((r) => [r.tag, r.event_id])).toEqual([['cake', eventId], ['food', eventId]]);
    expect(rows[0].score).toBeCloseTo(0.91, 5);
    const row = await photoRow(photoId);
    expect([row.tag_status, row.tag_started_at, row.tag_attempt_id, row.tag_error]).toEqual(['done', null, null, null]);
  });

  it('a re-run replaces the earlier tags', async () => {
    const eventId = await mkEvent();
    const photoId = await mkPhoto(eventId);
    await addTags(eventId, photoId, [['cake', 0.9], ['food', 0.5]]);
    mockTagImage.mockResolvedValue({ tags: [{ tag: 'dancing', score: 0.7 }] });

    await tagQueue.runClaimed(await claim(photoId));
    expect(await tagsOf(photoId)).toEqual(['dancing']);
  });

  it.each([
    ['the feature flag is off', async (eventId) => { void eventId; await setFlag(false); }],
    ['the gallery switch is off', async (eventId) => {
      await db('events').where({ id: eventId }).update({ auto_tagging_enabled: false });
    }],
  ])('skips without contacting the sidecar when %s', async (_name, arrange) => {
    const eventId = await mkEvent();
    const photoId = await mkPhoto(eventId);
    await arrange(eventId);

    expect(await tagQueue.runClaimed(await claim(photoId))).toBe('skipped');
    expect(mockTagImage).not.toHaveBeenCalled();
    expect((await photoRow(photoId)).tag_status).toBe('skipped');
  });

  it('skips videos', async () => {
    const eventId = await mkEvent();
    const photoId = await mkPhoto(eventId, { media_type: 'video', mime_type: 'video/mp4' });
    expect(await tagQueue.runClaimed(await claim(photoId))).toBe('skipped');
    expect(mockTagImage).not.toHaveBeenCalled();
  });

  it('returns the photo to the queue when the sidecar is unreachable', async () => {
    const eventId = await mkEvent();
    const photoId = await mkPhoto(eventId);
    mockTagImage.mockRejectedValue(new faceClient.SidecarUnavailableError('connect ECONNREFUSED'));

    expect(await tagQueue.runClaimed(await claim(photoId))).toBe('retry');
    const row = await photoRow(photoId);
    expect([row.tag_status, row.tag_started_at, row.tag_error]).toEqual(['pending', null, null]);
    // And it is claimable again once the sidecar is back.
    expect((await tagQueue.claimNextPhoto()).id).toBe(photoId);
  });

  it('returns the photo to the queue when the storage backend is unreachable', async () => {
    const eventId = await mkEvent();
    const photoId = await mkPhoto(eventId);
    mockStorageGet.mockRejectedValue(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));

    expect(await tagQueue.runClaimed(await claim(photoId))).toBe('retry');
    expect((await photoRow(photoId)).tag_status).toBe('pending');
    expect(mockTagImage).not.toHaveBeenCalled();
  });

  it('fails a photo the sidecar rejects, and keeps the reason', async () => {
    const eventId = await mkEvent();
    const photoId = await mkPhoto(eventId);
    mockTagImage.mockRejectedValue(new faceClient.SidecarRejectedError('Image could not be decoded', 400));

    expect(await tagQueue.runClaimed(await claim(photoId))).toBe('failed');
    const row = await photoRow(photoId);
    expect([row.tag_status, row.tag_error]).toEqual(['failed', 'Image could not be decoded']);
    expect(await tagQueue.claimNextPhoto()).toBeNull();
  });

  it('fails a photo that has no thumbnail to send', async () => {
    const eventId = await mkEvent();
    const photoId = await mkPhoto(eventId, { thumbnail_path: null });
    mockEnsureThumbnail.mockResolvedValue(null);

    expect(await tagQueue.runClaimed(await claim(photoId))).toBe('failed');
    expect(mockTagImage).not.toHaveBeenCalled();
  });

  // The image pipeline reports these three the way it reports a broken
  // file: no thumbnail. A failed row is never retried, so none may fail it.
  describe('a missing thumbnail that is not the photo\'s fault', () => {
    it('retries when the storage backend is away while it is rebuilt', async () => {
      const eventId = await mkEvent();
      const photoId = await mkPhoto(eventId, { thumbnail_path: null });
      mockEnsureThumbnail.mockResolvedValue(null);
      mockStorageStat.mockRejectedValue(Object.assign(new Error('S3 timed out'), { name: 'TimeoutError' }));

      expect(await tagQueue.runClaimed(await claim(photoId))).toBe('retry');
      expect((await photoRow(photoId)).tag_status).toBe('pending');
    });

    it('parks an external photo when opening its source throws on a detached mount', async () => {
      const eventId = await mkEvent({ source_mode: 'reference', external_path: `/nonexistent-mount-${seq}` });
      const photoId = await mkPhoto(eventId, {
        thumbnail_path: null, source_origin: 'reference', external_relpath: 'a.dng',
      });
      mockEnsureThumbnail.mockRejectedValue(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }));

      expect(await tagQueue.runClaimed(await claim(photoId))).toBe('parked');
      expect((await photoRow(photoId)).tag_status).toBe('processing');
    });

    it('returns the photo to the queue when its gallery was archived under the claim', async () => {
      const eventId = await mkEvent();
      const photoId = await mkPhoto(eventId);
      const claimed = await claim(photoId);
      mockStorageGet.mockImplementation(async () => {
        // archiveEvent: the flag first, then the thumbnails go.
        await db('events').where({ id: eventId }).update({ is_archived: true });
        throw Object.assign(new Error('NoSuchKey'), { code: 'ENOENT' });
      });

      expect(await tagQueue.runClaimed(claimed)).toBe('requeued');
      const row = await photoRow(photoId);
      expect([row.tag_status, row.tag_attempt_id, row.tag_error]).toEqual(['pending', null, null]);
      expect(await tagQueue.claimNextPhoto()).toBeNull();
    });

    it('still fails a photo whose thumbnail cannot be read for its own reasons', async () => {
      const eventId = await mkEvent();
      const photoId = await mkPhoto(eventId);
      mockStorageGet.mockRejectedValue(new Error('corrupt object'));

      expect(await tagQueue.runClaimed(await claim(photoId))).toBe('failed');
      expect((await photoRow(photoId)).tag_error).toBe('corrupt object');
    });
  });

  it('keeps nothing when the photo was reset while the sidecar worked', async () => {
    const eventId = await mkEvent();
    const photoId = await mkPhoto(eventId);
    const claimed = await claim(photoId);
    mockTagImage.mockImplementation(async () => {
      // What a delete or a replace does mid-flight.
      await tagProcessor.purgePhotoTags(photoId);
      return { tags: [{ tag: 'cake', score: 0.9 }] };
    });

    expect(await tagQueue.runClaimed(claimed)).toBe('skipped');
    expect(await tagsOf(photoId)).toEqual([]);
    expect((await photoRow(photoId)).tag_status).toBeNull();
  });

  // A replacement purges and re-queues the row; a second worker (or another
  // replica) can claim it before the first sidecar call returns. Both claims
  // are 'processing', so only the claim's own id tells them apart.
  describe('a claim that was replaced by a newer one', () => {
    const supersede = async (photoId) => {
      await tagProcessor.purgePhotoTags(photoId);
      await db('photos').where({ id: photoId }).update({ tag_status: 'pending' });
      return tagQueue.claimNextPhoto();
    };

    it('stores nothing and leaves the newer claim alone', async () => {
      const eventId = await mkEvent();
      const photoId = await mkPhoto(eventId, { tag_status: 'pending' });
      const first = await tagQueue.claimNextPhoto();
      let second;
      mockTagImage.mockImplementationOnce(async () => {
        second = await supersede(photoId);
        return { tags: [{ tag: 'cake', score: 0.9 }] };
      });

      expect(await tagQueue.runClaimed(first)).toBe('skipped');
      expect(await tagsOf(photoId)).toEqual([]);
      const row = await photoRow(photoId);
      expect([row.tag_status, row.tag_attempt_id]).toEqual(['processing', second.tag_attempt_id]);

      // The newer claim's own result still lands.
      mockTagImage.mockResolvedValue({ tags: [{ tag: 'dancing', score: 0.8 }] });
      expect(await tagQueue.runClaimed(second)).toBe('done');
      expect(await tagsOf(photoId)).toEqual(['dancing']);
    });

    it.each([
      ['an unreachable sidecar', () => new (jest.requireActual('../../src/services/faceClient').SidecarUnavailableError)('down'), 'retry'],
      ['a rejected image', () => new Error('unreadable'), 'failed'],
    ])('does not release or fail the newer claim after %s', async (_name, makeError, outcome) => {
      const eventId = await mkEvent();
      const photoId = await mkPhoto(eventId, { tag_status: 'pending' });
      const first = await tagQueue.claimNextPhoto();
      let second;
      mockTagImage.mockImplementationOnce(async () => {
        second = await supersede(photoId);
        throw makeError();
      });

      expect(await tagQueue.runClaimed(first)).toBe(outcome);
      const row = await photoRow(photoId);
      expect([row.tag_status, row.tag_attempt_id, row.tag_error]).toEqual(['processing', second.tag_attempt_id, null]);
    });

    it('does not tag a photo whose claim is gone before the scan starts', async () => {
      const eventId = await mkEvent();
      const photoId = await mkPhoto(eventId, { tag_status: 'pending' });
      const first = await tagQueue.claimNextPhoto();
      await supersede(photoId);

      expect(await tagQueue.runClaimed(first)).toBe('skipped');
      expect(mockTagImage).not.toHaveBeenCalled();
    });
  });

  it('a result that arrives after the photo was deleted stores nothing', async () => {
    const eventId = await mkEvent();
    const photoId = await mkPhoto(eventId, { path: 'watched/gone.jpg' });
    await addTags(eventId, photoId, [['food', 0.5]]);
    const claimed = await claim(photoId);
    mockTagImage.mockImplementation(async () => {
      // The watched-folder delete, which had no tag purge at all.
      const fileWatcher = require('../../src/services/fileWatcher');
      const { getStoragePath } = require('../../src/config/storage');
      await fileWatcher.removePhoto(path.join(getStoragePath(), 'events/active', 'watched/gone.jpg'));
      return { tags: [{ tag: 'cake', score: 0.9 }] };
    });

    expect(await tagQueue.runClaimed(claimed)).toBe('skipped');
    expect(await photoRow(photoId)).toBeUndefined();
    expect(await db('photo_tags').where({ photo_id: photoId })).toEqual([]);
  });

  it('queues a finished photo only while both switches are on, and only if never queued', async () => {
    const { enqueueFinishedPhotos } = require('../../src/services/tagSettings');
    const eventId = await mkEvent({ auto_tagging_enabled: false });
    const fresh = await mkPhoto(eventId);
    const done = await mkPhoto(eventId, { tag_status: 'done' });
    const status = async (id) => (await photoRow(id)).tag_status;

    expect(await enqueueFinishedPhotos(eventId, [fresh, done])).toBe(0);
    // The switch is read at this moment, not carried in from the caller: a
    // gallery switched on while the photo was still processing is honoured.
    await db('events').where({ id: eventId }).update({ auto_tagging_enabled: true });
    await setFlag(false);
    expect(await enqueueFinishedPhotos(eventId, [fresh, done])).toBe(0);
    await setFlag(true);
    expect(await enqueueFinishedPhotos(eventId, [fresh, done])).toBe(1);
    expect([await status(fresh), await status(done)]).toEqual(['pending', 'done']);
  });

  it('leaves the photos of an archived gallery queued until it is restored', async () => {
    const eventId = await mkEvent({ is_archived: true });
    const photoId = await mkPhoto(eventId, { tag_status: 'pending' });

    expect(await tagQueue.claimNextPhoto()).toBeNull();
    expect((await photoRow(photoId)).tag_status).toBe('pending');

    await db('events').where({ id: eventId }).update({ is_archived: false });
    expect((await tagQueue.claimNextPhoto()).id).toBe(photoId);
  });

  it('parks a photo whose thumbnail the image worker could not rebuild right now', async () => {
    const eventId = await mkEvent();
    const photoId = await mkPhoto(eventId, { tag_status: 'pending' });
    const next = await mkPhoto(eventId, { tag_status: 'pending' });
    mockEnsureThumbnail.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'IMAGE_WORKER_UNAVAILABLE' }));

    expect(await tagQueue.runClaimed(await tagQueue.claimNextPhoto())).toBe('parked');
    // Not failed, and not back at the head of the queue either: the janitor
    // returns it, and the worker gets on with the next photo meanwhile.
    const row = await photoRow(photoId);
    expect([row.tag_status, row.tag_error]).toEqual(['processing', null]);
    expect((await tagQueue.claimNextPhoto()).id).toBe(next);
  });

  it('parks an external photo whose source is not mounted instead of failing it', async () => {
    const eventId = await mkEvent({ source_mode: 'reference', external_path: `/nonexistent-mount-${seq}` });
    const photoId = await mkPhoto(eventId, {
      tag_status: 'pending', thumbnail_path: null, source_origin: 'reference', external_relpath: 'a.jpg',
    });
    mockEnsureThumbnail.mockResolvedValue(null);

    expect(await tagQueue.runClaimed(await tagQueue.claimNextPhoto())).toBe('parked');
    const row = await photoRow(photoId);
    expect([row.tag_status, row.tag_error]).toEqual(['processing', null]);
  });

  it('the janitor returns only rows stuck past the timeout', async () => {
    const eventId = await mkEvent();
    const stuck = await mkPhoto(eventId, {
      tag_status: 'processing', tag_started_at: new Date(Date.now() - 3600e3).toISOString(), tag_attempt_id: 'dead-worker',
    });
    const fresh = await mkPhoto(eventId, {
      tag_status: 'processing', tag_started_at: new Date().toISOString(),
    });

    expect(await tagQueue.resetStuck()).toBe(1);
    expect((await photoRow(stuck)).tag_status).toBe('pending');
    expect((await photoRow(stuck)).tag_attempt_id).toBeNull();
    expect((await photoRow(fresh)).tag_status).toBe('processing');
  });

  it('a backfill queues what has no tags yet; a re-run queues everything finished', async () => {
    const eventId = await mkEvent();
    const untouched = await mkPhoto(eventId);
    const failed = await mkPhoto(eventId, { tag_status: 'failed', tag_error: 'x' });
    const done = await mkPhoto(eventId, { tag_status: 'done' });
    const uploading = await mkPhoto(eventId, { processing_status: 'pending' });
    const status = async (id) => (await photoRow(id)).tag_status;

    // A claim made while the switch was off is about to be settled as
    // 'skipped'; the backfill takes it back instead of missing it.
    const midSkip = await claim(await mkPhoto(eventId));

    expect(await tagProcessor.enqueueEvent(eventId, { onlyUntagged: true })).toBe(3);
    expect([await status(untouched), await status(failed), await status(done), await status(uploading)])
      .toEqual(['pending', 'pending', 'done', null]);
    await db('events').where({ id: eventId }).update({ auto_tagging_enabled: false });
    expect(await tagQueue.runClaimed(midSkip)).toBe('skipped');
    await db('events').where({ id: eventId }).update({ auto_tagging_enabled: true });
    expect(await status(midSkip.id)).toBe('pending');
    expect((await photoRow(failed)).tag_error).toBeNull();

    expect(await tagProcessor.enqueueEvent(eventId)).toBe(4);
    expect(await status(done)).toBe('pending');
    expect(await status(uploading)).toBeNull();
  });
});

describe('guest photo list', () => {
  const list = (event, accessLevel = 'guest', extra = {}) => galleryQuery.getGalleryPhotos({
    event, slug: event.slug, query: {}, identity: { guestIdentifier: 'viewer' }, accessLevel,
    adminPreview: false, hiddenForGuest: false, ...extra,
  });
  const eventRow = (id) => db('events').where({ id }).first();

  async function seedGallery() {
    const eventId = await mkEvent();
    const visibleA = await mkPhoto(eventId);
    const visibleB = await mkPhoto(eventId);
    const hidden = await mkPhoto(eventId, { visibility: 'hidden' });
    const uploading = await mkPhoto(eventId, { processing_status: 'pending' });
    const held = await mkPhoto(eventId, { visibility: 'hidden', moderation_status: 'pending' });
    const untagged = await mkPhoto(eventId);
    await addTags(eventId, visibleA, [['food', 0.4], ['cake', 0.9]]);
    await addTags(eventId, visibleB, [['cake', 0.8]]);
    await addTags(eventId, hidden, [['cake', 0.7], ['rings', 0.9]]);
    await addTags(eventId, uploading, [['fireworks', 0.9]]);
    await addTags(eventId, held, [['pets', 0.9]]);
    return { eventId, visibleA, visibleB, hidden, untagged };
  }

  it('carries tag keys and counts while tagging is on', async () => {
    const { eventId, visibleA, untagged } = await seedGallery();
    const payload = await list(await eventRow(eventId));

    expect(payload.event.tags_enabled).toBe(true);
    const byId = Object.fromEntries(payload.photos.map((p) => [p.id, p]));
    // Best score first.
    expect(byId[visibleA].tag_keys).toEqual(['cake', 'food']);
    expect(byId[untagged].tag_keys).toEqual([]);
  });

  it('reads the tag keys of the page it sends, and the counts of the whole gallery', async () => {
    const { eventId } = await seedGallery();
    const tagQueries = require('../../src/services/tagQueries');
    const spy = jest.spyOn(tagQueries, 'getTagKeysByPhoto');
    try {
      const payload = await list(await eventRow(eventId), 'guest', { query: { limit: 2, page: 1 } });
      expect(payload.photos).toHaveLength(2);
      expect(spy).toHaveBeenCalledWith(eventId, payload.photos.map((p) => p.id));
      // Newest first: the untagged photo, then one of the two with a cake.
      expect(payload.photos.map((p) => p.tag_keys)).toEqual([[], ['cake']]);
      expect(payload.tags.find((tag) => tag.key === 'cake').count).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('counts only the photos this viewer may see', async () => {
    const { eventId, hidden } = await seedGallery();
    const event = await eventRow(eventId);

    // A guest: the hidden photo's "rings" does not even ship as a name, and
    // neither does a tag on a photo still uploading or held for review.
    const guest = await list(event);
    expect(guest.tags).toEqual([{ key: 'cake', count: 2 }, { key: 'food', count: 1 }]);
    expect(guest.photos.some((p) => p.id === hidden)).toBe(false);

    // The PIN client sees hidden photos, so their tags count; a photo under
    // review stays out for everyone.
    const client = await list(event, 'client');
    expect(client.tags).toEqual([
      { key: 'cake', count: 3 }, { key: 'food', count: 1 }, { key: 'rings', count: 1 },
    ]);
  });

  it.each([
    ['the feature flag is off', async (eventId) => { void eventId; await setFlag(false); }],
    ['the gallery switch is off', async (eventId) => {
      await db('events').where({ id: eventId }).update({ auto_tagging_enabled: false });
    }],
  ])('carries no tag data at all when %s', async (_name, arrange) => {
    const { eventId } = await seedGallery();
    await arrange(eventId);
    const payload = await list(await eventRow(eventId));

    expect(payload.event.tags_enabled).toBe(false);
    expect(payload).not.toHaveProperty('tags');
    expect(payload.photos.length).toBeGreaterThan(0);
    for (const photo of payload.photos) expect(photo).not.toHaveProperty('tag_keys');
    expect(JSON.stringify(payload)).not.toContain('rings');
  });

  it('carries no tags for the slideshow or behind reveal mode', async () => {
    const { eventId } = await seedGallery();
    const event = await eventRow(eventId);

    expect(await list(event, 'slideshow')).not.toHaveProperty('tags');
    const hiddenGallery = await list(event, 'guest', { hiddenForGuest: true });
    expect(hiddenGallery.tags).toEqual([]);
    expect(hiddenGallery.photos).toEqual([]);
  });
});

describe('admin routes', () => {
  let app; let token; let adminId;

  beforeAll(async () => {
    ({ adminId } = await seedMinimal(db));
    await assignAdminRole(db, adminId);
    token = mintAdminToken(adminId);
    app = buildRouteApp('/api/admin/events', require('../../src/routes/adminEvents'));
  });

  const call = (method, url) => request(app)[method](`/api/admin/events${url}`)
    .set('Authorization', `Bearer ${token}`);

  it('refuses every route while the feature flag is off', async () => {
    const eventId = await mkEvent({ created_by: adminId });
    await setFlag(false);

    for (const [method, url] of [['get', '/tags'], ['patch', '/tags'], ['post', '/tags/rescan']]) {
      const res = await call(method, `/${eventId}${url}`).send({ enabled: true });
      expect([res.status, res.body.code]).toEqual([403, 'AUTO_TAGGING_DISABLED']);
    }
    expect((await db('events').where({ id: eventId }).first()).auto_tagging_enabled).toBe(1);
  });

  it('switching a gallery on queues its untagged photos and reports progress', async () => {
    const eventId = await mkEvent({ created_by: adminId, auto_tagging_enabled: false });
    const missed = await mkPhoto(eventId);
    await mkPhoto(eventId);
    await mkPhoto(eventId, { tag_status: 'done' });

    const before = await call('get', `/${eventId}/tags`);
    expect(before.body).toEqual({
      enabled: false,
      status: { tagged: 1, total: 1, pending: 0, failed: 0, skipped: 0, in_progress: false },
    });

    const res = await call('patch', `/${eventId}/tags`).send({ enabled: true });
    expect([res.status, res.body]).toEqual([200, { success: true, queued: 2 }]);
    // Logged against the gallery and the admin, so its owner sees it.
    const logged = await db('activity_logs').where({ activity_type: 'event_tagging_updated', event_id: eventId }).first();
    expect([logged.actor_type, logged.actor_id]).toEqual(['admin', adminId]);

    const after = await call('get', `/${eventId}/tags`);
    expect(after.body.enabled).toBe(true);
    expect(after.body.status).toMatchObject({ tagged: 1, total: 3, pending: 2, in_progress: true });

    // Repeating "on" finishes a backfill that did not get through the first
    // time, and leaves what is queued or tagged alone.
    await db('photos').where({ id: missed }).update({ tag_status: null });
    const again = await call('patch', `/${eventId}/tags`).send({ enabled: true });
    expect(again.body).toEqual({ success: true, queued: 1 });

    // Switching it off queues nothing and deletes nothing.
    const off = await call('patch', `/${eventId}/tags`).send({ enabled: false });
    expect(off.body).toEqual({ success: true, queued: 0 });
    expect((await call('patch', `/${eventId}/tags`).send({})).status).toBe(400);
  });

  it('re-run queues every photo, and only for a gallery that has tagging on', async () => {
    const eventId = await mkEvent({ created_by: adminId });
    await mkPhoto(eventId, { tag_status: 'done' });
    await mkPhoto(eventId, { tag_status: 'failed' });

    const res = await call('post', `/${eventId}/tags/rescan`);
    expect([res.status, res.body]).toEqual([200, { success: true, queued: 2 }]);

    await db('events').where({ id: eventId }).update({ auto_tagging_enabled: false });
    expect((await call('post', `/${eventId}/tags/rescan`)).status).toBe(400);
  });

  it('deleting a gallery removes its tags', async () => {
    const eventId = await mkEvent({ created_by: adminId });
    const photoId = await mkPhoto(eventId);
    await addTags(eventId, photoId, [['cake', 0.9]]);

    const { deleteEventCascade } = require('../../src/routes/adminEvents/helpers');
    await deleteEventCascade(eventId, { id: adminId });
    expect(await db('photo_tags').where({ event_id: eventId })).toEqual([]);
  });
});

describe('vocabulary', () => {
  const repo = path.resolve(__dirname, '../../..');
  const vocabulary = JSON.parse(
    fs.readFileSync(path.join(repo, 'ml/app/tag_vocabulary.json'), 'utf8'),
  ).tags;

  it('every tag key is one the backend would store', () => {
    const kept = tagProcessor.sanitizeTags(vocabulary.map((t) => ({ tag: t.key, score: 0.5 })).slice(0, 10));
    expect(kept.map((t) => t.tag)).toEqual(vocabulary.slice(0, 10).map((t) => t.key));
    for (const { key } of vocabulary) expect(key).toMatch(/^[a-z][a-z_]{1,63}$/);
  });

  it.each(['de', 'en', 'es', 'fr', 'nl', 'pt', 'ru', 'sl'])('%s names every tag, and nothing else', (locale) => {
    const names = JSON.parse(
      fs.readFileSync(path.join(repo, `frontend/src/i18n/locales/${locale}.json`), 'utf8'),
    ).gallery.tags.names;
    expect(Object.keys(names).sort()).toEqual(vocabulary.map((t) => t.key).sort());
    for (const value of Object.values(names)) expect(String(value).trim()).not.toBe('');
  });
});
