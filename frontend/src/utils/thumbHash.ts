/**
 * Blurred tile placeholders (issue 1733, B1): the decoder.
 *
 * The photo list carries `thumb_hash`, a base64 ThumbHash of the thumbnail
 * (about 25 bytes: average colour, rough shape, aspect ratio; the encoder is
 * backend/src/services/thumbHash.js). This turns one into a tiny PNG data URL
 * to paint behind a tile while the real thumbnail loads.
 *
 * thumbHashToRGBA and rgbaToDataUrl are the reference decoder of ThumbHash by
 * Evan Wallace (https://github.com/evanw/thumbhash), carried here instead of
 * adding a dependency for two functions:
 *
 *   Copyright (c) 2023 Evan Wallace
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a
 *   copy of this software and associated documentation files (the
 *   "Software"), to deal in the Software without restriction, including
 *   without limitation the rights to use, copy, modify, merge, publish,
 *   distribute, sublicense, and/or sell copies of the Software, and to permit
 *   persons to whom the Software is furnished to do so, subject to the
 *   following conditions:
 *
 *   The above copyright notice and this permission notice shall be included
 *   in all copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
 *   OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 *   MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
 *   NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 *   DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 *   OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
 *   USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

/** Width over height, as coarsely as the hash stores it. */
export function thumbHashToApproximateAspectRatio(hash: ArrayLike<number>): number {
  const header = hash[3];
  const hasAlpha = hash[2] & 0x80;
  const isLandscape = hash[4] & 0x80;
  const lx = isLandscape ? (hasAlpha ? 5 : 7) : header & 7;
  const ly = isLandscape ? header & 7 : (hasAlpha ? 5 : 7);
  return lx / ly;
}

/** Decodes a ThumbHash to at most 32x32 RGBA pixels, not premultiplied. */
export function thumbHashToRGBA(hash: ArrayLike<number>): { w: number; h: number; rgba: Uint8Array } {
  const { PI, min, max, cos, round } = Math;

  // The constants.
  const header24 = hash[0] | (hash[1] << 8) | (hash[2] << 16);
  const header16 = hash[3] | (hash[4] << 8);
  const lDc = (header24 & 63) / 63;
  const pDc = ((header24 >> 6) & 63) / 31.5 - 1;
  const qDc = ((header24 >> 12) & 63) / 31.5 - 1;
  const lScale = ((header24 >> 18) & 31) / 31;
  const hasAlpha = header24 >> 23;
  const pScale = ((header16 >> 3) & 63) / 63;
  const qScale = ((header16 >> 9) & 63) / 63;
  const isLandscape = header16 >> 15;
  const lx = max(3, isLandscape ? (hasAlpha ? 5 : 7) : header16 & 7);
  const ly = max(3, isLandscape ? header16 & 7 : (hasAlpha ? 5 : 7));
  const aDc = hasAlpha ? (hash[5] & 15) / 15 : 1;
  const aScale = (hash[5] >> 4) / 15;

  // The varying terms. Saturation is boosted by 1.25 to make up for the
  // quantisation.
  const acStart = hasAlpha ? 6 : 5;
  let acIndex = 0;
  const decodeChannel = (nx: number, ny: number, scale: number): number[] => {
    const ac: number[] = [];
    for (let cy = 0; cy < ny; cy++) {
      for (let cx = cy ? 0 : 1; cx * ny < nx * (ny - cy); cx++) {
        ac.push((((hash[acStart + (acIndex >> 1)] >> ((acIndex++ & 1) << 2)) & 15) / 7.5 - 1) * scale);
      }
    }
    return ac;
  };
  const lAc = decodeChannel(lx, ly, lScale);
  const pAc = decodeChannel(3, 3, pScale * 1.25);
  const qAc = decodeChannel(3, 3, qScale * 1.25);
  const aAc = hasAlpha ? decodeChannel(5, 5, aScale) : [];

  // Inverse DCT into RGB.
  const ratio = thumbHashToApproximateAspectRatio(hash);
  const w = round(ratio > 1 ? 32 : 32 * ratio);
  const h = round(ratio > 1 ? 32 / ratio : 32);
  const rgba = new Uint8Array(w * h * 4);
  const fx: number[] = [];
  const fy: number[] = [];
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      let l = lDc, p = pDc, q = qDc, a = aDc;

      for (let cx = 0, n = max(lx, hasAlpha ? 5 : 3); cx < n; cx++) fx[cx] = cos(PI / w * (x + 0.5) * cx);
      for (let cy = 0, n = max(ly, hasAlpha ? 5 : 3); cy < n; cy++) fy[cy] = cos(PI / h * (y + 0.5) * cy);

      for (let cy = 0, j = 0; cy < ly; cy++) {
        const fy2 = fy[cy] * 2;
        for (let cx = cy ? 0 : 1; cx * ly < lx * (ly - cy); cx++, j++) l += lAc[j] * fx[cx] * fy2;
      }

      for (let cy = 0, j = 0; cy < 3; cy++) {
        const fy2 = fy[cy] * 2;
        for (let cx = cy ? 0 : 1; cx < 3 - cy; cx++, j++) {
          const f = fx[cx] * fy2;
          p += pAc[j] * f;
          q += qAc[j] * f;
        }
      }

      if (hasAlpha) {
        for (let cy = 0, j = 0; cy < 5; cy++) {
          const fy2 = fy[cy] * 2;
          for (let cx = cy ? 0 : 1; cx < 5 - cy; cx++, j++) a += aAc[j] * fx[cx] * fy2;
        }
      }

      const b = l - 2 / 3 * p;
      const r = (3 * l - b + q) / 2;
      const g = r - q;
      rgba[i] = max(0, 255 * min(1, r));
      rgba[i + 1] = max(0, 255 * min(1, g));
      rgba[i + 2] = max(0, 255 * min(1, b));
      rgba[i + 3] = max(0, 255 * min(1, a));
    }
  }
  return { w, h, rgba };
}

