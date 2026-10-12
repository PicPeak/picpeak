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
jest.mock('../../src/services/storage', () => ({
  ...jest.requireActual('../../src/services/storage'),
  getStorage: () => ({ get: (...args) => mockStorageGet(...args) }),
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
const claim = async (id) => {
  await db('photos').where({ id }).update({ tag_status: 'processing', tag_started_at: new Date().toISOString() });
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
  await db('photos').whereNotNull('tag_status').update({ tag_status: null });
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
    expect([row.tag_status, row.tag_started_at, row.tag_error]).toEqual(['done', null, null]);
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

  it('the janitor returns only rows stuck past the timeout', async () => {
    const eventId = await mkEvent();
    const stuck = await mkPhoto(eventId, {
      tag_status: 'processing', tag_started_at: new Date(Date.now() - 3600e3).toISOString(),
    });
    const fresh = await mkPhoto(eventId, {
      tag_status: 'processing', tag_started_at: new Date().toISOString(),
    });

    expect(await tagQueue.resetStuck()).toBe(1);
    expect((await photoRow(stuck)).tag_status).toBe('pending');
    expect((await photoRow(fresh)).tag_status).toBe('processing');
  });

  it('a backfill queues what has no tags yet; a re-run queues everything finished', async () => {
    const eventId = await mkEvent();
    const untouched = await mkPhoto(eventId);
    const failed = await mkPhoto(eventId, { tag_status: 'failed', tag_error: 'x' });
    const done = await mkPhoto(eventId, { tag_status: 'done' });
    const uploading = await mkPhoto(eventId, { processing_status: 'pending' });
    const status = async (id) => (await photoRow(id)).tag_status;

    expect(await tagProcessor.enqueueEvent(eventId, { onlyUntagged: true })).toBe(2);
    expect([await status(untouched), await status(failed), await status(done), await status(uploading)])
      .toEqual(['pending', 'pending', 'done', null]);
    expect((await photoRow(failed)).tag_error).toBeNull();

    expect(await tagProcessor.enqueueEvent(eventId)).toBe(3);
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
    await mkPhoto(eventId);
    await mkPhoto(eventId);
    await mkPhoto(eventId, { tag_status: 'done' });

    const before = await call('get', `/${eventId}/tags`);
    expect(before.body).toEqual({
      enabled: false,
      status: { tagged: 1, total: 1, pending: 0, failed: 0, skipped: 0, in_progress: false },
    });

    const res = await call('patch', `/${eventId}/tags`).send({ enabled: true });
    expect([res.status, res.body]).toEqual([200, { success: true, queued: 2 }]);

    const after = await call('get', `/${eventId}/tags`);
    expect(after.body.enabled).toBe(true);
    expect(after.body.status).toMatchObject({ tagged: 1, total: 3, pending: 2, in_progress: true });

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
