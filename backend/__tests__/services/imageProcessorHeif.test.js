/**
 * HEVC HEIC, the format an iPhone shoots (issue 2359), with ffmpeg mocked.
 *
 * The fixture is a real 40x30 HEVC file in Display P3 from macOS `sips`, so the
 * first test pins the reason this path exists. What ffmpeg itself does with one
 * was checked by hand in the backend image: 512px tile grids up to 48 MP
 * assemble, and a stored rotation comes out applied. It drops the ICC profile,
 * EXIF and XMP, which is why they are put back here.
 */
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const exifr = require('exifr');

const mediaProcesses = require('../../src/services/mediaProcessService');
const {
  withProcessableImage,
  heifStandIn,
} = require('../../src/services/imageProcessor');
const watermarkService = require('../../src/services/watermarkService');

const FIXTURE = path.join(__dirname, '../fixtures/hevc-display-p3.heic');
// 40x30 stored with rotation 6, capture date and camera make, from ImageIO.
const ROTATED = path.join(__dirname, '../fixtures/hevc-rotated-exif.heic');
const decodedJpeg = () => sharp({ create: { width: 40, height: 30, channels: 3, background: '#c33' } }).jpeg().toBuffer();
const fakeFfmpeg = () => jest.spyOn(mediaProcesses, 'run').mockImplementation(async (_command, args) => {
  await fs.writeFile(args[args.length - 1], await decodedJpeg());
  return { stdout: Buffer.alloc(0) };
});

