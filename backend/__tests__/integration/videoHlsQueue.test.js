/**
 * The adaptive streaming queue (issue 1733, D4) against a real database,
 * with the transcode stubbed: nothing is queued or claimed while the setting
 * is off, uploads go first, one video is never claimed twice, and a failure
 * is recorded in the hls_* columns and nowhere else.
 */
process.env.VIDEO_HLS_POLL_MS = '5';

jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/services/videoHlsService', () => ({
  ...jest.requireActual('../../src/services/videoHlsService'),
  isEnabled: jest.fn(async () => true), renderLadder: jest.fn(),
}));

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

describe('adaptive streaming queue', () => {
  let db, cleanup, eventId, archivedEventId, queue, service, attempts, capabilities;
  const id = rows => rows[0]?.id ?? rows[0];
  const refusal = code => Object.assign(new Error(`says ${code}`), { code });
  const event = async (slug, over = {}) => id(await db('events').insert({ slug, event_type: 'wedding', event_name: slug,
    event_date: '2026-10-12', host_email: 'host@fixture.invalid', admin_email: 'admin@fixture.invalid',
    password_hash: 'x', share_link: `/gallery/${slug}/share`, expires_at: new Date(Date.now() + 3600000).toISOString(),
    is_active: 1, is_archived: 0, is_draft: 0, ...over }).returning('id'));
  const photo = async (over = {}) => id(await db('photos').insert({
    event_id: eventId, filename: `p-${Date.now()}-${Math.random()}.jpg`, path: 'events/active/p.jpg', type: 'individual',
    size_bytes: 1000, uploaded_at: new Date().toISOString(), processing_status: 'complete', ...over,
  }).returning('id'));
  const video = (over = {}) => photo({ filename: `v-${Date.now()}-${Math.random()}.mov`, media_type: 'video', mime_type: 'video/quicktime', ...over });
  const row = photoId => db('photos').where({ id: photoId }).first();
  const settle = async predicate => {
    for (let index = 0; index < 600; index++) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('The queue did not reach the expected state');
  };
  const quiet = () => new Promise(resolve => setTimeout(resolve, 150));

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    eventId = await event('hls-queue');
    archivedEventId = await event('hls-queue-archived', { is_archived: 1 });
    capabilities = require('../../src/services/mediaCapabilities');
    capabilities.set({ guard: false, leases: false });
    queue = require('../../src/services/videoHlsQueue');
    service = require('../../src/services/videoHlsService');
    attempts = require('../../src/services/mediaAttemptService');
  }, 60000);
  afterAll(async () => { await queue.stop(); capabilities.set(null); if (cleanup) await cleanup(); });
  beforeEach(async () => {
    await db('photos').delete(); await db('media_process_attempts').delete();
    service.renderLadder.mockReset(); service.isEnabled.mockReset(); service.isEnabled.mockResolvedValue(true);
  });
  afterEach(async () => { await queue.stop(); });

  describe('the setting', () => {
    test('off: no video is queued and a pending one is not claimed', async () => {
      service.isEnabled.mockResolvedValue(false);
      const fresh = await video();
      const waiting = await video({ hls_status: 'pending' });
      queue.start();
      await quiet();
      expect((await row(fresh)).hls_status).toBeNull();
      expect(await row(waiting)).toMatchObject({ hls_status: 'pending', hls_attempts: 0, hls_attempt_id: null });
      expect(service.renderLadder).not.toHaveBeenCalled();
      expect(await db('media_process_attempts')).toEqual([]);
    });

    test('on: the idle queue picks up the videos nobody has looked at, and only those', async () => {
      service.renderLadder.mockImplementation(async (photoId) => {
        await db('photos').where({ id: photoId }).update({ hls_status: 'complete', hls_started_at: null });
        return 'complete';
      });
      const fresh = await video();
      const second = await video();
      const still = await photo();
      const archived = await video({ event_id: archivedEventId });
      const skipped = await video({ hls_status: 'skipped', hls_error: 'Longer than 1800 s' });
      const failed = await video({ hls_status: 'failed', hls_error: 'earlier' });
      queue.start();
      await settle(async () => (await row(fresh)).hls_status === 'complete' && (await row(second)).hls_status === 'complete');
      expect(service.renderLadder.mock.calls.map(call => call[0]).sort()).toEqual([fresh, second].sort());
      expect((await row(still)).hls_status).toBeNull();
      expect((await row(archived)).hls_status).toBeNull();
      expect((await row(skipped)).hls_status).toBe('skipped');
      // A failed video waits for the setting to be switched on again.
      expect((await row(failed)).hls_status).toBe('failed');
      expect(await service.queuePending({ retryFailed: true })).toBe(1);
      expect(await row(failed)).toMatchObject({ hls_status: 'pending', hls_error: null, hls_attempts: 0 });
    });
  });

  test('uploads go first: nothing is claimed while a photo is still being processed', async () => {
    service.renderLadder.mockImplementation(async (photoId) => {
      await db('photos').where({ id: photoId }).update({ hls_status: 'complete', hls_started_at: null });
    });
    const upload = await photo({ processing_status: 'pending' });
    const waiting = await video({ hls_status: 'pending' });
    queue.start();
    await quiet();
    expect(service.renderLadder).not.toHaveBeenCalled();
    expect((await row(waiting)).hls_status).toBe('pending');
    await db('photos').where({ id: upload }).update({ processing_status: 'complete' });
    await settle(async () => (await row(waiting)).hls_status === 'complete');
    expect(service.renderLadder).toHaveBeenCalledWith(waiting);
  });

  test('an upload in the trash, which the photo queue will not claim, holds no ladder back', async () => {
    service.renderLadder.mockImplementation(async (photoId) => {
      await db('photos').where({ id: photoId }).update({ hls_status: 'complete', hls_started_at: null });
    });
    await photo({ processing_status: 'pending', deleted_at: new Date().toISOString(),
      purge_after: new Date(Date.now() + 86400000).toISOString() });
    const waiting = await video({ hls_status: 'pending' });
    queue.start();
    await settle(async () => (await row(waiting)).hls_status === 'complete');
    expect(service.renderLadder).toHaveBeenCalledWith(waiting);
  });

  describe('leases', () => {
    test('two claims racing for one video: one gets it, with its own attempt id', async () => {
      const only = await video({ hls_status: 'pending' });
      const [first, second] = await Promise.all([attempts.claimNext('hls'), attempts.claimNext('hls')]);
      const won = [first, second].filter(Boolean);
      expect(won).toHaveLength(1);
      expect(won[0]).toMatchObject({ id: only, hls_status: 'processing', hls_attempts: 1 });
      expect(won[0].hls_attempt_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(await db('media_process_attempts').select('photo_id', 'kind')).toEqual([{ photo_id: only, kind: 'hls' }]);
      // While that attempt lives, neither a third claim nor the janitor takes the row.
      expect(await attempts.claimNext('hls')).toBeNull();
      expect(await attempts.recover('hls', new Date(Date.now() + 60000).toISOString())).toBe(0);
      expect((await row(only)).hls_attempt_id).toBe(won[0].hls_attempt_id);
      await attempts.execute(won[0], 'hls', async () => {});
      expect(await db('media_process_attempts')).toEqual([]);
    });

    test('the web copy and the ladder of one video are claimed independently', async () => {
      const both = await video({ hls_status: 'pending', web_status: 'pending' });
      const ladder = await attempts.claimNext('hls');
      const copy = await attempts.claimNext('web');
      expect(ladder).toMatchObject({ id: both, hls_status: 'processing' });
      expect(copy).toMatchObject({ id: both, web_status: 'processing' });
      expect(copy.web_attempt_id).not.toBe(ladder.hls_attempt_id);
      await attempts.execute(ladder, 'hls', async () => {});
      await attempts.execute(copy, 'web', async () => {});
    });

    test('a row whose worker is gone goes back to pending, and the old worker can publish nothing', async () => {
      const stale = '11111111-1111-4111-8111-111111111111';
      const stuck = await video({ hls_status: 'processing', hls_attempt_id: stale, hls_attempts: 1,
        hls_started_at: new Date(Date.now() - 3 * 3600000).toISOString() });
      expect(await attempts.recover('hls', new Date(Date.now() - 2 * 3600000).toISOString())).toBe(1);
      expect((await row(stuck)).hls_status).toBe('pending');
      const reclaimed = await attempts.claimNext('hls');
      expect(reclaimed).toMatchObject({ id: stuck, hls_attempts: 2 });
      expect(reclaimed.hls_attempt_id).not.toBe(stale);
      const before = await row(stuck);
      const oldWorker = { id: stale, kind: 'hls', photo: before };
      expect(await attempts.guard(oldWorker, db, true).update({ hls_status: 'complete', hls_path: `hls/${stuck}/${stale}` })).toBe(0);
      expect(await row(stuck)).toMatchObject({ hls_status: 'processing', hls_path: null });
      await attempts.execute(reclaimed, 'hls', async () => {});
    });

    test('a video that used up its attempts is recorded as failed, not claimed again', async () => {
      const spent = await video({ hls_status: 'pending', hls_attempts: attempts.MAX_ATTEMPTS });
      expect(await queue.claimNext()).toBeNull();
      expect(await row(spent)).toMatchObject({ hls_status: 'failed' });
    });
  });

  describe('outcomes', () => {
    test('a failed transcode is recorded on the hls columns and changes nothing else about the video', async () => {
      const broken = await video({ hls_status: 'pending', thumbnail_path: 'thumbnails/thumb_v.jpg', web_status: 'complete', web_path: 'videos/web_1_v.mp4' });
      const before = await row(broken);
      service.renderLadder.mockRejectedValue(new Error('ffmpeg failed (1): moov atom not found\nmore'));
      queue.start();
      await settle(async () => (await row(broken)).hls_status === 'failed');
      const after = await row(broken);
      expect(after).toMatchObject({ hls_error: 'ffmpeg failed (1): moov atom not found', hls_attempts: 1, hls_path: null, hls_started_at: null });
      const untouched = value => Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('hls_')));
      expect(untouched(after)).toEqual(untouched(before));
      expect(await db('media_process_attempts')).toEqual([]);
    });

    test('"not now" puts the video back with a pause; it is not a failure', async () => {
      const later = await video({ hls_status: 'pending' });
      service.renderLadder.mockRejectedValueOnce(refusal('MEDIA_QUEUE_FULL'));
      const before = Date.now();
      queue.start();
      await settle(async () => (await row(later)).hls_attempts === 1 && (await row(later)).hls_status === 'pending');
      expect(await row(later)).toMatchObject({ hls_status: 'pending', hls_error: null, hls_started_at: null });
      expect(new Date((await row(later)).hls_retry_at).getTime()).toBeGreaterThanOrEqual(before + 60000);
      await quiet();
      expect(service.renderLadder).toHaveBeenCalledTimes(1);
    });
  });
});
