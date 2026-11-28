/**
 * Writes synthetic.dng, the RAW fixture of the photo editor tests (issue 2619).
 *
 * A camera RAW of a known scene, made from nothing: a 384x256 RGGB Bayer
 * mosaic, 14 bits, uncompressed, with sRGB primaries as the camera space, an
 * as-shot white balance, a capture date and a camera name. The scene has a
 * grey ramp, colour patches and a highlight that clips one channel before
 * the others, which is what highlight reconstruction is for.
 *
 *   node makeSyntheticDng.js   (rewrites synthetic.dng next to this file)
 *
 * Original work of the PicPeak project, under the project's MIT licence.
 */
const fs = require('fs');
const path = require('path');

const W = 384;
const H = 256;
const WHITE = 16383;
const BLACK = 256;
// Camera neutral (AsShotNeutral): the raw response to a grey surface.
const NEUTRAL = [0.5, 1, 0.7];

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** Scene-linear RGB at (x, y). */
function scene(x, y) {
  if (y < 48) {
    // Grey ramp, black to diffuse white, in perceptual steps.
    const v = srgbToLinear(x / (W - 1));
    return [v, v, v];
  }
  if (y < 160) {
    // Six colour patches at mid brightness.
    const patches = [[0.8, 0.15, 0.1], [0.1, 0.6, 0.15], [0.1, 0.2, 0.75], [0.75, 0.7, 0.1], [0.6, 0.15, 0.6], [0.45, 0.3, 0.2]];
    return patches[Math.min(5, Math.floor(x / (W / 6)))].map((c) => c * 0.6);
  }
  // A bright warm highlight that clips the red channel first, on mid grey.
  const dx = x - W / 2;
  const dy = y - 208;
  const glow = Math.exp(-(dx * dx + dy * dy) / 900) * 3.5;
  return [0.18 + glow * 1.0, 0.18 + glow * 0.8, 0.18 + glow * 0.6];
}

function mosaic() {
  const data = Buffer.alloc(W * H * 2);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const channel = (y % 2 === 0) ? (x % 2 === 0 ? 0 : 1) : (x % 2 === 0 ? 1 : 2);
      const value = scene(x, y)[channel] * NEUTRAL[channel];
      const dn = Math.min(WHITE, Math.round(BLACK + value * (WHITE - BLACK)));
      data.writeUInt16LE(dn, (y * W + x) * 2);
    }
  }
  return data;
}

// --- a little-endian TIFF writer, just enough for one DNG IFD and an EXIF IFD.
const TYPES = { BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5, SRATIONAL: 10 };
const SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 10: 8 };

function encodeValues(type, values) {
  const t = TYPES[type];
  const buf = Buffer.alloc(values.length * SIZES[t]);
  values.forEach((v, i) => {
    if (t === 1 || t === 2) buf.writeUInt8(v, i);
    else if (t === 3) buf.writeUInt16LE(v, i * 2);
    else if (t === 4) buf.writeUInt32LE(v, i * 4);
    else if (t === 5) { buf.writeUInt32LE(v[0], i * 8); buf.writeUInt32LE(v[1], i * 8 + 4); }
    else if (t === 10) { buf.writeInt32LE(v[0], i * 8); buf.writeInt32LE(v[1], i * 8 + 4); }
  });
  return { type: t, count: values.length, data: buf };
}
const ascii = (text) => encodeValues('ASCII', [...Buffer.from(`${text}\0`, 'latin1')]);
const rational = (v) => [Math.round(v * 10000), 10000];

