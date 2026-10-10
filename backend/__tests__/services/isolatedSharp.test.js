const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const nativeSharp = require('sharp'); // Fixture creation only, never serving input.
const sharp = require('../../src/services/isolatedSharp');

const MiB = 1024 * 1024;
const withEnv = async (values, run) => {
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return await run(); }
  finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
};
// A fresh policy module with the host reporting `memory` bytes.
const policyFor = memory => {
  let policy;
  jest.isolateModules(() => {
    const total = jest.spyOn(os, 'totalmem').mockReturnValue(memory);
    // The machine running the suite may itself sit in a memory cgroup.
    const actualRead = require('fs').readFileSync;
    const cgroup = jest.spyOn(require('fs'), 'readFileSync').mockImplementation((file, ...rest) => {
      if (String(file).startsWith('/sys/fs/cgroup')) throw new Error('no cgroup in this fixture');
      return actualRead(file, ...rest);
    });
    const constrained = typeof process.constrainedMemory === 'function'
      ? jest.spyOn(process, 'constrainedMemory').mockReturnValue(0) : null;
    try { policy = require('../../src/services/imageResourcePolicy').configuration(); }
    finally { total.mockRestore(); cgroup.mockRestore(); constrained?.mockRestore(); }
  });
  return policy;
};

