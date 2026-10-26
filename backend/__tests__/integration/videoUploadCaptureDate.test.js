/**
 * The synchronous upload path (chunked admin upload) stores a video's
 * displayed size and the capture date its container carries (issue 2263).
 * ffmpeg is stood in for: what is under test is the row, not the probe.
 */

const fs = require('fs');
const path = require('path');

const mockVideo = { metadata: null };
jest.mock('../../src/services/videoProcessor', () => {
  const actual = jest.requireActual('../../src/services/videoProcessor');
  return {
    ...actual,
    processUploadedVideo: jest.fn(async () => ({
      success: true, metadata: mockVideo.metadata, thumbnailKey: 'thumbnails/thumb_clip.jpg', placeholder: false, thumbnailError: null, thumbHash: null,
    })),
  };
});

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

describe('video upload capture date (issue 2263)', () => {
  let db; let cleanup; let event; let counter = 0;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    const inserted = await db('events').insert({
      slug: 'video-date', event_type: 'wedding', event_name: 'Video Date', event_date: '2026-08-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: '/gallery/video-date/share', share_token: 'video-date-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_at: new Date().toISOString(),
    }).returning('id');
    event = await db('events').where({ id: inserted[0]?.id ?? inserted[0] }).first();
    await fs.promises.mkdir(path.join(process.env.STORAGE_PATH, 'events', 'active', event.slug), { recursive: true });
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  async function upload(metadata) {
    mockVideo.metadata = metadata;
    counter += 1;
    const temp = path.join(process.env.STORAGE_PATH, `clip-${counter}.mov`);
    await fs.promises.writeFile(temp, Buffer.from('not really a video'));
    const { processUploadedPhotos } = require('../../src/services/photoProcessor');
    const [uploaded] = await processUploadedPhotos(
      [{ path: temp, originalname: `clip-${counter}.mov`, mimetype: 'video/quicktime', size: 18 }], event.id
    );
    return db('photos').where({ id: uploaded.id }).first();
  }

  it('writes the date and the portrait size', async () => {
    const row = await upload({ duration: 3, videoCodec: 'hevc', width: 1080, height: 1920, capturedAt: '2025-06-15T12:30:00.000Z' });
    expect(new Date(row.captured_at).toISOString()).toBe('2025-06-15T12:30:00.000Z');
    expect(row.width).toBe(1080);
    expect(row.height).toBe(1920);
  });

  it('leaves it empty when the container has none', async () => {
    const row = await upload({ duration: 3, videoCodec: 'h264', width: 1920, height: 1080, capturedAt: null });
    expect(row.captured_at).toBeNull();
  });
});
