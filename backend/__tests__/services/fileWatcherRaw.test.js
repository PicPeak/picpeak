/**
 * A camera RAW dropped into the watched folder becomes a gallery photo.
 *
 * The watcher used to accept four extensions and return early on anything
 * else, so a RAW sat in the folder with no row and no log line. Widening that
 * list alone would not do: sharp cannot decode a RAW, so the row would have no
 * thumbnail and no dimensions, and a guest would see nothing.
 *
 * Runs against a real SQLite database and real files on disk. exiftool is not
 * available in CI and there is no RAW fixture in the repo, so the one stub is
 * the preview extraction: for a RAW name it hands back a real JPEG, the way
 * extractRawPreview does with the camera's embedded preview.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-watcher-raw-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'watcher-raw-test-secret';
process.env.STORAGE_BACKEND = 'local';

const mockPreviewCleanup = jest.fn();
jest.mock('../../src/services/imageProcessor', () => {
  const actual = jest.requireActual('../../src/services/imageProcessor');
  return {
    ...actual,
    withProcessableImage: jest.fn(async (localPath, sourceName) => {
      if (!/\.arw$/i.test(sourceName)) return actual.withProcessableImage(localPath, sourceName);
      const mockPath = require('path');
      const previewDir = require('fs').mkdtempSync(mockPath.join(require('os').tmpdir(), 'raw-preview-'));
      const previewPath = mockPath.join(previewDir, 'preview.jpg');
      await require('sharp')({
        create: { width: 600, height: 400, channels: 3, background: { r: 40, g: 80, b: 120 } },
      }).jpeg().toFile(previewPath);
      return { path: previewPath, outputBasename: mockPath.basename(sourceName), cleanup: mockPreviewCleanup };
    }),
  };
});

const sharp = require('sharp');
const logger = require('../../src/utils/logger');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const { processNewPhoto } = require('../../src/services/fileWatcher');
const { clearAllowedTypesCache } = require('../../src/services/uploadSettings');

const EVENT_SLUG = 'watcher-raw-event';

let db;
let cleanup;
let eventId;
let eventDir;

async function setAllowedTypes(value) {
  await db('app_settings').where({ setting_key: 'general_allowed_file_types' }).del();
  await db('app_settings').insert({
    setting_key: 'general_allowed_file_types',
    setting_value: JSON.stringify(value),
    setting_type: 'general',
  });
  clearAllowedTypesCache();
}

function drop(name, bytes) {
  const filePath = path.join(eventDir, name);
  fs.writeFileSync(filePath, bytes);
  return filePath;
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  await seedMinimal(db);
  const inserted = await db('events').insert({
    slug: EVENT_SLUG,
    event_type: 'wedding',
    event_name: 'Watcher RAW',
    event_date: '2026-10-12',
    host_email: 'host@example.com',
    admin_email: 'admin@example.com',
    password_hash: 'x',
    share_link: `/gallery/${EVENT_SLUG}/share`,
    share_token: 'watcher-raw-share',
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    is_active: 1,
    is_archived: 0,
    is_draft: 0,
    created_at: new Date().toISOString(),
  }).returning('id');
  eventId = inserted[0]?.id ?? inserted[0];
  eventDir = path.join(process.env.STORAGE_PATH, 'events/active', EVENT_SLUG, 'individual');
  fs.mkdirSync(eventDir, { recursive: true });
}, 120000);

afterEach(async () => {
  await db('photos').where({ event_id: eventId }).del();
  mockPreviewCleanup.mockClear();
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

describe('fileWatcher camera RAW import', () => {
  it('imports an allowed RAW with a thumbnail, dimensions and its RAW type', async () => {
    await setAllowedTypes('jpg,jpeg,png,webp,arw');
    // Not decodable by sharp, like a real ARW.
    const filePath = drop('DSC03359.ARW', Buffer.from('II*\0not really a sony raw'));

    await processNewPhoto(filePath);

    const photo = await db('photos').where({ event_id: eventId }).first();
    expect(photo).toMatchObject({
      filename: 'DSC03359.ARW',
      original_filename: 'DSC03359.ARW',
      path: `${EVENT_SLUG}/individual/DSC03359.ARW`,
      type: 'individual',
      media_type: 'image',
      mime_type: 'image/x-sony-arw',
      width: 600,
      height: 400,
    });
    const thumb = await sharp(path.join(process.env.STORAGE_PATH, photo.thumbnail_path)).metadata();
    expect(thumb.format).toBe('jpeg');
    expect(mockPreviewCleanup).toHaveBeenCalled();
  });

  // chokidar re-announces every file in the folder on each boot. A RAW
  // extraction reads the whole file, about 100 MB for a Sony A1 frame.
  it('does not re-extract a RAW that is already in the gallery', async () => {
    await setAllowedTypes('jpg,jpeg,png,webp,arw');
    const filePath = drop('DSC03376.ARW', Buffer.from('II*\0not really a sony raw'));
    await processNewPhoto(filePath);
    const { withProcessableImage } = require('../../src/services/imageProcessor');
    withProcessableImage.mockClear();

    await processNewPhoto(filePath);

    expect(withProcessableImage).not.toHaveBeenCalled();
    expect(await db('photos').where({ event_id: eventId })).toHaveLength(1);
  });

  it('says why it skipped a RAW the admin has not allowed', async () => {
    await setAllowedTypes('jpg,jpeg,png,webp');
    const warn = jest.spyOn(logger, 'warn');
    const filePath = drop('DSC03367.ARW', Buffer.from('II*\0not really a sony raw'));

    await processNewPhoto(filePath);

    expect(await db('photos').where({ event_id: eventId })).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/DSC03367\.ARW.*general_allowed_file_types/));
    warn.mockRestore();
  });

  // chokidar announces a file once, so a settings read that fails during a
  // database blip is retried in place rather than losing the file.
  it('retries a failed settings read and imports the RAW', async () => {
    await setAllowedTypes('jpg,jpeg,png,webp,arw');
    const filePath = drop('DSC03380.ARW', Buffer.from('II*\0not really a sony raw'));

    await db.raw('ALTER TABLE app_settings RENAME TO app_settings_offline');
    const restore = new Promise(resolve => setTimeout(resolve, 300))
      .then(() => db.raw('ALTER TABLE app_settings_offline RENAME TO app_settings'));
    try {
      await processNewPhoto(filePath);
    } finally {
      await restore;
    }

    expect(await db('photos').where({ event_id: eventId })).toHaveLength(1);
  });

  it('gives up with an error, not a skip, when the settings stay unreadable', async () => {
    await setAllowedTypes('jpg,jpeg,png,webp,arw');
    const filePath = drop('DSC03381.ARW', Buffer.from('II*\0not really a sony raw'));

    await db.raw('ALTER TABLE app_settings RENAME TO app_settings_offline');
    try {
      await expect(processNewPhoto(filePath)).rejects.toThrow();
    } finally {
      await db.raw('ALTER TABLE app_settings_offline RENAME TO app_settings');
    }
    expect(await db('photos').where({ event_id: eventId })).toHaveLength(0);
  });

  // Not RAW, but the same insert: the column defaults to 'image', so a watched
  // video was filed as a photo.
  it('files a watched video as a video', async () => {
    await setAllowedTypes('jpg,jpeg,png,webp,mp4');
    const filePath = drop('clip.mp4', Buffer.from('not really a video'));

    await processNewPhoto(filePath);

    const photo = await db('photos').where({ event_id: eventId }).first();
    expect(photo).toMatchObject({ type: 'video', media_type: 'video', mime_type: 'video/mp4' });
  });
});
