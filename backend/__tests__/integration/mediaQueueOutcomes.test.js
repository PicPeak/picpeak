/**
 * What the photo queue records when a job ends (item 7): "not now" puts the
 * row back with a pause, only a verdict on the media is a failure. Real
 * database; processPhoto stubbed. (This branch has no web-rendition queue.)
 */
process.env.UPLOAD_PROCESSOR_CONCURRENCY = '1';
process.env.UPLOAD_PROCESSOR_POLL_MS = '5';

jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/services/photoProcessor', () => ({ processPhoto: jest.fn() }));

const fs = require('fs');
const path = require('path');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

describe('queue outcomes', () => {
  let db, cleanup, eventId, background, processPhoto, capabilities;
  const id = rows => rows[0]?.id ?? rows[0];
  const refusal = code => Object.assign(new Error(`says ${code}`), { code });
  const photo = async (over = {}) => id(await db('photos').insert({
    event_id: eventId, filename: `p-${Date.now()}-${Math.random()}.jpg`, path: 'events/active/p.jpg', type: 'individual',
    size_bytes: 1000, uploaded_at: new Date().toISOString(), processing_status: 'pending', ...over,
  }).returning('id'));
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
    ({ processPhoto } = require('../../src/services/photoProcessor'));
  }, 60000);
  afterAll(async () => { await background.stop(); capabilities.set(null); if (cleanup) await cleanup(); });
  beforeEach(async () => { await db('photos').delete(); await db('media_process_attempts').delete(); processPhoto.mockReset(); });
  afterEach(async () => { await background.stop(); });

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

  describe('no work budgets (item 10, as far as this branch has the code)', () => {
    test('there is no work budget left that could refuse a backlog or hold up photo uploads', () => {
      const services = path.join(__dirname, '../../src/services');
      expect(fs.existsSync(path.join(services, 'mediaWorkAdmission.js'))).toBe(false);
      for (const file of ['photoProcessor.js', 'backgroundProcessor.js', 'photoReplacementService.js', '../routes/adminPhotos.js']) {
        expect(fs.readFileSync(path.join(services, file), 'utf8')).not.toMatch(/mediaWorkAdmission|media_video_work_reservations|work_units|ensureQueued/);
      }
    });
  });
});