describe('HEVC HEIC decoding', () => {
  let dir;
  let run;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'heif-test-'));
    run = fakeFfmpeg();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is not something the bundled sharp can do', async () => {
    const metadata = await sharp(FIXTURE).metadata();
    expect(metadata).toMatchObject({ format: 'heif', compression: 'hevc', width: 40, height: 30 });
    await expect(sharp(FIXTURE).resize(10).toBuffer()).rejects.toThrow(/HEVC|bad seek/);
  });

  it('decodes through ffmpeg, under the process limits, into a named temp file', async () => {
    const proc = await withProcessableImage(FIXTURE, '/gallery/IMG_1.HEIC');
    expect(proc.outputBasename).toBe('IMG_1.HEIC');
    expect((await sharp(proc.path).metadata()).format).toBe('jpeg');

    const [command, args, options] = run.mock.calls[0];
    expect(command).toBe('ffmpeg');
    expect(args).toEqual(expect.arrayContaining(['-protocol_whitelist', 'file,pipe', '-format_whitelist', '-frames:v']));
    expect(args.slice(args.indexOf('-c:v'), args.indexOf('-i'))).toEqual(['-c:v', 'hevc']);
    expect(options).toMatchObject({ memoryBytes: expect.any(Number), wallMs: expect.any(Number), fileBytes: expect.any(Number) });
    // One decoder per tile: the default thread budget ends a 12 MP photo.
    expect(args[args.indexOf('-threads') + 1]).toBe('1');
    expect(options.threadLimit).toBe(256);

    await proc.cleanup();
    await expect(fs.stat(proc.path)).rejects.toThrow();
  });

  it('keeps the colour profile ffmpeg drops', async () => {
    const source = await sharp(FIXTURE).metadata();
    expect(source.icc.length).toBeGreaterThan(0);

    const proc = await withProcessableImage(FIXTURE, 'IMG_1.heic');
    const decoded = await sharp(proc.path).metadata();
    expect(decoded.icc.equals(source.icc)).toBe(true);
    const rendered = await sharp(proc.path).resize(10).toColourspace('srgb').jpeg().toBuffer();
    expect((await sharp(rendered).metadata()).width).toBe(10);
    await proc.cleanup();
  });

  it('carries EXIF and XMP over, with the rotation ffmpeg applied taken out', async () => {
    const proc = await withProcessableImage(ROTATED, 'IMG_1.heic');
    const tags = await exifr.parse(proc.path, { reviveValues: false, translateValues: false });
    expect(tags).toMatchObject({ Orientation: 1, Make: 'PicPeak Test', DateTimeOriginal: '2026:05:04 11:22:33' });
    expect((await sharp(proc.path).metadata()).xmp).toBeDefined();
    expect((await sharp(proc.path).metadata()).xmp.toString()).not.toMatch(/tiff:Orientation(="|>)[2-8]/);
    await proc.cleanup();
  });

  it.each([
    ['a single tile', 10, 8],
    ['a larger video track', 128, 96],
    ['a frame with the same long edge', 40, 40],
    ['a strip with the same long edge', 40, 5],
  ])('refuses %s in place of the photo', async (_label, width, height) => {
    const seen = [];
    run.mockImplementation(async (_command, args) => {
      seen.push(path.dirname(args[args.length - 1]));
      await fs.writeFile(args[args.length - 1], await sharp({ create: { width, height, channels: 3, background: '#333' } }).jpeg().toBuffer());
    });
    await expect(withProcessableImage(FIXTURE, 'IMG_1.heic')).rejects.toThrow(/ffmpeg 8\.1/);
    await expect(fs.stat(seen[0])).rejects.toThrow();
  });

  it('removes the temp file when ffmpeg fails', async () => {
    const seen = [];
    run.mockImplementation(async (_command, args) => {
      seen.push(path.dirname(args[args.length - 1]));
      throw new Error('ffmpeg failed');
    });
    await expect(withProcessableImage(FIXTURE, 'IMG_1.heic')).rejects.toThrow('ffmpeg failed');
    await expect(fs.stat(seen[0])).rejects.toThrow();
  });

  it('leaves an AV1 .heif, which sharp decodes, and any other photo alone', async () => {
    const avif = path.join(dir, 'a.heif');
    await sharp({ create: { width: 16, height: 16, channels: 3, background: '#333' } }).avif().toFile(avif);
    const jpeg = path.join(dir, 'a.jpg');
    await fs.writeFile(jpeg, await decodedJpeg());

    expect((await withProcessableImage(avif, 'a.heif')).path).toBe(avif);
    expect((await withProcessableImage(jpeg, 'a.jpg')).path).toBe(jpeg);
    expect(run).not.toHaveBeenCalled();
  });

  it('leaves a .heic that is no HEIC to fail like any other bad file', async () => {
    const bad = path.join(dir, 'bad.heic');
    await fs.writeFile(bad, 'not an image');
    expect((await withProcessableImage(bad, 'bad.heic')).path).toBe(bad);
    expect(run).not.toHaveBeenCalled();
  });

  it('stands in for a HEVC buffer as well as a path, and for nothing else', async () => {
    const buffer = await fs.readFile(FIXTURE);
    const fromBuffer = await heifStandIn(buffer);
    const scratch = path.dirname(fromBuffer.path);
    expect((await sharp(fromBuffer.path).metadata()).format).toBe('jpeg');
    await fromBuffer.cleanup();
    await expect(fs.stat(scratch)).rejects.toThrow();

    const fromPath = await heifStandIn(FIXTURE);
    await fromPath.cleanup();

    expect(await heifStandIn(await decodedJpeg())).toBeNull();
    expect(await heifStandIn('/gallery/a.jpg')).toBeNull();
  });

  it('marks the decoded photo, and refuses rather than ships an undecodable one', async () => {
    const settings = { enabled: true, type: 'text', text: 'proof', opacity: 50, position: 'center', size: 20 };
    const marked = await watermarkService.applyWatermark(FIXTURE, settings);
    expect((await sharp(marked).metadata()).format).toBe('jpeg');

    await expect(watermarkService.applyWatermark(ROTATED, settings, { keepMetadata: true }))
      .resolves.toBeInstanceOf(Buffer);
    run.mockRejectedValue(new Error('ffmpeg failed'));
    await expect(watermarkService.applyWatermark(ROTATED, { ...settings, text: 'new' })).rejects.toThrow('ffmpeg failed');
    await expect(watermarkService.applyWatermark(await fs.readFile(FIXTURE), settings)).rejects.toThrow('ffmpeg failed');
  });

  it('keeps the metadata on a watermarked download, and not on a gallery rendition', async () => {
    const settings = { enabled: true, type: 'text', text: 'keep', opacity: 50, position: 'center', size: 20 };
    const download = await watermarkService.applyWatermark(ROTATED, settings, { keepMetadata: true });
    expect(await exifr.parse(download, { reviveValues: false })).toMatchObject({ DateTimeOriginal: '2026:05:04 11:22:33' });

    const rendition = await watermarkService.applyWatermark(ROTATED, settings);
    expect(await sharp(rendition).metadata()).not.toHaveProperty('exif');
  });

  it('caches a watermark under the photo, and never a buffer', async () => {
    const settings = { enabled: true, type: 'text', text: 'cache', opacity: 50, position: 'center', size: 20 };
    await watermarkService.applyWatermark(FIXTURE, settings);
    await watermarkService.applyWatermark(FIXTURE, settings);
    expect(run).toHaveBeenCalledTimes(1);
    expect([...watermarkService.cache.keys()].filter((key) => key.includes('picpeak-heif-'))).toEqual([]);

    const size = watermarkService.cache.size;
    await watermarkService.applyWatermark(await fs.readFile(FIXTURE), settings);
    expect(watermarkService.cache.size).toBe(size);
  });
});
