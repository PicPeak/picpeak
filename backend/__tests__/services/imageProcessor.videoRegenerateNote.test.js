/**
 * Regenerating a video's thumbnail keeps the processing note honest (issue
 * 1430, item 6): a real frame clears "No poster frame", a placeholder writes
 * it, and a row that is not `complete` keeps whatever its note says.
 *
 * Before this the admin "Regenerate thumbnails" button (and the lazy repair on
 * first view) updated thumbnail_path alone, so a rebuilt frame still showed
 * the stale warning and Retry.
 */
const path = require('path');
const fs = require('fs').promises;
const os = require('os');

jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

jest.mock('../../src/database/db', () => {
  const state = { events: {}, updates: [] };
  const api = (table) => {
    if (table === 'events') {
      return { where: (_col, id) => ({ first: async () => state.events[id] || null }) };
    }
    if (table === 'photos') {
      return { where: (criteria) => ({ update: async (values) => { state.updates.push({ criteria, values }); return 1; } }) };
    }
    if (table === 'app_settings') {
      return { whereIn: () => ({ select: async () => [] }) };
    }
    throw new Error(`unexpected table in test: ${table}`);
  };
  api.__state = state;
  return { db: api };
});

const mockProcessUploadedVideo = jest.fn();
jest.mock('../../src/services/videoProcessor', () => {
  const actual = jest.requireActual('../../src/services/videoProcessor');
  return { ...actual, processUploadedVideo: (...args) => mockProcessUploadedVideo(...args) };
});

const LocalFsStorage = require('../../src/services/storage/LocalFsStorage');
const storageModule = require('../../src/services/storage');
const { db } = require('../../src/database/db');

const EVENT = { id: 11, slug: 'managed-ev', source_mode: 'managed' };

describe('regenerating a video thumbnail and the processing note', () => {
  let imageProcessor; let storageRoot;

  beforeAll(async () => {
    storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-regen-note-'));
    const storage = new LocalFsStorage({ root: storageRoot });
    await storage.init();
    storageModule.setStorageForTesting(storage);
    imageProcessor = require('../../src/services/imageProcessor');
  });

  afterAll(async () => {
    storageModule.resetStorage();
    await fs.rm(storageRoot, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    db.__state.events = { [EVENT.id]: EVENT };
    db.__state.updates = [];
    mockProcessUploadedVideo.mockReset();
    await fs.mkdir(path.join(storageRoot, 'events/active/managed-ev/individual'), { recursive: true });
    await fs.writeFile(path.join(storageRoot, 'events/active/managed-ev/individual/clip.mp4'), 'not a video');
  });

  const video = (over = {}) => ({
    id: 501, event_id: EVENT.id, filename: 'clip.mp4', media_type: 'video', mime_type: 'video/mp4',
    path: 'events/active/managed-ev/individual/clip.mp4', thumbnail_path: null, processing_status: 'complete',
    ...over,
  });

  it('clears the note when a real poster frame comes back', async () => {
    mockProcessUploadedVideo.mockResolvedValue({ success: true, thumbnailKey: 'thumbnails/thumb_clip.jpg', placeholder: false, thumbnailError: null });
    expect(await imageProcessor.ensureThumbnail(video({ processing_error: 'No poster frame: ffmpeg seek failed' }), { force: true }))
      .toBe('thumbnails/thumb_clip.jpg');
    expect(db.__state.updates).toEqual([{ criteria: { id: 501 }, values: { thumbnail_path: 'thumbnails/thumb_clip.jpg', processing_error: null } }]);
  });

  it('writes the note when the regeneration fell back to the placeholder', async () => {
    mockProcessUploadedVideo.mockResolvedValue({ success: true, thumbnailKey: 'thumbnails/thumb_clip.jpg', placeholder: true, thumbnailError: 'ffmpeg exited with code 183: Error opening input file /srv/x/clip.mp4' });
    await imageProcessor.ensureThumbnail(video(), { force: true });
    const [update] = db.__state.updates;
    expect(update.values.thumbnail_path).toBe('thumbnails/thumb_clip.jpg');
    expect(update.values.processing_error).toMatch(/^No poster frame: ffmpeg exited with code 183/);
    // The note never carries the path on disk.
    expect(update.values.processing_error).not.toContain('/srv/x/');
  });

  it('leaves the note of a row that is not complete alone', async () => {
    mockProcessUploadedVideo.mockResolvedValue({ success: true, thumbnailKey: 'thumbnails/thumb_clip.jpg', placeholder: false, thumbnailError: null });
    await imageProcessor.ensureThumbnail(video({ processing_status: 'failed', processing_error: 'sharp: bad header' }), { force: true });
    expect(db.__state.updates).toEqual([{ criteria: { id: 501 }, values: { thumbnail_path: 'thumbnails/thumb_clip.jpg' } }]);
  });
});
