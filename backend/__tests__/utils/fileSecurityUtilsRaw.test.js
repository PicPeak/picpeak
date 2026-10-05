const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const {
  validateFileType,
  validateFileContent,
  normalizeUploadMimeType,
  isRawUploadFilename,
  RAW_UPLOAD_EXTENSIONS,
} = require('../../src/utils/fileSecurityUtils');

// What a browser actually hands multer for a camera RAW. macOS and Windows
// register no MIME for these extensions, so the field is empty; some Linux
// desktops fall back to the generic binary type.
const UNTYPED = '';
const OCTET_STREAM = 'application/octet-stream';

const RAW_ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/x-sony-arw'];
const NO_RAW_ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];

let tmpDir;

// Signatures are synthesised rather than committed: the magic check reads the
// first 64 bytes, so a handful of header bytes exercises it exactly as a real
// 55 MB ARW would, and the repo stays free of binary fixtures.
const writeFixture = async (name, bytes) => {
  const filePath = path.join(tmpDir, name);
  await fs.writeFile(filePath, Buffer.from(bytes));
  return filePath;
};

const TIFF_LE = [0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00];
const TIFF_BE = [0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08];
const JPEG = [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46];

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-rawtest-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('validateFileType with camera RAW', () => {
  test('accepts a RAW file the browser did not type', () => {
    expect(validateFileType('DSC01234.ARW', UNTYPED, RAW_ALLOWED)).toBe(true);
    expect(validateFileType('DSC01234.arw', OCTET_STREAM, RAW_ALLOWED)).toBe(true);
  });

  test('rejects RAW on a route that does not allow it', () => {
    // The scoping that matters: publicTransferUpload.js is unauthenticated and
    // shares this function, so resolving a type from the extension must never
    // add a format the caller did not ask for.
    expect(validateFileType('DSC01234.ARW', UNTYPED, NO_RAW_ALLOWED)).toBe(false);
    expect(validateFileType('DSC01234.ARW', OCTET_STREAM, NO_RAW_ALLOWED)).toBe(false);
  });

  test('rejects a non-RAW extension the browser did not type', () => {
    for (const name of ['payload.exe', 'payload.sh', 'payload.bin', 'payload']) {
      expect(validateFileType(name, UNTYPED, RAW_ALLOWED)).toBe(false);
      expect(validateFileType(name, OCTET_STREAM, RAW_ALLOWED)).toBe(false);
    }
  });

  test('leaves ordinary formats exactly as strict as before', () => {
    // An untyped .jpg was rejected before this change and still is. Only the
    // RAW set is resolved from its extension.
    expect(validateFileType('holiday.jpg', UNTYPED, RAW_ALLOWED)).toBe(false);
    expect(validateFileType('holiday.jpg', 'image/jpeg', RAW_ALLOWED)).toBe(true);
    expect(validateFileType('clip.mp4', 'video/mp4', ['video/mp4'])).toBe(true);
  });

  test('rejects a claimed type that disagrees with the extension', () => {
    expect(validateFileType('DSC01234.arw', 'image/jpeg', RAW_ALLOWED)).toBe(false);
    expect(validateFileType('holiday.jpg', 'image/x-sony-arw', RAW_ALLOWED)).toBe(false);
  });

  test('normalizeUploadMimeType only ever names a RAW type', () => {
    expect(normalizeUploadMimeType('DSC01234.ARW', UNTYPED)).toBe('image/x-sony-arw');
    expect(normalizeUploadMimeType('IMG_0001.CR2', OCTET_STREAM)).toBe('image/x-canon-cr2');
    // A generic type on a RAW extension is no more evidence than none at all.
    // image/tiff is the honest answer for a TIFF container and tells the
    // vendor formats apart not at all, so the extension still decides.
    expect(normalizeUploadMimeType('DSC01234.ARW', 'image/tiff')).toBe('image/x-sony-arw');
    expect(normalizeUploadMimeType('holiday.jpg', 'image/jpeg')).toBe('image/jpeg');
    // Nothing outside the RAW set is rescued: what arrived is what gets
    // tested, and no allow-list contains it.
    expect(normalizeUploadMimeType('holiday.jpg', UNTYPED)).toBe(UNTYPED);
    expect(normalizeUploadMimeType('payload.exe', OCTET_STREAM)).toBe(OCTET_STREAM);
    expect(normalizeUploadMimeType(undefined, UNTYPED)).toBe(UNTYPED);
  });
});

