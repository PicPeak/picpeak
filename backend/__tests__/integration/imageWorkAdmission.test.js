const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { once } = require('events');
const sharp = require('sharp'); // Bounded test fixture creation only.
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal, buildRouteApp } = require('./helpers/crmDb');

const linux = process.platform === 'linux' ? describe : describe.skip;
linux('real decoded-work admission', () => {
  let db, cleanup, tmpDir, eventId, admission, processor, storage, app, ordinary;
  const id = rows => rows[0]?.id ?? rows[0];
  beforeAll(async () => {
    ({ db, cleanup, tmpDir } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    eventId = id(await db('events').insert({ slug: 'decoded-budget', event_type: 'wedding', event_name: 'Decoded budget',
      event_date: '2026-10-08', host_email: 'host@fixture.invalid', admin_email: 'admin@fixture.invalid',
      password_hash: 'x', share_link: '/gallery/decoded-budget/share', expires_at: new Date(Date.now() + 3600000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, allow_user_uploads: 1, created_by: adminId }).returning('id'));
    const LocalFs = require('../../src/services/storage/LocalFsStorage');
    storage = new LocalFs({ root: process.env.STORAGE_PATH });
    await storage.init();
    require('../../src/services/storage').setStorageForTesting(storage);
    admission = require('../../src/services/imageWorkAdmission');
    processor = require('../../src/services/photoProcessor');
    app = buildRouteApp('/api/gallery', require('../../src/routes/gallery'));
    ordinary = await sharp({ create: { width: 7008, height: 4672, channels: 3, background: 'white' } }).jpeg().toBuffer();
  });
  afterAll(async () => { require('../../src/services/storage').resetStorage(); if (cleanup) await cleanup(); });
  beforeEach(async () => {
    await db('image_work_reservations').delete();
    await db('public_upload_objects').delete();
    await db('public_upload_requests').delete();
    await db('photos').delete();
  });
  async function file(buffer, name) {
    const filename = path.join(tmpDir, name);
    await fs.promises.writeFile(filename, buffer);
    return { path: filename, originalname: name, mimetype: name.endsWith('.gif') ? 'image/gif' : 'image/jpeg' };
  }

  test('ordinary 32.7MP guest input is queued with a durable decoded charge before processing', async () => {
    const result = await processor.queueFilesForProcessing([await file(ordinary, 'ordinary.jpg')], { eventId, uploadedBy: 'guest' });
    expect(result.photos).toHaveLength(1); expect(result.errors).toEqual([]);
    const row = await db('photos').where({ id: result.photos[0].id }).first();
    expect(row).toMatchObject({ processing_status: 'pending', uploaded_by: 'guest', size_bytes: ordinary.length });
    const charge = await db('image_work_reservations').first();
    expect(Number(charge.decoded_bytes)).toBe(130965504);
    expect(charge.photo_id).toBe(row.id);
    await processor.processPhoto(row.id);
    expect((await db('photos').where({ id: row.id }).first()).processing_status).toBe('complete');
    await admission.finish(row.id);
    expect(await db('image_work_reservations')).toEqual([]);
  });

  test('25 ordinary high-resolution files cannot bypass the batch decoded-work limit', async () => {
    const files = [];
    for (let index = 0; index < 25; index++) files.push(await file(ordinary, `batch-${index}.jpg`));
    const result = await processor.queueFilesForProcessing(files, { eventId, uploadedBy: 'guest' });
    expect(result.photos.length).toBeGreaterThan(0);
    expect(result.photos.length).toBeLessThan(25);
    expect(result.photos.length + result.errors.length).toBe(25);
    expect(result.errors.every(error => error.code === 'IMAGE_RESOURCE_LIMIT')).toBe(true);
    const reserved = Number((await db('image_work_reservations').sum('decoded_bytes as bytes').first()).bytes);
    expect(reserved).toBeLessThanOrEqual(require('../../src/services/imageResourcePolicy').configuration().batchBytes);
  });

  test('parallel requests serialize event decoded charges; unknown writers do not expire', async () => {
    const policy = require('../../src/services/imageResourcePolicy').configuration();
    const bytes = policy.decodedBytes;
    const count = Math.floor(policy.eventBytes / bytes) + 2;
    const results = await Promise.allSettled(Array.from({ length: count }, () => admission.reserve(eventId, bytes, bytes)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(Math.floor(policy.eventBytes / bytes));
    expect(results.filter(result => result.status === 'rejected').every(result => result.reason.code === 'IMAGE_RESOURCE_LIMIT')).toBe(true);
    expect((await db('image_work_reservations')).every(row => row.photo_id === null)).toBe(true);
  });

  test('512-frame source is refused before promotion and row insertion', async () => {
    const pixels = Buffer.alloc(16 * 16 * 512 * 3);
    for (let frame = 0; frame < 512; frame++) pixels.fill(frame % 2 ? 255 : 0, frame * 768, (frame + 1) * 768);
    const animation = await sharp(pixels, { raw: { width: 16, height: 8192, pageHeight: 16, channels: 3 } }).gif({ delay: 10 }).toBuffer();
    const promote = jest.spyOn(storage, 'putFromFile');
    try {
      const result = await processor.queueFilesForProcessing([await file(animation, 'many-frames.gif')], { eventId, uploadedBy: 'guest' });
      expect(result.photos).toEqual([]);
      expect(result.errors[0].code).toBe('IMAGE_RESOURCE_LIMIT');
      expect(promote).not.toHaveBeenCalled();
      expect(await db('photos')).toEqual([]);
      expect(await db('image_work_reservations')).toEqual([]);
    } finally { promote.mockRestore(); }
  });

  test('valid compressed 81MP PNG is refused through gallery HTTP and the real ingress ledger', async () => {
    const input = await compressedPng(9000, 9000);
    expect(input.length).toBeLessThan(1024 * 1024);
    const token = jwt.sign({ eventId, eventSlug: 'decoded-budget', type: 'gallery' }, process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' });
    const promote = jest.spyOn(storage, 'putFromFile');
    try {
      const response = await request(app).post(`/api/gallery/${eventId}/upload`).set('Authorization', `Bearer ${token}`)
        .attach('photos', input, { filename: 'large.png', contentType: 'image/png' });
      expect(response.status).toBe(202); // Existing partial-batch API contract.
      expect(response.body.count).toBe(0);
      expect(response.body.errors[0].code).toBe('IMAGE_RESOURCE_LIMIT');
      expect(promote).not.toHaveBeenCalled();
      expect(await db('photos')).toEqual([]);
      expect(await db('image_work_reservations')).toEqual([]);
      expect(await db('public_upload_objects')).toEqual([]);
      expect(await db('public_upload_requests').where({ active: 1 })).toEqual([]);
    } finally { promote.mockRestore(); }
  });
});

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function chunk(kind, bytes) {
  const type = Buffer.from(kind), output = Buffer.alloc(bytes.length + 12);
  output.writeUInt32BE(bytes.length, 0); type.copy(output, 4); bytes.copy(output, 8);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([type, bytes])) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
  return output;
}
async function compressedPng(width, height) {
  const stream = zlib.createDeflate({ level: 9 }), pieces = [];
  stream.on('data', bytes => pieces.push(bytes));
  const done = once(stream, 'end'), row = Buffer.alloc(1 + width * 4);
  for (let y = 0; y < height; y++) if (!stream.write(row)) await once(stream, 'drain');
  stream.end(); await done;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', Buffer.concat(pieces)), chunk('IEND', Buffer.alloc(0))]);
}
