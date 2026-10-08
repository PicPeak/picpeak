const fs = require('fs');
const path = require('path');
const sharp = require('sharp'); // Bounded test fixture creation only.
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal, buildRouteApp } = require('./helpers/crmDb');

// Upload-time image admission against the real queue, storage and worker:
// ordinary batches are never refused for backlog, and an image over the
// server's limits is refused with the limit named.
describe('image admission at upload', () => {
  let db, cleanup, tmpDir, eventId, processor, storage, app, ordinary;
  const id = rows => rows[0]?.id ?? rows[0];
  beforeAll(async () => {
    ({ db, cleanup, tmpDir } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    eventId = id(await db('events').insert({ slug: 'image-admission', event_type: 'wedding', event_name: 'Image admission',
      event_date: '2026-10-08', host_email: 'host@fixture.invalid', admin_email: 'admin@fixture.invalid',
      password_hash: 'x', share_link: '/gallery/image-admission/share', expires_at: new Date(Date.now() + 3600000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, allow_user_uploads: 1, created_by: adminId }).returning('id'));
    const LocalFs = require('../../src/services/storage/LocalFsStorage');
    storage = new LocalFs({ root: process.env.STORAGE_PATH });
    await storage.init();
    require('../../src/services/storage').setStorageForTesting(storage);
    processor = require('../../src/services/photoProcessor');
    app = buildRouteApp('/api/gallery', require('../../src/routes/gallery'));
    ordinary = await sharp({ create: { width: 6000, height: 4000, channels: 3, background: 'white' } }).jpeg().toBuffer();
  }, 60000);
  afterAll(async () => {
    await require('../../src/services/isolatedSharp').shutdown();
    require('../../src/services/storage').resetStorage();
    if (cleanup) await cleanup();
  });
  beforeEach(async () => {
    await db('public_upload_objects').delete();
    await db('public_upload_requests').delete();
    await db('photos').delete();
  });
  async function file(buffer, name) {
    const filename = path.join(tmpDir, name);
    await fs.promises.writeFile(filename, buffer);
    return { path: filename, originalname: name, mimetype: name.endsWith('.gif') ? 'image/gif' : 'image/jpeg' };
  }

  test('a batch of 25 ordinary 24 MP photos is queued whole and a queued photo processes', async () => {
    const files = [];
    for (let index = 0; index < 25; index++) files.push(await file(ordinary, `batch-${index}.jpg`));
    const result = await processor.queueFilesForProcessing(files, { eventId, uploadedBy: 'guest' });
    expect(result.errors).toEqual([]);
    expect(result.photos).toHaveLength(25);
    expect(await db('photos').where({ event_id: eventId, processing_status: 'pending' })).toHaveLength(25);
    // Nothing accounts queued work any more: there is no backlog budget to run out of.
    expect(await db.schema.hasTable('image_work_reservations')).toBe(false);
    expect(await db.schema.hasTable('image_work_lock')).toBe(false);
    await processor.processPhoto(result.photos[0].id);
    const row = await db('photos').where({ id: result.photos[0].id }).first();
    expect(row).toMatchObject({ processing_status: 'complete', width: 6000, height: 4000 });
    expect(row.thumbnail_path).toBeTruthy();
  }, 120000);

  test('a 512-frame animation is accepted as before', async () => {
    const pixels = Buffer.alloc(16 * 16 * 512 * 3);
    for (let frame = 0; frame < 512; frame++) pixels.fill(frame % 2 ? 255 : 0, frame * 768, (frame + 1) * 768);
    const animation = await sharp(pixels, { raw: { width: 16, height: 8192, pageHeight: 16, channels: 3 } }).gif({ delay: 10 }).toBuffer();
    const result = await processor.queueFilesForProcessing([await file(animation, 'many-frames.gif')], { eventId, uploadedBy: 'guest' });
    expect(result.errors).toEqual([]);
    expect(result.photos).toHaveLength(1);
  });

  test('an image over the pixel limit is refused through gallery HTTP with the limit named, before promotion', async () => {
    const input = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: 'white' } }).png().toBuffer();
    const token = jwt.sign({ eventId, eventSlug: 'image-admission', type: 'gallery' }, process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' });
    const promote = jest.spyOn(storage, 'putFromFile');
    process.env.IMAGE_MAX_PIXELS = '1000000';
    try {
      const response = await request(app).post(`/api/gallery/${eventId}/upload`).set('Authorization', `Bearer ${token}`)
        .attach('photos', input, { filename: 'large.png', contentType: 'image/png' });
      expect(response.status).toBe(202); // Existing partial-batch API contract.
      expect(response.body.count).toBe(0);
      expect(response.body.errors[0]).toMatchObject({ filename: 'large.png', code: 'IMAGE_RESOURCE_LIMIT', imageLimit: 'pixels', imageMax: 1 });
      expect(response.body.errors[0].error).toMatch(/2 megapixels.*up to 1 megapixels/);
      expect(promote).not.toHaveBeenCalled();
      expect(await db('photos')).toEqual([]);
      expect(await db('public_upload_objects')).toEqual([]);
      expect(await db('public_upload_requests').where({ active: 1 })).toEqual([]);
    } finally { delete process.env.IMAGE_MAX_PIXELS; promote.mockRestore(); }
  });
});

describe('imageWorkAdmission.inspect', () => {
  const load = metadata => {
    let admission;
    jest.isolateModules(() => {
      jest.doMock('../../src/services/isolatedSharp', () => Object.assign(jest.fn(() => ({ metadata })), { metadataBatch: jest.fn() }));
      admission = require('../../src/services/imageWorkAdmission');
    });
    jest.dontMock('../../src/services/isolatedSharp');
    return admission;
  };
  const refusal = code => Object.assign(new Error(code), { code });

  test.each(['IMAGE_QUEUE_FULL', 'IMAGE_WORKER_UNAVAILABLE', 'IMAGE_TIMEOUT', 'IMAGE_WORKER_FAILED', 'SHARP_PROCESSING_FAILED'])(
    'does not hold an upload back on %s', async code => {
      const admission = load(jest.fn().mockRejectedValue(refusal(code)));
      await expect(admission.inspect('/fixture/photo.jpg', 'photo.jpg')).resolves.toBeUndefined();
    });

  test('refuses an image over the limits and a cancelled request', async () => {
    await expect(load(jest.fn().mockRejectedValue(refusal('IMAGE_RESOURCE_LIMIT'))).inspect('/fixture/photo.jpg', 'photo.jpg'))
      .rejects.toMatchObject({ code: 'IMAGE_RESOURCE_LIMIT' });
    await expect(load(jest.fn().mockRejectedValue(refusal('IMAGE_CANCELLED'))).inspect('/fixture/photo.jpg', 'photo.jpg'))
      .rejects.toMatchObject({ code: 'IMAGE_CANCELLED' });
    // The header itself is over the limit.
    await expect(load(jest.fn().mockResolvedValue({ width: 20000, height: 20000, channels: 3 })).inspect('/fixture/photo.jpg', 'photo.jpg'))
      .rejects.toMatchObject({ code: 'IMAGE_RESOURCE_LIMIT', imageLimit: 'pixels' });
  });

  test('a RAW file is left to processing, with no extra extraction per upload', async () => {
    const metadata = jest.fn();
    await expect(load(metadata).inspect('/fixture/photo.arw', 'photo.arw')).resolves.toBeUndefined();
    expect(metadata).not.toHaveBeenCalled();
  });
});
