/**
 * HEVC HEIC, the format an iPhone shoots (issue 2359), with ffmpeg mocked.
 *
 * The fixture is a real 40x30 HEVC file in Display P3 from macOS `sips`, so the
 * first test pins the reason this path exists. What ffmpeg itself does with one
 * was checked by hand in the backend image: 512px tile grids up to 48 MP
 * assemble, and a stored rotation comes out applied. It drops the ICC profile,
 * which is why the profile is put back here.
 */
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const mediaProcesses = require('../../src/services/mediaProcessService');
const {
  withProcessableImage,
  heifStandIn,
} = require('../../src/services/imageProcessor');
const watermarkService = require('../../src/services/watermarkService');

const FIXTURE = path.join(__dirname, '../fixtures/hevc-display-p3.heic');
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

    run.mockRejectedValue(new Error('ffmpeg failed'));
    await expect(watermarkService.applyWatermark(FIXTURE, settings)).rejects.toThrow('ffmpeg failed');
    await expect(watermarkService.applyWatermark(await fs.readFile(FIXTURE), settings)).rejects.toThrow('ffmpeg failed');
  });
});
