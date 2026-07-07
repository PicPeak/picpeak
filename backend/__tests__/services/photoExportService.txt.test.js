/**
 * exportAsTxt — issue #623 regression test.
 *
 * The admin UI labels the TXT export "for Lightroom search". Lightroom's
 * filename search wants ONE comma-separated line WITHOUT file extensions
 * (the gallery JPEGs may map to RAW files in the catalog). The frontend
 * now passes separator='comma' + include_extension=false for the TXT
 * format; this test pins the resulting shape so a future refactor can't
 * silently regress it back to the newline-separated form the bug reported.
 *
 * Also pins backward compatibility: a direct API caller passing no options
 * still gets the original newline-with-extension behaviour, so existing
 * integrations don't break.
 */
jest.mock('../../src/database/db', () => ({ db: jest.fn() }));
jest.mock('../../src/services/xmpGenerator', () => ({ XmpGenerator: class {} }));

const { PhotoExportService } = require('../../src/services/photoExportService');
const service = new PhotoExportService();

const PHOTOS = [
  { original_filename: 'IMG_0001.jpg', filename: 'abc123.jpg' },
  { original_filename: 'IMG_0002.JPEG', filename: 'def456.jpeg' },
  { original_filename: 'shoot.final.tif', filename: 'ghi789.tif' },
  { original_filename: null, filename: 'fallback.png' }, // null original → falls back to filename
];

describe('exportAsTxt (issue #623)', () => {
  it('Lightroom mode: comma-joined, no extension, no space', () => {
    const result = service.exportAsTxt(PHOTOS, {
      separator: 'comma',
      include_extension: false,
    });
    expect(result.content).toBe('IMG_0001,IMG_0002,shoot.final,fallback');
    expect(result.contentType).toBe('text/plain');
  });

  it('backward compatible: no options → newline-joined with extensions', () => {
    const result = service.exportAsTxt(PHOTOS);
    expect(result.content).toBe(
      'IMG_0001.jpg\nIMG_0002.JPEG\nshoot.final.tif\nfallback.png',
    );
  });

  it('semicolon separator joins without a trailing space', () => {
    const result = service.exportAsTxt(PHOTOS, {
      separator: 'semicolon',
      include_extension: false,
    });
    expect(result.content).toBe('IMG_0001;IMG_0002;shoot.final;fallback');
  });

  it('filename_format=picpeak uses photo.filename (hashed) instead of original', () => {
    const result = service.exportAsTxt(PHOTOS, {
      filename_format: 'picpeak',
      separator: 'comma',
      include_extension: false,
    });
    expect(result.content).toBe('abc123,def456,ghi789,fallback');
  });

  it('extension stripping uses only the last segment ("a.b.c" → "a.b")', () => {
    // path.parse('shoot.final.tif').name === 'shoot.final' — Lightroom
    // catalogs that store basenames like "shoot.final" still match.
    const result = service.exportAsTxt(
      [{ original_filename: 'shoot.final.tif', filename: 'x.tif' }],
      { separator: 'comma', include_extension: false },
    );
    expect(result.content).toBe('shoot.final');
  });
});
