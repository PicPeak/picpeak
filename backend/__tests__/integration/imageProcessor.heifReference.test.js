/**
 * A HEVC HEIC in a reference gallery: every rendition has to reach the decode,
 * and one that outlives a replacement must not be recorded.
 */
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const mediaRoot = require('fs').mkdtempSync(path.join(os.tmpdir(), 'picpeak-heif-media-'));
process.env.EXTERNAL_MEDIA_ROOT = mediaRoot;

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

describe('renditions of a reference photo', () => {
  let db, cleanup, storage, imageProcessor, eventId;
  const resultId = rows => rows[0]?.id ?? rows[0];

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    eventId = resultId(await db('events').insert({ slug: 'heif-reference', event_type: 'wedding', event_name: 'Source version',
      event_date: '2026-10-14', host_email: 'host@fixture.invalid', admin_email: 'admin@fixture.invalid',
      password_hash: 'x', share_link: '/gallery/heif-reference/share', expires_at: new Date(Date.now() + 3600000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_by: adminId, source_mode: 'reference', external_path: 'shoot' }).returning('id'));
    const LocalFs = require('../../src/services/storage/LocalFsStorage');
    storage = new LocalFs({ root: process.env.STORAGE_PATH }); await storage.init();
    require('../../src/services/storage').setStorageForTesting(storage);
    imageProcessor = require('../../src/services/imageProcessor');
  }, 60000);
  afterAll(async () => {
    await require('../../src/services/isolatedSharp').shutdown();
    require('../../src/services/storage').resetStorage();
    if (cleanup) await cleanup();
    await fsp.rm(mediaRoot, { recursive: true, force: true });
  });
  afterEach(() => jest.restoreAllMocks());

  describe('a HEVC HEIC on the share (issue 2359)', () => {
    const FIXTURE = path.join(__dirname, '../fixtures/hevc-display-p3.heic');
    const mediaProcesses = require('../../src/services/mediaProcessService');
    const fakeFfmpeg = (during = async () => {}) => jest.spyOn(mediaProcesses, 'run').mockImplementation(async (_command, args) => {
      await during();
      await sharp({ create: { width: 40, height: 30, channels: 3, background: '#c33' } }).jpeg().toFile(args[args.length - 1]);
      return { stdout: Buffer.alloc(0) };
    });

    async function heicPhoto(name) {
      const full = path.join(mediaRoot, 'shoot', name);
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.copyFile(FIXTURE, full);
      const { size } = await fsp.stat(full);
      const id = resultId(await db('photos').insert({ event_id: eventId, filename: name, original_filename: name,
        path: `shoot/${name}`, external_relpath: `shoot/${name}`, type: 'individual', mime_type: 'image/heic', media_type: 'image',
        size_bytes: size, processing_status: 'complete', source_origin: 'reference' }).returning('id'));
      return db('photos').where({ id }).first();
    }

    test('the preview, its tiers and the hero go through the decode', async () => {
      const run = fakeFfmpeg();
      const row = await heicPhoto('share-renditions.heic');
      expect(await imageProcessor.ensurePreviewImage(row)).toBeTruthy();
      expect(await imageProcessor.ensurePreviewImageAtWidth(row, 640)).toBeTruthy();
      expect(await imageProcessor.ensureHeroImage(row)).toBeTruthy();
      expect(run).toHaveBeenCalledTimes(3);
    });

    test('a decode that outlives a replacement is not recorded', async () => {
      const row = await heicPhoto('share-replaced.heic');
      fakeFfmpeg(() => db('photos').where({ id: row.id }).update({ filename: 'replacement.jpg' }));
      await expect(imageProcessor.ensurePreviewImage(row)).rejects.toMatchObject({ code: 'MEDIA_SUPERSEDED' });
      expect((await db('photos').where({ id: row.id }).first()).preview_path).toBeNull();
    });
  });
});
