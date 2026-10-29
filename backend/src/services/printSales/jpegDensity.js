'use strict';
/** Set only the JFIF density header after rendering. Keep camera EXIF/XMP/GPS
 * stripped and avoid a second lossy image encode just to record print DPI. */
function jpegDensity(bytes, dpi) {
  if (!Buffer.isBuffer(bytes) || bytes[0] !== 0xff || bytes[1] !== 0xd8 ||
      !Number.isFinite(dpi) || dpi < 72 || dpi > 600) throw new Error('Invalid print JPEG or density');
  const density = Math.round(dpi);
  if (bytes.length >= 20 && bytes[2] === 0xff && bytes[3] === 0xe0 && bytes.toString('ascii', 6, 11) === 'JFIF\0') {
    const result = Buffer.from(bytes);
    result[13] = 1; result.writeUInt16BE(density, 14); result.writeUInt16BE(density, 16);
    return result;
  }
  const header = Buffer.from([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0]);
  header.writeUInt16BE(density, 12); header.writeUInt16BE(density, 14);
  return Buffer.concat([bytes.subarray(0, 2), header, bytes.subarray(2)]);
}
module.exports = { jpegDensity };
