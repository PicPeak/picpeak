const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const nativeSharp = require('sharp'); // Fixture creation only, never serving input.
const sharp = require('../../src/services/isolatedSharp');
const { estimate, configuration } = require('../../src/services/imageResourcePolicy');

describe('decoded image policy', () => {
  test('counts every frame, high-depth channel and rejects unsafe dimensions', () => {
    expect(estimate({ width: 7008, height: 4672, channels: 3, depth: 'uchar' })).toBe(130965504);
    for (const metadata of [
      { width: 9000, height: 9000 },
      { width: 16, height: 16, pages: 512 },
      { width: 7008, height: 4672, depth: 'float' },
      { width: NaN, height: 1 }, { width: 1, height: 1, pages: -1 },
      { width: true, height: 1 }, { width: 1, height: 1, pages: 0 }, { width: 1, height: 1, channels: 0 },
    ]) expect(() => estimate(metadata)).toThrow();
  });
  test('requires finite nonzero configuration, with a deployment reserve', () => {
    const policy = configuration();
    expect(policy.workers * policy.nativeBytes).toBeLessThanOrEqual(require('../../src/services/imageResourcePolicy').effectiveMemory() / 2);
    process.env.IMAGE_WORKER_MEMORY_MIB = '0';
    try { expect(configuration).toThrow('Invalid IMAGE_WORKER_MEMORY_MIB'); }
    finally { delete process.env.IMAGE_WORKER_MEMORY_MIB; }
  });
});

const linux = process.platform === 'linux' ? describe : describe.skip;
linux('hard-capped native image runner', () => {
  let workspace;
  beforeAll(async () => { workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'isolated-sharp-test-')); });
  afterAll(async () => { await fs.rm(workspace, { recursive: true, force: true }); });

  test('the production Linux pre-exec cap refuses native allocation above the limit', () => {
    const { spawnSync } = require('child_process');
    const result = spawnSync('/bin/sh', ['-c',
      'ulimit -v "$1" || exit 125; exec "$2" --jitless --no-expose-wasm --max-old-space-size=64 --eval "$3"',
      'picpeak-image-limit-test', String(configuration().nativeBytes / 1024), process.execPath,
      `try { Buffer.alloc(${configuration().nativeBytes + 64 * 1024 * 1024}); process.exit(2); } catch (_) { process.exit(0); }`],
    { timeout: 30000, env: { ...process.env, MALLOC_ARENA_MAX: '2' } });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });

  test('keeps the ordinary 32.7MP file/Buffer control and orientation/EXIF', async () => {
    const input = await nativeSharp({ create: { width: 7008, height: 4672, channels: 3, background: 'white' } })
      .jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const filename = path.join(workspace, 'ordinary.jpg');
    await fs.writeFile(filename, input);
    const metadata = await sharp(filename).metadata();
    expect(metadata.width).toBe(7008);
    expect(metadata.height).toBe(4672);
    expect(metadata.orientation).toBe(6);
    expect(Buffer.isBuffer(metadata.exif)).toBe(true);
    const output = await sharp(input).rotate().resize(300, 300, { fit: 'inside' }).keepMetadata().jpeg().toBuffer();
    const transformed = await sharp(output).metadata();
    expect(transformed.width).toBe(200);
    expect(transformed.height).toBe(300);
    expect([undefined, 1]).toContain(transformed.orientation);
    expect(Buffer.isBuffer(transformed.exif)).toBe(true);
    // Full-resolution watermarking cannot use the thumbnail's shrink-on-load
    // optimization. Preserve this legitimate source under the hard cap too.
    const overlay = Buffer.from('<svg width="10" height="10"><rect width="10" height="10" fill="red"/></svg>');
    const watermarked = await sharp(input).rotate().composite([{ input: overlay, left: 0, top: 0 }])
      .keepMetadata().jpeg({ quality: 100, mozjpeg: true }).toBuffer();
    const watermarkedMetadata = await sharp(watermarked).metadata();
    expect(watermarkedMetadata).toMatchObject({ width: 4672, height: 7008 });
    expect(Buffer.isBuffer(watermarkedMetadata.exif)).toBe(true);
  });

  test('bounds all frames before animated decode while preserving ordinary animation', async () => {
    const input = async pages => {
      const pixels = Buffer.alloc(16 * 16 * pages * 3);
      for (let frame = 0; frame < pages; frame++) pixels.fill(frame % 2 ? 255 : 0, frame * 768, (frame + 1) * 768);
      return nativeSharp(pixels, { raw: { width: 16, height: 16 * pages, pageHeight: 16, channels: 3 } }).gif({ delay: 10 }).toBuffer();
    };
    await expect(sharp(await input(512), { limitInputPixels: false }).metadata()).rejects.toMatchObject({ code: 'IMAGE_RESOURCE_LIMIT' });
    const animation = await input(4);
    const rendered = await sharp(animation, { animated: true }).resize({ width: 8 }).webp().toBuffer();
    expect((await sharp(rendered).metadata()).pages).toBe(4);
  });

  test('isolates SVG/composite/raw overlays and does not truncate an old toFile on refusal', async () => {
    const input = await nativeSharp({ create: { width: 80, height: 40, channels: 4, background: 'white' } }).png().toBuffer();
    const overlay = Buffer.from('<svg width="10" height="10"><rect width="10" height="10" fill="red"/></svg>');
    const tall = Buffer.from('<svg width="1" height="16000"><rect width="1" height="16000" fill="red"/></svg>');
    await expect(sharp(tall).resize({ width: 512 }).png().toBuffer()).rejects.toMatchObject({ code: 'IMAGE_RESOURCE_LIMIT' });
    const rendered = await sharp(input).composite([{ input: overlay, left: 0, top: 0 }]).png().toBuffer();
    expect((await sharp(rendered).metadata()).width).toBe(80);
    const filename = path.join(workspace, 'derivative.png');
    await fs.writeFile(filename, input);
    await expect(sharp(input).resize(16384, 16384).toFile(filename)).rejects.toMatchObject({ code: 'IMAGE_RESOURCE_LIMIT' });
    expect(await fs.readFile(filename)).toEqual(input);
    await sharp(input).resize(20).png().toFile(filename);
    expect((await sharp(filename).metadata()).width).toBe(20);
  });

  test('deadline is queue-inclusive and cancellation is explicit', async () => {
    const input = await nativeSharp({ create: { width: 16, height: 16, channels: 3, background: 'white' } }).jpeg().toBuffer();
    const controller = new AbortController();
    controller.abort();
    await expect(sharp(input, { signal: controller.signal }).metadata()).rejects.toMatchObject({ code: 'IMAGE_CANCELLED' });
    process.env.IMAGE_WORKER_TIMEOUT_MS = '1';
    try { await expect(sharp(input).metadata()).rejects.toMatchObject({ code: 'IMAGE_TIMEOUT' }); }
    finally { delete process.env.IMAGE_WORKER_TIMEOUT_MS; }
    // A timed-out child cannot poison the next live lease or the backend.
    expect((await sharp(input).metadata()).width).toBe(16);
  });
});
