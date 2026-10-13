/**
 * Tile placeholder hashes (issue 1733, B1): the ThumbHash encoder.
 *
 * The expected hashes below were produced by the published reference
 * implementation (the `thumbhash` npm package, 0.1.1) for the same images.
 * The package is not a dependency; the vectors pin that the encoder carried
 * in services/thumbHash.js is still that algorithm.
 *
 * What is and is not guaranteed, because the first version of this suite got
 * it wrong and failed on CI:
 *
 *   A hash stores each varying term in four bits, as round(15 * f). The
 *   encoder computes f through Math.cos, and V8's Math.cos is not the same
 *   function on every build: Node 22 on x64 and on arm64 disagree in the last
 *   bit for some arguments (3 of the 224 cosines a 32x32 encode uses). That
 *   is invisible unless 15 * f sits on a .5 boundary, and it does whenever a
 *   term is zero in exact arithmetic: f becomes 0.5 plus or minus one ulp,
 *   15 * f is 7.5 give or take 1e-15, and the last bit of a cosine decides
 *   between 7 and 8. Symmetric or separable images (plain ramps, flat
 *   colours, most synthetic test cards) are full of such terms.
 *
 * So there are two kinds of test:
 *
 *   - Byte-exact pins, on images built from integers only (identical bytes
 *     everywhere) whose every quantised term is at least 0.05 away from a
 *     boundary. The margin is asserted, not assumed. These were derived on
 *     arm64 and on x64 and agree.
 *   - A tolerance test on ramp images, which do sit on boundaries: the hash
 *     must have the reference's structure and every quantised value within
 *     one step of the reference's. That is all the format promises there,
 *     and one step of one term is not visible in a placeholder.
 */

const sharp = require('sharp');
const { rgbaToThumbHash, computeThumbHash } = require('../../src/services/thumbHash');

// Integer arithmetic only: every byte is a polynomial in x, y and the seed,
// reduced mod 256. No division, no Math.*, so the input is the same bytes on
// every platform. The seeds were picked so that no quantised term of the
// encode comes near a rounding boundary.
function pattern(w, h, alpha, seed) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = (x * x * 3 + y * 7 + x * y + seed * 17) % 256;
      data[i + 1] = (y * y * 5 + x * 11 + x * y * 2 + seed * 29) % 256;
      data[i + 2] = (x * 13 + y * y * 3 + x * x * y + seed * 43) % 256;
      data[i + 3] = alpha ? 255 - ((x * 5 + y * 3 + x * y + seed * 7) % 192) : 255;
    }
  }
  return data;
}

// A red ramp across, a green ramp down and a blue sawtooth; with `alpha`
// the right half is mostly transparent. Readable, and exactly the kind of
// image whose hash has terms on a rounding boundary.
function ramps(w, h, alpha) {
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

const toBase64 = (hash) => Buffer.from(hash).toString('base64');

// Encode while recording every value the encoder rounds, to measure how far
// the nearest one is from a .5 boundary.
function encodeWithMargin(w, h, rgba) {
  const rounded = [];
  const realRound = Math.round;
  const spy = jest.spyOn(Math, 'round').mockImplementation((value) => {
    rounded.push(value);
    return realRound(value);
  });
  try {
    const hash = toBase64(rgbaToThumbHash(w, h, rgba));
    const margin = Math.min(...rounded.map((value) => Math.abs(value - Math.floor(value) - 0.5)));
    return { hash, margin };
  } finally {
    spy.mockRestore();
  }
}

// A hash as its stored values: `structure` decides the layout and must match
// exactly, `values` are the quantised numbers.
function unpack(base64) {
  const hash = Buffer.from(base64, 'base64');
  const header24 = hash[0] | (hash[1] << 8) | (hash[2] << 16);
  const header16 = hash[3] | (hash[4] << 8);
  const hasAlpha = header24 >> 23;
  const values = [
    header24 & 63, (header24 >> 6) & 63, (header24 >> 12) & 63, (header24 >> 18) & 31,
    (header16 >> 3) & 63, (header16 >> 9) & 63,
  ];
  for (let i = 5; i < hash.length; i++) values.push(hash[i] & 15, hash[i] >> 4);
  return {
    structure: { bytes: hash.length, hasAlpha, isLandscape: header16 >> 15, lOrder: header16 & 7 },
    values,
  };
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
    [40, 30, false, 7, '4PcBDYIsN4vWrP12hDR0aKSfpd+9'],
    [30, 40, false, 254, 'H/gBDQKyfohmY5Ss27v7q1cgdgRk'],
    [32, 32, true, 395, '4PeBBQIJsNJu64Y190agdpB5ICYGlkd8hA=='],
    [100, 25, false, 112, '4AcCCoCgh9fZatloX7zzTn0='],
    [7, 5, true, 136, 'XEiFNIod8qPnVqWxFUVgsMc7MEUxdYd3BQ=='],
  ])('matches the reference byte for byte on a %ix%i integer pattern (alpha: %s, seed %i)', (w, h, alpha, seed, expected) => {
    const { hash, margin } = encodeWithMargin(w, h, pattern(w, h, alpha, seed));
    // The pin is only meaningful while nothing sits on a rounding boundary:
    // platform noise in Math.cos is around 1e-15.
    expect(margin).toBeGreaterThan(0.05);
    expect(hash).toBe(expected);
    // What the column has to hold.
    expect(hash.length).toBeLessThanOrEqual(36);
  });

  it.each([
    [40, 30, false, 'HwgKPZpgh3dwh3eHdXh2eKCACPeH'],
    [30, 40, false, 'HwgKPRqAh3B3d4d3Zld5eXGQCPeI'],
    [32, 32, true, 'XLeFJRBJQoZAiHhGdYJQJ/WKj3WIiHeIiA=='],
    [100, 25, false, 'H/gJOppwdoZweHh3gYAI+Ic='],
    [2, 2, false, 'lgsuXyx1CoqFeIqHiKiHCIqKCAd3cI8I'],
  ])('stays within one quantisation step of the reference on a %ix%i ramp image (alpha: %s)', (w, h, alpha, reference) => {
    const { hash, margin } = encodeWithMargin(w, h, ramps(w, h, alpha));
    // The reason this is not a byte-exact pin: at least one term is on a
    // boundary. If that ever stops being true the image no longer tests it.
    expect(margin).toBeLessThan(1e-9);
    const actual = unpack(hash);
    const expected = unpack(reference);
    expect(actual.structure).toEqual(expected.structure);
    const steps = actual.values.map((value, i) => Math.abs(value - expected.values[i]));
    expect(Math.max(...steps)).toBeLessThanOrEqual(1);
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
