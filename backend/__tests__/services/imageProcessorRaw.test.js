/**
 * Unit tests for the RAW/DNG handling helpers (#821). The actual exiftool
 * extraction can only be exercised in the built image (exiftool isn't a dev
 * dependency), so these cover the gating logic: which files are treated as RAW,
 * and that ordinary images pass through untouched (zero cost / no extraction).
 */
const {
  isRawFilename,
  withProcessableImage,
  originalNeedsPreview,
  RAW_EXTENSIONS,
} = require('../../src/services/imageProcessor');

describe('isRawFilename', () => {
  it('recognises common RAW / DNG extensions', () => {
    for (const ext of ['dng', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'rw2', 'orf']) {
      expect(isRawFilename(`IMG_1234.${ext}`)).toBe(true);
      expect(isRawFilename(`IMG_1234.${ext.toUpperCase()}`)).toBe(true); // case-insensitive
    }
  });

  it('does not treat ordinary images/videos as RAW', () => {
    for (const name of ['photo.jpg', 'photo.jpeg', 'photo.png', 'photo.webp', 'clip.mp4', 'clip.mov', 'photo.heic']) {
      expect(isRawFilename(name)).toBe(false);
    }
  });

  it('is null/empty safe', () => {
    expect(isRawFilename(null)).toBe(false);
    expect(isRawFilename('')).toBe(false);
    expect(isRawFilename('noextension')).toBe(false);
  });

  it('RAW_EXTENSIONS includes dng (Apple ProRAW)', () => {
    expect(RAW_EXTENSIONS.has('dng')).toBe(true);
  });
});

describe('originalNeedsPreview', () => {
  it('sends the lightbox to the preview for every RAW format', () => {
    for (const ext of ['arw', 'cr2', 'cr3', 'nef', 'dng', 'raf', 'rw2', 'orf']) {
      expect(originalNeedsPreview({ filename: `IMG_1234.${ext}` })).toBe(true);
      expect(originalNeedsPreview({ filename: `IMG_1234.${ext.toUpperCase()}` })).toBe(true);
    }
  });

  it('recognises the type as well as the name', () => {
    // The stored name is a sanitised generated one on some ingest paths, so
    // neither signal alone is enough.
    expect(originalNeedsPreview({ filename: 'abc123', mime_type: 'image/x-sony-arw' })).toBe(true);
    expect(originalNeedsPreview({ filename: 'abc123', mime_type: 'IMAGE/HEIC' })).toBe(true);
  });

  it('prefers the original filename over the stored one', () => {
    // original_filename is NULL for rows predating migration 062, which is why
    // filename is still consulted.
    expect(originalNeedsPreview({ filename: 'gen_abc.jpg', original_filename: 'DSC01234.ARW' })).toBe(true);
    expect(originalNeedsPreview({ filename: 'gen_abc.jpg' })).toBe(false);
  });

  it('covers HEIC and HEIF, and leaves ordinary images alone', () => {
    expect(originalNeedsPreview({ filename: 'a.heic' })).toBe(true);
    expect(originalNeedsPreview({ filename: 'a.heif' })).toBe(true);
    for (const name of ['a.jpg', 'a.png', 'a.webp', 'a.gif', 'clip.mp4', 'noextension']) {
      expect(originalNeedsPreview({ filename: name })).toBe(false);
    }
  });
});

describe('withProcessableImage', () => {
  it('passes ordinary images through with no extraction and a no-op cleanup', async () => {
    const localPath = '/tmp/whatever/photo.jpg';
    const proc = await withProcessableImage(localPath, 'photo.jpg');
    expect(proc.path).toBe(localPath);          // unchanged — sharp reads it directly
    expect(proc.outputBasename).toBeUndefined(); // generators keep their default naming
    await expect(Promise.resolve(proc.cleanup())).resolves.toBeUndefined();
  });

  it('routes RAW files to extraction, which fails cleanly on a file with no preview', async () => {
    // Rejects either way, which is the point: with no exiftool the spawn fails,
    // and with exiftool the path does not exist, and both are a normal
    // processing failure to the caller. What is asserted is the routing — an
    // ordinary image would have returned above without spawning anything.
    // The real extraction is covered in imageProcessorRawExtraction.test.js.
    await expect(withProcessableImage('/tmp/whatever/IMG_1234.dng', 'IMG_1234.dng')).rejects.toThrow();
  });
});
