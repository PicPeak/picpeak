/**
 * Lazy thumbnail regeneration for videos (#1414).
 *
 * ensureThumbnail is the one path that repairs a photo row whose thumbnail is
 * missing or unreadable — the gallery thumbnail route, the admin "regenerate
 * thumbnails" button and the OG-image builder all go through it. It had no
 * video branch, so it resolved the source and handed it to Sharp, which throws
 * on an mp4. Videos that reached that state — uploaded before the upload
 * pipeline learned to fall back to a placeholder, or with their rendition
 * since lost — could never get a thumbnail back, however many times they were
 * viewed or regenerated.
 *
 * They now go through the same processUploadedVideo a fresh upload uses, so
 * regeneration yields the poster frame (or, if ffmpeg cannot read the file,
 * the same SVG placeholder the upload path falls back to).
 */

jest.mock('../../utils/logger');
jest.mock('../../database/db', () => {
  const photosUpdate = jest.fn().mockResolvedValue(1);
  const db = jest.fn((table) => {
    if (table === 'events') {
      return { where: () => ({ first: () => Promise.resolve({ id: 7, slug: 'summer-wedding' }) }) };
    }
    if (table === 'photos') {
      return { where: () => ({ update: photosUpdate }) };
    }
    throw new Error(`unexpected table: ${table}`);
  });
  db.photosUpdate = photosUpdate;
  return { db };
});
jest.mock('../storage', () => ({
  getStorage: () => ({
    kind: () => 'local',
    resolveLocalPath: (key) => `/storage/${key}`
  })
}));
jest.mock('../videoProcessor', () => ({
  processUploadedVideo: jest.fn()
}));
jest.mock('../photoResolver', () => ({
  resolvePhotoStorageKey: jest.fn(),
  resolvePhotoFilePath: jest.fn()
}));

const { db } = require('../../database/db');
const { processUploadedVideo } = require('../videoProcessor');
const { resolvePhotoStorageKey, resolvePhotoFilePath } = require('../photoResolver');
const { ensureThumbnail } = require('../imageProcessor');

const managedVideo = {
  id: 42,
  event_id: 7,
  filename: 'clip.mp4',
  path: 'summer-wedding/individual/clip.mp4',
  media_type: 'video',
  mime_type: 'video/mp4',
  thumbnail_path: null
};

describe('ensureThumbnail rebuilds a video thumbnail from the video (#1414)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resolvePhotoStorageKey.mockReturnValue('events/active/summer-wedding/individual/clip.mp4');
    resolvePhotoFilePath.mockReturnValue('/mnt/nas/2026/clip.mp4');
    processUploadedVideo.mockImplementation(async (_videoPath, thumbnailKey) => ({
      success: true,
      metadata: { duration: 12 },
      thumbnailKey
    }));
  });

  it('generates a poster frame for a managed video that has no thumbnail yet', async () => {
    const result = await ensureThumbnail(managedVideo);

    expect(processUploadedVideo).toHaveBeenCalledWith(
      '/storage/events/active/summer-wedding/individual/clip.mp4',
      'thumbnails/thumb_clip.jpg'
    );
    expect(result).toBe('thumbnails/thumb_clip.jpg');
    expect(db.photosUpdate).toHaveBeenCalledWith({ thumbnail_path: 'thumbnails/thumb_clip.jpg' });
  });

  it('recognises a video by mime type alone, for rows predating media_type', async () => {
    const { media_type: _unused, ...legacyRow } = managedVideo;

    const result = await ensureThumbnail({ ...legacyRow, id: 43 });

    expect(processUploadedVideo).toHaveBeenCalled();
    expect(result).toBe('thumbnails/thumb_clip.jpg');
  });

  it('reads an external video straight off its mount, under a per-photo key', async () => {
    const result = await ensureThumbnail({
      ...managedVideo,
      id: 44,
      source_origin: 'external',
      external_relpath: '2026/clip.mp4'
    });

    expect(resolvePhotoFilePath).toHaveBeenCalled();
    expect(processUploadedVideo).toHaveBeenCalledWith(
      '/mnt/nas/2026/clip.mp4',
      'thumbnails/thumb_ext44_clip.jpg'
    );
    expect(result).toBe('thumbnails/thumb_ext44_clip.jpg');
  });

  it('returns null instead of throwing when the video cannot be thumbnailed at all', async () => {
    processUploadedVideo.mockRejectedValue(new Error('storage backend down'));

    await expect(ensureThumbnail({ ...managedVideo, id: 45 })).resolves.toBeNull();
    expect(db.photosUpdate).not.toHaveBeenCalled();
  });

  it('leaves still images on the image path', async () => {
    resolvePhotoStorageKey.mockImplementation(() => { throw new Error('resolved as an image'); });

    const result = await ensureThumbnail({
      ...managedVideo,
      id: 46,
      filename: 'still.jpg',
      media_type: 'image',
      mime_type: 'image/jpeg'
    });

    expect(processUploadedVideo).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});
