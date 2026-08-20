/**
 * External / reference photos are scannable (#1090).
 *
 * faceProcessor used to short-circuit every photo with source_origin
 * 'external' or 'reference' to 'skipped', because resolvePhotoStorageKey
 * returns null for anything outside managed storage and ensurePreviewImage
 * could not build a preview for it. #1078 removed that limitation —
 * ensurePreviewImage now reads externals straight off the mount and writes
 * the preview into managed storage — but the guard stayed, so the whole
 * feature was a no-op on external-media installs. The reporter's gallery sat
 * at 0/3230 with every row 'skipped' and no error.
 *
 * These pin both halves: the guard is gone, and a photo whose source is
 * genuinely missing still fails rather than being quietly skipped — the blanket
 * skip used to absorb that case too, so a real breakage looked like an
 * unsupported one.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-faceext-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'faceext-test-secret';
// A real, existing media root. getExternalMediaRoot only honours the env var
// if the directory exists and caches it on first call, so this has to be set
// up before anything requires externalMediaService.
process.env.EXTERNAL_MEDIA_ROOT = path.join(path.dirname(process.env.TEST_DATABASE_PATH), 'media');
fs.mkdirSync(path.join(process.env.EXTERNAL_MEDIA_ROOT, 'share', 'individual'), { recursive: true });
// Non-empty on purpose: an empty directory is read as an unmounted share
// (faceTransientSource.test.js), so a "healthy storage, dead photo" fixture
// needs a sibling present or it defers instead of failing.
fs.writeFileSync(path.join(process.env.EXTERNAL_MEDIA_ROOT, 'share', 'individual', 'sibling.jpg'), 'x');

const sharp = require('sharp');

let mockPreviewBuffer;
// Set per-test: what ensurePreviewImage returns for the photo under test.
let previewKeyResult;  // eslint-disable-line prefer-const
const mockEnsurePreviewImage = jest.fn(async () => previewKeyResult);
const mockDetectFaces = jest.fn();

jest.mock('../../src/services/imageProcessor', () => ({
  ...jest.requireActual('../../src/services/imageProcessor'),
  ensurePreviewImage: (...args) => mockEnsurePreviewImage(...args),
}));

jest.mock('../../src/services/storage', () => ({
  getStorage: () => ({ get: async () => mockPreviewBuffer }),
}));

jest.mock('../../src/services/faceClient', () => ({
  detectFaces: (...args) => mockDetectFaces(...args),
  SidecarUnavailableError: class extends Error {},
}));

const { bootCrmDb } = require('./helpers/crmDb');

let db; let cleanup; let faceProcessor;

async function seedPhoto({ sourceOrigin = 'managed', sourceMode = 'managed' } = {}) {
  const [e] = await db('events').insert({
    slug: `ext-${Math.random().toString(36).slice(2, 8)}`,
    event_type: 'wedding',
    event_name: 'ext',
    event_date: '2026-01-01',
    host_email: 'h@example.com',
    admin_email: 'a@example.com',
    password_hash: 'x',
    share_link: `ext-${Math.random()}`,
    expires_at: new Date().toISOString(),
    face_recognition_enabled: true,
    source_mode: sourceMode,
    external_path: 'share',
  }).returning('id');
  const eventId = typeof e === 'object' ? e.id : e;

  const [p] = await db('photos').insert({
    event_id: eventId,
    filename: 'ext.jpg',
    path: '/tmp/ext.jpg',
    type: 'individual',
    width: 1920,
    height: 1440,
    processing_status: 'complete',
    face_status: 'processing',
    source_origin: sourceOrigin,
    external_relpath: sourceOrigin === 'managed' ? null : 'individual/ext.jpg',
  }).returning('id');
  return { eventId, photoId: typeof p === 'object' ? p.id : p };
}

describe('face scanning of external/reference photos (#1090)', () => {
  beforeAll(async () => {
    mockPreviewBuffer = await sharp({
      create: { width: 1920, height: 1440, channels: 3, background: { r: 20, g: 40, b: 80 } },
    }).jpeg().toBuffer();

    ({ db, cleanup } = await bootCrmDb());
    await db('feature_flags').insert({ key: 'faces', value: true })
      .onConflict('key').merge()
      .catch(async () => { await db('feature_flags').where({ key: 'faces' }).update({ value: true }); });
    faceProcessor = require('../../src/services/faceProcessor');
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(() => {
    mockEnsurePreviewImage.mockClear();
    mockDetectFaces.mockClear();
    previewKeyResult = 'previews/preview_ext.jpg';
    mockDetectFaces.mockResolvedValue({
      model_version: 'test-v1',
      faces: [{
        bbox: [100, 100, 50, 50],
        score: 0.99,
        landmarks: [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]],
        yaw: 0, pitch: 0, blur: 500,
        embedding: Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0)),
      }],
    });
  });

  it.each(['external', 'reference'])('scans a %s photo instead of skipping it', async (origin) => {
    const { photoId } = await seedPhoto({ sourceOrigin: origin, sourceMode: 'reference' });

    const result = await faceProcessor.processPhotoFaces(photoId);

    // The regression: this used to return 'skipped' without ever building a
    // preview or contacting the sidecar.
    expect(result.status).not.toBe('skipped');
    expect(mockEnsurePreviewImage).toHaveBeenCalled();
    expect(mockDetectFaces).toHaveBeenCalled();

    const photo = await db('photos').where({ id: photoId }).first();
    expect(photo.face_status).toBe('done');
    expect(await db('photo_faces').where({ photo_id: photoId }).first()).toBeTruthy();
  });

  it('fails, not skips, when the external source is genuinely gone', async () => {
    // A missing file is a property of that photo, so it should be visible as a
    // failure the admin can act on — not silently absorbed the way the old
    // blanket skip did.
    //
    // The containing directory exists here on purpose. An absent directory is
    // a dropped mount, which defers rather than fails
    // (faceTransientSource.test.js); this is the other case — healthy storage,
    // dead photo.
    previewKeyResult = null;
    const { photoId } = await seedPhoto({ sourceOrigin: 'external', sourceMode: 'reference' });

    const result = await faceProcessor.processPhotoFaces(photoId);

    expect(result.status).toBe('failed');
    expect(mockDetectFaces).not.toHaveBeenCalled();
    const photo = await db('photos').where({ id: photoId }).first();
    expect(photo.face_status).toBe('failed');
    expect(photo.face_error).toMatch(/preview/i);
  });
});
