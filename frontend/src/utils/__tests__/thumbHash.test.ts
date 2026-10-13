/**
 * Tile placeholder decoder (issue 1733, B1).
 *
 * The hashes are what the reference encoder gives for the ramp images of the
 * backend encoder test (backend/__tests__/services/thumbHash.test.js): a red
 * ramp across, a green ramp down and a blue sawtooth. Decoding them here
 * closes the round trip: what the server stores comes back as the picture it
 * was taken from, at placeholder resolution.
 *
 * Nothing here pins decoded pixels byte for byte, on purpose. The decoder
 * goes through Math.cos, whose last bit differs between V8 builds (x64 and
 * arm64 Node 22 disagree), and a pixel that lands on an integer boundary can
 * come out one level apart. The assertions are sizes, which come from the
 * header alone, and means with margins far wider than that.
 */
import { describe, it, expect } from 'vitest';
import {
  thumbHashBytes,
  thumbHashToRGBA,
  thumbHashToApproximateAspectRatio,
  thumbHashToDataUrl,
  thumbHashCacheSize,
  rgbaToDataUrl,
} from '../thumbHash';

const LANDSCAPE = 'HwgKPZpgh3dwh3eHdXh2eKCACPeH'; // 40x30
const PORTRAIT = 'HwgKPRqAh3B3d4d3Zld5eXGQCPeI'; // 30x40
const WITH_ALPHA = 'XLeFJRBJQoZAiHhGdYJQJ/WKj3WIiHeIiA=='; // 32x32, right half at 25%
const PANORAMA = 'H/gJOppwdoZweHh3gYAI+Ic='; // 100x25

const decode = (base64: string) => thumbHashToRGBA(thumbHashBytes(base64)!);

/** Mean of one channel over a rectangle of the decoded image. */
function mean(
  image: { w: number; h: number; rgba: Uint8Array },
  channel: number,
  x0 = 0, x1 = image.w, y0 = 0, y1 = image.h,
): number {
  let sum = 0;
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      sum += image.rgba[(y * image.w + x) * 4 + channel];
      count += 1;
    }
  }
  return sum / count;
}

describe('thumbHash decoder', () => {
  it('keeps the aspect ratio of the source', () => {
    expect(thumbHashToApproximateAspectRatio(thumbHashBytes(LANDSCAPE)!)).toBeCloseTo(7 / 5, 5);
    expect(decode(LANDSCAPE)).toMatchObject({ w: 32, h: 23 });
    expect(decode(PORTRAIT)).toMatchObject({ w: 23, h: 32 });
    expect(decode(WITH_ALPHA)).toMatchObject({ w: 32, h: 32 });
    // 4:1 is stored as 7:2.
    expect(decode(PANORAMA)).toMatchObject({ w: 32, h: 9 });
  });

  it('gives back the average colour within tolerance', () => {
    const image = decode(LANDSCAPE);
    // The source ramps average 127.5 in red and green; the sawtooth about the same in blue.
    expect(Math.abs(mean(image, 0) - 127.5)).toBeLessThan(16);
    expect(Math.abs(mean(image, 1) - 127.5)).toBeLessThan(16);
    expect(Math.abs(mean(image, 2) - 127.5)).toBeLessThan(24);
    expect(mean(image, 3)).toBe(255);
  });

  it('gives back the shape, not just the colour', () => {
    const image = decode(LANDSCAPE);
    // Red rises left to right, green top to bottom.
    expect(mean(image, 0, 0, 8)).toBeLessThan(mean(image, 0, 24, 32) - 80);
    expect(mean(image, 1, 0, 32, 0, 6)).toBeLessThan(mean(image, 1, 0, 32, 17, 23) - 80);
  });

  it('decodes transparency', () => {
    const image = decode(WITH_ALPHA);
    expect(mean(image, 3, 0, 12)).toBeGreaterThan(200);
    expect(mean(image, 3, 20, 32)).toBeLessThan(120);
  });

  it('encodes a PNG data URL of the decoded size', () => {
    const url = thumbHashToDataUrl(LANDSCAPE)!;
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
    const png = atob(url.slice('data:image/png;base64,'.length));
    expect(png.slice(1, 4)).toBe('PNG');
    // IHDR: width and height, big-endian, at bytes 16 and 20.
    expect(png.charCodeAt(19)).toBe(32);
    expect(png.charCodeAt(23)).toBe(23);
    expect(png.slice(-8, -4)).toBe('IEND');
    // The same bytes for the same pixels.
    const { w, h, rgba } = decode(LANDSCAPE);
    expect(rgbaToDataUrl(w, h, rgba)).toBe(url);
  });

  it('answers null for anything that is not a hash', () => {
    expect(thumbHashToDataUrl(null)).toBeNull();
    expect(thumbHashToDataUrl(undefined)).toBeNull();
    expect(thumbHashToDataUrl('')).toBeNull();
    expect(thumbHashToDataUrl('not base64 !!')).toBeNull();
    expect(thumbHashToDataUrl('AAAA')).toBeNull(); // three bytes
    expect(thumbHashToDataUrl(btoa('x'.repeat(40)))).toBeNull(); // too long
  });

  it('decodes a truncated hash instead of throwing', () => {
    // Header only: the missing terms read as zero.
    expect(thumbHashToDataUrl(btoa(atob(LANDSCAPE).slice(0, 5)))).toMatch(/^data:image\/png/);
  });

  it('memoises per hash and stays bounded', () => {
    const first = thumbHashToDataUrl(PORTRAIT);
    expect(thumbHashToDataUrl(PORTRAIT)).toBe(first);
    // 400 distinct, valid hashes: only the last byte differs.
    const head = atob(LANDSCAPE).slice(0, -2);
    for (let i = 0; i < 400; i++) {
      thumbHashToDataUrl(btoa(head + String.fromCharCode(i & 255, i >> 8)));
    }
    expect(thumbHashCacheSize()).toBeLessThanOrEqual(256);
  });
});
