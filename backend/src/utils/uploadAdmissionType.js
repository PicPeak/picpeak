const { Transform } = require('stream');

// Admission classification only, not codec validation. Read no more than a
// small header before granting the larger video allowance. HEIF/AVIF also use
// ftyp, so a generic BMFF signature cannot distinguish images from video.
const PREFIX_BYTES = 4096;
const IMAGE_BRANDS = new Set([
  'heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs',
  'mif1', 'mif2', 'msf1', 'avif', 'avis', 'avci', 'avcs',
  'jpeg', 'jpgs', 'j2ki', 'j2ks', 'j2is', 'jxsi', 'jxss',
]);
// A classic QuickTime file has no ftyp box: it opens with one of these atoms.
const QUICKTIME_ATOMS = new Set(['moov', 'mdat', 'wide', 'free', 'skip', 'pnot']);
const BRAND = /^[\x20-\x7e]{4}$/;

function vint(buffer, offset, keepMarker = false) {
  if (offset >= buffer.length || buffer[offset] === 0) return null;
  let length = 1; let marker = 0x80;
  while (!(buffer[offset] & marker)) { length++; marker >>= 1; }
  if (length > 4 || offset + length > buffer.length) return null;
  let value = keepMarker ? buffer[offset] : buffer[offset] & (marker - 1);
  for (let n = 1; n < length; n++) value = value * 256 + buffer[offset + n];
  return { length, value };
}

// null means more prefix bytes are needed; false is a definitive refusal.
function videoPrefix(buffer, mime, ended = false) {
  const need = length => buffer.length < length ? (ended ? false : null) : true;
  if (mime === 'video/mp4' || mime === 'video/quicktime') {
    if (need(8) !== true) return need(8);
    const size = buffer.readUInt32BE(0);
    const atom = buffer.toString('latin1', 4, 8);
    // Size 1 announces a 64-bit length; anything else covers its own header.
    if (atom !== 'ftyp') return mime === 'video/quicktime' && QUICKTIME_ATOMS.has(atom) && (size === 1 || size >= 8);
    if (size < 16 || size > PREFIX_BYTES || size % 4 !== 0) return false;
    if (need(size) !== true) return need(size);
    const brands = [buffer.toString('latin1', 8, 12)];
    for (let at = 16; at < size; at += 4) brands.push(buffer.toString('latin1', at, at + 4));
    // Any ISO base media brand is a video container here (isom, iso2-iso6,
    // 3gp*, hvc1, M4V, msnv, qt, ...) unless it names a still-image format.
    // The all-zero filler an old QuickTime writer leaves is not a brand.
    const named = brands.filter(brand => brand !== '\0\0\0\0');
    return named.length > 0 && named.every(brand => BRAND.test(brand)) && !named.some(brand => IMAGE_BRANDS.has(brand));
  }
  if (mime === 'video/x-msvideo') {
    if (need(12) !== true) return need(12);
    return buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'AVI ';
  }
  if (mime === 'video/webm') {
    if (need(5) !== true) return need(5);
    if (!buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return false;
    const size = vint(buffer, 4);
    if (!size) return ended || buffer.length >= 8 ? false : null;
    const end = 4 + size.length + size.value;
    if (end > PREFIX_BYTES) return false;
    if (need(end) !== true) return need(end);
    let offset = 4 + size.length;
    let documentType = null;
    while (offset < end) {
      const id = vint(buffer, offset, true);
      if (!id) return false;
      offset += id.length;
      const fieldSize = vint(buffer, offset);
      if (!fieldSize) return false;
      offset += fieldSize.length;
      if (offset + fieldSize.value > end) return false;
      if (id.value === 0x4282) {
        if (documentType !== null) return false;
        documentType = buffer.toString('latin1', offset, offset + fieldSize.value);
      }
      offset += fieldSize.value;
    }
    return documentType === 'webm';
  }
  return false;
}

function typeError() {
  return Object.assign(new Error('Invalid video file content.'), { status: 400, code: 'UPLOAD_TYPE_REJECTED' });
}

function createUploadFileGuard(file, photoBytes, videoBytes) {
  const video = file.mimetype.startsWith('video/');
  const cap = video ? videoBytes : photoBytes;
  let size = 0;
  let prefix = Buffer.alloc(0);
  let classified = !video;
  const classify = ended => {
    const result = videoPrefix(prefix, file.mimetype, ended);
    if (result === false) throw typeError();
    if (result === true) classified = true;
  };
  return new Transform({
    transform(chunk, _encoding, next) {
      try {
        size += chunk.length;
        if (size > cap) throw Object.assign(new Error(
          `File too large. Maximum size is ${Math.floor(cap / (1024 * 1024))} MB per file.`
        ), { status: 400, code: 'UPLOAD_FILE_TOO_LARGE' });
        if (classified) return next(null, chunk);
        const held = Math.min(PREFIX_BYTES - prefix.length, chunk.length);
        prefix = Buffer.concat([prefix, chunk.subarray(0, held)]);
        classify(false);
        if (!classified) return next();
        this.push(prefix);
        prefix = Buffer.alloc(0);
        next(null, chunk.subarray(held));
      } catch (err) { next(err); }
    },
    flush(next) {
      try {
        if (!classified) { classify(true); this.push(prefix); }
        next();
      } catch (err) { next(err); }
    },
  });
}

module.exports = { createUploadFileGuard, videoPrefix, PREFIX_BYTES };