/**
 * RGBA pixels as a PNG data URL. Stored uncompressed: built for speed and a
 * few dozen pixels a side, with no canvas (so it also runs where there is
 * none).
 */
export function rgbaToDataUrl(w: number, h: number, rgba: ArrayLike<number>): string {
  const row = w * 4 + 1;
  const idat = 6 + h * (5 + row);
  const bytes = [
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0,
    w >> 8, w & 255, 0, 0, h >> 8, h & 255, 8, 6, 0, 0, 0, 0, 0, 0, 0,
    idat >>> 24, (idat >> 16) & 255, (idat >> 8) & 255, idat & 255,
    73, 68, 65, 84, 120, 1,
  ];
  const table = [
    0, 498536548, 997073096, 651767980, 1994146192, 1802195444, 1303535960,
    1342533948, -306674912, -267414716, -690576408, -882789492, -1687895376,
    -2032938284, -1609899400, -1111625188,
  ];
  let a = 1, b = 0;
  for (let y = 0, i = 0, end = row - 1; y < h; y++, end += row - 1) {
    bytes.push(y + 1 < h ? 0 : 1, row & 255, row >> 8, ~row & 255, (row >> 8) ^ 255, 0);
    for (b = (b + a) % 65521; i < end; i++) {
      const u = rgba[i] & 255;
      bytes.push(u);
      a = (a + u) % 65521;
      b = (b + a) % 65521;
    }
  }
  bytes.push(
    b >> 8, b & 255, a >> 8, a & 255, 0, 0, 0, 0,
    0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
  );
  for (const [start, stop] of [[12, 29], [37, 41 + idat]]) {
    let end = stop;
    let c = ~0;
    for (let i = start; i < end; i++) {
      c ^= bytes[i];
      c = (c >>> 4) ^ table[c & 15];
      c = (c >>> 4) ^ table[c & 15];
    }
    c = ~c;
    bytes[end++] = c >>> 24;
    bytes[end++] = (c >> 16) & 255;
    bytes[end++] = (c >> 8) & 255;
    bytes[end++] = c & 255;
  }
  return `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
}

/** The bytes of a base64 `thumb_hash`, or null when it is not one. */
export function thumbHashBytes(base64: string): Uint8Array | null {
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    return null;
  }
  // Five header bytes, and at most 25 in all. Anything else is not a hash
  // this encoder wrote, and the decoder reads its length from the header.
  if (binary.length < 5 || binary.length > 25) return null;
  const hash = new Uint8Array(25);
  for (let i = 0; i < binary.length; i++) hash[i] = binary.charCodeAt(i);
  return hash;
}

// One decode per hash. A data URL is about 5 kB, so the cache is bounded:
// a tile that scrolls back in after its entry was dropped decodes again,
// which costs well under a millisecond.
const CACHE_LIMIT = 256;
const cache = new Map<string, string | null>();

/** A blurred placeholder for a `thumb_hash`, as a PNG data URL; null when there is none. */
export function thumbHashToDataUrl(thumbHash: string | null | undefined): string | null {
  if (!thumbHash) return null;
  const cached = cache.get(thumbHash);
  if (cached !== undefined) {
    // Most recently used goes last.
    cache.delete(thumbHash);
    cache.set(thumbHash, cached);
    return cached;
  }
  let url: string | null = null;
  try {
    const hash = thumbHashBytes(thumbHash);
    if (hash) {
      const { w, h, rgba } = thumbHashToRGBA(hash);
      url = rgbaToDataUrl(w, h, rgba);
    }
  } catch {
    url = null;
  }
  cache.set(thumbHash, url);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return url;
}

/** Test seam: the number of cached placeholders. */
export const thumbHashCacheSize = (): number => cache.size;
