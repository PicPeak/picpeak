/**
 * Bounding-box coordinate space (#1074).
 *
 * The sidecar reports boxes in the pixel space of the image it was HANDED —
 * the ≤1920px preview — while every consumer (the strip's avatar crop, the
 * admin manager, the auto-category portrait rule) compares them against
 * photos.width/height, the ORIGINAL dimensions. faceProcessor scales once so
 * everything downstream can assume original-image coordinates.
 *
 * This is the defect that survived longest in review, and it is invisible on
 * any photo already under 1920px — the entire demo gallery was 750px, so the
 * scale factor was always exactly 1.0 and the correction never ran. Verified
 * by hand afterwards on a real 4000x3000 upload (stored box moved from
 * 1493,204 to 3110,426 — a factor of 2.083, exactly 4000/1920). This test
 * exists so that verification does not have to be repeated by hand.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-facescale-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'facescale-test-secret';

// A 1920x1440 JPEG standing in for the preview rendition. faceProcessor reads
// its dimensions with sharp to derive the scale, so it must be a real image.
const sharp = require('sharp');

let mockPreviewBuffer;
const mockSidecarBox = [1493, 204, 131, 161]; // what the sidecar sees on the preview

jest.mock('../../src/services/imageProcessor', () => ({
  ...jest.requireActual('../../src/services/imageProcessor'),
  ensurePreviewImage: jest.fn(async () => 'previews/preview_test.jpg'),
}));

jest.mock('../../src/services/storage', () => ({
  getStorage: () => ({ get: async () => mockPreviewBuffer }),
}));

jest.mock('../../src/services/faceClient', () => ({
  detectFaces: jest.fn(async () => ({
    model_version: 'test-v1',
    faces: [{
      bbox: mockSidecarBox,
      score: 0.99,
      landmarks: [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]],
      yaw: 0, pitch: 0, blur: 500,
      embedding: Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0)),
    }],
  })),
  SidecarUnavailableError: class extends Error {},
}));

const { bootCrmDb } = require('./helpers/crmDb');

let db; let cleanup; let faceProcessor;

async function seedPhoto(width, height) {
  const [e] = await db('events').insert({
    slug: `scale-${width}-${Math.random().toString(36).slice(2, 8)}`,
    event_type: 'wedding',
    event_name: 'scale',
    event_date: '2026-01-01',
    host_email: 'h@example.com',
    admin_email: 'a@example.com',
    password_hash: 'x',
    share_link: `scale-${Math.random()}`,
    expires_at: new Date().toISOString(),
    face_recognition_enabled: true,
  }).returning('id');
  const eventId = typeof e === 'object' ? e.id : e;

  const [p] = await db('photos').insert({
    event_id: eventId,
    filename: 'big.jpg',
    path: '/tmp/big.jpg',
    type: 'individual',
    width,
    height,
    processing_status: 'complete',
    face_status: 'processing',
  }).returning('id');
  return { eventId, photoId: typeof p === 'object' ? p.id : p };
}

describe('face bbox coordinate space (#1074)', () => {
  beforeAll(async () => {
    mockPreviewBuffer = await sharp({
      create: { width: 1920, height: 1440, channels: 3, background: { r: 20, g: 40, b: 80 } },
    }).jpeg().toBuffer();

    ({ db, cleanup } = await bootCrmDb());
    // The faces flag gates everything; turn it on for this suite.
    await db('feature_flags').insert({ key: 'faces', value: true })
      .onConflict('key').merge()
      .catch(async () => { await db('feature_flags').where({ key: 'faces' }).update({ value: true }); });
    faceProcessor = require('../../src/services/faceProcessor');
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('scales preview-space boxes into ORIGINAL image coordinates', async () => {
    // 4000px original, 1920px preview -> every coordinate must grow by 4000/1920.
    const { photoId } = await seedPhoto(4000, 3000);
    await faceProcessor.processPhotoFaces(photoId);

    const face = await db('photo_faces').where({ photo_id: photoId }).first();
    const scale = 4000 / 1920;

    expect(face.bbox_x).toBeCloseTo(mockSidecarBox[0] * scale, 1);
    expect(face.bbox_y).toBeCloseTo(mockSidecarBox[1] * scale, 1);
    expect(face.bbox_w).toBeCloseTo(mockSidecarBox[2] * scale, 1);
    expect(face.bbox_h).toBeCloseTo(mockSidecarBox[3] * scale, 1);

    // The regression this guards: the raw preview-space value being stored.
    expect(face.bbox_x).not.toBeCloseTo(mockSidecarBox[0], 1);
    // And a sanity check that it lands inside the original frame.
    expect(face.bbox_x + face.bbox_w).toBeLessThanOrEqual(4000);
  });

  it('leaves boxes untouched when the photo is already preview-sized', async () => {
    // The case that hid the bug: no downscale, so scale is exactly 1 and the
    // stored box equals what the sidecar reported.
    const { photoId } = await seedPhoto(1920, 1440);
    await faceProcessor.processPhotoFaces(photoId);

    const face = await db('photo_faces').where({ photo_id: photoId }).first();
    expect(face.bbox_x).toBeCloseTo(mockSidecarBox[0], 1);
    expect(face.bbox_w).toBeCloseTo(mockSidecarBox[2], 1);
  });

  it('falls back to unscaled rather than corrupting when width is unknown', async () => {
    // Pre-dimension-migration rows have no width. Storing a box scaled by
    // NaN/0 would be worse than storing an unscaled one.
    const { photoId } = await seedPhoto(null, null);
    await faceProcessor.processPhotoFaces(photoId);

    const face = await db('photo_faces').where({ photo_id: photoId }).first();
    expect(Number.isFinite(face.bbox_x)).toBe(true);
    expect(face.bbox_x).toBeCloseTo(mockSidecarBox[0], 1);
  });
});
