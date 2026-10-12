/**
 * Tile placeholder hashes (issue 1733, B1): the ThumbHash encoder.
 *
 * The expected hashes below were produced by the published reference
 * implementation (the `thumbhash` npm package, 0.1.1) for the same synthetic
 * images. The package is not a dependency; the vectors pin that the encoder
 * carried in services/thumbHash.js is still that algorithm. The frontend
 * decoder test decodes the same vectors.
 */

const sharp = require('sharp');
const { rgbaToThumbHash, computeThumbHash } = require('../../src/services/thumbHash');

// A red ramp across, a green ramp down and a blue sawtooth; with `alpha`
// the right half is mostly transparent.
function synthetic(w, h, alpha) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = Math.round(255 * x / (w - 1));
      data[i + 1] = Math.round(255 * y / (h - 1));
      data[i + 2] = (x * 7 + y * 13) % 256;
      data[i + 3] = alpha && x >= w / 2 ? 64 : 255;
    }
  }
  return data;
}

// Header fields, read the way the format defines them.
function readHeader(base64) {
  const hash = Buffer.from(base64, 'base64');
  const header = hash[0] | (hash[1] << 8) | (hash[2] << 16);
  const l = (header & 63) / 63;
  const p = ((header >> 6) & 63) / 31.5 - 1;
  const q = ((header >> 12) & 63) / 31.5 - 1;
  const hasAlpha = Boolean(header >> 23);
  const b = l - 2 / 3 * p;
  const r = (3 * l - b + q) / 2;
  const g = r - q;
  const landscape = Boolean(hash[4] & 0x80);
  const full = hasAlpha ? 5 : 7;
  const lx = landscape ? full : hash[3] & 7;
  const ly = landscape ? hash[3] & 7 : full;
  return { r: r * 255, g: g * 255, b: b * 255, hasAlpha, aspect: lx / ly, bytes: hash.length };
}

describe('ThumbHash encoder', () => {
  afterAll(() => require('../../src/services/isolatedSharp').shutdown());

  it.each([
    [40, 30, false, 'HwgKPZpgh3dwh3eHdXh2eKCACPeH'],
    [30, 40, false, 'HwgKPRqAh3B3d4d3Zld5eXGQCPeI'],
    [32, 32, true, 'XLeFJRBJQoZAiHhGdYJQJ/WKj3WIiHeIiA=='],
    [100, 25, false, 'H/gJOppwdoZweHh3gYAI+Ic='],
    [2, 2, false, 'lgsuXyx1CoqFeIqHiKiHCIqKCAd3cI8I'],
  ])('matches the reference for a %ix%i image (alpha: %s)', (w, h, alpha, expected) => {
    const hash = Buffer.from(rgbaToThumbHash(w, h, synthetic(w, h, alpha))).toString('base64');
    expect(hash).toBe(expected);
    // What the column has to hold.
    expect(hash.length).toBeLessThanOrEqual(36);
  });

  it('refuses an image larger than 100x100', () => {
    expect(() => rgbaToThumbHash(101, 10, new Uint8Array(101 * 10 * 4))).toThrow(/100x100/);
  });

  it('keeps the average colour and the aspect ratio of a thumbnail', async () => {
    const jpeg = await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 200, g: 120, b: 40 } } })
      .jpeg().toBuffer();
    const hash = await computeThumbHash(jpeg);
    expect(typeof hash).toBe('string');
    const info = readHeader(hash);
    expect(info.hasAlpha).toBe(false);
    // Six bits per channel term: within a few percent of the real colour.
    expect(Math.abs(info.r - 200)).toBeLessThan(12);
    expect(Math.abs(info.g - 120)).toBeLessThan(12);
    expect(Math.abs(info.b - 40)).toBeLessThan(12);
    // 3:2, quantised to sevenths.
    expect(info.aspect).toBeCloseTo(7 / 5, 5);

    const portrait = await sharp({ create: { width: 200, height: 300, channels: 3, background: { r: 10, g: 10, b: 10 } } })
      .jpeg().toBuffer();
    expect(readHeader(await computeThumbHash(portrait)).aspect).toBeCloseTo(5 / 7, 5);
  });

  it('records transparency', async () => {
    const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 0.25 } } })
      .png().toBuffer();
    const info = readHeader(await computeThumbHash(png));
    expect(info.hasAlpha).toBe(true);
    expect(info.bytes).toBeLessThanOrEqual(25);
  });

  it('answers null instead of throwing for something that is not an image', async () => {
    await expect(computeThumbHash(Buffer.from('not an image'))).resolves.toBeNull();
    await expect(computeThumbHash('/nonexistent/thumb.jpg')).resolves.toBeNull();
  });
});
