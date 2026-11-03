/**
 * A capped or watermarked RAW download keeps the container's metadata
 * (issue 2393).
 *
 * The download ships as a JPEG made from the RAW's embedded preview, and the
 * preview carries no EXIF of its own, so the Artist, Copyright, capture data,
 * GPS, XMP and IPTC the download contract keeps (issue 1649) were lost. The
 * container's tags go onto the finished JPEG, without its orientation (the
 * rendition states its own) and without its embedded previews.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
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

jest.mock('../../src/services/photoResolver', () => ({
  resolvePhotoStorageKey: () => null,
  resolvePhotoFilePath: (_event, photo) => photo.__path,
}));

// The preview extraction is covered elsewhere; this hands back a JPEG
// standing in for it, the way extractRawPreview leaves one: bare, apart from
// the container's orientation.
const mockRawStandIn = { path: null };
jest.mock('../../src/services/imageProcessor', () => {
  const actual = jest.requireActual('../../src/services/imageProcessor');
  return {
    ...actual,
    withProcessableImage: jest.fn(async (localPath, sourceName) => {
      if (!actual.isRawFilename(sourceName)) return actual.withProcessableImage(localPath, sourceName);
      return { path: mockRawStandIn.path, outputBasename: sourceName, cleanup: async () => {} };
    }),
  };
});

const mediaProcesses = require('../../src/services/mediaProcessService');
const logger = require('../../src/utils/logger');
const { renderPhotoForDownload } = require('../../src/services/downloadRendition');

const hasExiftool = spawnSync('exiftool', ['-ver'], { stdio: 'ignore' }).status === 0;
const withExiftool = hasExiftool ? describe : describe.skip;

const ARTIST = 'Nikos Photographer';
const COPYRIGHT = '(c) 2026 Nikos Photographer';
const BOX = { width: 800, height: 600 };
const WATERMARK = {
  enabled: true, position: 'bottom-right', opacity: 50, size: 15, companyName: 'PicPeak',
};

let dir;
let rawPath;
const photo = () => ({ id: 1, filename: 'IMG_0001.DNG', original_filename: 'IMG_0001.DNG', media_type: 'photo', __path: rawPath });
const solid = (width, height) => sharp({ create: { width, height, channels: 3, background: { r: 30, g: 80, b: 140 } } });
const tags = (buffer) => {
  const file = path.join(dir, `read-${Math.random().toString(16).slice(2)}.jpg`);
  fs.writeFileSync(file, buffer);
  return JSON.parse(execFileSync('exiftool', ['-json', '-n', '-a', '-G1', file]))[0];
};

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-rawtags-test-'));
  // A portrait camera frame stored landscape: the preview is 3000x2000 with
  // Orientation 6, as applyContainerOrientation leaves it.
  mockRawStandIn.path = path.join(dir, 'preview.jpg');
  fs.writeFileSync(mockRawStandIn.path, await solid(3000, 2000).withMetadata({ orientation: 6 }).jpeg().toBuffer());
  // The "RAW": a TIFF (what a DNG is) carrying the photographer's tags, the
  // camera's orientation and an embedded preview.
  rawPath = path.join(dir, 'IMG_0001.DNG');
  fs.writeFileSync(rawPath, await solid(600, 400).tiff().toBuffer());
  if (hasExiftool) {
    const embedded = path.join(dir, 'embedded.jpg');
    fs.writeFileSync(embedded, await solid(1600, 1000).jpeg().toBuffer());
    execFileSync('exiftool', ['-overwrite_original', '-n',
      `-Artist=${ARTIST}`, `-Copyright=${COPYRIGHT}`, '-Orientation=6', '-XMP-tiff:Orientation=6',
      `-XMP-dc:Creator=${ARTIST}`, `-IPTC:By-line=${ARTIST}`, '-GPSLatitude=48.1', '-GPSLatitudeRef=N',
      `-PreviewImage<=${embedded}`, rawPath]);
  }
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => jest.restoreAllMocks());

const orientations = (meta) => Object.keys(meta).filter((key) => key.endsWith(':Orientation') && meta[key] !== 1);
const expectContainerTags = (meta) => {
  expect(meta['IFD0:Artist']).toBe(ARTIST);
  expect(meta['IFD0:Copyright']).toBe(COPYRIGHT);
  expect(meta['XMP-dc:Creator']).toBe(ARTIST);
  expect(meta['IPTC:By-line']).toBe(ARTIST);
  expect(meta['GPS:GPSLatitude']).toBeCloseTo(48.1);
  expect(Object.keys(meta).filter((key) => /PreviewImage|ThumbnailImage|JpgFromRaw/.test(key))).toEqual([]);
};

withExiftool('a RAW download carries the container metadata (issue 2393)', () => {
  // Upright pixels: the container's orientation would turn them a second time.
  test.each([
    ['capped to the gallery standard', BOX, null, [400, 600]],
    ['capped and watermarked', BOX, WATERMARK, [400, 600]],
    ['watermarked at full size', null, WATERMARK, [2000, 3000]],
  ])('%s', async (_name, box, watermark, size) => {
    const out = await renderPhotoForDownload({}, photo(), box, watermark);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('jpeg');
    expect([meta.width, meta.height]).toEqual(size);
    const read = tags(out);
    expectContainerTags(read);
    expect(orientations(read)).toEqual([]);
  });

  test('copies them from a RAW whose name exiftool would read as a format', async () => {
    const odd = path.join(dir, 'IMG 100%f.DNG');
    fs.copyFileSync(rawPath, odd);
    const out = await renderPhotoForDownload({}, { ...photo(), filename: 'IMG 100%f.DNG', __path: odd }, BOX, null);
    expectContainerTags(tags(out));
  });

  test('keeps the preview\'s own orientation when the mark draws nothing', async () => {
    const out = await renderPhotoForDownload({}, photo(), null, { ...WATERMARK, companyName: '' });
    // Shipped as extracted: stored landscape, turned by its own tag.
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height, meta.orientation]).toEqual([3000, 2000, 6]);
    const read = tags(out);
    expectContainerTags(read);
    expect(orientations(read)).toEqual(['IFD0:Orientation']);
  });
});

describe('a RAW download whose tags cannot be copied', () => {
  test('ships without them', async () => {
    const run = mediaProcesses.run;
    jest.spyOn(mediaProcesses, 'run').mockImplementation((command, ...rest) => (command === 'exiftool'
      ? Promise.reject(Object.assign(new Error('exiftool is not installed'), { code: 'ENOENT' }))
      : run(command, ...rest)));
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const out = await renderPhotoForDownload({}, photo(), BOX, null);
    expect((await sharp(out).metadata()).format).toBe('jpeg');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ships without its EXIF'));
  });

  test('is refused on a resource error, like the rest of the pipeline', async () => {
    jest.spyOn(mediaProcesses, 'run').mockRejectedValue(
      Object.assign(new Error('Media input staging capacity is full'), { code: 'MEDIA_QUEUE_FULL' }));
    await expect(renderPhotoForDownload({}, photo(), BOX, null)).rejects.toMatchObject({ code: 'MEDIA_QUEUE_FULL' });
  });
});
