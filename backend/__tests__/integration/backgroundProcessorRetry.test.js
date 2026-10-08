/**
 * A transient refusal from the image worker ("not now") puts a photo back in
 * the queue with a pause; it is never recorded as that photo's failure until
 * the attempts are used up. Real database, processPhoto stubbed.
 */
process.env.UPLOAD_PROCESSOR_CONCURRENCY = '1';
process.env.UPLOAD_PROCESSOR_POLL_MS = '5';

jest.mock('../../src/services/photoProcessor', () => ({ processPhoto: jest.fn() }));

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

describe('background processor retries transient image-worker refusals', () => {
  let db, cleanup, eventId, background, processPhoto;
  const id = rows => rows[0]?.id ?? rows[0];
  const refusal = code => Object.assign(new Error(`worker says ${code}`), { code, status: 503 });
  const photo = async (over = {}) => id(await db('photos').insert({
    event_id: eventId, filename: `p-${Date.now()}-${Math.random()}.jpg`, path: 'events/active/p.jpg', type: 'individual',
    size_bytes: 1000, uploaded_at: new Date().toISOString(), processing_status: 'pending', ...over,
  }).returning('id'));
  const settle = async predicate => {
    for (let index = 0; index < 400; index++) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Background processor did not reach the expected state');
  };
  const row = photoId => db('photos').where({ id: photoId }).first();

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    eventId = id(await db('events').insert({ slug: 'retry', event_type: 'wedding', event_name: 'Retry',
      event_date: '2026-10-08', host_email: 'host@fixture.invalid', admin_email: 'admin@fixture.invalid',
      password_hash: 'x', share_link: '/gallery/retry/share', expires_at: new Date(Date.now() + 3600000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_by: adminId }).returning('id'));
    background = require('../../src/services/backgroundProcessor');
    ({ processPhoto } = require('../../src/services/photoProcessor'));
  }, 60000);
  afterAll(async () => { await background.stop(); if (cleanup) await cleanup(); });
  beforeEach(async () => { await db('photos').delete(); processPhoto.mockReset(); });
  afterEach(async () => { await background.stop(); });

  test.each(['IMAGE_QUEUE_FULL', 'IMAGE_TIMEOUT', 'IMAGE_CANCELLED', 'IMAGE_WORKER_UNAVAILABLE'])(
    '%s requeues the photo with a pause instead of failing it', async code => {
      const photoId = await photo();
      processPhoto.mockRejectedValue(refusal(code));
      const before = Date.now();
      background.start();
      await settle(async () => (await row(photoId)).processing_attempts === 1 && (await row(photoId)).processing_status === 'pending');
      await new Promise(resolve => setTimeout(resolve, 50));
      const requeued = await row(photoId);
      expect(requeued).toMatchObject({ processing_status: 'pending', processing_error: null, processing_attempts: 1, processing_started_at: null });
      expect(new Date(requeued.processing_retry_at).getTime()).toBeGreaterThanOrEqual(before + 15000);
      // Not due yet: it is not claimed again, and the queue behind it moves on.
      expect(processPhoto).toHaveBeenCalledTimes(1);
      processPhoto.mockResolvedValue(undefined);
      const next = await photo();
      await settle(() => processPhoto.mock.calls.some(([claimed]) => claimed === next));
      expect((await row(photoId)).processing_status).toBe('pending');
    });

  test('a requeued photo is claimed again once it is due and can then complete', async () => {
    const photoId = await photo({ processing_attempts: 1, processing_retry_at: new Date(Date.now() - 1000).toISOString() });
    processPhoto.mockImplementation(async claimed => { await db('photos').where({ id: claimed }).update({ processing_status: 'complete' }); });
    background.start();
    await settle(async () => (await row(photoId)).processing_status === 'complete');
    expect((await row(photoId)).processing_attempts).toBe(2);
  });

  test('the last allowed attempt records the refusal; attempts are bounded', async () => {
    const lastChance = await photo({ processing_attempts: 4 });
    processPhoto.mockRejectedValue(refusal('IMAGE_WORKER_UNAVAILABLE'));
    background.start();
    await settle(async () => (await row(lastChance)).processing_status === 'failed');
    expect(await row(lastChance)).toMatchObject({ processing_attempts: 5, processing_error: 'worker says IMAGE_WORKER_UNAVAILABLE' });
    // A photo the janitor keeps recovering stops being claimed as well.
    const spent = await photo({ processing_attempts: 5 });
    expect(await background.claimNextPhoto()).toBeNull();
    expect(await row(spent)).toMatchObject({ processing_status: 'failed', processing_error: 'Image processing did not complete after 5 attempts' });
  });

  test('an image over the limits fails at once with its message', async () => {
    const photoId = await photo();
    processPhoto.mockRejectedValue(Object.assign(new Error('Image has 300 megapixels; this server processes images up to 268.4 megapixels (IMAGE_MAX_PIXELS)'),
      { code: 'IMAGE_RESOURCE_LIMIT', status: 422 }));
    background.start();
    await settle(async () => (await row(photoId)).processing_status === 'failed');
    expect(await row(photoId)).toMatchObject({ processing_attempts: 1, processing_error: expect.stringContaining('IMAGE_MAX_PIXELS') });
  });
});