describe('image resource policy', () => {
  const { estimate, configuration } = require('../../src/services/imageResourcePolicy');

  test('accepts what the app accepted before: large sensors, panoramas, 16-bit', () => {
    const policy = configuration();
    expect(policy.maxPixels).toBe(268402689);
    expect(policy.maxDimension).toBe(65535);
    for (const metadata of [
      { width: 8192, height: 5464, channels: 3 },                   // 45 MP
      { width: 9504, height: 6336, channels: 3 },                   // 61 MP
      { width: 11648, height: 8736, channels: 3 },                  // 100 MP
      { width: 30000, height: 4000, channels: 3 },                  // panorama wider than 16384 px
      { width: 9504, height: 6336, channels: 3, depth: 'ushort' },  // 16-bit
      { width: 9504, height: 6336, channels: 4, depth: 'float' },
      { width: 16, height: 16, pages: 512, channels: 3 },           // only the first frame is read
    ]) expect(() => estimate(metadata, policy)).not.toThrow();
    // Real channel count and bit depth, not a flat four bytes per pixel.
    expect(estimate({ width: 7008, height: 4672, channels: 3, depth: 'uchar' }, policy)).toBe(7008 * 4672 * 3);
    expect(estimate({ width: 7008, height: 4672, channels: 3, depth: 'ushort' }, policy)).toBe(7008 * 4672 * 6);
  });

  test('a refusal names the limit that was exceeded', async () => {
    const policy = configuration();
    expect(() => estimate({ width: 20000, height: 20000, channels: 3 }, policy)).toThrow(
      expect.objectContaining({ code: 'IMAGE_RESOURCE_LIMIT', status: 422, imageLimit: 'pixels', imageMax: 268.4,
        message: expect.stringContaining('268.4 megapixels') }));
    expect(() => estimate({ width: 16, height: 16, pages: 3, channels: 3 }, { ...policy, maxPixels: 512 }, 3))
      .toThrow(expect.objectContaining({ imageLimit: 'pixels' }));
    await withEnv({ IMAGE_MAX_DIMENSION: '1000', IMAGE_MAX_DECODED_MIB: '1', IMAGE_MAX_FRAMES: '2' }, () => {
      const lowered = configuration();
      expect(() => estimate({ width: 1001, height: 10, channels: 3 }, lowered)).toThrow(
        expect.objectContaining({ imageLimit: 'dimension', imageMax: 1000, message: expect.stringContaining('1000 px') }));
      expect(() => estimate({ width: 1000, height: 1000, channels: 3 }, lowered)).toThrow(
        expect.objectContaining({ imageLimit: 'decoded', imageMax: 1 }));
      expect(() => estimate({ width: 10, height: 10, channels: 3, pages: 3 }, lowered, 3)).toThrow(
        expect.objectContaining({ imageLimit: 'frames', imageMax: 2 }));
    });
    expect(() => estimate({ width: NaN, height: 1 }, policy)).toThrow();
  });

  test('every host gets at least one worker, and the workers fit half its memory when they can', () => {
    for (const memory of [256, 512, 1024, 1536]) expect(policyFor(memory * MiB).workers).toBe(1);
    const large = policyFor(8192 * MiB);
    expect(large.workers).toBe(2);
    expect(large.workers * large.nativeBytes).toBeLessThanOrEqual(4096 * MiB);
    // A job that does not fit a shared worker may run once alone with the
    // whole image budget.
    expect(large.exclusiveBytes).toBe(4096 * MiB);
    expect(policyFor(512 * MiB).exclusiveBytes).toBe(768 * MiB);
  });

  test('invalid overrides are refused; the cgroup files are not re-read on every call', async () => {
    await withEnv({ IMAGE_WORKER_MEMORY_MIB: '0' }, () => expect(configuration).toThrow('Invalid IMAGE_WORKER_MEMORY_MIB'));
    await withEnv({ IMAGE_MAX_PIXELS: '268402690' }, () => expect(configuration).toThrow('Invalid IMAGE_MAX_PIXELS'));
    configuration();
    const read = jest.spyOn(require('fs'), 'readFileSync');
    try {
      for (let index = 0; index < 20; index++) configuration();
      expect(read).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
  });
});

describe('retryTransient', () => {
  const { retryTransient } = require('../../src/services/imageResourcePolicy');
  const refusal = code => Object.assign(new Error(code), { code });

  test('asks again while the worker says "not now", then returns the result', async () => {
    const work = jest.fn().mockRejectedValueOnce(refusal('IMAGE_WORKER_UNAVAILABLE')).mockRejectedValueOnce(refusal('IMAGE_QUEUE_FULL'))
      .mockResolvedValue({ width: 16 });
    await expect(retryTransient(work, { pauseMs: 1 })).resolves.toEqual({ width: 16 });
    expect(work).toHaveBeenCalledTimes(3);
  });

  test('gives up after the attempts, and never repeats an ordinary failure', async () => {
    const busy = jest.fn().mockRejectedValue(refusal('IMAGE_TIMEOUT'));
    await expect(retryTransient(busy, { attempts: 3, pauseMs: 1 })).rejects.toMatchObject({ code: 'IMAGE_TIMEOUT' });
    expect(busy).toHaveBeenCalledTimes(3);
    for (const code of ['IMAGE_RESOURCE_LIMIT', 'SHARP_PROCESSING_FAILED']) {
      const work = jest.fn().mockRejectedValue(refusal(code));
      await expect(retryTransient(work, { pauseMs: 1 })).rejects.toMatchObject({ code });
      expect(work).toHaveBeenCalledTimes(1);
    }
  });
});

describe('isolated image runner', () => {
  let workspace;
  const fixture = async (name, pipeline) => {
    const filename = path.join(workspace, name);
    await pipeline.toFile(filename);
    return filename;
  };
  const noise = (width, height) => {
    const pixels = Buffer.alloc(width * height * 3);
    for (let index = 0; index < pixels.length; index++) pixels[index] = (index * 2654435761) >>> 24;
    return nativeSharp(pixels, { raw: { width, height, channels: 3 } });
  };
  beforeAll(async () => { workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'isolated-sharp-test-')); });
  afterAll(async () => {
    await sharp.shutdown();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  test('runs on this host and reports how it is isolated', async () => {
    expect(await sharp.prepare()).toBe(process.platform === 'linux' ? 'capped' : 'child');
  });

  test('processes a 61 MP camera file and a panorama wider than 16384 px', async () => {
    const camera = await fixture('camera.jpg', nativeSharp({ create: { width: 9504, height: 6336, channels: 3, background: '#888' } })
      .jpeg().withMetadata({ orientation: 6 }));
    const metadata = await sharp(camera).metadata();
    expect(metadata).toMatchObject({ width: 9504, height: 6336, orientation: 6 });
    expect(Buffer.isBuffer(metadata.exif)).toBe(true);
    const thumbnail = await sharp(camera, { sequentialRead: true }).rotate().resize(300, 300, { fit: 'inside' }).jpeg().toBuffer();
    expect(await sharp(thumbnail).metadata()).toMatchObject({ width: 200, height: 300 });
    // Full resolution, no shrink-on-load: what a watermarked download does.
    const overlay = Buffer.from('<svg width="10" height="10"><rect width="10" height="10" fill="red"/></svg>');
    const full = await sharp(camera).rotate().composite([{ input: overlay, left: 0, top: 0 }]).keepMetadata().jpeg().toBuffer();
    expect(await sharp(full).metadata()).toMatchObject({ width: 6336, height: 9504 });

    const panorama = await fixture('panorama.jpg', nativeSharp({ create: { width: 30000, height: 1500, channels: 3, background: '#468' } }).jpeg());
    expect(await sharp(panorama).metadata()).toMatchObject({ width: 30000, height: 1500 });
    const strip = await sharp(panorama).resize({ height: 300 }).jpeg().toBuffer();
    expect(await sharp(strip).metadata()).toMatchObject({ width: 6000, height: 300 });
  }, 60000);

  test('an image over the limit fails with a message naming it, and the old file survives', async () => {
    const input = await nativeSharp({ create: { width: 80, height: 40, channels: 4, background: 'white' } }).png().toBuffer();
    const target = path.join(workspace, 'derivative.png');
    await fs.writeFile(target, input);
    await withEnv({ IMAGE_MAX_PIXELS: '1000' }, async () => {
      await expect(sharp(input).metadata()).rejects.toMatchObject({
        code: 'IMAGE_RESOURCE_LIMIT', status: 422, imageLimit: 'pixels', message: expect.stringContaining('IMAGE_MAX_PIXELS') });
      await expect(sharp(input).resize(20).toFile(target)).rejects.toMatchObject({ code: 'IMAGE_RESOURCE_LIMIT' });
    });
    expect(await fs.readFile(target)).toEqual(input);
    // An output larger than the limits is refused before it is allocated.
    await expect(sharp(input).resize(16384, 16384).toFile(target)).rejects.toMatchObject({ code: 'IMAGE_RESOURCE_LIMIT' });
    expect(await fs.readFile(target)).toEqual(input);
    // toFile still takes its format from the target's extension.
    const webp = path.join(workspace, 'derivative.webp');
    await sharp(input).resize(20).toFile(webp);
    expect(await sharp(webp).metadata()).toMatchObject({ format: 'webp', width: 20 });
  });

  test('animated sources keep their frames; overlays and raw tiles composite', async () => {
    const pixels = Buffer.alloc(16 * 16 * 4 * 3);
    for (let frame = 0; frame < 4; frame++) pixels.fill(frame % 2 ? 255 : 0, frame * 768, (frame + 1) * 768);
    const animation = await nativeSharp(pixels, { raw: { width: 16, height: 64, pageHeight: 16, channels: 3 } }).gif({ delay: 10 }).toBuffer();
    const rendered = await sharp(animation, { animated: true }).resize({ width: 8 }).webp().toBuffer();
    expect((await sharp(rendered).metadata()).pages).toBe(4);
    const input = await nativeSharp({ create: { width: 80, height: 40, channels: 4, background: 'white' } }).png().toBuffer();
    const faded = await sharp(input).composite([{ input: Buffer.from([255, 255, 255, 128]), raw: { width: 1, height: 1, channels: 4 }, tile: true, blend: 'dest-in' }]).png().toBuffer();
    expect(await sharp(faded).metadata()).toMatchObject({ width: 80, hasAlpha: true });
  });

  test('a metadata batch accounts each file on its own', async () => {
    const files = [];
    for (let index = 0; index < 3; index++) files.push(await fixture(`noise-${index}.jpg`, noise(520, 520).jpeg({ quality: 100, chromaSubsampling: '4:4:4' })));
    const large = await fixture('noise-large.jpg', noise(1100, 1100).jpeg({ quality: 100, chromaSubsampling: '4:4:4' }));
    const size = (await fs.stat(files[0])).size;
    expect(size).toBeLessThan(MiB);
    expect(size * 3).toBeGreaterThan(MiB);
    expect((await fs.stat(large)).size).toBeGreaterThan(MiB);
    await withEnv({ IMAGE_MAX_INPUT_MIB: '1' }, async () => {
      const results = await sharp.metadataBatch([...files, large], { validate: true });
      // Together the first three exceed the 1 MiB limit; none of them does alone.
      for (const result of results.slice(0, 3)) expect(result).toMatchObject({ decodedBytes: 520 * 520 * 3, fingerprint: { size } });
      expect(results[3].error).toMatchObject({ code: 'IMAGE_RESOURCE_LIMIT', imageLimit: 'input', imageMax: 1 });
    });
  });

  test('metadata with an oversized XMP block is returned without the block', async () => {
    const input = await nativeSharp({ create: { width: 16, height: 16, channels: 3, background: 'white' } }).png()
      .withXmp(`<x:xmpmeta xmlns:x="adobe:ns:meta/">${'a'.repeat(900000)}</x:xmpmeta>`).toBuffer();
    expect((await nativeSharp(input).metadata()).xmp.length).toBeGreaterThan(750 * 1024);
    const metadata = await sharp(input).metadata();
    expect(metadata).toMatchObject({ width: 16, height: 16, format: 'png' });
    expect(metadata.xmp).toBeUndefined();
    // An ordinary block still comes back as a Buffer.
    const small = await nativeSharp({ create: { width: 16, height: 16, channels: 3, background: 'white' } }).png()
      .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/">ok</x:xmpmeta>').toBuffer();
    expect(Buffer.isBuffer((await sharp(small).metadata()).xmp)).toBe(true);
  });

  test('a request that is already cancelled never starts', async () => {
    const input = await nativeSharp({ create: { width: 16, height: 16, channels: 3, background: 'white' } }).jpeg().toBuffer();
    const controller = new AbortController();
    controller.abort();
    await expect(sharp(input, { signal: controller.signal }).metadata()).rejects.toMatchObject({ code: 'IMAGE_CANCELLED', status: 503 });
    expect((await sharp(input).metadata()).width).toBe(16);
  });

  test('a missing or unreadable source is an ordinary error, not a resource refusal', async () => {
    await expect(sharp(path.join(workspace, 'absent.jpg')).metadata()).rejects.toMatchObject({ code: 'ENOENT' });
    const error = await sharp(Buffer.from('not an image')).metadata().catch(caught => caught);
    expect(require('../../src/services/imageResourcePolicy').isResourceError(error)).toBe(false);
  });
});
