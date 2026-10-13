/**
 * Blurred tile placeholders (issue 1733, B1).
 *
 * A ThumbHash is about 25 bytes that hold a photo's average colour, its
 * rough shape and its aspect ratio. It is computed once from the thumbnail
 * that was just generated, stored base64 in photos.thumb_hash, shipped in the
 * photo list and painted behind the tile while the real thumbnail loads
 * (frontend/src/utils/thumbHash.ts holds the decoder).
 *
 * rgbaToThumbHash is the reference encoder of ThumbHash by Evan Wallace
 * (https://github.com/evanw/thumbhash), carried here instead of adding a
 * dependency for one function:
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

const sharp = require('./isolatedSharp');
const logger = require('../utils/logger');

// The encoder is quadratic in the pixel count and gains nothing past this.
const MAX_SIDE = 100;

/**
 * @param {number} w Width, at most 100.
 * @param {number} h Height, at most 100.
 * @param {Uint8Array} rgba w*h*4 bytes, row by row, not premultiplied.
 * @returns {Uint8Array} The ThumbHash.
 */
function rgbaToThumbHash(w, h, rgba) {
  if (w > MAX_SIDE || h > MAX_SIDE) throw new Error(`${w}x${h} doesn't fit in ${MAX_SIDE}x${MAX_SIDE}`);
  const { PI, round, max, cos, abs } = Math;

  // Average colour, weighted by alpha.
  let avgR = 0, avgG = 0, avgB = 0, avgA = 0;
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    const alpha = rgba[j + 3] / 255;
    avgR += alpha / 255 * rgba[j];
    avgG += alpha / 255 * rgba[j + 1];
    avgB += alpha / 255 * rgba[j + 2];
    avgA += alpha;
  }
  if (avgA) {
    avgR /= avgA;
    avgG /= avgA;
    avgB /= avgA;
  }

  const hasAlpha = avgA < w * h;
  const lLimit = hasAlpha ? 5 : 7; // Fewer luminance terms when alpha needs the room.
  const lx = max(1, round(lLimit * w / max(w, h)));
  const ly = max(1, round(lLimit * h / max(w, h)));
  const l = []; // luminance
  const p = []; // yellow - blue
  const q = []; // red - green
  const a = []; // alpha

  // RGBA to LPQA, composited over the average colour.
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    const alpha = rgba[j + 3] / 255;
    const r = avgR * (1 - alpha) + alpha / 255 * rgba[j];
    const g = avgG * (1 - alpha) + alpha / 255 * rgba[j + 1];
    const b = avgB * (1 - alpha) + alpha / 255 * rgba[j + 2];
    l[i] = (r + g + b) / 3;
    p[i] = (r + g) / 2 - b;
    q[i] = r - g;
    a[i] = alpha;
  }

  // DCT into one constant (DC) term and normalised varying (AC) terms.
  const encodeChannel = (channel, nx, ny) => {
    let dc = 0, scale = 0;
    const ac = [], fx = [];
    for (let cy = 0; cy < ny; cy++) {
      for (let cx = 0; cx * ny < nx * (ny - cy); cx++) {
        let f = 0;
        for (let x = 0; x < w; x++) fx[x] = cos(PI / w * cx * (x + 0.5));
        for (let y = 0; y < h; y++) {
          const fy = cos(PI / h * cy * (y + 0.5));
          for (let x = 0; x < w; x++) f += channel[x + y * w] * fx[x] * fy;
        }
        f /= w * h;
        if (cx || cy) {
          ac.push(f);
          scale = max(scale, abs(f));
        } else {
          dc = f;
        }
      }
    }
    if (scale) for (let i = 0; i < ac.length; i++) ac[i] = 0.5 + 0.5 / scale * ac[i];
    return [dc, ac, scale];
  };
  const [lDc, lAc, lScale] = encodeChannel(l, max(3, lx), max(3, ly));
  const [pDc, pAc, pScale] = encodeChannel(p, 3, 3);
  const [qDc, qAc, qScale] = encodeChannel(q, 3, 3);
  const [aDc, aAc, aScale] = hasAlpha ? encodeChannel(a, 5, 5) : [];

  // The constants.
  const isLandscape = w > h;
  const header24 = round(63 * lDc) | (round(31.5 + 31.5 * pDc) << 6) | (round(31.5 + 31.5 * qDc) << 12)
    | (round(31 * lScale) << 18) | (hasAlpha << 23);
  const header16 = (isLandscape ? ly : lx) | (round(63 * pScale) << 3) | (round(63 * qScale) << 9) | (isLandscape << 15);
  const hash = [header24 & 255, (header24 >> 8) & 255, header24 >> 16, header16 & 255, header16 >> 8];
  const acStart = hasAlpha ? 6 : 5;
  let acIndex = 0;
  if (hasAlpha) hash.push(round(15 * aDc) | (round(15 * aScale) << 4));

  // The varying terms, four bits each.
  for (const ac of hasAlpha ? [lAc, pAc, qAc, aAc] : [lAc, pAc, qAc]) {
    for (const f of ac) hash[acStart + (acIndex >> 1)] |= round(15 * f) << ((acIndex++ & 1) << 2);
  }
  return new Uint8Array(hash);
}

/**
 * The base64 ThumbHash of an image, or null.
 *
 * `input` is the thumbnail that was just generated: its buffer, or the path
 * of a poster frame on local disk. Never the original. Never throws: a photo
 * without a hash shows the plain loading tile, and that is not worth failing
 * an upload over.
 *
 * @param {Buffer|string} input
 * @returns {Promise<string|null>}
 */
async function computeThumbHash(input) {
  try {
    const { data, info } = await sharp(input, { failOn: 'none' })
      .resize(MAX_SIDE, MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return Buffer.from(rgbaToThumbHash(info.width, info.height, data)).toString('base64');
  } catch (error) {
    logger.debug(`No placeholder hash: ${error.message}`);
    return null;
  }
}

module.exports = { rgbaToThumbHash, computeThumbHash };
