const fs = require('fs');
const path = require('path');
const sharp = require('sharp'); // Bounded test fixture creation only.
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

// The capture date a guest's browser sends with a scaled-down photo (issue
// 1733) is a fallback: stored only when the file that arrived has no EXIF
// date of its own, and never for a video.
describe('guest upload capture date fallback', () => {
  let db, cleanup, tmpDir, eventId, processor, plain, dated;
  const id = rows => rows[0]?.id ?? rows[0];
  const clientDate = new Date(2026, 8, 20, 14, 5, 9);

  beforeAll(async () => {
    ({ db, cleanup, tmpDir } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    eventId = id(await db('events').insert({ slug: 'capture-fallback', event_type: 'wedding', event_name: 'Capture fallback',
      event_date: '2026-10-08', host_email: 'host@fixture.invalid', admin_email: 'admin@fixture.invalid',
      password_hash: 'x', share_link: '/gallery/capture-fallback/share', expires_at: new Date(Date.now() + 3600000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, allow_user_uploads: 1, created_by: adminId }).returning('id'));
    const LocalFs = require('../../src/services/storage/LocalFsStorage');
    const storage = new LocalFs({ root: process.env.STORAGE_PATH });
    await storage.init();
    require('../../src/services/storage').setStorageForTesting(storage);
    processor = require('../../src/services/photoProcessor');
    const image = () => sharp({ create: { width: 64, height: 48, channels: 3, background: 'white' } }).jpeg();
    plain = await image().toBuffer();
    dated = await image().withExif({ IFD2: { DateTimeOriginal: '2024:05:01 09:10:11' } }).toBuffer();
  }, 60000);
  afterAll(async () => {
    await require('../../src/services/isolatedSharp').shutdown();
    require('../../src/services/storage').resetStorage();
    if (cleanup) await cleanup();
  });

  async function queue(buffer, name, options) {
    const filename = path.join(tmpDir, name);
    await fs.promises.writeFile(filename, buffer);
    const result = await processor.queueFilesForProcessing(
      [{ path: filename, originalname: name, mimetype: 'image/jpeg' }],
      { eventId, uploadedBy: 'guest', ...options },
    );
    expect(result.errors).toEqual([]);
    return result.photos[0].id;
  }
  const capturedAt = async (photoId) => (await db('photos').where({ id: photoId }).first()).captured_at;
  const asTime = (value) => new Date(value).getTime();

  test('a photo without an EXIF date takes the date the browser sent', async () => {
    const photoId = await queue(plain, 'scaled.jpg', { clientCapturedAt: clientDate });
    expect(asTime(await capturedAt(photoId))).toBe(clientDate.getTime());
    // The worker leaves a date that is already there alone.
    await processor.processPhoto(photoId);
    expect(asTime(await capturedAt(photoId))).toBe(clientDate.getTime());
  });

  test('a photo with its own EXIF date ignores the date the browser sent', async () => {
    const photoId = await queue(dated, 'original.jpg', { clientCapturedAt: clientDate });
    expect(await capturedAt(photoId)).toBeNull();
    // The worker then stores the EXIF date. Under jest that write is a Date
    // object sqlite3 cannot bind (see CLAUDE.md), so only "written, and not
    // the browser's" is asserted.
    await processor.processPhoto(photoId);
    const stored = await capturedAt(photoId);
    expect(stored).not.toBeNull();
    expect(asTime(stored)).not.toBe(clientDate.getTime());
  });

  test('without a date from the browser nothing is stored at queue time', async () => {
    const photoId = await queue(plain, 'no-date.jpg', {});
    expect(await capturedAt(photoId)).toBeNull();
  });
});
