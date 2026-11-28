// A JPEG whose EXIF segment sits behind large metadata blocks, as some
// editors write it (issue 2617): a sharp JPEG with 65 KB APP segments spliced
// in front of its EXIF. exifr alone misses the EXIF from two segments on.
const sharp = require('sharp');

const DEFAULT_EXIF = {
  IFD0: { Make: 'Canon', Model: 'Canon EOS R5' },
  IFD2: { DateTimeOriginal: '2025:06:01 09:45:03', OffsetTimeOriginal: '+02:00' },
};

// An APPn segment of `size` payload bytes after its identifier.
function appSegment(marker, id, size) {
  const body = Buffer.concat([Buffer.from(id, 'latin1'), Buffer.alloc(size, 0x20)]);
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

/**
 * The file's bytes.
 *   exif       what sharp's withExif takes; null for a JPEG without EXIF
 *   xmp        label the leading segments as XMP (APP1) instead of ICC (APP2)
 *   fillBytes  0xFF fill bytes in front of the EXIF segment's marker
 */
async function jpegBehindSegments(leadingSegments, { exif = DEFAULT_EXIF, xmp = false, fillBytes = 0 } = {}) {
  let image = sharp({ create: { width: 30, height: 20, channels: 3, background: { r: 5, g: 5, b: 5 } } });
  if (exif) image = image.withExif(exif);
  const plain = await image.jpeg().toBuffer();
  // sharp writes the EXIF APP1 right after SOI; the extra blocks go in front of it.
  if (exif && plain.readUInt16BE(2) !== 0xffe1) throw new Error('fixture: EXIF is not the first segment');
  const extra = Array.from({ length: leadingSegments }, () => (xmp
    ? appSegment(0xe1, 'http://ns.adobe.com/xap/1.0/\0', 65000)
    : appSegment(0xe2, 'ICC_PROFILE\0', 65000)));
  return Buffer.concat([plain.subarray(0, 2), ...extra, Buffer.alloc(fillBytes, 0xff), plain.subarray(2)]);
}

module.exports = jpegBehindSegments;