/** Serialise an IFD at `offset`; values larger than 4 bytes follow it. Returns the bytes. */
function ifd(entries, offset, next = 0) {
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);
  const head = Buffer.alloc(2 + sorted.length * 12 + 4);
  head.writeUInt16LE(sorted.length, 0);
  const extra = [];
  let extraOffset = offset + head.length;
  sorted.forEach((entry, i) => {
    const at = 2 + i * 12;
    head.writeUInt16LE(entry.tag, at);
    head.writeUInt16LE(entry.value.type, at + 2);
    head.writeUInt32LE(entry.value.count, at + 4);
    if (entry.value.data.length <= 4) {
      entry.value.data.copy(head, at + 8);
    } else {
      head.writeUInt32LE(extraOffset, at + 8);
      const padded = entry.value.data.length % 2 ? Buffer.concat([entry.value.data, Buffer.alloc(1)]) : entry.value.data;
      extra.push(padded);
      extraOffset += padded.length;
    }
  });
  head.writeUInt32LE(next, 2 + sorted.length * 12);
  return Buffer.concat([head, ...extra]);
}

function build() {
  const pixels = mosaic();
  // Two passes: the first to learn the sizes, the second with the offsets.
  let exifOffset = 0;
  let stripOffset = 0;
  let bytes;
  for (let pass = 0; pass < 2; pass++) {
    const main = [
      { tag: 254, value: encodeValues('LONG', [0]) },
      { tag: 256, value: encodeValues('LONG', [W]) },
      { tag: 257, value: encodeValues('LONG', [H]) },
      { tag: 258, value: encodeValues('SHORT', [16]) },
      { tag: 259, value: encodeValues('SHORT', [1]) },
      { tag: 262, value: encodeValues('SHORT', [32803]) },
      { tag: 271, value: ascii('PicPeak') },
      { tag: 272, value: ascii('Synthetic RAW') },
      { tag: 273, value: encodeValues('LONG', [stripOffset]) },
      { tag: 274, value: encodeValues('SHORT', [1]) },
      { tag: 277, value: encodeValues('SHORT', [1]) },
      { tag: 278, value: encodeValues('LONG', [H]) },
      { tag: 279, value: encodeValues('LONG', [pixels.length]) },
      { tag: 284, value: encodeValues('SHORT', [1]) },
      { tag: 306, value: ascii('2026:08:01 14:30:00') },
      { tag: 33421, value: encodeValues('SHORT', [2, 2]) },
      { tag: 33422, value: encodeValues('BYTE', [0, 1, 1, 2]) },
      { tag: 34665, value: encodeValues('LONG', [exifOffset]) },
      { tag: 50706, value: encodeValues('BYTE', [1, 4, 0, 0]) },
      { tag: 50707, value: encodeValues('BYTE', [1, 1, 0, 0]) },
      { tag: 50708, value: ascii('PicPeak Synthetic RAW') },
      { tag: 50714, value: encodeValues('LONG', [BLACK]) },
      { tag: 50717, value: encodeValues('LONG', [WHITE]) },
      // XYZ (D65) -> camera, the camera being linear sRGB.
      { tag: 50721, value: encodeValues('SRATIONAL', [3.2406, -1.5372, -0.4986, -0.9689, 1.8758, 0.0415, 0.0557, -0.2040, 1.0570].map(rational)) },
      { tag: 50728, value: encodeValues('RATIONAL', NEUTRAL.map(rational)) },
      { tag: 50778, value: encodeValues('SHORT', [21]) },
    ];
    const header = Buffer.alloc(8);
    header.write('II', 0, 'latin1');
    header.writeUInt16LE(42, 2);
    header.writeUInt32LE(8, 4);
    const mainIfd = ifd(main, 8);
    exifOffset = 8 + mainIfd.length;
    const exif = ifd([
      { tag: 36867, value: ascii('2026:08:01 14:30:00') }, // DateTimeOriginal
      { tag: 33434, value: encodeValues('RATIONAL', [[1, 250]]) }, // ExposureTime
      { tag: 34855, value: encodeValues('SHORT', [200]) }, // ISO
    ], exifOffset);
    stripOffset = exifOffset + exif.length;
    bytes = Buffer.concat([header, mainIfd, exif, pixels]);
  }
  return bytes;
}

if (require.main === module) {
  const out = path.join(__dirname, 'synthetic.dng');
  fs.writeFileSync(out, build());
  console.log(`wrote ${out}`);
}

module.exports = { build, W, H, NEUTRAL, scene };
