/**
 * A face scan publishes only under the claim that started it (issue 2069).
 *
 * `face_status = 'processing'` alone does not say WHICH claim holds the row.
 * A purge and a re-queue while worker A waits on the sidecar (an external
 * file edited in place, an admin re-scan), followed by worker B's claim,
 * leave the row 'processing' again, and A used to commit the faces of the
 * old image over it. Each claim now carries its own id, and every write the
 * worker makes afterwards is guarded on it.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-faceattempt-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'faceattempt-test-secret';

const sharp = require('sharp');

let mockPreviewBuffer;
let mockPreviewKey = 'previews/preview_test.jpg';
// Runs once inside the next sidecar call: the window between a scan's start
// and its commit.
let mockDuringScan = null;
let mockFaceCount = 1;

jest.mock('../../src/services/imageProcessor', () => ({
  ...jest.requireActual('../../src/services/imageProcessor'),
  ensurePreviewImage: jest.fn(async () => {
    if (mockDuringScan) {
      const hook = mockDuringScan;
      mockDuringScan = null;
      await hook();
    }
    return mockPreviewKey;
  }),
}));

jest.mock('../../src/services/storage', () => ({
  getStorage: () => ({ get: async () => mockPreviewBuffer }),
}));

jest.mock('../../src/services/faceClient', () => ({
  detectFaces: jest.fn(async () => {
    if (mockDuringScan) {
      const hook = mockDuringScan;
      mockDuringScan = null;
      await hook();
    }
    return {
      model_version: 'test-v1',
      faces: Array.from({ length: mockFaceCount }, (_, n) => ({
        bbox: [10 + n * 100, 10, 50, 60],
        score: 0.99,
        yaw: 0, pitch: 0, blur: 500,
        embedding: Array.from({ length: 64 }, (_, i) => (i === n ? 1 : 0)),
      })),
    };
  }),
  SidecarUnavailableError: class extends Error {},
}));

const { bootCrmDb } = require('./helpers/crmDb');

let db; let cleanup; let faceProcessor; let faceQueue;

async function seedPendingPhoto() {
  const [e] = await db('events').insert({
    slug: `attempt-${Math.random().toString(36).slice(2, 8)}`,
    event_type: 'wedding',
    event_name: 'attempt',
    event_date: '2026-01-01',
    host_email: 'h@example.com',
    admin_email: 'a@example.com',
    password_hash: 'x',
    share_link: `attempt-${Math.random()}`,
    expires_at: new Date().toISOString(),
    face_recognition_enabled: true,
  }).returning('id');
  const eventId = typeof e === 'object' ? e.id : e;
  const [p] = await db('photos').insert({
    event_id: eventId,
    filename: 'p.jpg',
    path: '/tmp/p.jpg',
    type: 'individual',
    width: 1920,
    height: 1440,
    processing_status: 'complete',
    face_status: 'pending',
  }).returning('id');
  return { eventId, photoId: typeof p === 'object' ? p.id : p };
}

// What externalImportService does when a file was edited in place.
async function refreshInPlace({ photoId }) {
  await db.transaction(async (trx) => {
    await faceProcessor.purgePhotoFaces(photoId, trx);
    await trx('photos').where({ id: photoId }).update({ face_status: 'pending' });
  });
}

// The admin "Re-scan" button.
async function adminRescan({ eventId }) {
  await faceProcessor.enqueueEvent(eventId, { onlyUnscanned: false });
}

describe('face scan attempt guard (issue 2069)', () => {
  beforeAll(async () => {
    mockPreviewBuffer = await sharp({
      create: { width: 1920, height: 1440, channels: 3, background: { r: 20, g: 40, b: 80 } },
    }).jpeg().toBuffer();
    ({ db, cleanup } = await bootCrmDb());
    await db('feature_flags').insert({ key: 'faces', value: true })
      .onConflict('key').merge()
      .catch(async () => { await db('feature_flags').where({ key: 'faces' }).update({ value: true }); });
    faceProcessor = require('../../src/services/faceProcessor');
    faceQueue = require('../../src/services/faceQueue');
  }, 120000);

  beforeEach(async () => {
    await db('photo_faces').del();
    await db('event_people').del();
    await db('photos').del();
    mockDuringScan = null;
    mockFaceCount = 1;
    mockPreviewKey = 'previews/preview_test.jpg';
  });

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('commits the faces of a normal scan and clears the claim id', async () => {
    const { photoId } = await seedPendingPhoto();
    const claimed = await faceQueue.claimNextPhoto();
    expect(claimed.id).toBe(photoId);
    expect(claimed.face_attempt_id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await db('photos').where({ id: photoId }).first()).face_attempt_id)
      .toBe(claimed.face_attempt_id);

    await expect(faceProcessor.processPhotoFaces(claimed)).resolves.toMatchObject({ status: 'done' });

    const row = await db('photos').where({ id: photoId }).first();
    expect(row).toMatchObject({ face_status: 'done', face_count: 1, face_attempt_id: null });
    expect(await db('photo_faces').where({ photo_id: photoId }).count({ c: '*' }).first())
      .toEqual({ c: 1 });
  });

  it.each([
    ['an external refresh', refreshInPlace],
    ['an admin re-scan', adminRescan],
  ])('discards the first scan after %s and a new claim', async (_label, requeue) => {
    const seeded = await seedPendingPhoto();
    const { photoId } = seeded;
    const first = await faceQueue.claimNextPhoto();
    let second = null;
    // Worker A's sidecar call is in flight: the photo is re-queued and
    // worker B claims it again.
    mockDuringScan = async () => {
      await requeue(seeded);
      second = await faceQueue.claimNextPhoto();
    };
    // A sees two faces in the old bytes.
    mockFaceCount = 2;

    await expect(faceProcessor.processPhotoFaces(first)).resolves.toEqual({ status: 'skipped' });

    expect(second.id).toBe(photoId);
    expect(second.face_attempt_id).not.toBe(first.face_attempt_id);
    // Nothing of A's landed, and B still holds the row.
    expect(await db('photo_faces').where({ photo_id: photoId }).count({ c: '*' }).first())
      .toEqual({ c: 0 });
    expect(await db('photos').where({ id: photoId }).first())
      .toMatchObject({ face_status: 'processing', face_attempt_id: second.face_attempt_id });

    // B scans the new bytes (one face) and commits.
    mockFaceCount = 1;
    await expect(faceProcessor.processPhotoFaces(second)).resolves.toMatchObject({ status: 'done' });
    expect(await db('photos').where({ id: photoId }).first())
      .toMatchObject({ face_status: 'done', face_count: 1, face_attempt_id: null });
    expect(await db('photo_faces').where({ photo_id: photoId }).count({ c: '*' }).first())
      .toEqual({ c: 1 });
  });

  it('a superseded scan that cannot get a preview does not fail the newer claim', async () => {
    const seeded = await seedPendingPhoto();
    const first = await faceQueue.claimNextPhoto();
    let second = null;
    mockDuringScan = async () => {
      await refreshInPlace(seeded);
      second = await faceQueue.claimNextPhoto();
    };
    mockPreviewKey = null;

    await expect(faceProcessor.processPhotoFaces(first)).resolves.toEqual({ status: 'failed' });

    expect(await db('photos').where({ id: seeded.photoId }).first())
      .toMatchObject({ face_status: 'processing', face_attempt_id: second.face_attempt_id, face_error: null });
  });

  it('takes the photo before its faces in the scan commit and the event purge', () => {
    // The lock order faceScanLockOrder.pg.test.js exercises on PostgreSQL;
    // pinned here too because that suite only runs with a PG URL.
    const src = fs.readFileSync(path.join(__dirname, '../../src/services/faceProcessor.js'), 'utf8');
    const between = (from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));
    const scanTrx = between('await db.transaction(async (trx) => {', '} catch (err) {');
    expect(scanTrx.indexOf('forKeyShare()')).toBeGreaterThan(-1);
    expect(scanTrx.indexOf('forKeyShare()')).toBeLessThan(scanTrx.indexOf('claimGuard(claimed, trx)'));
    expect(scanTrx.indexOf('claimGuard(claimed, trx)')).toBeLessThan(scanTrx.indexOf('trx(\'photo_faces\')'));
    const purge = between('async function purgeEvent(', '\n}\n');
    expect(purge.indexOf('trx(\'photos\')')).toBeGreaterThan(-1);
    expect(purge.indexOf('trx(\'photos\')')).toBeLessThan(purge.indexOf('trx(\'photo_faces\')'));
  });

  it('a claim taken away before the scan starts is skipped without a sidecar call', async () => {
    const seeded = await seedPendingPhoto();
    const first = await faceQueue.claimNextPhoto();
    await refreshInPlace(seeded);
    const second = await faceQueue.claimNextPhoto();
    const { detectFaces } = require('../../src/services/faceClient');
    detectFaces.mockClear();

    await expect(faceProcessor.processPhotoFaces(first)).resolves.toEqual({ status: 'skipped' });
    expect(detectFaces).not.toHaveBeenCalled();
    expect(await db('photos').where({ id: seeded.photoId }).first())
      .toMatchObject({ face_status: 'processing', face_attempt_id: second.face_attempt_id });
  });
});
