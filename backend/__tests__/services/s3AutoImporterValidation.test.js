/**
 * The S3 auto-import runs the upload validator on its local copy before it
 * writes a row (issue 2394): any bytes under an image name in the bucket
 * prefix used to become a gallery photo, a bare HEIF `ftyp` header included.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { bootCrmDb } = require('../integration/helpers/crmDb');

// The real validator, unless a test stands in for a worker that cannot check.
const mockValidator = { failWith: null, calls: [] };
jest.mock('../../src/middleware/uploadValidation', () => {
  const actual = jest.requireActual('../../src/middleware/uploadValidation');
  return { ...actual, validateUploadedFile: async (...args) => {
    mockValidator.calls.push(args);
    if (mockValidator.failWith) throw mockValidator.failWith;
    return actual.validateUploadedFile(...args);
  } };
});

describe('s3AutoImporter: upload validation', () => {
  let db; let cleanup; let processEvent; let refusedObjects; let counter = 0;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ processEvent, refusedObjects } = require('../../src/services/s3AutoImporter').__test);
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  async function makeEvent() {
    counter += 1;
    const slug = `s3-check-${counter}`;
    const inserted = await db('events').insert({
      slug, event_type: 'wedding', event_name: `S3 Check ${counter}`, event_date: '2026-08-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `/gallery/${slug}/share`, share_token: `s3-check-share-${counter}`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_at: new Date().toISOString(),
    }).returning('id');
    return db('events').where({ id: inserted[0]?.id ?? inserted[0] }).first();
  }

  async function importFile(name, bytes) {
    const event = await makeEvent();
    const dir = path.join(process.env.STORAGE_PATH, 'events', 'active', event.slug);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, name), bytes);
    const bucket = { list: async () => [{ key: `events/active/${event.slug}/${name}`, size: bytes.length }] };
    // A key is imported on the second poll that lists it.
    await processEvent(event, bucket);
    await processEvent(event, bucket);
    return { event, bucket, row: await db('photos').where({ event_id: event.id }).first() };
  }

  it('does not import a bare container header under a .heic name', async () => {
    const { event, bucket, row } = await importFile('x.heic', Buffer.from('\0\0\0\x18ftypisom-not-an-image-at-all'));
    expect(row).toBeUndefined();
    // Remembered, so the next poll does not fetch it again.
    const key = `events/active/${event.slug}/x.heic`;
    expect(refusedObjects.has(key)).toBe(true);
    const fetched = jest.spyOn(require('../../src/services/storage').getStorage(), 'resolveLocalPath');
    try {
      await processEvent(event, bucket);
      expect(fetched).not.toHaveBeenCalled();
    } finally { fetched.mockRestore(); }
  }, 30000);

  it('does not import random bytes under a .jpg name', async () => {
    const { row } = await importFile('x.jpg', Buffer.from('definitely not a jpeg, just some bytes'));
    expect(row).toBeUndefined();
  }, 30000);

  it('still imports a real JPEG', async () => {
    const jpeg = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#c33' } }).jpeg().toBuffer();
    const { row } = await importFile('real.jpg', jpeg);
    expect(row).toMatchObject({ filename: 'real.jpg', media_type: 'image', width: 40, height: 30 });
  }, 30000);

  it('still imports a real HEIC', async () => {
    const heic = fs.readFileSync(path.join(__dirname, '../fixtures/hevc-display-p3.heic'));
    const { row } = await importFile('IMG_3974.heic', heic);
    expect(row).toMatchObject({ filename: 'IMG_3974.heic', media_type: 'image', mime_type: 'image/heic' });
    // A busy worker fails the check rather than passing the file (a HEIF
    // check would pass it on upload): the import can look again.
    expect(mockValidator.calls.at(-1)[3]).toEqual({ passBusy: false });
  }, 30000);

  it.each([
    ['a busy image worker', 'IMAGE_WORKER_UNAVAILABLE'],
    ['a full disk', 'ENOSPC'],
  ])('leaves a file it could not check for %s for the next poll, never importing it unchecked', async (_name, code) => {
    const jpeg = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#3c3' } }).jpeg().toBuffer();
    mockValidator.failWith = Object.assign(new Error(`could not check: ${code}`), { code });
    let imported;
    try {
      imported = await importFile('busy.jpg', jpeg);
    } finally { mockValidator.failWith = null; }
    expect(imported.row).toBeUndefined();
    expect(refusedObjects.has(`events/active/${imported.event.slug}/busy.jpg`)).toBe(false);
    await processEvent(imported.event, imported.bucket);
    expect(await db('photos').where({ event_id: imported.event.id }).first()).toMatchObject({ filename: 'busy.jpg' });
  }, 30000);

  it('remembers a file over a configured image limit instead of fetching it every poll', async () => {
    const big = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#33c' } }).jpeg().toBuffer();
    const before = process.env.IMAGE_MAX_PIXELS;
    process.env.IMAGE_MAX_PIXELS = '1000000';
    try {
      const { event, row } = await importFile('huge.jpg', big);
      expect(row).toBeUndefined();
      expect(refusedObjects.has(`events/active/${event.slug}/huge.jpg`)).toBe(true);
    } finally {
      if (before === undefined) delete process.env.IMAGE_MAX_PIXELS; else process.env.IMAGE_MAX_PIXELS = before;
    }
  }, 30000);
});
