/**
 * A download rendition fails closed.
 *
 * The gallery's download standard is a cap: a box handed to
 * renderPhotoForDownload must come back as an image inside it, never as the
 * original. resizeToBox returns its input for HEIC/AVIF, camera RAW and any
 * source it fails on, and renderPhotoForDownload used to pass that through.
 *
 * The same for the watermark: applyWatermark returns the clean input when it
 * fails, unless asked to fail closed, and the download path did not ask.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

jest.mock('../../src/database/db', () => {
  const api = (table) => {
    if (table === 'app_settings') {
      return { where: () => ({ whereIn: () => [], first: async () => null }), whereIn: async () => [] };
    }
    return { where: () => ({ first: async () => null }) };
  };
  return { db: api };
});

// External photos: no storage key, the file is read where it lies.
jest.mock('../../src/services/photoResolver', () => ({
  resolvePhotoStorageKey: () => null,
  resolvePhotoFilePath: (_event, photo) => photo.__path,
}));

// Extracting a RAW's embedded preview needs exiftool; the tests hand back a
// JPEG standing in for it. Everything else goes through the real function.
const mockRawStandIn = { path: null, fail: false };
jest.mock('../../src/services/imageProcessor', () => {
  const actual = jest.requireActual('../../src/services/imageProcessor');
  return {
    ...actual,
    withProcessableImage: jest.fn(async (localPath, sourceName) => {
      if (!actual.isRawFilename(sourceName)) return actual.withProcessableImage(localPath, sourceName);
      if (mockRawStandIn.fail) throw new Error('no preview in this RAW');
      return { path: mockRawStandIn.path, outputBasename: sourceName, cleanup: async () => {} };
    }),
  };
});

const watermarkService = require('../../src/services/watermarkService');
const { renderPhotoForDownload, resolveWatermarkSettings } = require('../../src/services/downloadRendition');

const BOX = { width: 800, height: 600 };
const WATERMARK = {
  enabled: true, position: 'bottom-right', opacity: 50, size: 15, companyName: 'PicPeak',
};

let dir;
const write = (name, bytes) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return { id: 1, filename: name, original_filename: name, media_type: 'photo', __path: file };
};
const solid = (width, height, r = 30) => sharp({
  create: { width, height, channels: 3, background: { r, g: 80, b: 140 } },
});

beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-dlrend-')); });
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  jest.restoreAllMocks();
  mockRawStandIn.fail = false;
});

const expectInsideBox = async (buffer, format) => {
  const meta = await sharp(buffer).metadata();
  expect(meta.format).toBe(format);
  expect(meta.width).toBeLessThanOrEqual(BOX.width);
  expect(meta.height).toBeLessThanOrEqual(BOX.height);
};

describe('the download cap', () => {
  test('resizes a JPEG in kind', async () => {
    const photo = write('big.jpg', await solid(2400, 1600).jpeg().toBuffer());
    await expectInsideBox(await renderPhotoForDownload({}, photo, BOX, null), 'jpeg');
  });

  test('turns an AVIF it cannot encode in kind into a JPEG inside the box', async () => {
    const photo = write('big.avif', await solid(2400, 1600).avif().toBuffer());
    await expectInsideBox(await renderPhotoForDownload({}, photo, BOX, null), 'jpeg');
  });

  test('caps a RAW through its embedded preview', async () => {
    const preview = path.join(dir, 'preview.jpg');
    fs.writeFileSync(preview, await solid(3000, 2000).jpeg().toBuffer());
    mockRawStandIn.path = preview;
    const photo = write('IMG_0001.CR2', Buffer.from('not really a raw'));
    await expectInsideBox(await renderPhotoForDownload({}, photo, BOX, null), 'jpeg');
  });

  test('refuses a RAW with no readable preview instead of shipping it', async () => {
    mockRawStandIn.fail = true;
    const photo = write('IMG_0002.NEF', Buffer.from('not really a raw'));
    await expect(renderPhotoForDownload({}, photo, BOX, null)).rejects.toThrow();
  });

  test('refuses a source sharp cannot read instead of shipping it', async () => {
    const photo = write('broken.jpg', Buffer.from('definitely not an image'));
    await expect(renderPhotoForDownload({}, photo, BOX, null)).rejects.toThrow();
  });

  test('keeps an animation animated', async () => {
    const frames = 3;
    // Distinct frames: the GIF encoder folds identical ones into one.
    const pngs = await Promise.all(Array.from({ length: frames }, (_, i) => solid(1200, 900, 40 * (i + 1)).png().toBuffer()));
    const gif = await sharp(pngs, { join: { animated: true } }).gif().toBuffer();
    const photo = write('anim.gif', gif);
    const meta = await sharp(await renderPhotoForDownload({}, photo, BOX, null)).metadata();
    expect(meta.format).toBe('gif');
    expect(meta.pages).toBe(frames);
    // Opened without `animated`, metadata describes one frame.
    expect(meta.width).toBeLessThanOrEqual(BOX.width);
    expect(meta.height).toBeLessThanOrEqual(BOX.height);
  });

  test('ships the stored bytes when there is no cap and no watermark', async () => {
    const photo = write('IMG_0003.CR2', Buffer.from('not really a raw'));
    expect(await renderPhotoForDownload({}, photo, null, null)).toBeNull();
  });
});

describe('the download watermark', () => {
  // A failure inside applyWatermark's own try, the shape that used to hand
  // the clean input back.
  const breakTheMark = () => jest.spyOn(watermarkService, 'getPositionCoordinates')
    .mockImplementation(() => { throw new Error('composite failed'); });

  test('fails closed on an original-size download', async () => {
    const photo = write('mark.jpg', await solid(1200, 800).jpeg().toBuffer());
    breakTheMark();
    await expect(renderPhotoForDownload({}, photo, null, WATERMARK)).rejects.toThrow('composite failed');
  });

  test('fails closed on a resized download', async () => {
    const photo = write('mark-big.jpg', await solid(2400, 1600).jpeg().toBuffer());
    breakTheMark();
    await expect(renderPhotoForDownload({}, photo, BOX, WATERMARK)).rejects.toThrow('composite failed');
  });

  test('marks a RAW on its embedded preview rather than refusing it', async () => {
    const preview = path.join(dir, 'raw-preview.jpg');
    fs.writeFileSync(preview, await solid(1200, 800).jpeg().toBuffer());
    mockRawStandIn.path = preview;
    const photo = write('IMG_0004.ARW', Buffer.from('not really a raw'));
    const out = await renderPhotoForDownload({}, photo, null, WATERMARK);
    expect((await sharp(out).metadata()).format).toBe('jpeg');
  });

  test('ships a video as stored, not refused by the image watermark', async () => {
    const video = write('clip.mp4', Buffer.from('not an image'));
    video.media_type = 'video';
    video.mime_type = 'video/mp4';
    expect(await renderPhotoForDownload({}, video, null, WATERMARK)).toBeNull();
    expect(await renderPhotoForDownload({}, video, BOX, WATERMARK)).toBeNull();
  });

  test('fails closed on a logo it cannot draw when there is no text to fall back on', async () => {
    const photo = write('mark-logo.jpg', await solid(1200, 800).jpeg().toBuffer());
    const logoOnly = { ...WATERMARK, companyName: '', logoPath: path.join(dir, 'missing-logo.png') };
    await expect(renderPhotoForDownload({}, photo, null, logoOnly)).rejects.toThrow('logo');
  });

  test('ships a photo as stored when nothing is configured to draw', async () => {
    const source = await solid(1200, 800).jpeg().toBuffer();
    const photo = write('mark-none.jpg', source);
    const out = await renderPhotoForDownload({}, photo, null, { ...WATERMARK, companyName: '' });
    expect(out.equals(source)).toBe(true);
  });

  test('refuses when the watermark settings cannot be read', async () => {
    jest.spyOn(watermarkService, 'getWatermarkSettings').mockResolvedValue(null);
    await expect(resolveWatermarkSettings({ watermark_downloads: 1 })).rejects.toThrow('settings');
  });

  test('still marks a healthy photo', async () => {
    const source = await solid(1200, 800).jpeg().toBuffer();
    const photo = write('mark-ok.jpg', source);
    const out = await renderPhotoForDownload({}, photo, null, WATERMARK);
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.equals(source)).toBe(false);
  });
});
