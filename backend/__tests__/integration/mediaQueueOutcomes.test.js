/**
 * What the two queues record when a job ends (items 7, 10): "not now" puts
 * the row back with a pause, only a verdict on the media is a failure, and
 * switching the web copy on queues the back catalogue without probing it.
 * Real database; processPhoto and renderWebCopy stubbed.
 */
process.env.UPLOAD_PROCESSOR_CONCURRENCY = '1';
process.env.UPLOAD_PROCESSOR_POLL_MS = '5';
process.env.VIDEO_RENDITION_POLL_MS = '5';

jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/services/photoProcessor', () => ({ processPhoto: jest.fn() }));
jest.mock('../../src/services/videoRenditionService', () => ({
  ...jest.requireActual('../../src/services/videoRenditionService'),
  isEnabled: jest.fn(async () => true), renderWebCopy: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

describe('queue outcomes', () => {
  let db, cleanup, eventId, background, renditions, processPhoto, renderWebCopy, capabilities;
  const id = rows => rows[0]?.id ?? rows[0];
  const refusal = code => Object.assign(new Error(`says ${code}`), { code });
  const photo = async (over = {}) => id(await db('photos').insert({
    event_id: eventId, filename: `p-${Date.now()}-${Math.random()}.jpg`, path: 'events/active/p.jpg', type: 'individual',
    size_bytes: 1000, uploaded_at: new Date().toISOString(), processing_status: 'pending', ...over,
  }).returning('id'));
  const video = (over = {}) => photo({ filename: `v-${Date.now()}-${Math.random()}.mov`, media_type: 'video', mime_type: 'video/quicktime', processing_status: 'complete', ...over });
  const row = photoId => db('photos').where({ id: photoId }).first();
  const settle = async predicate => {
    for (let index = 0; index < 600; index++) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('The queue did not reach the expected state');
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    eventId = id(await db('events').insert({ slug: 'outcomes', event_type: 'wedding', event_name: 'Outcomes',
      event_date: '2026-10-08', host_email: 'host@fixture.invalid', admin_email: 'admin@fixture.invalid',
      password_hash: 'x', share_link: '/gallery/outcomes/share', expires_at: new Date(Date.now() + 3600000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_by: adminId }).returning('id'));
    capabilities = require('../../src/services/mediaCapabilities');
    capabilities.set({ guard: false, leases: false });
    background = require('../../src/services/backgroundProcessor');
    renditions = require('../../src/services/videoRenditionQueue');
    ({ processPhoto } = require('../../src/services/photoProcessor'));
    ({ renderWebCopy } = require('../../src/services/videoRenditionService'));
  }, 60000);
  afterAll(async () => { await background.stop(); await renditions.stop(); capabilities.set(null); if (cleanup) await cleanup(); });
  beforeEach(async () => { await db('photos').delete(); await db('media_process_attempts').delete(); processPhoto.mockReset(); renderWebCopy.mockReset(); });
  afterEach(async () => { await background.stop(); await renditions.stop(); });

  describe('photo queue', () => {
    test.each(['MEDIA_CANCELLED', 'MEDIA_QUEUE_FULL', 'MEDIA_WORKER_UNAVAILABLE', 'MEDIA_LEASE_UNAVAILABLE', 'MEDIA_LEASE_BUSY'])(
      '%s puts the photo back with a pause; it is not a failure', async code => {
        const photoId = await photo();
        processPhoto.mockRejectedValue(refusal(code));
        const before = Date.now();
        background.start();
        await settle(async () => (await row(photoId)).processing_attempts === 1 && (await row(photoId)).processing_status === 'pending');
        const requeued = await row(photoId);
        expect(requeued).toMatchObject({ processing_status: 'pending', processing_error: null, processing_started_at: null });
        expect(new Date(requeued.processing_retry_at).getTime()).toBeGreaterThanOrEqual(before + 15000);
        expect(await db('media_process_attempts')).toEqual([]);
      });

    test.each([['MEDIA_RESOURCE_LIMIT', 'says MEDIA_RESOURCE_LIMIT'], ['MEDIA_INVALID_SIGNATURE', 'says MEDIA_INVALID_SIGNATURE'],
      ['MEDIA_TIMEOUT', 'says MEDIA_TIMEOUT'], [undefined, 'says undefined']])('a verdict on the media (%s) is recorded as the failure at once', async (code, message) => {
      const photoId = await photo();
      processPhoto.mockRejectedValue(refusal(code));
      background.start();
      await settle(async () => (await row(photoId)).processing_status === 'failed');
      expect(await row(photoId)).toMatchObject({ processing_error: message, processing_attempts: 1 });
      expect(processPhoto).toHaveBeenCalledTimes(1);
    });

    test('"not now" five times running is recorded on the last attempt, never earlier', async () => {
      const photoId = await photo({ processing_attempts: 4 });
      processPhoto.mockRejectedValue(refusal('MEDIA_WORKER_UNAVAILABLE'));
      background.start();
      await settle(async () => (await row(photoId)).processing_status === 'failed');
      expect(await row(photoId)).toMatchObject({ processing_attempts: 5, processing_error: 'says MEDIA_WORKER_UNAVAILABLE' });
    });

    test('a shutdown stops the photo in flight and puts it back without using up an attempt', async () => {
      const photoId = await photo();
      let started;
      const running = new Promise(resolve => { started = resolve; });
      processPhoto.mockImplementation(() => new Promise((resolve, reject) => {
        const attempt = require('../../src/services/mediaAttemptService').current();
        attempt.signal.addEventListener('abort', () => reject(refusal('MEDIA_CANCELLED')));
        started();
      }));
      background.start();
      await running;
      await background.stop();
      expect(await row(photoId)).toMatchObject({ processing_status: 'pending', processing_attempts: 0, processing_retry_at: null, processing_error: null });
    });

    test('a worker that lost its claim writes nothing over the row\'s new state', async () => {
      const photoId = await photo();
      processPhoto.mockImplementation(async () => {
        // An admin retried / a replacement arrived while this attempt ran.
        await db('photos').where({ id: photoId }).update({ processing_status: 'complete', processing_attempt_id: null });
        throw new Error('late failure of the old attempt');
      });
      background.start();
      await settle(() => processPhoto.mock.calls.length === 1);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(await row(photoId)).toMatchObject({ processing_status: 'complete', processing_error: null });
    });
  });

  describe('web rendition queue', () => {
    test('"not now" puts the video back with a pause; a broken video is recorded as failed', async () => {
      const later = await video({ web_status: 'pending' });
      renderWebCopy.mockRejectedValueOnce(refusal('MEDIA_QUEUE_FULL'));
      const before = Date.now();
      renditions.start();
      await settle(async () => (await row(later)).web_attempts === 1 && (await row(later)).web_status === 'pending');
      expect(await row(later)).toMatchObject({ web_status: 'pending', web_error: null, web_started_at: null });
      expect(new Date((await row(later)).web_retry_at).getTime()).toBeGreaterThanOrEqual(before + 60000);
      const broken = await video({ web_status: 'pending' });
      renderWebCopy.mockRejectedValue(new Error('ffmpeg failed (1): moov atom not found\nmore'));
      await settle(async () => (await row(broken)).web_status === 'failed');
      expect(await row(broken)).toMatchObject({ web_error: 'ffmpeg failed (1): moov atom not found', web_attempts: 1 });
      // The paused one was not claimed again in the meantime.
      expect((await row(later)).web_attempts).toBe(1);
      expect(await db('media_process_attempts')).toEqual([]);
    });
  });

  describe('switching the web copy on (item 10)', () => {
    test('queues the whole back catalogue in one statement, probing nothing and failing nothing', async () => {
      const service = require('../../src/services/videoRenditionService');
      const processes = require('../../src/services/mediaProcessService');
      const runner = require('../../src/services/nativeProcessRunner');
      const probe = jest.spyOn(processes, 'probeVideo'), run = jest.spyOn(runner, 'run');
      const ids = [];
      for (let index = 0; index < 40; index++) ids.push(await video(index % 2 ? { web_status: 'failed', web_error: 'earlier', web_attempts: 5 } : {}));
      const still = await photo({ processing_status: 'complete' });
      const done = await video({ web_status: 'complete', web_path: 'videos/x.mp4' });
      expect(await service.backfillPending()).toBe(40);
      expect(probe).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
      const rows = await db('photos').whereIn('id', ids);
      expect(rows.every(item => item.web_status === 'pending' && item.web_error === null && item.web_attempts === 0)).toBe(true);
      expect((await row(still)).web_status).toBeNull();
      expect((await row(done)).web_status).toBe('complete');
      probe.mockRestore(); run.mockRestore();
    });

    test('there is no work budget left that could refuse a backlog or hold up photo uploads', () => {
      const services = path.join(__dirname, '../../src/services');
      expect(fs.existsSync(path.join(services, 'mediaWorkAdmission.js'))).toBe(false);
      for (const file of ['photoProcessor.js', 'videoRenditionService.js', 'videoRenditionQueue.js', 'backgroundProcessor.js', 'photoReplacementService.js', '../routes/adminPhotos.js', '../routes/adminSettings.js']) {
        expect(fs.readFileSync(path.join(services, file), 'utf8')).not.toMatch(/mediaWorkAdmission|media_video_work_reservations|work_units|ensureQueued/);
      }
    });
  });
});
