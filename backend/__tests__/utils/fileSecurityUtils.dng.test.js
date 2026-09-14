/**
 * DNG uploads from an iPhone (issue 821).
 *
 * Two independent ways a valid DNG was refused:
 *
 *  - The DNG signature accepted little-endian TIFF only, on the belief that
 *    Apple ProRAW is little-endian. An iPhone 15 Pro Max ProRAW file is
 *    big-endian: its first bytes (the fixture below, copied from the
 *    reporter's file) are "MM\0*" followed by "APPLEDNG". The admin upload
 *    content check rejected every such file.
 *  - Both upload filters required the browser to report exactly
 *    image/x-adobe-dng. What a browser reports for a .dng depends on the OS
 *    type table, and a machine without a RAW codec reports nothing, so those
 *    files were refused as an invalid type before any bytes were read.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  validateFileContent,
  validateFileType,
  normalizeUploadMimeType,
} = require('../../src/utils/fileSecurityUtils');

// First 16 bytes of the reporter's iPhone 15 Pro Max ProRAW file.
const IPHONE_PRORAW_HEADER = Buffer.from([
  0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x12,
  0x41, 0x50, 0x50, 0x4C, 0x45, 0x44, 0x4E, 0x47,
]);
const LITTLE_ENDIAN_TIFF_HEADER = Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00]);
const JPEG_HEADER = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46]);

describe('DNG content signature', () => {
  let dir;
  const writeFixture = (name, header) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, Buffer.concat([header, Buffer.alloc(64)]));
    return file;
  };

  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-dng-')); });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('accepts a big-endian iPhone ProRAW DNG', async () => {
    const file = writeFixture('iphone.dng', IPHONE_PRORAW_HEADER);
    await expect(validateFileContent(file, 'image/x-adobe-dng')).resolves.toBe(true);
  });

  it('still accepts a little-endian DNG', async () => {
    const file = writeFixture('camera.dng', LITTLE_ENDIAN_TIFF_HEADER);
    await expect(validateFileContent(file, 'image/x-adobe-dng')).resolves.toBe(true);
  });

  it('rejects content that is not TIFF at all', async () => {
    const file = writeFixture('renamed.dng', JPEG_HEADER);
    await expect(validateFileContent(file, 'image/x-adobe-dng')).resolves.toBe(false);
  });

  it('keeps single-set signatures strict for other types', async () => {
    // AVI lists two checks that must both match; alternatives must not
    // loosen that into "either one".
    const riffOnly = writeFixture('clip.avi', Buffer.from('RIFF\0\0\0\0WAVE', 'latin1'));
    await expect(validateFileContent(riffOnly, 'video/x-msvideo')).resolves.toBe(false);
    const tiffAsJpeg = writeFixture('photo.jpg', IPHONE_PRORAW_HEADER);
    await expect(validateFileContent(tiffAsJpeg, 'image/jpeg')).resolves.toBe(false);
  });
});

describe('normalizeUploadMimeType', () => {
  const allowed = ['image/jpeg', 'image/x-adobe-dng'];

  it.each(['', 'application/octet-stream', 'image/dng', 'image/x-dng', 'image/tiff'])(
    'maps a .dng reported as %j onto image/x-adobe-dng',
    (reported) => {
      const mimetype = normalizeUploadMimeType('IMG_0001.DNG', reported);
      expect(mimetype).toBe('image/x-adobe-dng');
      expect(validateFileType('IMG_0001.DNG', mimetype, allowed)).toBe(true);
    },
  );

  it('leaves a correctly reported DNG alone', () => {
    expect(normalizeUploadMimeType('shot.dng', 'image/x-adobe-dng')).toBe('image/x-adobe-dng');
  });

  it('does not rename a type that says something else entirely', () => {
    // A .dng claiming to be a JPEG is a mismatch, not a naming variant.
    expect(normalizeUploadMimeType('shot.dng', 'image/jpeg')).toBe('image/jpeg');
    expect(validateFileType('shot.dng', 'image/jpeg', allowed)).toBe(false);
  });

  it('only applies to .dng files', () => {
    expect(normalizeUploadMimeType('photo.jpg', 'application/octet-stream')).toBe('application/octet-stream');
    expect(normalizeUploadMimeType('scan.tiff', 'image/tiff')).toBe('image/tiff');
    expect(normalizeUploadMimeType(undefined, '')).toBe('');
  });

  it('does not admit a DNG the admin has not enabled', () => {
    const mimetype = normalizeUploadMimeType('IMG_0001.DNG', 'application/octet-stream');
    expect(validateFileType('IMG_0001.DNG', mimetype, ['image/jpeg'])).toBe(false);
  });
});