describe('isRawUploadFilename', () => {
  test('names every RAW in the table, not just DNG', () => {
    for (const name of ['a.dng', 'DSC01234.ARW', 'a.sr2', 'a.srf', 'IMG.CR2',
      'a.nef', 'a.nrw', 'a.pef', 'a.srw', 'a.orf']) {
      expect(isRawUploadFilename(name)).toBe(true);
    }
  });

  test('says no to ordinary formats and to junk', () => {
    for (const name of ['holiday.jpg', 'a.png', 'a.webp', 'a.heic', 'clip.mp4',
      'a.tif', 'payload.exe', 'noextension', '.dng', '', null, undefined]) {
      expect(isRawUploadFilename(name)).toBe(false);
    }
  });

  test('stays derived from the type table', () => {
    // The point of the helper: a new RAW entry reaches the callers that report
    // what an upload was without anyone remembering to widen a second list.
    expect([...RAW_UPLOAD_EXTENSIONS].sort()).toEqual(
      ['arw', 'cr2', 'dng', 'nef', 'nrw', 'orf', 'pef', 'sr2', 'srf', 'srw']
    );
    for (const extension of RAW_UPLOAD_EXTENSIONS) {
      expect(isRawUploadFilename(`photo.${extension}`)).toBe(true);
    }
  });
});

describe('validateFileContent with camera RAW', () => {
  test('accepts either TIFF byte order', async () => {
    // Nikon and Pentax ship big-endian files. Rejecting one would be a bug,
    // not a defence, which is why the RAW entries list alternatives.
    const little = await writeFixture('little.arw', TIFF_LE);
    const big = await writeFixture('big.nef', TIFF_BE);
    await expect(validateFileContent(little, 'image/x-sony-arw')).resolves.toBe(true);
    await expect(validateFileContent(big, 'image/x-nikon-nef')).resolves.toBe(true);
  });

  test('accepts the Olympus marker rather than the TIFF one', async () => {
    const iiro = await writeFixture('a.orf', [0x49, 0x49, 0x52, 0x4F, 0x08, 0x00, 0x00, 0x00]);
    await expect(validateFileContent(iiro, 'image/x-olympus-orf')).resolves.toBe(true);
    // An ORF is not a plain TIFF, so the generic signature must not pass it.
    const tiff = await writeFixture('b.orf', TIFF_LE);
    await expect(validateFileContent(tiff, 'image/x-olympus-orf')).resolves.toBe(false);
  });

  test('rejects a renamed non-RAW file', async () => {
    const disguised = await writeFixture('evil.arw', JPEG);
    await expect(validateFileContent(disguised, 'image/x-sony-arw')).resolves.toBe(false);
  });

  test('rejects a file too short to carry a signature', async () => {
    const stub = await writeFixture('stub.arw', [0x49, 0x49]);
    await expect(validateFileContent(stub, 'image/x-sony-arw')).resolves.toBe(false);
  });

  test('still requires every part of a multi-part signature', async () => {
    // WebP is RIFF at 0 AND WEBP at 8. Alternatives must not have loosened it
    // into "either half will do".
    const halfWebp = await writeFixture('half.webp', [
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x4E, 0x4F, 0x50, 0x45,
    ]);
    await expect(validateFileContent(halfWebp, 'image/webp')).resolves.toBe(false);
  });
});
